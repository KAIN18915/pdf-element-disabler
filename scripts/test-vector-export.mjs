import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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

async function testPathStrokeAndThinFillRecolor() {
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
  if (!strokeText.includes(`${TARGET_RGB} RG`)) {
    throw new Error(`Expected near-white path stroke to be recolored: ${strokeText}`);
  }
  if (strokeText.includes("0.92 G")) {
    throw new Error(`Near-white G operator should be rewritten: ${strokeText}`);
  }

  const bracketStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 RG 0 0 m 0 0 l 0 50 l S\n"),
    baseOptions,
  );
  const bracketText = new TextDecoder("latin1").decode(bracketStream);
  if (!bracketText.includes(`${TARGET_RGB} RG`)) {
    throw new Error(`Expected white bracket stroke to be recolored: ${bracketText}`);
  }

  const fractionStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 rg 10 10 100 1 re f\n"),
    baseOptions,
  );
  const fractionText = new TextDecoder("latin1").decode(fractionStream);
  if (!fractionText.includes(`${TARGET_RGB} rg`)) {
    throw new Error(`Expected thin white fraction bar fill to be recolored: ${fractionText}`);
  }

  const coverStream = transformContentBytes(
    new TextEncoder().encode("1 1 1 rg 100 600 200 40 re f\n"),
    baseOptions,
  );
  const coverText = new TextDecoder("latin1").decode(coverStream);
  if (!coverText.includes("1 1 1 rg") || !coverText.includes(" re f")) {
    throw new Error(`Large white cover rect should remain untouched: ${coverText}`);
  }

  console.log("OK: path strokes and thin fills recolored without touching cover rects");
}

async function main() {
  await testRecolorOperators();
  await testPathStrokeAndThinFillRecolor();
  await testStreamPassthroughIntegrity();
  await testCoverRemovalOnlyWhenRevealed();

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
