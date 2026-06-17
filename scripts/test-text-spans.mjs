import * as pdfjsLib from "../node_modules/pdfjs-dist/legacy/build/pdf.mjs";

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

function applyPdfMatrix(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

function pdfPointsToBBox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * 0.55;
}

function getFontAscentRatio(style = {}) {
  if (style.ascent != null) {
    return style.ascent;
  }
  if (style.descent != null) {
    return 1 + style.descent;
  }
  return 0.8;
}

function getTextItemPdfBBox(item, style = {}) {
  const transform = item.transform;
  const fontSize = Math.hypot(transform[0], transform[1]);
  const fontHeight = Math.hypot(transform[2], transform[3]) || fontSize;
  const width = item.width || estimateTextWidth(item.str, fontSize);
  const fontAscent = fontHeight * getFontAscentRatio(style);
  const fontDescent = fontHeight - fontAscent;

  const textSpaceCorners = [
    [0, -fontDescent],
    [width, -fontDescent],
    [0, fontAscent],
    [width, fontAscent],
  ];
  const userSpacePoints = textSpaceCorners.map(([tx, ty]) => applyPdfMatrix(transform, tx, ty));
  const bbox = pdfPointsToBBox(userSpacePoints);

  return {
    ...bbox,
    baselineX: transform[4],
    baselineY: transform[5],
    fontSize,
    fontHeight,
  };
}

function getTransformAngle(transform) {
  return Math.atan2(transform[1], transform[0]);
}

function getTextItemAdvanceEnd(item) {
  const width = item.width || 0;
  return applyPdfMatrix(item.transform, width, 0);
}

function mergePdfBBoxes(a, b) {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function shouldMergeTextItems(previous, current) {
  if (previous.item.hasEOL) {
    return false;
  }

  const prevSize = Math.max(previous.metrics.fontSize, previous.metrics.fontHeight);
  const currSize = Math.max(current.metrics.fontSize, current.metrics.fontHeight);
  const lineTolerance = Math.max(prevSize, currSize) * 0.35;
  if (Math.abs(previous.metrics.baselineY - current.metrics.baselineY) > lineTolerance) {
    return false;
  }

  const angleDiff = Math.abs(previous.angle - current.angle);
  if (angleDiff > 0.2 && Math.abs(angleDiff - Math.PI) > 0.2) {
    return false;
  }

  const [prevEndX, prevEndY] = previous.advanceEnd;
  const gap = Math.hypot(current.metrics.baselineX - prevEndX, current.metrics.baselineY - prevEndY);
  const maxGap = Math.max(prevSize, currSize) * 1.5;
  if (gap > maxGap) {
    return false;
  }

  const mergedLength = previous.text.length + current.item.str.length;
  if (mergedLength > 400) {
    return false;
  }

  return true;
}

function mergeTextItemsIntoSpans(items) {
  const spans = [];
  let group = null;

  const flushGroup = () => {
    if (!group) {
      return;
    }

    const trimmed = group.text.trim();
    if (!trimmed) {
      group = null;
      return;
    }

    spans.push({
      index: group.firstIndex,
      originalText: group.text,
      bbox: group.bbox,
      fontSize: group.fontSize,
    });
    group = null;
  };

  for (const entry of items) {
    if (!group) {
      group = {
        firstIndex: entry.index,
        text: entry.item.str,
        bbox: { ...entry.bbox },
        fontSize: entry.metrics.fontSize,
        angle: entry.angle,
        advanceEnd: entry.advanceEnd,
        item: entry.item,
        metrics: entry.metrics,
      };
      continue;
    }

    if (shouldMergeTextItems(group, entry)) {
      group.text += entry.item.str;
      group.bbox = mergePdfBBoxes(group.bbox, entry.bbox);
      group.advanceEnd = entry.advanceEnd;
      group.item = entry.item;
      continue;
    }

    flushGroup();
    group = {
      firstIndex: entry.index,
      text: entry.item.str,
      bbox: { ...entry.bbox },
      fontSize: entry.metrics.fontSize,
      angle: entry.angle,
      advanceEnd: entry.advanceEnd,
      item: entry.item,
      metrics: entry.metrics,
    };
  }

  flushGroup();
  return spans;
}

async function getTextSpansForPage(page) {
  const textContent = await page.getTextContent();
  const rawItems = [];

  for (let index = 0; index < textContent.items.length; index += 1) {
    const item = textContent.items[index];
    if (!item.str) {
      continue;
    }

    const style = textContent.styles[item.fontName] ?? {};
    const metrics = getTextItemPdfBBox(item, style);

    rawItems.push({
      index,
      item,
      metrics,
      angle: getTransformAngle(item.transform),
      advanceEnd: getTextItemAdvanceEnd(item),
      bbox: {
        x: metrics.x,
        y: metrics.y,
        w: metrics.w,
        h: metrics.h,
      },
    });
  }

  return mergeTextItemsIntoSpans(rawItems);
}

async function main() {
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
    if (ratio < 0.8) {
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
