import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";
import {
  __test__,
  makeCoverKey,
  needsContentStreamTransform,
  transformPdfContent,
} from "./pdf-content-transform.node.mjs";

const {
  tokenizeContentStream,
  transformContentBytes,
  tryPushRecoloredColorOperator,
} = __test__;

const TARGET_RGB = "0.867 0.067 0.2";

function countOperators(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    if (typeof token === "object") {
      continue;
    }
    if (["f", "F", "f*", "S", "s", "Do", "re", "m", "l", "sh", "gs", "W", "n", "BT", "ET", "Tj", "TJ"].includes(token)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

async function loadPageTokens(pdfDoc, pageIndex = 0) {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const page = pdfDoc.getPages()[pageIndex];
  const context = pdfDoc.context;
  const { PDFName } = await import("pdf-lib");
  const contentsRef = page.node.get(PDFName.of("Contents"));
  const contents = context.lookup(contentsRef);
  const refs = contents instanceof PDFArray
    ? contents.asArray()
    : [contentsRef];
  const tokens = [];
  for (const ref of refs) {
    const stream = context.lookupMaybe(ref, PDFRawStream);
    if (!stream) {
      continue;
    }
    tokens.push(...tokenizeContentStream(decodePDFRawStream(stream).decode()));
  }
  return tokens;
}

function assertOperatorCounts(label, before, after, expected) {
  for (const [op, count] of Object.entries(expected)) {
    const afterCount = after.get(op) ?? 0;
    if (afterCount !== count) {
      throw new Error(
        `${label}: operator ${op} expected ${count}, got ${afterCount} (before: ${before.get(op) ?? 0})`,
      );
    }
  }
}

async function makeSamplePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  page.drawRectangle({
    x: 100,
    y: 600,
    width: 200,
    height: 40,
    color: rgb(1, 1, 1),
    borderWidth: 0,
  });

  page.drawText("Hidden answer", {
    x: 110,
    y: 615,
    size: 14,
    font,
    color: rgb(0.95, 0.95, 0.95),
  });

  page.drawText("Visible title", {
    x: 72,
    y: 720,
    size: 24,
    font,
    color: rgb(0, 0, 0),
  });

  return new Uint8Array(await doc.save());
}

async function makeGraphicsPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  page.drawRectangle({
    x: 80,
    y: 500,
    width: 120,
    height: 80,
    borderColor: rgb(0, 0, 0),
    borderWidth: 2,
    color: rgb(0.9, 0.2, 0.2),
  });

  page.drawLine({
    start: { x: 250, y: 520 },
    end: { x: 400, y: 600 },
    thickness: 3,
    color: rgb(0, 0.4, 0.8),
  });

  page.drawText("Chart label", {
    x: 250,
    y: 480,
    size: 16,
    font,
    color: rgb(0, 0, 0),
  });

  const pngBytes = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkHAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const image = await doc.embedPng(pngBytes);
  page.drawImage(image, { x: 450, y: 500, width: 48, height: 48 });

  page.drawRectangle({
    x: 100,
    y: 650,
    width: 180,
    height: 35,
    color: rgb(1, 1, 1),
    borderWidth: 0,
  });

  return new Uint8Array(await doc.save());
}

async function makeIccBasedColorSpacePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const context = doc.context;
  const iccStream = context.flateStream(Uint8Array.from([0]), {
    N: 3,
    Alternate: PDFName.of("DeviceRGB"),
  });
  const iccRef = context.register(iccStream);
  const content = new TextEncoder().encode(
    "/Cs1 cs 1 1 1 sc BT /F1 12 Tf 72 720 Td (ICCBased white) Tj ET\n",
  );
  const contentRef = context.register(context.flateStream(content));

  page.node.set(PDFName.of("Resources"), context.obj({
    ColorSpace: {
      Cs1: [PDFName.of("ICCBased"), iccRef],
    },
  }));
  page.node.set(PDFName.of("Contents"), contentRef);

  return new Uint8Array(await doc.save());
}

async function testVectorExport(label, pdfBytes, options = {}) {
  console.log(`\n=== ${label} ===`);
  try {
    const beforeDoc = await PDFDocument.load(pdfBytes.slice());
    const beforeTokens = await loadPageTokens(beforeDoc, 0);
    const beforeCounts = countOperators(beforeTokens);

    const transformOptions = {
      whiteThreshold: 238,
      revealedCovers: options.revealedCovers ?? new Set(),
      recolorText: options.recolorText ?? false,
      textColor: "#dd1133",
    };

    if (!needsContentStreamTransform(transformOptions) && !options.textEdits?.length && !options.imagePlacements?.length) {
      console.log("OK: fast path (no content stream rewrite)");
      return pdfBytes;
    }

    const outDoc = await PDFDocument.load(pdfBytes.slice());
    await transformPdfContent(outDoc, transformOptions);

    if (options.textEdits?.length) {
      const helvetica = await outDoc.embedFont(StandardFonts.Helvetica);
      for (const edit of options.textEdits) {
        const page = outDoc.getPage(edit.pageNumber - 1);
        page.drawRectangle({
          x: edit.x - 1,
          y: edit.y - 1,
          width: edit.width + 2,
          height: edit.height + 2,
          color: rgb(1, 1, 1),
        });
        page.drawText(edit.newText, {
          x: edit.baselineX ?? edit.x,
          y: edit.baselineY ?? edit.y,
          size: edit.fontSize,
          font: helvetica,
          color: rgb(0, 0, 0),
        });
      }
    }

    if (options.imagePlacements?.length) {
      for (const placement of options.imagePlacements) {
        const page = outDoc.getPage(placement.pageNumber - 1);
        const embeddedImage = await outDoc.embedPng(placement.imageBytes);
        page.drawImage(embeddedImage, {
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
        });
      }
    }

    const afterDoc = await PDFDocument.load(new Uint8Array(await outDoc.save()));
    const afterTokens = await loadPageTokens(afterDoc, 0);
    const afterCounts = countOperators(afterTokens);

    if (options.expectOperatorCounts) {
      assertOperatorCounts(label, beforeCounts, afterCounts, options.expectOperatorCounts);
    } else if (!options.allowCoverRemoval) {
      for (const [op, count] of beforeCounts) {
        if (op === "f" || op === "F" || op === "f*") {
          continue;
        }
        const afterCount = afterCounts.get(op) ?? 0;
        if (afterCount < count) {
          throw new Error(`${label}: lost ${count - afterCount} '${op}' operator(s)`);
        }
      }
    }

    const bytes = await outDoc.save();
    console.log(`OK: saved ${bytes.length} bytes`);
    return bytes;
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    console.error(error);
    throw error;
  }
}

async function testMerge(baseBytes, appendBytes) {
  const baseDoc = await PDFDocument.load(baseBytes.slice());
  const appendDoc = await PDFDocument.load(appendBytes);
  const copiedPages = await baseDoc.copyPages(appendDoc, appendDoc.getPageIndices());
  for (const page of copiedPages) {
    baseDoc.addPage(page);
  }
  return new Uint8Array(await baseDoc.save());
}

function makeTinyPng() {
  return Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
}

async function testStreamPassthroughIntegrity() {
  const source = "1 0 0 1 0 0 cm 10 20 m 100 200 l 2 w 0 0 0 RG 1 0 0 S q 50 60 re 1 1 1 rg f Q /Img1 Do\n";
  const bytes = new TextEncoder().encode(source);
  const transformed = transformContentBytes(bytes, {
    whiteThreshold: 238,
    revealedCovers: new Set(),
    recolorText: false,
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  });
  const out = new TextDecoder("latin1").decode(transformed).trim();
  const normalized = source.trim();
  if (out !== normalized) {
    throw new Error(`Passthrough rewrite changed stream:\n  in:  ${normalized}\n  out: ${out}`);
  }
  console.log("OK: complex path/stroke/Do stream preserved byte-for-byte");
}

async function testCoverRemovalOnlyWhenRevealed() {
  const bytes = new TextEncoder().encode("100 600 200 40 re 1 1 1 rg f 72 720 Td (Hi) Tj\n");
  const key = makeCoverKey(1, { x: 100, y: 600, w: 200, h: 40 });
  const untouched = transformContentBytes(bytes, {
    whiteThreshold: 238,
    revealedCovers: new Set(),
    recolorText: false,
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  });
  if (new TextDecoder("latin1").decode(untouched).includes(" re ") === false) {
    throw new Error("Cover rect removed without explicit reveal");
  }

  const removed = transformContentBytes(bytes, {
    whiteThreshold: 238,
    revealedCovers: new Set([key]),
    recolorText: false,
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  });
  const removedText = new TextDecoder("latin1").decode(removed);
  if (removedText.includes(" re ") || removedText.includes(" f")) {
    throw new Error("Revealed cover rect was not removed");
  }
  if (!removedText.includes("Tj")) {
    throw new Error("Text operator lost during cover removal");
  }
  console.log("OK: cover removal is strict to revealed keys");
}

async function testSmallNestedCoverRemoval() {
  const baseOptions = {
    whiteThreshold: 238,
    revealedCovers: new Set(),
    recolorText: false,
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  };

  const bytes = new TextEncoder().encode(
    "100 600 200 40 re 1 1 1 rg f 150 610 30 20 re 1 1 1 rg f\n",
  );
  const largeKey = makeCoverKey(1, { x: 100, y: 600, w: 200, h: 40 });
  const smallKey = makeCoverKey(1, { x: 150, y: 610, w: 30, h: 20 });

  const removeSmallOnly = transformContentBytes(bytes, {
    ...baseOptions,
    revealedCovers: new Set([smallKey]),
  });
  const removeSmallText = new TextDecoder("latin1").decode(removeSmallOnly);
  if (!removeSmallText.includes("100 600 200 40 re")) {
    throw new Error("Large cover removed when only small cover was revealed");
  }
  if (removeSmallText.includes("150 610 30 20 re")) {
    throw new Error("Revealed small nested cover was not removed");
  }

  const removeBoth = transformContentBytes(bytes, {
    ...baseOptions,
    revealedCovers: new Set([largeKey, smallKey]),
  });
  const removeBothText = new TextDecoder("latin1").decode(removeBoth);
  if (removeBothText.includes(" re ") || removeBothText.includes(" f")) {
    throw new Error("Revealed nested covers were not both removed");
  }

  console.log("OK: small nested white cover rects remove independently");
}

async function testRecolorOperators() {
  const options = { textColor: "#dd1133", whiteThreshold: 238 };
  const output = [];
  const tokens = ["1", "1", "1", "RG", "0", "0", "0", "rg"];
  let index = 3;
  if (!tryPushRecoloredColorOperator(tokens, index, "RG", options, output)) {
    throw new Error("Expected white RG to be recolored");
  }
  if (output.length !== 4 || output[3] !== "RG") {
    throw new Error(`Unexpected RG recolor output: ${output.join(" ")}`);
  }

  const transformed = transformContentBytes(
    new TextEncoder().encode("BT 1 1 1 rg 1 1 1 RG (()) Tj ET\n"),
    {
    whiteThreshold: 238,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  });
  const text = new TextDecoder("latin1").decode(transformed);
  if (text.includes("1 1 1 rg") || text.includes("1 1 1 RG")) {
    throw new Error(`Recolored text block still contains near-white operators: ${text}`);
  }
  if (!text.includes("Tj")) {
    throw new Error("Text operator lost during recolor");
  }
  console.log("OK: stroke/fill color operators recolored without duplicate operands");
}

async function testRedHighlightWhiteText() {
  const opts = {
    whiteThreshold: 238,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  };

  const cases = [
    {
      label: "white rg inside BT on red rect",
      source: "100 600 200 40 re 0.9 0.1 0.1 rg f BT 1 1 1 rg /F1 12 Tf 110 615 Td (Hi) Tj ET\n",
      mustInclude: "0.867 0.067 0.2 rg",
      mustNotInclude: "1 1 1 rg",
    },
    {
      label: "white color inherited from q block before BT",
      source: "100 600 200 40 re 0.9 0.1 0.1 rg f q 1 1 1 rg BT /F1 12 Tf 110 615 Td (Hi) Tj ET Q\n",
      mustInclude: "0.867 0.067 0.2 rg",
      mustNotInclude: null,
    },
    {
      label: "DeviceGray sc white text",
      source: "100 600 200 40 re 0.9 0.1 0.1 rg f q BT 1 sc /F1 12 Tf 110 615 Td (Hi) Tj ET Q\n",
      mustInclude: "0.867 0.067 0.2 rg",
      mustNotInclude: "1 sc",
    },
  ];

  for (const testCase of cases) {
    const transformed = transformContentBytes(new TextEncoder().encode(testCase.source), opts);
    const text = new TextDecoder("latin1").decode(transformed);
    if (!text.includes(testCase.mustInclude)) {
      throw new Error(`${testCase.label}: expected ${testCase.mustInclude} in ${text}`);
    }
    if (testCase.mustNotInclude && text.includes(testCase.mustNotInclude)) {
      throw new Error(`${testCase.label}: still contains ${testCase.mustNotInclude}: ${text}`);
    }
  }

  console.log("OK: red highlight + white text streams recolored for visibility");
}

async function testPathStrokeRecolorOnly() {
  const baseOptions = {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  };

  const strokeStream = transformContentBytes(
    new TextEncoder().encode("0.92 G 0 0 m 10 0 l S\n"),
    baseOptions,
  );
  const strokeText = new TextDecoder("latin1").decode(strokeStream);
  if (!strokeText.includes(`${TARGET_RGB} RG S`)) {
    throw new Error(`Expected near-white path stroke to be recolored before S: ${strokeText}`);
  }

  const bracketStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 RG 0 0 m 0 0 l 0 50 l S\n"),
    baseOptions,
  );
  const bracketText = new TextDecoder("latin1").decode(bracketStream);
  if (!bracketText.includes(`${TARGET_RGB} RG S`)) {
    throw new Error(`Expected white bracket stroke to be recolored before S: ${bracketText}`);
  }

  const thickStrokeStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 RG 3 w 0 0 m 0 0 l 0 50 l S\n"),
    baseOptions,
  );
  const thickStrokeText = new TextDecoder("latin1").decode(thickStrokeStream);
  if (!thickStrokeText.includes(`${TARGET_RGB} RG`)) {
    throw new Error(`Thick white bracket stroke should be recolored: ${thickStrokeText}`);
  }

  const thickBorderStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 RG 3 w 0 0 m 200 0 l 400 0 l S\n"),
    baseOptions,
  );
  const thickBorderText = new TextDecoder("latin1").decode(thickBorderStream);
  if (thickBorderText.includes(`${TARGET_RGB} RG`)) {
    throw new Error(`Wide horizontal border stroke should not be recolored: ${thickBorderText}`);
  }

  const longThinFillStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 rg 0 100 612 2 re f\n"),
    baseOptions,
  );
  const longThinFillText = new TextDecoder("latin1").decode(longThinFillStream);
  if (longThinFillText.includes(`${TARGET_RGB} rg`)) {
    throw new Error(`Long thin white fill bar must not be recolored: ${longThinFillText}`);
  }

  const fractionStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 rg 10 10 100 1 re f\n"),
    baseOptions,
  );
  const fractionText = new TextDecoder("latin1").decode(fractionStream);
  if (fractionText.includes(`${TARGET_RGB} rg`)) {
    throw new Error(`White fill paths must not be recolored at paint time: ${fractionText}`);
  }

  const coverStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 rg 100 600 200 40 re f\n"),
    baseOptions,
  );
  const coverText = new TextDecoder("latin1").decode(coverStream);
  if (!coverText.includes("1 1 1 rg") || !coverText.includes(" re f")) {
    throw new Error(`Large white cover rect should remain untouched: ${coverText}`);
  }

  const pageBackgroundStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 rg 0 0 612 792 re f\n"),
    baseOptions,
  );
  const pageBackgroundText = new TextDecoder("latin1").decode(pageBackgroundStream);
  if (pageBackgroundText.includes(TARGET_RGB)) {
    throw new Error(`Full-page white background must stay white: ${pageBackgroundText}`);
  }
  if (!pageBackgroundText.includes("1 1 1 rg") || !pageBackgroundText.includes(" re f")) {
    throw new Error(`Full-page white background fill was altered: ${pageBackgroundText}`);
  }

  console.log("OK: bracket and thin path strokes recolored; fills and page background preserved");
}

async function testIccBasedRgbColorSpaceRecolor() {
  const bytes = await makeIccBasedColorSpacePdf();
  const outDoc = await PDFDocument.load(bytes.slice());
  await transformPdfContent(outDoc, {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
  });
  const afterTokens = await loadPageTokens(outDoc, 0);
  const afterText = afterTokens.join(" ");
  if (!afterText.includes(`${TARGET_RGB} rg`)) {
    throw new Error(`ICCBased /Cs1 white text was not recolored: ${afterText}`);
  }
  const tjIndex = afterText.indexOf("Tj");
  const beforeTj = afterText.slice(0, tjIndex);
  if (!beforeTj.includes(`${TARGET_RGB} rg`)) {
    throw new Error(`ICCBased text show is not preceded by target color: ${afterText}`);
  }
  console.log("OK: ICCBased N=3 /Cs1 color space resolves to RGB for white text");
}

async function testWhiteOutlineFillRecolor() {
  const opts = {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  };

  const outlineStream = transformContentBytes(
    new TextEncoder().encode(
      "1 1 1 rg 10 10 m 12 10 12 40 10 40 c 8 40 8 10 10 10 c h f*\n",
    ),
    opts,
  );
  const outlineText = new TextDecoder("latin1").decode(outlineStream);
  if (!outlineText.includes(`${TARGET_RGB} rg f*`)) {
    throw new Error(`White outline fill bracket was not recolored before f*: ${outlineText}`);
  }

  const rectCoverStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 rg 100 600 200 40 re f 1 1 1 rg 0 0 612 792 re f\n"),
    opts,
  );
  const rectCoverText = new TextDecoder("latin1").decode(rectCoverStream);
  if (rectCoverText.includes(`${TARGET_RGB} rg f`)) {
    throw new Error(`White cover/background rectangle was recolored: ${rectCoverText}`);
  }
  if (!rectCoverText.includes("100 600 200 40 re f") || !rectCoverText.includes("0 0 612 792 re f")) {
    throw new Error(`White cover/background rectangle was altered: ${rectCoverText}`);
  }

  console.log("OK: white f* outline symbols recolor while white covers/backgrounds stay white");
}

async function testFormInheritedWhiteTextRecolor() {
  const formBytes = new TextEncoder().encode("BT /F1 12 Tf 10 20 Td (Hidden) Tj ET\n");
  const pageBytes = new TextEncoder().encode("1 1 1 rg /Fm0 Do\n");
  const formResolver = (nameToken) => {
    if (nameToken !== "/Fm0") {
      return null;
    }
    return {
      bytes: formBytes,
      width: 200,
      height: 200,
      nestedFormResolver: () => null,
    };
  };

  const transformed = transformContentBytes(pageBytes, {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
    formResolver,
  });
  const text = new TextDecoder("latin1").decode(transformed);
  if (!text.includes(`${TARGET_RGB} rg`)) {
    throw new Error(`Expected inherited white form text to be recolored: ${text}`);
  }
  const inlinedSegment = text.slice(text.indexOf("q"));
  if (inlinedSegment.includes("1 1 1 rg") && inlinedSegment.includes("Tj")) {
    throw new Error(`Form text still uses near-white fill before Tj: ${text}`);
  }
  if (text.includes("/Fm0 Do")) {
    throw new Error(`Expected Form XObject to be inlined during recolor: ${text}`);
  }
  console.log("OK: inherited white text in Form XObject recolored at Do inline");
}

async function testFormInheritedWhiteStrokeRecolor() {
  const formBytes = new TextEncoder().encode("0 0 m 0 50 l S\n");
  const pageBytes = new TextEncoder().encode("1 1 1 RG /Fm0 Do\n");
  const formResolver = (nameToken) => {
    if (nameToken !== "/Fm0") {
      return null;
    }
    return {
      bytes: formBytes,
      width: 20,
      height: 50,
      nestedFormResolver: () => null,
    };
  };

  const transformed = transformContentBytes(pageBytes, {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
    formResolver,
  });
  const text = new TextDecoder("latin1").decode(transformed);
  if (!text.includes(`${TARGET_RGB} RG S`)) {
    throw new Error(`Expected inherited white bracket stroke to be recolored: ${text}`);
  }
  console.log("OK: inherited white matrix stroke in Form XObject recolored");
}

async function testPathBackgroundPreserved() {
  const opts = {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  };

  const cases = [
    "1 1 1 rg 0 0 612 792 re f",
    "0 0 612 792 re 1 1 1 rg f",
    "q 1 1 1 rg 0 0 612 792 re f Q",
    "1 1 1 rg 0 0 m 612 0 l 612 792 l 0 792 l h f",
  ];

  for (const source of cases) {
    const transformed = transformContentBytes(new TextEncoder().encode(source), opts);
    const text = new TextDecoder("latin1").decode(transformed);
    if (text.includes(`${TARGET_RGB} rg f`) || text.includes(`${TARGET_RGB} rg F`)) {
      throw new Error(`Page background was recolored for stream: ${source}\n${text}`);
    }
    if (!text.includes("1 1 1 rg")) {
      throw new Error(`Page background white operator missing for stream: ${source}\n${text}`);
    }
  }

  console.log("OK: full-page and path-based white backgrounds stay white");
}

async function testWhiteTextVisibleBeforeTj() {
  const opts = {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  };

  const gsStream = transformContentBytes(
    new TextEncoder().encode(
      "100 600 200 40 re 0.9 0.1 0.1 rg f BT q 1 1 1 rg /Gs1 gs /F1 12 Tf 110 615 Td (Hi) Tj ET Q\n",
    ),
    opts,
  );
  const gsText = new TextDecoder("latin1").decode(gsStream);
  const tjIndex = gsText.indexOf("Tj");
  if (tjIndex === -1) {
    throw new Error(`Expected Tj in gs stream: ${gsText}`);
  }
  const beforeTj = gsText.slice(0, tjIndex);
  if (!beforeTj.includes(`${TARGET_RGB} rg`)) {
    throw new Error(`White text after gs was not recolored before Tj: ${gsText}`);
  }

  const backgroundStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 rg 0 0 612 792 re f BT 1 1 1 rg /F1 12 Tf 72 720 Td (Hi) Tj ET\n"),
    opts,
  );
  const backgroundText = new TextDecoder("latin1").decode(backgroundStream);
  if (backgroundText.includes(`${TARGET_RGB} rg f`)) {
    throw new Error(`Background recolored alongside text stream: ${backgroundText}`);
  }
  const textTjIndex = backgroundText.indexOf("Tj");
  if (!backgroundText.slice(0, textTjIndex).includes(`${TARGET_RGB} rg`)) {
    throw new Error(`White text on preserved background missing recolor before Tj: ${backgroundText}`);
  }

  console.log("OK: white text recolored before Tj without touching page background");
}

async function testBracketStrokeRecolor() {
  const baseOptions = {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  };

  const bracketStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 RG 2 w 10 20 m 10 80 l S 100 20 m 130 20 l 130 80 l S\n"),
    baseOptions,
  );
  const bracketText = new TextDecoder("latin1").decode(bracketStream);
  if (!bracketText.includes(`${TARGET_RGB} RG S`)) {
    throw new Error(`Expected matrix bracket strokes to be recolored before S: ${bracketText}`);
  }
  if ((bracketText.match(/\bS\b/g) ?? []).length < 2) {
    throw new Error(`Expected both bracket strokes to remain in stream: ${bracketText}`);
  }

  console.log("OK: matrix bracket strokes recolored before S");
}

async function testStrokeTextRecolor() {
  const opts = {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    pageArea: 612 * 792,
  };

  const strokeTextStream = transformContentBytes(
    new TextEncoder().encode("BT 1 Tr 1 1 1 RG /F1 12 Tf 72 720 Td (Hi) Tj ET\n"),
    opts,
  );
  const strokeText = new TextDecoder("latin1").decode(strokeTextStream);
  const tjIndex = strokeText.indexOf("Tj");
  if (tjIndex === -1) {
    throw new Error(`Expected Tj in stroke text stream: ${strokeText}`);
  }
  const beforeTj = strokeText.slice(0, tjIndex);
  if (!beforeTj.includes(`${TARGET_RGB} RG`)) {
    throw new Error(`Stroke-only white text was not recolored before Tj: ${strokeText}`);
  }
  if (beforeTj.includes("1 1 1 RG")) {
    throw new Error(`Stroke-only white text still has near-white RG before Tj: ${strokeText}`);
  }

  const dualModeStream = transformContentBytes(
    new TextEncoder().encode("BT 2 Tr 1 1 1 rg 1 1 1 RG /F1 12 Tf 72 700 Td (Hi) Tj ET\n"),
    opts,
  );
  const dualModeText = new TextDecoder("latin1").decode(dualModeStream);
  const dualTjIndex = dualModeText.indexOf("Tj");
  const dualBeforeTj = dualModeText.slice(0, dualTjIndex);
  if (!dualBeforeTj.includes(`${TARGET_RGB} rg`) || !dualBeforeTj.includes(`${TARGET_RGB} RG`)) {
    throw new Error(`Fill+stroke white text missing both recolors before Tj: ${dualModeText}`);
  }

  console.log("OK: stroke and fill+stroke white text recolored before Tj");
}

async function testRecolorOnlyTransformRuns() {
  const sampleBytes = await makeSamplePdf();
  const beforeDoc = await PDFDocument.load(sampleBytes.slice());
  const beforeText = new TextDecoder("latin1").decode(new Uint8Array(await beforeDoc.save()));

  const outDoc = await PDFDocument.load(sampleBytes.slice());
  await transformPdfContent(outDoc, {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
  });
  const afterTokens = await loadPageTokens(outDoc, 0);
  const afterText = afterTokens.join(" ");

  if (!needsContentStreamTransform({ recolorText: true, revealedCovers: new Set() })) {
    throw new Error("recolorText must force content stream transform");
  }
  if (!afterText.includes(`${TARGET_RGB} rg`)) {
    throw new Error(`Recolor-only export missing target rgb in stream: ${afterText}`);
  }
  const hiddenAnswerIndex = afterText.indexOf("<48696464656E20616E73776572> Tj");
  if (hiddenAnswerIndex === -1) {
    throw new Error(`Recolor-only export missing hidden answer text operator: ${afterText}`);
  }
  const beforeHidden = afterText.slice(0, hiddenAnswerIndex);
  if (!beforeHidden.includes(`${TARGET_RGB} rg`)) {
    throw new Error(`Hidden answer text was not recolored before Tj: ${afterText}`);
  }
  if (afterText === beforeText) {
    throw new Error("Recolor-only export left page stream unchanged");
  }
  console.log("OK: recolorText alone rewrites streams without cover reveal");
}

async function main() {
  await testRecolorOperators();
  await testRedHighlightWhiteText();
  await testPathStrokeRecolorOnly();
  await testIccBasedRgbColorSpaceRecolor();
  await testWhiteOutlineFillRecolor();
  await testPathBackgroundPreserved();
  await testWhiteTextVisibleBeforeTj();
  await testBracketStrokeRecolor();
  await testStrokeTextRecolor();
  await testFormInheritedWhiteTextRecolor();
  await testFormInheritedWhiteStrokeRecolor();
  await testRecolorOnlyTransformRuns();
  await testStreamPassthroughIntegrity();
  await testCoverRemovalOnlyWhenRevealed();
  await testSmallNestedCoverRemoval();

  const sampleBytes = await makeSamplePdf();
  writeFileSync("scripts/sample-test.pdf", sampleBytes);

  await testVectorExport("Simple PDF, no edits", sampleBytes);
  await testVectorExport("No transform when idle", sampleBytes, {
    allowCoverRemoval: true,
  });

  const coverKey = makeCoverKey(1, { x: 100, y: 600, w: 200, h: 40 });
  await testVectorExport("Reveal one cover", sampleBytes, {
    revealedCovers: new Set([coverKey]),
    allowCoverRemoval: true,
  });

  await testVectorExport("Recolor text", sampleBytes, {
    recolorText: true,
    revealedCovers: new Set([coverKey]),
  });

  await testVectorExport("Text edit on page 1", sampleBytes, {
    textEdits: [
      {
        pageNumber: 1,
        x: 72,
        y: 700,
        width: 200,
        height: 30,
        baselineX: 72,
        baselineY: 720,
        fontSize: 24,
        newText: "Edited title",
      },
    ],
  });

  const pngBytes = makeTinyPng();
  await testVectorExport("Image placement", sampleBytes, {
    imagePlacements: [
      {
        pageNumber: 1,
        x: 100,
        y: 100,
        width: 50,
        height: 50,
        imageBytes: pngBytes,
        mimeType: "image/png",
      },
    ],
  });

  const graphicsBytes = await makeGraphicsPdf();
  await testVectorExport("Graphics PDF unchanged without reveals", graphicsBytes);

  const mergedBytes = await testMerge(sampleBytes, sampleBytes);
  await testVectorExport("Merged PDF", mergedBytes, {
    revealedCovers: new Set([coverKey, makeCoverKey(2, { x: 100, y: 600, w: 200, h: 40 })]),
    allowCoverRemoval: true,
  });

  const mozillaPath = "scripts/mozilla-sample.pdf";
  try {
    const mozillaBytes = readFileSync(mozillaPath);
    await testVectorExport("Mozilla sample PDF passthrough", mozillaBytes);
    console.log(`OK: ${mozillaPath} stream integrity`);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`Skip: ${mozillaPath} not found`);
    } else {
      throw error;
    }
  }

  console.log("\nAll tests passed.");
}

main().catch((error) => {
  console.error("\nTest suite failed:", error?.message ?? error);
  if (error?.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
