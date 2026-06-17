import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  containsCjkText,
  findEmbeddedFontMatch,
  mapToStandardFont,
  PdfFontResolver,
  resolveCanvasFontFamily,
} from "../font-matching-utils.js";
import { indexEmbeddedPdfFonts } from "./font-pdf-extract.node.mjs";
import { extractSpanFontFields } from "../text-span-utils.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testSpanFontFields() {
  const fields = extractSpanFontFields(
    {
      fontFamily: "Arial",
      fontSubstitution: "Arial",
      vertical: false,
    },
    { fontName: "g_d0_f1" },
  );

  assert(fields.fontName === "g_d0_f1", "fontName should be captured");
  assert(fields.fontFamily === "Arial", "fontFamily should be captured");
  assert(fields.fontSubstitution === "Arial", "fontSubstitution should be captured");
}

function testCanvasFontFamily() {
  assert(
    resolveCanvasFontFamily({ fontFamily: "serif" }) === "serif",
    "Generic serif should pass through",
  );
  assert(
    resolveCanvasFontFamily({ fontFamily: "Times New Roman" }).includes("Times New Roman"),
    "Named font should be quoted",
  );
  assert(
    resolveCanvasFontFamily({ fontSubstitution: "Meiryo" }).includes("Meiryo"),
    "fontSubstitution should take priority",
  );
}

function testStandardFontMapping() {
  assert(
    mapToStandardFont(StandardFonts, { fontFamily: "Times-Roman" }) === StandardFonts.TimesRoman,
    "Times should map to TimesRoman",
  );
  assert(
    mapToStandardFont(StandardFonts, { fontFamily: "Courier" }) === StandardFonts.Courier,
    "Courier should map to Courier",
  );
  assert(
    mapToStandardFont(StandardFonts, { fontFamily: "Arial Bold" }) === StandardFonts.HelveticaBold,
    "Bold sans should map to HelveticaBold",
  );
}

function testCjkDetection() {
  assert(containsCjkText("こんにちは"), "Japanese should be detected");
  assert(!containsCjkText("Hello"), "Latin-only text should not be detected");
}

async function testEmbeddedFontIndex() {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Sample", { x: 72, y: 720, size: 12, font });
  const bytes = await doc.save();

  const loaded = await PDFDocument.load(bytes);
  const indexed = indexEmbeddedPdfFonts(loaded);
  assert(indexed.size >= 0, "Indexing should not throw for standard-font PDF");
}

async function testFontResolver() {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  page.drawText("Title", { x: 72, y: 720, size: 18, font });
  const bytes = await doc.save();
  const loaded = await PDFDocument.load(bytes);

  const resolver = new PdfFontResolver(loaded, {
    StandardFonts,
    indexEmbeddedPdfFonts,
  });
  const resolved = await resolver.resolveFontForEdit({
    newText: "Edited",
    fontFamily: "Times-Roman",
  });
  assert(resolved, "Resolver should return a font");
}

async function main() {
  testSpanFontFields();
  testCanvasFontFamily();
  testStandardFontMapping();
  testCjkDetection();
  await testEmbeddedFontIndex();
  await testFontResolver();

  const indexed = indexEmbeddedPdfFonts(await PDFDocument.create());
  const match = findEmbeddedFontMatch(indexed, { fontFamily: "missing-font" });
  assert(match === null, "Missing font should not match");

  console.log("Font matching checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
