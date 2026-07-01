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

async function testThinInheritedCoverRemoval() {
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
    "1 1 1 rg 209.2 222.4879 8 1 re f* q BT /F1 12 Tf 110 615 Td (Hi) Tj ET Q\n",
  );
  const key = makeCoverKey(1, { x: 209.2, y: 222.5, w: 8, h: 1 });

  const removed = transformContentBytes(bytes, {
    ...baseOptions,
    revealedCovers: new Set([key]),
  });
  const removedText = new TextDecoder("latin1").decode(removed);
  if (removedText.includes("209.2 222.4879 8 1 re")) {
    throw new Error("Thin inherited-color cover was not removed");
  }
  if (!removedText.includes("Tj")) {
    throw new Error("Text operator lost when removing thin inherited cover");
  }

  console.log("OK: thin re f* covers with inherited sc color remove when revealed");
}

async function testPathBasedCoverRemoval() {
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
    "1 1 1 rg 100 600 m 300 600 l 300 640 l 100 640 l h f 72 720 Td (Hi) Tj\n",
  );
  const key = makeCoverKey(1, { x: 100, y: 600, w: 200, h: 40 });

  const removed = transformContentBytes(bytes, {
    ...baseOptions,
    revealedCovers: new Set([key]),
  });
  const removedText = new TextDecoder("latin1").decode(removed);
  if (removedText.includes(" 600 m ") || removedText.includes(" h f")) {
    throw new Error("Path-based white cover was not removed");
  }
  if (!removedText.includes("Tj")) {
    throw new Error("Text operator lost during path-based cover removal");
  }

  console.log("OK: path-based white cover fills remove when revealed");
}

async function testNestedPathAndRectCoverRemoval() {
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
    "1 1 1 rg 100 600 m 300 600 l 300 640 l 100 640 l h f 150 610 30 20 re 1 1 1 rg f\n",
  );
  const largeKey = makeCoverKey(1, { x: 100, y: 600, w: 200, h: 40 });
  const smallKey = makeCoverKey(1, { x: 150, y: 610, w: 30, h: 20 });

  const removeSmallOnly = transformContentBytes(bytes, {
    ...baseOptions,
    revealedCovers: new Set([smallKey]),
  });
  const removeSmallText = new TextDecoder("latin1").decode(removeSmallOnly);
  if (!removeSmallText.includes("100 600 m")) {
    throw new Error("Large path cover removed when only nested rect cover was revealed");
  }
  if (removeSmallText.includes("150 610 30 20 re")) {
    throw new Error("Revealed nested rect cover on path cover was not removed");
  }

  const removeBoth = transformContentBytes(bytes, {
    ...baseOptions,
    revealedCovers: new Set([largeKey, smallKey]),
  });
  const removeBothText = new TextDecoder("latin1").decode(removeBoth);
  if (removeBothText.includes(" h f") || removeBothText.includes("150 610 30 20 re")) {
    throw new Error("Revealed nested path and rect covers were not both removed");
  }

  console.log("OK: nested path and rect covers remove independently");
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

async function testCurvedOutlineFillWithStaleFillColor() {
  const opts = {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 720,
    pageHeight: 450,
    pageArea: 720 * 450,
  };

  const stream = transformContentBytes(
    new TextEncoder().encode(
      "0.25 0.25 0.25 sc 503.9794 309.9631 m 504.2167 309.2863 l 502.8456 308.8351 501.8305 307.9548 501.1713 306.6452 c 500.5121 305.3356 500.1825 303.6906 500.1825 301.7101 c 500.1825 299.6594 500.5121 297.9689 501.1713 296.6389 c 501.8305 295.3088 502.8368 294.4181 504.1903 293.967 c 503.9794 293.2902 l 502.2626 293.7414 500.9471 294.7126 500.0331 296.2038 c 499.119 297.695 498.662 299.5012 498.662 301.6223 c 498.662 303.7375 499.1205 305.5436 500.0375 307.0407 c 500.9545 308.5378 502.2685 309.5119 503.9794 309.9631 c h f*\n",
    ),
    opts,
  );
  const text = new TextDecoder("latin1").decode(stream);
  if (!text.includes(`${TARGET_RGB} rg f*`)) {
    throw new Error(`Curved white outline f* was not recolored after fill changed: ${text}`);
  }

  console.log("OK: curved outline f* recolors even when active fill is no longer white");
}

async function testSpeechBubbleCoverPreserved() {
  const opts = {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 720,
    pageHeight: 540,
    pageArea: 720 * 540,
  };

  const speechBubblePath = [
    "1 1 1 rg",
    "575.457 393.5201 m",
    "575.457 397.7817 578.9117 401.2364 583.1733 401.2364 c",
    "598.1367 401.2364 l",
    "632.1562 401.2364 l",
    "703.8188 401.2364 l",
    "708.0804 401.2364 711.5351 397.7817 711.5351 393.5201 c",
    "711.5351 381.946 l",
    "711.5351 362.6557 l",
    "711.5351 358.3941 708.0804 354.9394 703.8188 354.9394 c",
    "632.1562 354.9394 l",
    "598.1367 354.9394 l",
    "583.1733 354.9394 l",
    "578.9117 354.9394 575.457 358.3941 575.457 362.6557 c",
    "575.457 381.946 l",
    "575.457 393.5201 l",
    "h f*",
  ].join(" ");

  const stream = transformContentBytes(new TextEncoder().encode(`${speechBubblePath}\n`), opts);
  const text = new TextDecoder("latin1").decode(stream);
  if (text.includes(`${TARGET_RGB} rg f*`)) {
    throw new Error(`Speech-bubble white fill was recolored: ${text}`);
  }
  if (!text.includes("1 1 1 rg") || !text.includes("f*")) {
    throw new Error(`Speech-bubble fill was altered unexpectedly: ${text}`);
  }

  console.log("OK: speech-bubble white fills with many curves stay white");
}

async function testMultiSubpathSpeechBubblePreserved() {
  const opts = {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
    pageNumber: 1,
    pageWidth: 720,
    pageHeight: 540,
    pageArea: 720 * 540,
  };

  const speechBubblePath = [
    "1 1 1 rg",
    "260.3111 344.7122 m",
    "262.9706 343.2328 261.841 344.2109 260.3111 344.7122 c",
    "h",
    "170.256 345.4642 m",
    "170.5197 344.7122 l",
    "168.9962 344.2109 167.8683 343.2328 167.1359 341.7777 c",
    "166.4035 340.3226 166.0373 338.4948 166.0373 336.2943 c",
    "166.0373 334.0156 166.4035 332.1374 167.1359 330.6595 c",
    "167.8683 329.1817 168.9865 328.1921 170.4904 327.6908 c",
    "170.256 326.9388 l",
    "168.3485 327.4401 166.8869 328.5192 165.8712 330.1761 c",
    "164.8556 331.833 164.3478 333.8399 164.3478 336.1966 c",
    "164.3478 338.5469 164.8572 340.5537 165.8761 342.2171 c",
    "166.895 343.8805 168.355 344.9629 170.256 345.4642 c",
    "h f*",
  ].join(" ");

  const stream = transformContentBytes(new TextEncoder().encode(`${speechBubblePath}\n`), opts);
  const text = new TextDecoder("latin1").decode(stream);
  if (text.includes(`${TARGET_RGB} rg f*`)) {
    throw new Error(`Multi-subpath speech-bubble white fill was recolored: ${text}`);
  }
  if (!text.includes("1 1 1 rg") || !text.includes("f*")) {
    throw new Error(`Multi-subpath speech-bubble fill was altered unexpectedly: ${text}`);
  }

  console.log("OK: multi-subpath speech-bubble white fills stay white");
}

async function testLecturePdfSpeechBubblesPreserved() {
  const lecturePath = "ref/20260610-講義.pdf";
  let lectureBytes;
  try {
    lectureBytes = readFileSync(lecturePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`Skip: ${lecturePath} not found`);
      return;
    }
    throw error;
  }

  const outDoc = await PDFDocument.load(lectureBytes.slice());
  await transformPdfContent(outDoc, {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
  });

  const { PDFArray, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const page = outDoc.getPages()[0];
  const context = outDoc.context;
  const contentsRef = page.node.get(PDFName.of("Contents"));
  const contents = context.lookup(contentsRef);
  const refs = contents instanceof PDFArray ? contents.asArray() : [contentsRef];
  const tokens = [];
  for (const ref of refs) {
    const stream = context.lookupMaybe(ref, PDFRawStream);
    if (!stream) continue;
    tokens.push(...tokenizeContentStream(decodePDFRawStream(stream).decode()));
  }

  let curvedRedFills = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== "f" && tokens[i] !== "f*") {
      continue;
    }
    const window = tokens.slice(Math.max(0, i - 5), i).join(" ");
    if (!window.includes(TARGET_RGB)) {
      continue;
    }
    let hasCurve = false;
    for (let j = i - 1; j >= Math.max(0, i - 40); j -= 1) {
      if (tokens[j] === "c" || tokens[j] === "v" || tokens[j] === "y") {
        hasCurve = true;
        break;
      }
      if (tokens[j] === "m") {
        break;
      }
    }
    if (hasCurve) {
      curvedRedFills += 1;
    }
  }

  if (curvedRedFills > 0) {
    throw new Error(`Lecture PDF page 1 still has ${curvedRedFills} recolored curved white fill(s)`);
  }

  console.log("OK: lecture PDF speech-bubble curved fills stay white on vector export");
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
  if (!text.includes("/Fm0 Do")) {
    throw new Error(`Expected Form XObject Do to remain intact: ${text}`);
  }
  console.log("OK: inherited white text in Form XObject recolored via parent fill color");
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
  if (!text.includes(`${TARGET_RGB} RG /Fm0 Do`)) {
    throw new Error(`Expected inherited white bracket stroke to be recolored: ${text}`);
  }
  console.log("OK: inherited white matrix stroke in Form XObject recolored via parent stroke color");
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
  await testCurvedOutlineFillWithStaleFillColor();
  await testSpeechBubbleCoverPreserved();
  await testMultiSubpathSpeechBubblePreserved();
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
  await testThinInheritedCoverRemoval();
  await testPathBasedCoverRemoval();
  await testNestedPathAndRectCoverRemoval();

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
    allowCoverRemoval: true,
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

  await testLecturePdfImagePreserved();
  await testLecturePdfSpeechBubblesPreserved();
  await testImageRecolorSkippedWithRecolorText();

  console.log("\nAll tests passed.");
}

async function assertImageXObjectsUnchanged(beforeDoc, afterDoc, label) {
  const { PDFDict, PDFRawStream } = await import("pdf-lib");
  for (let pageIndex = 0; pageIndex < beforeDoc.getPageCount(); pageIndex += 1) {
    const page = beforeDoc.getPages()[pageIndex];
    const resources = beforeDoc.context.lookupMaybe(page.node.get(PDFName.of("Resources")), PDFDict);
    const xObjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xObjects) {
      continue;
    }

    for (const [name, ref] of xObjects.entries()) {
      const stream = beforeDoc.context.lookupMaybe(ref, PDFRawStream);
      if (!stream) {
        continue;
      }
      const subtype = stream.dict.get(PDFName.of("Subtype"))?.toString();
      if (subtype !== "/Image") {
        continue;
      }

      const beforeBytes = stream.getContents();
      const afterBytes = afterDoc.context.lookup(ref, PDFRawStream).getContents();
      if (
        beforeBytes.length !== afterBytes.length
        || Buffer.compare(Buffer.from(beforeBytes), Buffer.from(afterBytes)) !== 0
      ) {
        throw new Error(`${label}: image ${name.toString()} on page ${pageIndex + 1} was modified`);
      }
    }
  }
}

async function testImageRecolorSkippedWithRecolorText() {
  const graphicsBytes = await makeGraphicsPdf();
  const beforeDoc = await PDFDocument.load(graphicsBytes.slice());
  const afterDoc = await PDFDocument.load(graphicsBytes.slice());
  await transformPdfContent(afterDoc, {
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
    recolorText: true,
    textColor: "#dd1133",
  });

  await assertImageXObjectsUnchanged(beforeDoc, afterDoc, "Graphics PDF with recolorText");

  const pngBytes = makeTinyPng();
  await testVectorExport("Image placement with recolorText", graphicsBytes, {
    recolorText: true,
    imagePlacements: [
      {
        pageNumber: 1,
        x: 300,
        y: 300,
        width: 40,
        height: 40,
        imageBytes: pngBytes,
        mimeType: "image/png",
      },
    ],
  });

  console.log("OK: image XObjects stay unchanged during vector export with recolorText");
}

async function testLecturePdfImagePreserved() {
  const lecturePath = "main.pdf";
  let lectureBytes;
  try {
    lectureBytes = readFileSync(lecturePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`Skip: ${lecturePath} not found`);
      return;
    }
    throw error;
  }

  const { PDFDict, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const beforeDoc = await PDFDocument.load(lectureBytes.slice());
  const afterDoc = await PDFDocument.load(lectureBytes.slice());
  await transformPdfContent(afterDoc, {
    recolorText: true,
    textColor: "#dd1133",
    whiteThreshold: 238,
    strokeWhiteThreshold: 220,
    revealedCovers: new Set(),
  });

  const imageRef = [...beforeDoc.context
    .lookup(beforeDoc.getPages()[3].node.get(PDFName.of("Resources")), PDFDict)
    .lookup(PDFName.of("XObject"), PDFDict)
    .entries()].find(([name]) => name.toString() === "/Image46")?.[1];
  if (!imageRef) {
    throw new Error("Expected /Image46 on page 4 of main.pdf");
  }

  const beforeImage = beforeDoc.context.lookup(imageRef, PDFRawStream).getContents();
  const afterImage = afterDoc.context.lookup(imageRef, PDFRawStream).getContents();
  if (
    beforeImage.length !== afterImage.length
    || Buffer.compare(Buffer.from(beforeImage), Buffer.from(afterImage)) !== 0
  ) {
    throw new Error("JPEG figure /Image46 was recolored during vector export");
  }

  await assertImageXObjectsUnchanged(beforeDoc, afterDoc, "main.pdf lecture export");

  const meta65Ref = [...beforeDoc.context
    .lookup(beforeDoc.getPages()[7].node.get(PDFName.of("Resources")), PDFDict)
    .lookup(PDFName.of("XObject"), PDFDict)
    .entries()].find(([name]) => name.toString() === "/Meta65")?.[1];
  if (meta65Ref) {
    const meta65Tokens = tokenizeContentStream(
      decodePDFRawStream(afterDoc.context.lookup(meta65Ref, PDFRawStream)).decode(),
    );
    if (meta65Tokens.includes("0.867") && meta65Tokens.includes("0.067") && meta65Tokens.includes("0.2")) {
      throw new Error("Colored vector diagram /Meta65 should not be recolored as white text");
    }
  }

  console.log("OK: JPEG figure XObjects stay unchanged; colored vector diagrams stay intact");
}

main().catch((error) => {
  console.error("\nTest suite failed:", error?.message ?? error);
  if (error?.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
