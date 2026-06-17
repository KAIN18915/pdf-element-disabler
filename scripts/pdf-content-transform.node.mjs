import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from "pdf-lib";

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

const PURE_FILL_OPERATORS = new Set(["f", "F", "f*"]);
const SMALL_WHITE_ELEMENT_MAX_PDF_AREA = 400;
const STROKE_WHITE_THRESHOLD_CAP = 220;
const MAX_SYMBOL_STROKE_LINE_WIDTH = 2;
export const MAX_BRACKET_STROKE_LINE_WIDTH = 5;
export const MIN_BRACKET_EXTENT_PT = 20;
export const BRACKET_ASPECT_RATIO = 3;
const MAX_THIN_SYMBOL_AREA = 2000;
const LINEAR_SYMBOL_ASPECT_RATIO = 6;
const PAGE_BACKGROUND_AREA_RATIO = 0.9;
const MIN_OUTLINE_SYMBOL_OPS = 6;
const MAX_OUTLINE_SYMBOL_AREA = 8000;
const FILL_COLOR_OPERATORS = new Set(["rg", "g", "k", "sc", "scn"]);
const STROKE_COLOR_OPERATORS = new Set(["RG", "G", "K", "SC", "SCN"]);
const TEXT_SHOW_OPERATORS = new Set(["Tj", "TJ", "'", '"']);
const STROKE_PAINT_OPERATORS = new Set(["S", "s"]);
const FILL_PAINT_OPERATORS = new Set(["f", "F", "f*"]);
const BOTH_PAINT_OPERATORS = new Set(["B", "B*", "b", "b*"]);

export function needsContentStreamTransform(options) {
  if (options.recolorText) {
    return true;
  }
  const revealed = options.revealedCovers;
  return Boolean(revealed && revealed.size > 0);
}

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
  if (!needsContentStreamTransform(options)) {
    return;
  }

  const context = pdfDoc.context;
  const processedStreams = new Set();
  const pages = pdfDoc.getPages();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const pageNumber = pageIndex + 1;
    const { width, height } = page.getSize();
    const resourcesRef = page.node.get(PDFName.of("Resources"));
    const transformOptions = {
      ...options,
      pageNumber,
      pageWidth: width,
      pageHeight: height,
      pageArea: width * height,
      processedStreams,
      colorSpaceResolver: createColorSpaceResolver(resourcesRef, context),
      formResolver: options.recolorText
        ? createFormResolver(resourcesRef, context)
        : null,
    };

    if (!options.recolorText) {
      await transformResourceXObjects(page.node, context, transformOptions);
    }
    await transformContentRefs(getPageContentRefs(page, context), context, transformOptions);
  }
}

function lookupXObjectRefInDict(name, resourcesDict) {
  if (!resourcesDict) {
    return null;
  }
  const xObjects = resourcesDict.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xObjects) {
    return null;
  }
  const ref = xObjects.get(name);
  return ref instanceof PDFRef ? ref : null;
}

function lookupXObjectRef(name, resourcesDict, context, parentResourceDicts = []) {
  let ref = lookupXObjectRefInDict(name, resourcesDict);
  if (ref) {
    return ref;
  }
  for (const parentRef of parentResourceDicts) {
    const parentDict = context.lookupMaybe(parentRef, PDFDict);
    ref = lookupXObjectRefInDict(name, parentDict);
    if (ref) {
      return ref;
    }
  }
  return null;
}

function createFormResolver(resourcesRef, context, parentResourceRefs = []) {
  const resourcesDict = resourcesRef ? context.lookupMaybe(resourcesRef, PDFDict) : null;

  return (nameToken) => {
    if (typeof nameToken !== "string" || !nameToken.startsWith("/")) {
      return null;
    }

    const name = PDFName.of(nameToken.slice(1));
    const ref = lookupXObjectRef(name, resourcesDict, context, parentResourceRefs);
    if (!ref) {
      return null;
    }

    const xObject = context.lookup(ref);
    const dict = xObject?.dict;
    if (!dict) {
      return null;
    }

    const subtype = dict.get(PDFName.of("Subtype"));
    if (subtype?.toString() !== "/Form") {
      return null;
    }

    const stream = context.lookupMaybe(ref, PDFRawStream);
    if (!stream) {
      return null;
    }

    const bbox = readFormBBox(dict);
    const nestedResourcesRef = dict.get(PDFName.of("Resources"));
    const nestedColorSpaceResolver = createColorSpaceResolver(nestedResourcesRef ?? resourcesRef, context);
    const nestedFormResolver = nestedResourcesRef
      ? createFormResolver(
        nestedResourcesRef,
        context,
        [...parentResourceRefs, resourcesRef].filter(Boolean),
      )
      : () => null;

    return {
      bytes: decodePDFRawStream(stream).decode(),
      width: bbox.width,
      height: bbox.height,
      colorSpaceResolver: nestedColorSpaceResolver,
      nestedFormResolver,
    };
  };
}

function createColorSpaceResolver(resourcesRef, context) {
  const resourcesDict = resourcesRef ? context.lookupMaybe(resourcesRef, PDFDict) : null;
  const colorSpaces = readResourceColorSpaces(resourcesDict, context);

  return (nameToken) => {
    const direct = normalizeDeviceColorSpaceName(nameToken);
    if (direct !== "unknown") {
      return direct;
    }

    if (typeof nameToken !== "string" || !nameToken.startsWith("/")) {
      return "unknown";
    }

    return colorSpaces.get(nameToken.slice(1)) ?? "unknown";
  };
}

function readResourceColorSpaces(resourcesDict, context) {
  const colorSpaces = new Map();
  const colorSpaceDict = resourcesDict?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  if (!colorSpaceDict) {
    return colorSpaces;
  }

  for (const [name, value] of colorSpaceDict.entries()) {
    const resolved = resolveColorSpaceObject(value, context, new Set());
    if (resolved !== "unknown") {
      colorSpaces.set(name.toString().replace(/^\//, ""), resolved);
    }
  }

  return colorSpaces;
}

function resolveColorSpaceObject(value, context, seen) {
  const object = value instanceof PDFRef ? context.lookup(value) : value;
  if (!object || seen.has(object)) {
    return "unknown";
  }
  seen.add(object);

  if (object instanceof PDFName) {
    return normalizeDeviceColorSpaceName(object.toString());
  }

  if (object instanceof PDFArray && object.size() > 0) {
    const kind = object.get(0)?.toString();
    if (kind === "/ICCBased") {
      return resolveIccBasedColorSpace(object, context, seen);
    }
    if (kind === "/DeviceRGB" || kind === "/DeviceCMYK" || kind === "/DeviceGray") {
      return normalizeDeviceColorSpaceName(kind);
    }
  }

  return "unknown";
}

function resolveIccBasedColorSpace(array, context, seen) {
  const streamRef = array.get(1);
  const stream = streamRef instanceof PDFRef ? context.lookup(streamRef) : streamRef;
  const dict = stream?.dict;
  if (!dict) {
    return "unknown";
  }

  const n = Number(dict.get(PDFName.of("N")));
  if (n === 3) {
    return "DeviceRGB";
  }

  const alternate = dict.get(PDFName.of("Alternate"));
  if (alternate) {
    return resolveColorSpaceObject(alternate, context, seen);
  }

  if (n === 1) {
    return "DeviceGray";
  }
  if (n === 4) {
    return "DeviceCMYK";
  }

  return "unknown";
}

async function transformResourceXObjects(pageNode, context, options) {
  const resourcesRef = pageNode.get(PDFName.of("Resources"));
  if (!resourcesRef) {
    return;
  }

  const resources = context.lookupMaybe(resourcesRef, PDFDict);
  if (!resources) {
    return;
  }
  await transformResourceXObjectsFromDict(resources, context, options);
}

async function transformResourceXObjectsFromDict(resources, context, options) {
  const xObjectRef = resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xObjectRef) {
    return;
  }

  for (const [, ref] of xObjectRef.entries()) {
    if (!(ref instanceof PDFRef)) {
      continue;
    }

    const xObject = context.lookup(ref);
    const subtype = xObject?.dict?.get(PDFName.of("Subtype"));
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

    const nestedResources = xObject.dict.lookupMaybe(PDFName.of("Resources"), PDFDict);
    if (nestedResources) {
      await transformResourceXObjectsFromDict(nestedResources, context, formOptions);
    }

    await transformContentRefs([ref], context, formOptions);
  }
}

function readFormBBox(dict) {
  const bboxArray = dict?.lookupMaybe(PDFName.of("BBox"), PDFArray);
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
    const stream = context.lookupMaybe(ref, PDFRawStream);
    if (!stream) {
      continue;
    }

    const decoded = decodePDFRawStream(stream).decode();
    const transformed = transformContentBytes(decoded, options);
    replaceStreamContents(context, ref, transformed, stream);
  }
}

function readStreamFilter(stream, context) {
  const filterEntry = stream.dict.get(PDFName.of("Filter"));
  if (!filterEntry) {
    return undefined;
  }
  return filterEntry instanceof PDFRef ? context.lookup(filterEntry) : filterEntry;
}

function replaceStreamContents(context, ref, bytes, originalStream) {
  const filter = readStreamFilter(originalStream, context);
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
  if (!needsContentStreamTransform(options)) {
    return bytes;
  }

  const tokens = tokenizeContentStream(bytes);
  const output = [];
  const state = createGraphicsState(
    options.pageWidth,
    options.pageHeight,
    options.inheritedGraphicsState ?? null,
  );
  state.colorSpaceResolver = options.colorSpaceResolver ?? state.colorSpaceResolver;

  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index];

    if (isRawSegment(token)) {
      output.push(token);
      index += 1;
      continue;
    }

    if (token === "BT") {
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

    if (token === "re") {
      const removal = tryRemoveRevealedCoverRectFill(tokens, index, state, options);
      if (removal) {
        index = removal.nextIndex;
        continue;
      }
    }

    if (isOperator(token)) {
      if (token === "Do" && options.recolorText && options.formResolver) {
        const formInfo = options.formResolver(tokens[index - 1]);
        if (formInfo) {
          if (output.length > 0 && output[output.length - 1] === tokens[index - 1]) {
            output.pop();
          }
          output.push("q");
          const formOptions = {
            ...options,
            inheritedGraphicsState: cloneGraphicsState(state),
            pageWidth: formInfo.width,
            pageHeight: formInfo.height,
            pageArea: formInfo.width * formInfo.height,
            colorSpaceResolver: formInfo.colorSpaceResolver,
            formResolver: formInfo.nestedFormResolver,
          };
          const nestedBytes = transformContentBytes(formInfo.bytes, formOptions);
          output.push(...tokenizeContentStream(nestedBytes));
          output.push("Q");
          index += 1;
          continue;
        }
      }

      if (options.recolorText && tryInjectRecolorBeforePaint(tokens, index, token, state, options, output)) {
        index += 1;
        continue;
      }
      updateGraphicsState(tokens, index, state, token);
    }

    output.push(token);
    index += 1;
  }

  return new TextEncoder().encode(joinTokens(output));
}

function createGraphicsState(pageWidth, pageHeight, inheritedState = null) {
  if (inheritedState) {
    const cloned = cloneGraphicsState(inheritedState);
    cloned.pageWidth = pageWidth;
    cloned.pageHeight = pageHeight;
    cloned.stack = [];
    return cloned;
  }

  return {
    pageWidth,
    pageHeight,
    ctm: identityMatrix(),
    stack: [],
    colorSpaceResolver: inheritedState?.colorSpaceResolver ?? null,
    fillColor: { r: 0, g: 0, b: 0, gray: 0, kind: "rgb" },
    strokeColor: { r: 0, g: 0, b: 0, gray: 0, kind: "rgb" },
    fillColorSpace: "DeviceGray",
    strokeColorSpace: "DeviceGray",
    lastRect: null,
    pathBBox: null,
    lineWidth: 1,
    pathOps: 0,
    rectCount: 0,
    hasCurve: false,
  };
}

function updateGraphicsState(tokens, index, state, token) {
  if (token === "q") {
    state.stack.push(cloneGraphicsState(state));
    return;
  }

  if (token === "Q") {
    if (state.stack.length > 0) {
      restoreGraphicsState(state, state.stack.pop());
    }
    return;
  }

  if (token === "cm") {
    const args = readNumberArgs(tokens, index, 6);
    const [a, b, c, d, e, f] = args;
    state.ctm = multiplyMatrix({ a, b, c, d, e, f }, state.ctm);
    return;
  }

  if (token === "rg") {
    const args = readNumberArgs(tokens, index, 3);
    state.fillColor = { kind: "rgb", r: args[0], g: args[1], b: args[2] };
    return;
  }

  if (token === "RG") {
    const args = readNumberArgs(tokens, index, 3);
    state.strokeColor = { kind: "rgb", r: args[0], g: args[1], b: args[2] };
    return;
  }

  if (token === "g") {
    const gray = readNumberArgs(tokens, index, 1)[0];
    state.fillColor = { kind: "gray", gray, r: gray, g: gray, b: gray };
    return;
  }

  if (token === "G") {
    const gray = readNumberArgs(tokens, index, 1)[0];
    state.strokeColor = { kind: "gray", gray, r: gray, g: gray, b: gray };
    return;
  }

  if (token === "k") {
    const args = readNumberArgs(tokens, index, 4);
    const [c, m, y, kVal] = args;
    const r = (1 - c) * (1 - kVal);
    const g = (1 - m) * (1 - kVal);
    const b = (1 - y) * (1 - kVal);
    state.fillColor = { kind: "cmyk", c, m, y, k: kVal, r, g, b };
    return;
  }

  if (token === "K") {
    const args = readNumberArgs(tokens, index, 4);
    const [c, m, y, kVal] = args;
    const r = (1 - c) * (1 - kVal);
    const g = (1 - m) * (1 - kVal);
    const b = (1 - y) * (1 - kVal);
    state.strokeColor = { kind: "cmyk", c, m, y, k: kVal, r, g, b };
    return;
  }

  if (token === "re") {
    const args = readNumberArgs(tokens, index, 4);
    const [rx, ry, rw, rh] = args;
    if (!state.pathBBox) {
      resetPathBBox(state);
    }
    state.lastRect = rectToBbox(rx, ry, rw, rh, state.ctm);
    includeRectInPathBBox(state, rx, ry, rw, rh);
    state.pathOps += 1;
    state.rectCount += 1;
    return;
  }

  if (token === "m") {
    resetPathBBox(state);
    const args = readNumberArgs(tokens, index, 2);
    includePointInPathBBox(state, args[0], args[1]);
    state.lastRect = null;
    state.pathOps += 1;
    return;
  }

  if (token === "l") {
    const args = readNumberArgs(tokens, index, 2);
    includePointInPathBBox(state, args[0], args[1]);
    state.lastRect = null;
    state.pathOps += 1;
    return;
  }

  if (token === "c") {
    const args = readNumberArgs(tokens, index, 6);
    includePointInPathBBox(state, args[0], args[1]);
    includePointInPathBBox(state, args[2], args[3]);
    includePointInPathBBox(state, args[4], args[5]);
    state.lastRect = null;
    state.pathOps += 1;
    state.hasCurve = true;
    return;
  }

  if (token === "v") {
    const args = readNumberArgs(tokens, index, 4);
    includePointInPathBBox(state, args[0], args[1]);
    includePointInPathBBox(state, args[2], args[3]);
    state.lastRect = null;
    state.pathOps += 1;
    state.hasCurve = true;
    return;
  }

  if (token === "y") {
    const args = readNumberArgs(tokens, index, 4);
    includePointInPathBBox(state, args[0], args[1]);
    includePointInPathBBox(state, args[2], args[3]);
    state.lastRect = null;
    state.pathOps += 1;
    state.hasCurve = true;
    return;
  }

  if (token === "h") {
    state.lastRect = null;
    state.pathOps += 1;
    return;
  }

  if (token === "w") {
    state.lineWidth = readNumberArgs(tokens, index, 1)[0];
    return;
  }

  if (token === "cs") {
    state.fillColorSpace = normalizeColorSpaceName(tokens[index - 1], state.colorSpaceResolver);
    return;
  }

  if (token === "CS") {
    state.strokeColorSpace = normalizeColorSpaceName(tokens[index - 1], state.colorSpaceResolver);
    return;
  }

  if (token === "sc" || token === "scn") {
    const colorInfo = readColorFromOperator(tokens, index, token, state.fillColorSpace);
    state.fillColor = colorInfo.kind === "unknown" ? { kind: "unknown" } : colorInfo;
    return;
  }

  if (token === "SC" || token === "SCN") {
    const colorInfo = readColorFromOperator(tokens, index, token, state.strokeColorSpace);
    state.strokeColor = colorInfo.kind === "unknown" ? { kind: "unknown" } : colorInfo;
    return;
  }

  if (token === "gs") {
    state.fillColor = { kind: "unknown" };
    state.strokeColor = { kind: "unknown" };
    return;
  }

  if (
    FILL_PAINT_OPERATORS.has(token)
    || STROKE_PAINT_OPERATORS.has(token)
    || BOTH_PAINT_OPERATORS.has(token)
    || token === "n"
  ) {
    clearPathState(state);
  }
}

function tryRemoveRevealedCoverRectFill(tokens, reIndex, state, options) {
  if (reIndex < 4) {
    return null;
  }

  const rectArgs = readNumberArgs(tokens, reIndex, 4);
  if (rectArgs.some((value) => !Number.isFinite(value))) {
    return null;
  }

  let cursor = reIndex + 1;
  let fillColor = { ...state.fillColor };

  while (cursor < tokens.length) {
    const token = tokens[cursor];

    if (token === "rg") {
      const args = readNumberArgs(tokens, cursor, 3);
      fillColor = { kind: "rgb", r: args[0], g: args[1], b: args[2] };
      cursor += 1;
      continue;
    }

    if (token === "g") {
      const gray = readNumberArgs(tokens, cursor, 1)[0];
      fillColor = { kind: "gray", gray, r: gray, g: gray, b: gray };
      cursor += 1;
      continue;
    }

    if (token === "k") {
      const args = readNumberArgs(tokens, cursor, 4);
      const [c, m, y, kVal] = args;
      const r = (1 - c) * (1 - kVal);
      const g = (1 - m) * (1 - kVal);
      const b = (1 - y) * (1 - kVal);
      fillColor = { kind: "cmyk", c, m, y, k: kVal, r, g, b };
      cursor += 1;
      continue;
    }

    if (PURE_FILL_OPERATORS.has(token)) {
      const bbox = rectToBbox(rectArgs[0], rectArgs[1], rectArgs[2], rectArgs[3], state.ctm);
      if (shouldRemoveFill(bbox, fillColor, options)) {
        return { nextIndex: cursor + 1 };
      }
      return null;
    }

    if (isOperator(token)) {
      return null;
    }

    cursor += 1;
  }

  return null;
}

function shouldRemoveFill(bbox, fillColor, options) {
  if (!bbox || !fillColor || fillColor.kind === "unknown") {
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
  return Boolean(options.revealedCovers?.has(key));
}

function createTextBlockState(outerState) {
  const fillColor = cloneColorState(outerState.fillColor);
  const strokeColor = cloneColorState(outerState.strokeColor ?? { kind: "rgb", r: 0, g: 0, b: 0 });
  return {
    fillColor,
    strokeColor,
    lastKnownFillColor: fillColor.kind !== "unknown" ? fillColor : null,
    lastKnownStrokeColor: strokeColor.kind !== "unknown" ? strokeColor : null,
    fillColorSpace: outerState.fillColorSpace ?? "DeviceGray",
    strokeColorSpace: outerState.strokeColorSpace ?? "DeviceGray",
    colorSpaceResolver: outerState.colorSpaceResolver ?? null,
    textRenderingMode: 0,
  };
}

function recolorTextBlock(blockTokens, options, outerState) {
  const output = [];
  const state = createTextBlockState(outerState);

  for (let index = 0; index < blockTokens.length; ) {
    const token = blockTokens[index];

    if (FILL_COLOR_OPERATORS.has(token) || STROKE_COLOR_OPERATORS.has(token)) {
      const result = processColorOperatorInBlock(blockTokens, index, token, state, options);
      output.push(...result.output);
      index = result.nextIndex;
      continue;
    }

    if (token === "cs" || token === "CS") {
      const colorSpace = normalizeColorSpaceName(blockTokens[index - 1], state.colorSpaceResolver);
      if (token === "cs") {
        state.fillColorSpace = colorSpace;
      } else {
        state.strokeColorSpace = colorSpace;
      }
      output.push(blockTokens[index - 1], token);
      index += 1;
      continue;
    }

    if (token === "Tr") {
      state.textRenderingMode = Number(blockTokens[index - 1]);
      output.push(blockTokens[index - 1], token);
      index += 1;
      continue;
    }

    if (token === "gs") {
      state.fillColor = { kind: "unknown" };
      state.strokeColor = { kind: "unknown" };
      output.push(blockTokens[index - 1], token);
      index += 1;
      continue;
    }

    if (TEXT_SHOW_OPERATORS.has(token)) {
      injectRecoloredTextPaint(output, state, options);
      index = emitTextShowOperator(blockTokens, index, token, output);
      continue;
    }

    output.push(token);
    index += 1;
  }

  return output;
}

function processColorOperatorInBlock(tokens, operatorIndex, token, state, options) {
  const isStroke = STROKE_COLOR_OPERATORS.has(token);
  const colorSpace = isStroke ? state.strokeColorSpace : state.fillColorSpace;
  const colorInfo = readColorFromOperator(tokens, operatorIndex, token, colorSpace);
  const argCount = colorInfo.argCount ?? 0;
  const startIndex = operatorIndex - argCount;
  const threshold = isStroke ? getStrokeThreshold(options) : getFillThreshold(options);

  if (
    colorInfo.kind !== "unknown"
    && isNearWhite(colorInfo.r, colorInfo.g, colorInfo.b, threshold)
  ) {
    const target = hexToPdfRgb(options.textColor ?? "#dd1133");
    const outOp = isStroke ? "RG" : "rg";
    const recolored = { kind: "rgb", r: target[0], g: target[1], b: target[2] };
    if (isStroke) {
      state.strokeColor = recolored;
      state.lastKnownStrokeColor = recolored;
    } else {
      state.fillColor = recolored;
      state.lastKnownFillColor = recolored;
    }
    return {
      output: [
        formatNumber(target[0]),
        formatNumber(target[1]),
        formatNumber(target[2]),
        outOp,
      ],
      nextIndex: operatorIndex + 1,
    };
  }

  const output = tokens.slice(startIndex, operatorIndex + 1);
  if (colorInfo.kind !== "unknown") {
    if (isStroke) {
      state.strokeColor = colorInfo;
      state.lastKnownStrokeColor = colorInfo;
    } else {
      state.fillColor = colorInfo;
      state.lastKnownFillColor = colorInfo;
    }
  } else if (isStroke) {
    state.strokeColor = { kind: "unknown" };
  } else {
    state.fillColor = { kind: "unknown" };
  }

  return {
    output,
    nextIndex: operatorIndex + 1,
  };
}

function effectiveTextFillColor(state) {
  if (state.fillColor?.kind !== "unknown") {
    return state.fillColor;
  }
  return state.lastKnownFillColor ?? state.fillColor;
}

function effectiveTextStrokeColor(state) {
  if (state.strokeColor?.kind !== "unknown") {
    return state.strokeColor;
  }
  return state.lastKnownStrokeColor ?? state.strokeColor;
}

function injectRecoloredTextPaint(output, state, options) {
  const mode = state.textRenderingMode ?? 0;
  const usesFill = mode === 0 || mode === 2 || mode === 4 || mode === 6;
  const usesStroke = mode === 1 || mode === 2 || mode === 5 || mode === 6;
  const fillColor = effectiveTextFillColor(state);
  const strokeColor = effectiveTextStrokeColor(state);

  if (usesFill && shouldRecolorTextPaint(fillColor, getFillThreshold(options))) {
    pushTargetColor(output, options, "rg");
    const recolored = targetColorFromOptions(options);
    state.fillColor = recolored;
    state.lastKnownFillColor = recolored;
  }

  if (usesStroke && shouldRecolorTextPaint(strokeColor, getStrokeThreshold(options))) {
    pushTargetColor(output, options, "RG");
    const recolored = targetColorFromOptions(options);
    state.strokeColor = recolored;
    state.lastKnownStrokeColor = recolored;
  }
}

function shouldRecolorTextPaint(color, threshold) {
  return isNearWhiteColor(color, threshold);
}

function targetColorFromOptions(options) {
  const target = hexToPdfRgb(options.textColor ?? "#dd1133");
  return { kind: "rgb", r: target[0], g: target[1], b: target[2] };
}

function emitTextShowOperator(tokens, operatorIndex, token, output) {
  if (token === "Tj" || token === "TJ" || token === "'") {
    output.push(token);
    return operatorIndex + 1;
  }

  if (token === '"') {
    output.push(token);
    return operatorIndex + 1;
  }

  output.push(token);
  return operatorIndex + 1;
}

function getFillThreshold(options) {
  return options.whiteThreshold ?? 238;
}

function getStrokeThreshold(options) {
  const fillThreshold = getFillThreshold(options);
  if (options.strokeWhiteThreshold != null) {
    return Math.min(fillThreshold, options.strokeWhiteThreshold);
  }
  return Math.min(fillThreshold, STROKE_WHITE_THRESHOLD_CAP);
}

function isNearWhiteColor(color, threshold) {
  if (!color || color.kind === "unknown") {
    return false;
  }
  const { r, g, b } = normalizeColor(color);
  return isNearWhite(r, g, b, threshold);
}

function pushTargetColor(output, options, operator) {
  const target = hexToPdfRgb(options.textColor ?? "#dd1133");
  output.push(formatNumber(target[0]), formatNumber(target[1]), formatNumber(target[2]), operator);
}

function applyRecoloredColorToState(state, operator, options) {
  const target = hexToPdfRgb(options.textColor ?? "#dd1133");
  const color = { kind: "rgb", r: target[0], g: target[1], b: target[2] };
  if (STROKE_COLOR_OPERATORS.has(operator)) {
    state.strokeColor = color;
    return;
  }
  state.fillColor = color;
}

export function isBracketLikeBbox(bbox) {
  if (!bbox || !Number.isFinite(bbox.w) || !Number.isFinite(bbox.h)) {
    return false;
  }

  const w = Math.max(bbox.w, 0);
  const h = Math.max(bbox.h, 0);

  if (h >= MIN_BRACKET_EXTENT_PT && (h >= BRACKET_ASPECT_RATIO * Math.max(w, 1.5) || h >= 50)) {
    return true;
  }

  if (w >= MIN_BRACKET_EXTENT_PT && h >= 1.5 && w >= BRACKET_ASPECT_RATIO * Math.max(h, 1.5)) {
    return true;
  }

  return false;
}

function isThinSymbolBbox(bbox) {
  if (!bbox || !Number.isFinite(bbox.w) || !Number.isFinite(bbox.h)) {
    return false;
  }

  const w = bbox.w;
  const h = bbox.h;
  const area = w * h;

  if (area >= MAX_THIN_SYMBOL_AREA) {
    return false;
  }

  if (w < 3 || h < 3) {
    return area < SMALL_WHITE_ELEMENT_MAX_PDF_AREA;
  }

  const minDim = Math.min(w, h);
  const maxDim = Math.max(w, h);
  return minDim > 0
    && maxDim / minDim >= LINEAR_SYMBOL_ASPECT_RATIO
    && area < SMALL_WHITE_ELEMENT_MAX_PDF_AREA;
}

export function shouldRecolorNearWhiteStroke(bbox, lineWidth, options) {
  if (!bbox || !Number.isFinite(lineWidth)) {
    return false;
  }

  if (lineWidth > MAX_BRACKET_STROKE_LINE_WIDTH) {
    return false;
  }

  if (isPageBackgroundBbox(bbox, options)) {
    return false;
  }

  if (isWhiteCoverRect(bbox, options)) {
    return false;
  }

  if (isBracketLikeBbox(bbox)) {
    return true;
  }

  if (lineWidth <= MAX_SYMBOL_STROKE_LINE_WIDTH && isThinSymbolBbox(bbox)) {
    return true;
  }

  return false;
}

function shouldRecolorStrokeAtPaint(state, options) {
  if (!isNearWhiteColor(state.strokeColor, getStrokeThreshold(options))) {
    return false;
  }

  const rect = getPaintBbox(state);
  if (!rect) {
    return false;
  }

  return shouldRecolorNearWhiteStroke(rect, state.lineWidth ?? 1, options);
}

export function shouldRecolorNearWhiteFillPath(pathInfo, options) {
  const bbox = pathInfo?.bbox;
  if (!bbox || !Number.isFinite(bbox.w) || !Number.isFinite(bbox.h)) {
    return false;
  }

  if (isPageBackgroundBbox(bbox, options)) {
    return false;
  }

  if (pathInfo.isSimpleRectPath || pathInfo.rectCount > 0) {
    return false;
  }

  const area = bbox.w * bbox.h;
  if (area <= 0 || area > MAX_OUTLINE_SYMBOL_AREA) {
    return false;
  }

  if (pathInfo.hasCurve && isBracketLikeBbox(bbox)) {
    return true;
  }

  if (pathInfo.hasCurve && pathInfo.pathOps >= 3 && !isWhiteCoverRect(bbox, options)) {
    return true;
  }

  if (pathInfo.pathOps >= MIN_OUTLINE_SYMBOL_OPS && isBracketLikeBbox(bbox)) {
    return true;
  }

  return pathInfo.pathOps >= MIN_OUTLINE_SYMBOL_OPS
    && area < SMALL_WHITE_ELEMENT_MAX_PDF_AREA;
}

function shouldRecolorFillAtPaint(state, options) {
  if (!isNearWhiteColor(state.fillColor, getFillThreshold(options))) {
    return false;
  }

  return shouldRecolorNearWhiteFillPath(getPaintPathInfo(state), options);
}

function tryInjectRecolorBeforePaint(tokens, operatorIndex, token, state, options, output) {
  if (!STROKE_PAINT_OPERATORS.has(token)) {
    if (!FILL_PAINT_OPERATORS.has(token) || !shouldRecolorFillAtPaint(state, options)) {
      return false;
    }
    pushTargetColor(output, options, "rg");
    applyRecoloredColorToState(state, "rg", options);
    output.push(token);
    clearPathState(state);
    return true;
  }

  if (!shouldRecolorStrokeAtPaint(state, options)) {
    return false;
  }

  pushTargetColor(output, options, "RG");
  applyRecoloredColorToState(state, "RG", options);
  output.push(token);
  clearPathState(state);
  return true;
}

function newPathBBox() {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
}

function resetPathBBox(state) {
  state.pathBBox = newPathBBox();
  state.pathOps = 0;
  state.rectCount = 0;
  state.hasCurve = false;
}

function includePointInPathBBox(state, x, y) {
  if (!state.pathBBox) {
    resetPathBBox(state);
  }
  const point = applyMatrix(state.ctm, x, y);
  const bbox = state.pathBBox;
  bbox.minX = Math.min(bbox.minX, point.x);
  bbox.minY = Math.min(bbox.minY, point.y);
  bbox.maxX = Math.max(bbox.maxX, point.x);
  bbox.maxY = Math.max(bbox.maxY, point.y);
}

function includeRectInPathBBox(state, x, y, w, h) {
  includePointInPathBBox(state, x, y);
  includePointInPathBBox(state, x + w, y);
  includePointInPathBBox(state, x, y + h);
  includePointInPathBBox(state, x + w, y + h);
}

function pathBBoxToRect(bbox) {
  if (!bbox || !Number.isFinite(bbox.minX)) {
    return null;
  }
  return {
    x: bbox.minX,
    y: bbox.minY,
    w: bbox.maxX - bbox.minX,
    h: bbox.maxY - bbox.minY,
  };
}

function getPaintBbox(state) {
  if (state.lastRect) {
    return state.lastRect;
  }
  return pathBBoxToRect(state.pathBBox);
}

function getPaintPathInfo(state) {
  return {
    bbox: getPaintBbox(state),
    pathOps: state.pathOps ?? 0,
    rectCount: state.rectCount ?? 0,
    hasCurve: Boolean(state.hasCurve),
    isSimpleRectPath: Boolean(state.lastRect && state.rectCount === 1 && state.pathOps === 1),
  };
}

function clearPathState(state) {
  state.lastRect = null;
  state.pathBBox = null;
  state.pathOps = 0;
  state.rectCount = 0;
  state.hasCurve = false;
}

function isPageBackgroundBbox(bbox, options) {
  if (!bbox || !Number.isFinite(bbox.w) || !Number.isFinite(bbox.h)) {
    return false;
  }

  const area = bbox.w * bbox.h;
  const pageArea = options.pageArea ?? 0;
  if (pageArea > 0 && area / pageArea >= PAGE_BACKGROUND_AREA_RATIO) {
    return true;
  }

  const pageWidth = options.pageWidth ?? 0;
  const pageHeight = options.pageHeight ?? 0;
  if (pageWidth > 0 && pageHeight > 0) {
    if (bbox.w >= pageWidth * PAGE_BACKGROUND_AREA_RATIO
      && bbox.h >= pageHeight * PAGE_BACKGROUND_AREA_RATIO) {
      return true;
    }
  }

  return false;
}

function isWhiteCoverRect(bbox, options) {
  if (!bbox || !Number.isFinite(bbox.w) || !Number.isFinite(bbox.h)) {
    return false;
  }

  if (isPageBackgroundBbox(bbox, options)) {
    return false;
  }

  if (bbox.w < 3 || bbox.h < 3) {
    return false;
  }

  return true;
}

function tryPushRecoloredColorOperator(tokens, operatorIndex, token, options, output, state = null) {
  if (!FILL_COLOR_OPERATORS.has(token) && !STROKE_COLOR_OPERATORS.has(token)) {
    return false;
  }

  const blockState = createTextBlockState(state ?? createGraphicsState(0, 0));
  const result = processColorOperatorInBlock(tokens, operatorIndex, token, blockState, options);
  const colorInfo = readColorFromOperator(
    tokens,
    operatorIndex,
    token,
    STROKE_COLOR_OPERATORS.has(token) ? blockState.strokeColorSpace : blockState.fillColorSpace,
  );
  const original = tokens.slice(operatorIndex - (colorInfo.argCount ?? 0), operatorIndex + 1);
  if (result.output.join(" ") === original.join(" ")) {
    return false;
  }

  output.push(...result.output);
  if (state) {
    if (STROKE_COLOR_OPERATORS.has(token)) {
      state.strokeColor = blockState.strokeColor;
    } else {
      state.fillColor = blockState.fillColor;
    }
  }
  return true;
}

function normalizeDeviceColorSpaceName(name) {
  const normalized = String(name ?? "DeviceGray").replace(/^\//, "");
  if (normalized === "DeviceRGB" || normalized === "RGB") {
    return "DeviceRGB";
  }
  if (normalized === "DeviceCMYK" || normalized === "CMYK") {
    return "DeviceCMYK";
  }
  if (normalized === "DeviceGray" || normalized === "G") {
    return "DeviceGray";
  }
  return "unknown";
}

function normalizeColorSpaceName(name, resolver = null) {
  const direct = normalizeDeviceColorSpaceName(name);
  if (direct !== "unknown") {
    return direct;
  }
  return resolver ? resolver(name) : "unknown";
}

function readColorFromOperator(tokens, operatorIndex, token, colorSpace) {
  if (token === "rg" || token === "RG") {
    const args = readNumberArgs(tokens, operatorIndex, 3);
    return { kind: "rgb", r: args[0], g: args[1], b: args[2], argCount: 3 };
  }

  if (token === "g" || token === "G") {
    const gray = readNumberArgs(tokens, operatorIndex, 1)[0];
    return { kind: "gray", gray, r: gray, g: gray, b: gray, argCount: 1 };
  }

  if (token === "k" || token === "K") {
    const args = readNumberArgs(tokens, operatorIndex, 4);
    const [c, m, y, kVal] = args;
    const r = (1 - c) * (1 - kVal);
    const g = (1 - m) * (1 - kVal);
    const b = (1 - y) * (1 - kVal);
    return { kind: "cmyk", c, m, y, k: kVal, r, g, b, argCount: 4 };
  }

  if (token === "sc" || token === "SC") {
    return readScColor(tokens, operatorIndex, colorSpace);
  }

  if (token === "scn" || token === "SCN") {
    return readScnColor(tokens, operatorIndex, colorSpace);
  }

  return { kind: "unknown", argCount: 0 };
}

function readScColor(tokens, operatorIndex, colorSpace) {
  const resolvedSpace = colorSpace;
  if (resolvedSpace === "unknown") {
    return { kind: "unknown", argCount: 0 };
  }
  if (resolvedSpace === "DeviceRGB") {
    const args = readNumberArgs(tokens, operatorIndex, 3);
    return { kind: "rgb", r: args[0], g: args[1], b: args[2], argCount: 3 };
  }
  if (resolvedSpace === "DeviceCMYK") {
    const args = readNumberArgs(tokens, operatorIndex, 4);
    const [c, m, y, kVal] = args;
    const r = (1 - c) * (1 - kVal);
    const g = (1 - m) * (1 - kVal);
    const b = (1 - y) * (1 - kVal);
    return { kind: "cmyk", c, m, y, k: kVal, r, g, b, argCount: 4 };
  }
  const gray = readNumberArgs(tokens, operatorIndex, 1)[0];
  return { kind: "gray", gray, r: gray, g: gray, b: gray, argCount: 1 };
}

function readScnColor(tokens, operatorIndex, colorSpace) {
  const numericCount = countNumericArgsBeforeOperator(tokens, operatorIndex);
  let resolvedSpace = colorSpace;
  let argCount = 0;

  if (resolvedSpace === "DeviceRGB") {
    argCount = 3;
  } else if (resolvedSpace === "DeviceCMYK") {
    argCount = 4;
  } else if (resolvedSpace === "DeviceGray") {
    argCount = 1;
  } else if (numericCount === 1 || numericCount === 3 || numericCount === 4) {
    argCount = numericCount;
    if (argCount === 1) {
      resolvedSpace = "DeviceGray";
    } else if (argCount === 3) {
      resolvedSpace = "DeviceRGB";
    } else {
      resolvedSpace = "DeviceCMYK";
    }
  } else {
    return { kind: "unknown", argCount: 0 };
  }

  if (numericCount !== argCount) {
    return { kind: "unknown", argCount: 0 };
  }

  return readScColor(tokens, operatorIndex, resolvedSpace);
}

function countNumericArgsBeforeOperator(tokens, operatorIndex) {
  let count = 0;
  for (let index = operatorIndex - 1; index >= 0; index -= 1) {
    if (!isNumericToken(tokens[index])) {
      break;
    }
    count += 1;
  }
  return count;
}

function isNumericToken(token) {
  if (typeof token !== "string") {
    return false;
  }
  return Number.isFinite(Number(token));
}

function cloneColorState(color) {
  return color ? { ...color } : { kind: "unknown" };
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

    if (char === "/") {
      const name = readPdfName(source, index);
      tokens.push(name.value);
      index = name.nextIndex;
      continue;
    }

    const word = readWord(source, index);
    if (word.nextIndex <= index) {
      index += 1;
      continue;
    }
    tokens.push(word.value);
    index = word.nextIndex;

    if (word.value === "ID") {
      const inlineImage = readInlineImageSegment(source, index);
      tokens.push(inlineImage.value);
      index = inlineImage.nextIndex;
      continue;
    }
  }

  return tokens;
}

function isRawSegment(token) {
  return typeof token === "object" && token?.type === "raw";
}

function readInlineImageSegment(source, idIndex) {
  const pattern = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r ])/;
  const match = pattern.exec(source.slice(idIndex));
  if (!match) {
    return {
      value: { type: "raw", value: source.slice(idIndex) },
      nextIndex: source.length,
    };
  }
  const end = idIndex + match.index + match[0].length;
  return {
    value: { type: "raw", value: source.slice(idIndex, end) },
    nextIndex: end,
  };
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

function readPdfName(source, index) {
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (/[\0\t\n\f\r ]/.test(char) || "()[]<>/%#".includes(char)) {
      break;
    }
    cursor += 1;
  }
  return { value: source.slice(index, cursor), nextIndex: cursor };
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
  return tokens.slice(operatorIndex - count, operatorIndex).map((token) => Number(token));
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

function joinTokens(tokens) {
  let result = "";
  for (const token of tokens) {
    if (isRawSegment(token)) {
      if (result && !result.endsWith("\n") && !/[\0\t\n\f\r ]$/.test(result)) {
        result += " ";
      }
      result += token.value;
      continue;
    }
    result += result ? ` ${token}` : token;
  }
  return `${result}\n`;
}

function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrix(left, right) {
  const rightMatrix = Array.isArray(right)
    ? { a: right[0], b: right[1], c: right[2], d: right[3], e: right[4], f: right[5] }
    : right;
  const { a, b, c, d, e, f } = rightMatrix;
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

function cloneGraphicsState(state) {
  return {
    pageWidth: state.pageWidth,
    pageHeight: state.pageHeight,
    ctm: { ...state.ctm },
    stack: [],
    fillColor: cloneColorState(state.fillColor),
    strokeColor: cloneColorState(state.strokeColor),
    colorSpaceResolver: state.colorSpaceResolver,
    fillColorSpace: state.fillColorSpace,
    strokeColorSpace: state.strokeColorSpace,
    lastRect: state.lastRect ? { ...state.lastRect } : null,
    pathBBox: state.pathBBox ? { ...state.pathBBox } : null,
    lineWidth: state.lineWidth ?? 1,
    pathOps: state.pathOps ?? 0,
    rectCount: state.rectCount ?? 0,
    hasCurve: Boolean(state.hasCurve),
  };
}

function restoreGraphicsState(state, saved) {
  state.ctm = saved.ctm;
  state.fillColor = saved.fillColor;
  state.strokeColor = saved.strokeColor;
  state.colorSpaceResolver = saved.colorSpaceResolver;
  state.fillColorSpace = saved.fillColorSpace;
  state.strokeColorSpace = saved.strokeColorSpace;
  state.lastRect = saved.lastRect;
  state.pathBBox = saved.pathBBox;
  state.lineWidth = saved.lineWidth ?? 1;
  state.pathOps = saved.pathOps ?? 0;
  state.rectCount = saved.rectCount ?? 0;
  state.hasCurve = Boolean(saved.hasCurve);
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

export const __test__ = {
  tokenizeContentStream,
  transformContentBytes,
  tryRemoveRevealedCoverRectFill,
  tryPushRecoloredColorOperator,
  tryInjectRecolorBeforePaint,
  makeCoverKey,
  needsContentStreamTransform,
  isPageBackgroundBbox,
  isBracketLikeBbox,
  shouldRecolorNearWhiteFillPath,
  shouldRecolorNearWhiteStroke,
  shouldRecolorStrokeAtPaint,
  createGraphicsState,
};
