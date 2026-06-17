import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { transformPdfContent } from "./pdf-content-transform.node.mjs";

async function makeSamplePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // White cover rectangle (typical overlay to remove)
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

async function testVectorExport(label, pdfBytes, options = {}) {
  console.log(`\n=== ${label} ===`);
  try {
    const outDoc = await PDFDocument.load(pdfBytes.slice());
    await transformPdfContent(outDoc, {
      whiteThreshold: 238,
      revealAllOverlays: options.revealAllOverlays ?? false,
      revealedCovers: options.revealedCovers ?? new Set(),
      recolorText: options.recolorText ?? false,
      textColor: "#dd1133",
    });

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

async function main() {
  const sampleBytes = await makeSamplePdf();
  writeFileSync("scripts/sample-test.pdf", sampleBytes);

  await testVectorExport("Simple PDF, no edits", sampleBytes);
  await testVectorExport("Reveal all overlays", sampleBytes, {
    revealAllOverlays: true,
  });
  await testVectorExport("Recolor text", sampleBytes, {
    recolorText: true,
    revealAllOverlays: true,
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

  const mergedBytes = await testMerge(sampleBytes, sampleBytes);
  await testVectorExport("Merged PDF", mergedBytes, { revealAllOverlays: true });

  console.log("\nAll tests passed.");
}

main().catch((error) => {
  console.error("\nTest suite failed:", error?.message ?? error);
  if (error?.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
