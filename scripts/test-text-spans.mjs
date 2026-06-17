import * as pdfjsLib from "../node_modules/pdfjs-dist/legacy/build/pdf.mjs";
import {
  buildMockTextEntry,
  getFontAscentRatio,
  getTextItemPdfBBox,
  getTextLayerCssBox,
  getTextSpaceDescent,
  getTextSpansForPage,
  mergeTextItemsIntoSpans,
  pdfBBoxToCssBox,
} from "../text-span-utils.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

const SAMPLE_URL =
  "https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf";

async function loadSamplePdfBytes() {
  try {
    const response = await fetch(SAMPLE_URL);
    if (response.ok) {
      return new Uint8Array(await response.arrayBuffer());
    }
  } catch {
    // Fall back to a tiny inline PDF when network/TLS is unavailable.
  }

  return Uint8Array.from(
    atob(
      "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0NvdW50IDEvS2lkc1szIDAgUl0+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDYxMiA3OTJdL1BhcmVudCAyIDAgUi9Db250ZW50cyA0IDAgUj4+CmVuZG9iago0IDAgb2JqCjw8L0xlbmd0aCA2MT4+c3RyZWFtCkJUCi9GMSAxNCBUZgoxMDAgNzAwIFRkCihIZWxsbyBXb3JsZCkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0MxPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuCjAwMDAwMDAyMDggMDAwMDAgbiAKMDAwMDAwMDMwNCAwMDAwMCBuCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpxdGFydHhyZWYKMzkyCiUlRU9G",
    ),
    (char) => char.charCodeAt(0),
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testNegativeScalePdfBBoxWrapsBaseline() {
  const item = {
    str: "Hello",
    transform: [12, 0, 0, -12, 100, 700],
    width: 33,
  };
  const bbox = getTextItemPdfBBox(item);
  assert(bbox.y < item.transform[5], "bbox bottom should sit below baseline in PDF Y-up space");
  assert(
    bbox.y + bbox.h > item.transform[5],
    "bbox top should sit above baseline in PDF Y-up space",
  );
}

function testNegativeScaleCssAlignment() {
  const item = {
    str: "Hello",
    transform: [12, 0, 0, -12, 100, 700],
    width: 33,
  };
  const viewport = {
    scale: 1.5,
    rawDims: { pageX: 0, pageY: 0, pageWidth: 612, pageHeight: 792 },
    convertToViewportPoint(x, y) {
      return [x * this.scale, (792 - y) * this.scale];
    },
  };
  const bbox = getTextItemPdfBBox(item);
  const cssBox = pdfBBoxToCssBox(bbox, viewport);
  const expected = getTextLayerCssBox(item, {}, viewport);
  assert(
    Math.abs(cssBox.y - expected.y) < 0.05,
    `Top should match PDF.js TextLayer (got=${cssBox.y.toFixed(2)} expected=${expected.y.toFixed(2)})`,
  );
  const tightHeight = 12 * viewport.scale * (getFontAscentRatio({}) + getTextSpaceDescent({}));
  assert(
    cssBox.h < expected.h,
    `Hit box height should be tighter than full TextLayer em (got=${cssBox.h.toFixed(2)} textLayer=${expected.h.toFixed(2)})`,
  );
  assert(
    Math.abs(cssBox.h - tightHeight) < 0.05,
    `Height should follow ascent+|descent| (got=${cssBox.h.toFixed(2)} expected=${tightHeight.toFixed(2)})`,
  );
  assert(
    cssBox.w < expected.w,
    `Width should trim trailing advance (got=${cssBox.w.toFixed(2)} textLayer=${expected.w.toFixed(2)})`,
  );
}

function testSingleItemBboxRatio() {
  const item = {
    str: "Hello",
    transform: [12, 0, 0, -12, 100, 700],
    width: 33,
  };
  const bbox = getTextItemPdfBBox(item);
  const ratio = bbox.w / Math.max(bbox.h, 0.01);
  assert(ratio > 1, `Single horizontal text should be wider than tall (ratio=${ratio.toFixed(2)})`);
  assert(
    bbox.h <= 12 * (0.75 + 0.18) + 0.01,
    `Default bbox height should use capped descent (h=${bbox.h.toFixed(2)})`,
  );
}

function testStyleDescentTightensHeight() {
  const item = {
    str: "Hello World",
    transform: [14, 0, 0, -14, 100, 700],
    width: 72.338,
  };
  const fullEmStyle = { ascent: 0.718, descent: -(1 - 0.718) };
  const tightStyle = { ascent: 0.718, descent: -0.207 };
  const fullEm = getTextItemPdfBBox(item, fullEmStyle);
  const tight = getTextItemPdfBBox(item, tightStyle);
  assert(
    tight.h < fullEm.h,
    `style.descent should shorten bbox vs full em (tight=${tight.h.toFixed(2)} fullEm=${fullEm.h.toFixed(2)})`,
  );
  assert(
    Math.abs(tight.h - 14 * (0.718 + 0.207)) < 0.2,
    `Height should match ascent+|descent| (h=${tight.h.toFixed(2)})`,
  );
  assert(
    Math.abs(getTextSpaceDescent(tightStyle, getFontAscentRatio(tightStyle)) - 0.207) < 0.001,
    "Descent helper should use PDF.js style.descent magnitude",
  );
}

function testHorizontalTrim() {
  const item = {
    str: "Hello",
    transform: [12, 0, 0, -12, 100, 700],
    width: 33,
  };
  const bbox = getTextItemPdfBBox(item);
  assert(bbox.w < 33, `Width should trim trailing advance (w=${bbox.w.toFixed(2)})`);
  assert(bbox.w >= 31, `Width trim should stay close to advance (w=${bbox.w.toFixed(2)})`);
}

function testCommaSpaceMerge() {
  const fontSize = 12;
  const baselineY = 700;
  const items = [
    buildMockTextEntry({
      index: 0,
      str: "Hello",
      transform: [fontSize, 0, 0, -fontSize, 100, baselineY],
      width: 30,
    }),
    buildMockTextEntry({
      index: 1,
      str: ",",
      transform: [fontSize, 0, 0, -fontSize, 132, baselineY],
      width: 4,
    }),
    buildMockTextEntry({
      index: 2,
      str: " world",
      transform: [fontSize, 0, 0, -fontSize, 138, baselineY],
      width: 42,
    }),
  ];

  const spans = mergeTextItemsIntoSpans(items);
  assert(spans.length === 1, `Comma phrase should merge into one span, got ${spans.length}`);
  assert(
    spans[0].originalText === "Hello, world",
    `Expected "Hello, world", got "${spans[0].originalText}"`,
  );
}

function testSpaceSeparatedWordsMerge() {
  const fontSize = 12;
  const baselineY = 700;
  const items = [
    buildMockTextEntry({
      index: 0,
      str: "a",
      transform: [fontSize, 0, 0, -fontSize, 100, baselineY],
      width: 7,
    }),
    buildMockTextEntry({
      index: 1,
      str: " ",
      transform: [fontSize, 0, 0, -fontSize, 108, baselineY],
      width: 4,
    }),
    buildMockTextEntry({
      index: 2,
      str: "b",
      transform: [fontSize, 0, 0, -fontSize, 112, baselineY],
      width: 7,
    }),
    buildMockTextEntry({
      index: 3,
      str: " ",
      transform: [fontSize, 0, 0, -fontSize, 120, baselineY],
      width: 4,
    }),
    buildMockTextEntry({
      index: 4,
      str: "c",
      transform: [fontSize, 0, 0, -fontSize, 124, baselineY],
      width: 7,
    }),
  ];

  const spans = mergeTextItemsIntoSpans(items);
  assert(spans.length === 1, `"a b c" should merge into one span, got ${spans.length}`);
  assert(spans[0].originalText === "a b c", `Expected "a b c", got "${spans[0].originalText}"`);
}

function testSpacedCommaPhraseMerge() {
  const fontSize = 12;
  const baselineY = 700;
  const items = [
    buildMockTextEntry({
      index: 0,
      str: "word",
      transform: [fontSize, 0, 0, -fontSize, 100, baselineY],
      width: 24,
    }),
    buildMockTextEntry({
      index: 1,
      str: " , ",
      transform: [fontSize, 0, 0, -fontSize, 126, baselineY],
      width: 18,
    }),
    buildMockTextEntry({
      index: 2,
      str: "word",
      transform: [fontSize, 0, 0, -fontSize, 146, baselineY],
      width: 24,
    }),
  ];

  const spans = mergeTextItemsIntoSpans(items);
  assert(spans.length === 1, `"word , word" should merge into one span, got ${spans.length}`);
  assert(
    spans[0].originalText === "word , word",
    `Expected "word , word", got "${spans[0].originalText}"`,
  );
}

function testInlineMathMerge() {
  const bodySize = 12;
  const mathSize = 10;
  const baselineY = 700;
  const items = [
    buildMockTextEntry({
      index: 0,
      str: "Let ",
      transform: [bodySize, 0, 0, -bodySize, 100, baselineY],
      width: 24,
    }),
    buildMockTextEntry({
      index: 1,
      str: "x",
      transform: [mathSize, 0, 0, -mathSize, 124, baselineY + 1.5],
      width: 6,
      style: { ascent: 0.75, descent: -0.22 },
    }),
    buildMockTextEntry({
      index: 2,
      str: "+",
      transform: [mathSize, 0, 0, -mathSize, 130, baselineY - 0.5],
      width: 6,
      style: { ascent: 0.75, descent: -0.22 },
    }),
    buildMockTextEntry({
      index: 3,
      str: "y",
      transform: [mathSize, 0, 0, -mathSize, 136, baselineY + 1],
      width: 6,
      style: { ascent: 0.75, descent: -0.22 },
    }),
    buildMockTextEntry({
      index: 4,
      str: " denote a variable.",
      transform: [bodySize, 0, 0, -bodySize, 142, baselineY],
      width: 96,
    }),
  ];

  const spans = mergeTextItemsIntoSpans(items);
  assert(spans.length === 1, `Inline math should merge into one span, got ${spans.length}`);
  const ratio = spans[0].bbox.w / Math.max(spans[0].bbox.h, 0.01);
  assert(ratio > 1.5, `Merged inline sentence should be wide (ratio=${ratio.toFixed(2)})`);
  assert(
    spans[0].originalText.includes("x+y"),
    `Merged text should keep math inline: "${spans[0].originalText}"`,
  );
}

async function main() {
  testNegativeScalePdfBBoxWrapsBaseline();
  testNegativeScaleCssAlignment();
  testSingleItemBboxRatio();
  testStyleDescentTightensHeight();
  testHorizontalTrim();
  testCommaSpaceMerge();
  testSpaceSeparatedWordsMerge();
  testSpacedCommaPhraseMerge();
  testInlineMathMerge();

  const bytes = await loadSamplePdfBytes();
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  const spans = await getTextSpansForPage(page);

  console.log(`Merged spans on page 1: ${spans.length}`);

  let tallNarrow = 0;
  let okRatio = 0;
  for (const span of spans.slice(0, 20)) {
    const ratio = span.bbox.w / Math.max(span.bbox.h, 0.01);
    const preview = span.originalText.replace(/\s+/g, " ").trim().slice(0, 60);
    console.log(
      `  w=${span.bbox.w.toFixed(1)} h=${span.bbox.h.toFixed(1)} ratio=${ratio.toFixed(2)} "${preview}"`,
    );
    if (ratio < 0.75) {
      tallNarrow += 1;
    } else {
      okRatio += 1;
    }
  }

  const avgChars = spans.reduce((sum, span) => sum + span.originalText.trim().length, 0) / spans.length;
  console.log(`Average chars per span: ${avgChars.toFixed(1)}`);

  if (tallNarrow > okRatio) {
    throw new Error("Too many tall/narrow boxes in sample set");
  }

  if (avgChars < 4) {
    throw new Error("Spans are still too fragmented");
  }

  console.log("Text span checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
