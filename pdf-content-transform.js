import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js";

const OPERATORS = new Set([
  "b",
  "B",
  "b*",
  "B*",
  "BDC",
  "BI",
  "BMC",
  "BT",
  "BX",
  "c",
  "cm",
  "CS",
  "cs",
  "d",
  "Do",
  "DP",
  "EI",
  "EMC",
  "ET",
  "EX",
  "f",
  "F",
  "f*",
  "G",
  "g",
  "gs",
  "h",
  "i",
  "ID",
  "j",
  "J",
  "K",
  "k",
  "l",
  "m",
  "M",
  "n",
  "q",
  "Q",
  "re",
  "RG",
  "rg",
  "ri",
  "s",
  "S",
  "SC",
  "sc",
  "SCN",
  "scn",
  "sh",
  "T*",
  "Tc",
  "Td",
  "TD",
  "Tf",
  "Tj",
  "TJ",
  "TL",
  "Tm",
  "Tr",
  "Ts",
  "Tw",
  "Tz",
  "v",
  "w",
  "W",
  "W*",
  "y",
  "''",
  "'",
  '"',
]);

export function makeCoverKey(pageNumber, pdfBBox) {
  const round1 = (value) => Math.round(value * 10) / 10;
  const x = pdfBBox.x ?? pdfBBox.minX ?? 0;
  const y = pdfBBox.y ?? pdfBBox.minY ?? 0;
  const w = pdfBBox.w ?? (pdfBBox.maxX - pdfBBox.minX);
  const h = pdfBBox.h ?? (pdfBBox.maxY - pdfBBox.minY);
  return [
    pageNumber,
    round1(x),
    round1(y),
    round1(w),
    round1(h),
  ].join(":");
}

export async function transformPdfContent(pdfDoc, options) {
  const context = pdfDoc.context;
  const processedStreams = new Set();
  const pages = pdfDoc.getPages();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const pageNumber = pageIndex + 1;
    const { width, height } = page.getSize();
    const transformOptions = {
      ...options,
      pageNumber,
      pageWidth: width,
      pageHeight: height,
      pageArea: width * height,
      processedStreams,
    };

    await transformResourceXObjects(page.node, context, transformOptions);
    await transformContentRefs(getPageContentRefs(page, context), context, transformOptions);
  }
}

async function transformResourceXObjects(pageNode, context, options) {
  const resourcesRef = pageNode.get(PDFName.of("Resources"));
  if (!resourcesRef) {
    return;
  }

  const resources = context.lookup(resourcesRef, PDFDict);
  await transformResourceXObjectsFromDict(resources, context, options);
}

async function transformResourceXObjectsFromDict(resources, context, options) {
  const xObjectRef = resources?.lookup(PDFName.of("XObject"), PDFDict);
  if (!xObjectRef) {
    return;
  }

  for (const [, ref] of xObjectRef.entries()) {
    if (!(ref instanceof PDFRef)) {
      continue;
    }

    const xObject = context.lookup(ref);
    const subtype = xObject?.dict?.lookup(PDFName.of("Subtype"));
    if (subtype?.toString() !== "/Form") {
      continue;
    }

    const bbox = readFormBBox(xObject.dict);
    const formOptions = {
      ...options,
      pageWidth: bbox.width,
      pageHeight: bbox.height,
      pageArea: bbox.width * bbox.height,
    };

    const nestedResources = xObject.dict.lookup(PDFName.of("Resources"), PDFDict);
    if (nestedResources) {
      await transformResourceXObjectsFromDict(nestedResources, context, formOptions);
    }

    await transformContentRefs([ref], context, formOptions);
  }
}

function readFormBBox(dict) {
  const bboxArray = dict?.lookup(PDFName.of("BBox"), PDFArray);
  if (!bboxArray || bboxArray.size() < 4) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const values = bboxArray.asArray().map((value) => Number(value));
  const [x1, y1, x2, y2] = values;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function getPageContentRefs(page, context) {
  const contentsRef = page.node.get(PDFName.of("Contents"));
  if (!contentsRef) {
    return [];
  }

  const contents = context.lookup(contentsRef);
  if (contents instanceof PDFArray) {
    return contents.asArray().filter((entry) => entry instanceof PDFRef);
  }
  if (contentsRef instanceof PDFRef) {
    return [contentsRef];
  }
  return [];
}

async function transformContentRefs(refs, context, options) {
  for (const ref of refs) {
    if (!(ref instanceof PDFRef) || options.processedStreams.has(ref)) {
      continue;
    }

    options.processedStreams.add(ref);
    const stream = context.lookup(ref, PDFRawStream);
    if (!stream) {
      continue;
    }

    const decoded = decodePDFRawStream(stream).decode();
    const transformed = transformContentBytes(decoded, options);
    replaceStreamContents(context, ref, transformed, stream);
  }
}

function replaceStreamContents(context, ref, bytes, originalStream) {
  const filter = originalStream.dict.lookup(PDFName.of("Filter"));
  const newStream = hasFlateFilter(filter)
    ? context.flateStream(bytes)
    : context.stream(bytes);
  context.assign(ref, newStream);
}

function hasFlateFilter(filter) {
  if (!filter) {
    return false;
  }
  if (filter instanceof PDFName) {
    return filter.toString() === "/FlateDecode";
  }
  if (filter instanceof PDFArray) {
    return filter.asArray().some((entry) => entry?.toString() === "/FlateDecode");
  }
  return false;
}

function transformContentBytes(bytes, options) {
  const tokens = tokenizeContentStream(bytes);
  const output = [];
  const state = createGraphicsState(options.pageWidth, options.pageHeight);

  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index];

    if (token === "BT") {
      flushPathBuffer(output, state);
      const blockEnd = findBlockEnd(tokens, index, "BT", "ET");
      const blockTokens = tokens.slice(index, blockEnd + 1);
      if (options.recolorText) {
        output.push(...recolorTextBlock(blockTokens, options, state));
      } else {
        output.push(...blockTokens);
      }
      index = blockEnd + 1;
      continue;
    }

    if (isOperator(token)) {
      const handled = handleGraphicsOperator(tokens, index, output, state, options);
      index = handled.nextIndex;
      continue;
    }

    flushPathBuffer(output, state);
    output.push(token);
    index += 1;
  }

  flushPathBuffer(output, state);
  return new TextEncoder().encode(joinTokens(output));
}

function createGraphicsState(pageWidth, pageHeight) {
  return {
    pageWidth,
    pageHeight,
    ctm: identityMatrix(),
    stack: [],
    fillColor: { r: 0, g: 0, b: 0, gray: 0, kind: "rgb" },
    pathBuffer: [],
    pathBbox: null,
    pendingRect: null,
  };
}

function flushPathBuffer(output, state) {
  if (state.pathBuffer.length > 0) {
    output.push(...state.pathBuffer);
    state.pathBuffer = [];
    state.pathBbox = null;
    state.pendingRect = null;
  }
}

function handleGraphicsOperator(tokens, index, output, state, options) {
  const token = tokens[index];

  if (token === "q") {
    flushPathBuffer(output, state);
    state.stack.push(cloneGraphicsState(state));
    output.push(token);
    return { nextIndex: index + 1 };
  }

  if (token === "Q") {
    flushPathBuffer(output, state);
    if (state.stack.length > 0) {
      restoreGraphicsState(state, state.stack.pop());
    }
    output.push(token);
    return { nextIndex: index + 1 };
  }

  if (token === "cm") {
    flushPathBuffer(output, state);
    const args = readNumberArgs(tokens, index, 6);
    state.ctm = multiplyMatrix(state.ctm, args);
    output.push(...tokens.slice(index - 6, index + 1));
    return { nextIndex: index + 1 };
  }

  if (token === "rg") {
    flushPathBuffer(output, state);
    const args = readNumberArgs(tokens, index, 3);
    state.fillColor = { kind: "rgb", r: args[0], g: args[1], b: args[2] };
    output.push(...tokens.slice(index - 3, index + 1));
    return { nextIndex: index + 1 };
  }

  if (token === "g") {
    flushPathBuffer(output, state);
    const gray = readNumberArgs(tokens, index, 1)[0];
    state.fillColor = { kind: "gray", gray, r: gray, g: gray, b: gray };
    output.push(...tokens.slice(index - 1, index + 1));
    return { nextIndex: index + 1 };
  }

  if (token === "re") {
    const args = readNumberArgs(tokens, index, 4);
    state.pendingRect = { x: args[0], y: args[1], w: args[2], h: args[3] };
    state.pathBbox = rectToBbox(args[0], args[1], args[2], args[3], state.ctm);
    state.pathBuffer.push(...tokens.slice(index - 4, index + 1));
    return { nextIndex: index + 1 };
  }

  if (token === "m" || token === "l" || token === "c" || token === "v" || token === "y") {
    const argCount = token === "c" ? 6 : token === "m" || token === "l" ? 2 : 4;
    const args = readNumberArgs(tokens, index, argCount);
    const points = [];
    if (token === "m" || token === "l") {
      points.push([args[0], args[1]]);
    } else if (token === "c") {
      points.push([args[4], args[5]]);
    } else {
      points.push([args[2], args[3]]);
    }
    for (const [x, y] of points) {
      const transformed = applyMatrix(state.ctm, x, y);
      state.pathBbox = includePoint(state.pathBbox, transformed.x, transformed.y);
    }
    state.pathBuffer.push(...tokens.slice(index - argCount, index + 1));
    return { nextIndex: index + 1 };
  }

  if (token === "h") {
    state.pathBuffer.push(token);
    return { nextIndex: index + 1 };
  }

  if (isFillOperator(token)) {
    const bbox = state.pathBbox || (state.pendingRect
      ? rectToBbox(state.pendingRect.x, state.pendingRect.y, state.pendingRect.w, state.pendingRect.h, state.ctm)
      : null);

    if (shouldRemoveFill(bbox, state.fillColor, options)) {
      state.pathBuffer = [];
      state.pathBbox = null;
      state.pendingRect = null;
      return { nextIndex: index + 1 };
    }

    output.push(...state.pathBuffer, token);
    state.pathBuffer = [];
    state.pathBbox = null;
    state.pendingRect = null;
    return { nextIndex: index + 1 };
  }

  flushPathBuffer(output, state);
  output.push(token);
  return { nextIndex: index + 1 };
}

function shouldRemoveFill(bbox, fillColor, options) {
  if (!bbox || !fillColor) {
    return false;
  }

  const { r, g, b } = normalizeColor(fillColor);
  if (!isNearWhite(r, g, b, options.whiteThreshold ?? 238)) {
    return false;
  }

  const area = bbox.w * bbox.h;
  const pageArea = options.pageArea ?? 0;
  if (pageArea > 0 && area / pageArea >= 0.9) {
    return false;
  }

  if (bbox.w < 3 || bbox.h < 3) {
    return false;
  }

  const key = makeCoverKey(options.pageNumber, bbox);
  return Boolean(options.revealAllOverlays || options.revealedCovers?.has(key));
}

function recolorTextBlock(blockTokens, options, outerState) {
  const output = [];
  const textState = {
    fillColor: { ...outerState.fillColor },
  };
  const target = hexToPdfRgb(options.textColor ?? "#dd1133");

  for (let index = 0; index < blockTokens.length; index += 1) {
    const token = blockTokens[index];

    if (token === "rg") {
      const args = readNumberArgs(blockTokens, index, 3);
      const color = { r: args[0], g: args[1], b: args[2] };
      if (isNearWhite(color.r, color.g, color.b, options.whiteThreshold ?? 238)) {
        output.push(formatNumber(target[0]), formatNumber(target[1]), formatNumber(target[2]), "rg");
      } else {
        output.push(...blockTokens.slice(index - 3, index + 1));
      }
      textState.fillColor = { kind: "rgb", ...color };
      continue;
    }

    if (token === "g") {
      const gray = readNumberArgs(blockTokens, index, 1)[0];
      if (isNearWhite(gray, gray, gray, options.whiteThreshold ?? 238)) {
        output.push(formatNumber(target[0]), formatNumber(target[1]), formatNumber(target[2]), "rg");
        textState.fillColor = { kind: "rgb", r: target[0], g: target[1], b: target[2] };
      } else {
        output.push(...blockTokens.slice(index - 1, index + 1));
        textState.fillColor = { kind: "gray", gray, r: gray, g: gray, b: gray };
      }
      continue;
    }

    output.push(token);
  }

  return output;
}

function tokenizeContentStream(bytes) {
  const source = new TextDecoder("latin1").decode(bytes);
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (index >= source.length) {
      break;
    }

    const char = source[index];
    if (char === "%") {
      index = skipComment(source, index);
      continue;
    }

    if (char === "(") {
      const literal = readLiteralString(source, index);
      tokens.push(literal.value);
      index = literal.nextIndex;
      continue;
    }

    if (char === "<" && source[index + 1] === "<") {
      const dict = readDictionary(source, index);
      tokens.push(dict.value);
      index = dict.nextIndex;
      continue;
    }

    if (char === "<") {
      const hex = readHexString(source, index);
      tokens.push(hex.value);
      index = hex.nextIndex;
      continue;
    }

    if (char === "[") {
      const array = readArray(source, index);
      tokens.push(array.value);
      index = array.nextIndex;
      continue;
    }

    const word = readWord(source, index);
    tokens.push(word.value);
    index = word.nextIndex;
  }

  return tokens;
}

function skipWhitespace(source, index) {
  while (index < source.length && /[\0\t\n\f\r ]/.test(source[index])) {
    index += 1;
  }
  return index;
}

function skipComment(source, index) {
  while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
    index += 1;
  }
  return index;
}

function readWord(source, index) {
  let start = index;
  while (index < source.length) {
    const char = source[index];
    if (/[\0\t\n\f\r ]/.test(char) || "()[]<>/%".includes(char)) {
      break;
    }
    index += 1;
  }
  return { value: source.slice(start, index), nextIndex: index };
}

function readLiteralString(source, index) {
  let depth = 0;
  let escaped = false;
  let cursor = index;

  while (cursor < source.length) {
    const char = source[cursor];
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        cursor += 1;
        break;
      }
    }
    cursor += 1;
  }

  return { value: source.slice(index, cursor), nextIndex: cursor };
}

function readHexString(source, index) {
  let cursor = index + 1;
  while (cursor < source.length && source[cursor] !== ">") {
    cursor += 1;
  }
  cursor += 1;
  return { value: source.slice(index, cursor), nextIndex: cursor };
}

function readDictionary(source, index) {
  let depth = 0;
  let cursor = index;
  while (cursor < source.length) {
    if (source[cursor] === "<" && source[cursor + 1] === "<") {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (source[cursor] === ">" && source[cursor + 1] === ">") {
      depth -= 1;
      cursor += 2;
      if (depth === 0) {
        break;
      }
      continue;
    }
    cursor += 1;
  }
  return { value: source.slice(index, cursor), nextIndex: cursor };
}

function readArray(source, index) {
  let depth = 0;
  let cursor = index;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        cursor += 1;
        break;
      }
    }
    cursor += 1;
  }
  return { value: source.slice(index, cursor), nextIndex: cursor };
}

function readNumberArgs(tokens, operatorIndex, count) {
  const args = [];
  for (let offset = count; offset >= 1; offset -= 1) {
    args.unshift(Number(tokens[operatorIndex - offset]));
  }
  return args;
}

function findBlockEnd(tokens, startIndex, startToken, endToken) {
  let depth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    if (tokens[index] === startToken) {
      depth += 1;
    } else if (tokens[index] === endToken) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return tokens.length - 1;
}

function isOperator(token) {
  return OPERATORS.has(token);
}

function isFillOperator(token) {
  return token === "f" || token === "F" || token === "f*" || token === "B" || token === "B*" || token === "b" || token === "b*";
}

function joinTokens(tokens) {
  return `${tokens.join(" ")}\n`;
}

function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrix(left, right) {
  const [a, b, c, d, e, f] = right;
  return {
    a: left.a * a + left.c * b,
    b: left.b * a + left.d * b,
    c: left.a * c + left.c * d,
    d: left.b * c + left.d * d,
    e: left.a * e + left.c * f + left.e,
    f: left.b * e + left.d * f + left.f,
  };
}

function applyMatrix(matrix, x, y) {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

function rectToBbox(x, y, w, h, matrix) {
  const corners = [
    applyMatrix(matrix, x, y),
    applyMatrix(matrix, x + w, y),
    applyMatrix(matrix, x, y + h),
    applyMatrix(matrix, x + w, y + h),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of corners) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function includePoint(bbox, x, y) {
  if (!bbox) {
    return { x, y, w: 0, h: 0, minX: x, minY: y, maxX: x, maxY: y };
  }
  const minX = Math.min(bbox.minX ?? bbox.x, x);
  const minY = Math.min(bbox.minY ?? bbox.y, y);
  const maxX = Math.max(bbox.maxX ?? bbox.x + bbox.w, x);
  const maxY = Math.max(bbox.maxY ?? bbox.y + bbox.h, y);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, minX, minY, maxX, maxY };
}

function cloneGraphicsState(state) {
  return {
    pageWidth: state.pageWidth,
    pageHeight: state.pageHeight,
    ctm: { ...state.ctm },
    stack: [],
    fillColor: { ...state.fillColor },
    pathBuffer: [...state.pathBuffer],
    pathBbox: state.pathBbox ? { ...state.pathBbox } : null,
    pendingRect: state.pendingRect ? { ...state.pendingRect } : null,
  };
}

function restoreGraphicsState(state, saved) {
  state.ctm = saved.ctm;
  state.fillColor = saved.fillColor;
  state.pathBuffer = [...saved.pathBuffer];
  state.pathBbox = saved.pathBbox;
  state.pendingRect = saved.pendingRect;
}

function normalizeColor(color) {
  if (color.kind === "gray") {
    return { r: color.gray, g: color.gray, b: color.gray };
  }
  return { r: color.r, g: color.g, b: color.b };
}

function isNearWhite(r, g, b, threshold) {
  const min = threshold / 255;
  return r >= min && g >= min && b >= min;
}

function hexToPdfRgb(hex) {
  const normalized = hex.replace("#", "");
  const full = normalized.length === 3
    ? normalized.split("").map((part) => part + part).join("")
    : normalized;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

function formatNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}
