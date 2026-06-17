export function applyPdfMatrix(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

export function pdfPointsToBBox(points) {
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

export function estimateTextWidth(text, fontHeight) {
  return text.length * fontHeight * 0.55;
}

function getHorizontalScale(transform) {
  return Math.hypot(transform[0], transform[1]) || 1;
}

function getTextSpaceWidth(item) {
  const hScale = getHorizontalScale(item.transform);
  if (item.width > 0) {
    return item.width / hScale;
  }
  const fontHeight = Math.hypot(item.transform[2], item.transform[3]) || hScale || 1;
  return estimateTextWidth(item.str, fontHeight) / hScale;
}

export function getFontAscentRatio(style = {}) {
  if (style.ascent != null) {
    return style.ascent;
  }
  if (style.descent != null) {
    return 1 + style.descent;
  }
  return 0.8;
}

export function getTextItemPdfBBox(item, style = {}) {
  const tx = item.transform;
  const hScale = getHorizontalScale(tx);
  const vScale = Math.hypot(tx[2], tx[3]) || hScale || 1;
  const ascentRatio = getFontAscentRatio(style);
  const textSpaceAscent = ascentRatio;
  const textSpaceDescent = 1 - ascentRatio;
  const textSpaceWidth = getTextSpaceWidth(item);

  const corners = [
    [0, -textSpaceDescent],
    [textSpaceWidth, -textSpaceDescent],
    [0, textSpaceAscent],
    [textSpaceWidth, textSpaceAscent],
  ].map(([x, y]) => applyPdfMatrix(tx, x, y));
  const bbox = pdfPointsToBBox(corners);

  return {
    ...bbox,
    baselineX: tx[4],
    baselineY: tx[5],
    fontSize: vScale,
    fontHeight: vScale,
    leftX: bbox.x,
  };
}

export function getTransformAngle(transform) {
  return Math.atan2(transform[1], transform[0]);
}

export function getTextItemAdvanceEnd(item) {
  const tx = item.transform;
  const width = item.width || 0;
  const hScale = getHorizontalScale(tx);
  const dirX = tx[0] / hScale;
  const dirY = tx[1] / hScale;
  return [tx[4] + width * dirX, tx[5] + width * dirY];
}

export function mergePdfBBoxes(a, b) {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function getLineStats(entries) {
  const baselines = entries.map((entry) => entry.metrics.baselineY);
  const sizes = entries.map((entry) => entry.metrics.fontHeight);
  return {
    medianBaseline: median(baselines),
    medianSize: median(sizes),
    maxSize: Math.max(...sizes),
  };
}

function clusterItemsIntoLines(items) {
  if (!items.length) {
    return [];
  }

  const sorted = [...items].sort((a, b) => {
    const yDiff = b.metrics.baselineY - a.metrics.baselineY;
    if (Math.abs(yDiff) > 0.5) {
      return yDiff;
    }
    return a.metrics.baselineX - b.metrics.baselineX;
  });

  const lines = [];
  let line = [];

  for (const entry of sorted) {
    if (!line.length) {
      line.push(entry);
      continue;
    }

    const stats = getLineStats(line);
    const tolerance = Math.max(stats.medianSize * 0.65, stats.maxSize * 0.5);
    if (Math.abs(entry.metrics.baselineY - stats.medianBaseline) <= tolerance) {
      line.push(entry);
      continue;
    }

    lines.push(line);
    line = [entry];
  }

  if (line.length) {
    lines.push(line);
  }

  return lines;
}

export function shouldMergeTextItems(previous, current, lineContext = null) {
  if (previous.item.hasEOL) {
    return false;
  }

  const prevSize = previous.metrics.fontHeight;
  const currSize = current.metrics.fontHeight;
  const lineSize = lineContext?.medianSize ?? Math.max(prevSize, currSize);

  const [prevEndX, prevEndY] = previous.advanceEnd;
  const dx = current.metrics.baselineX - prevEndX;
  const dy = current.metrics.baselineY - prevEndY;
  const horizontalGap = Math.abs(dx);
  const verticalGap = Math.abs(dy);

  const angleDiff = Math.abs(previous.angle - current.angle);
  if (angleDiff > 0.35 && Math.abs(angleDiff - Math.PI) > 0.35) {
    return false;
  }

  let maxVerticalGap = lineSize * 0.7;
  if (horizontalGap <= lineSize * 0.5) {
    maxVerticalGap = lineSize * 1.05;
  }
  if (verticalGap > maxVerticalGap) {
    return false;
  }

  let maxGap = lineSize * 2.5;
  if (horizontalGap <= lineSize * 0.25) {
    maxGap = lineSize * 3.5;
  }

  const endsWithSentenceBreak = /[.!?。．！？]\s*$/.test(previous.text);
  if (endsWithSentenceBreak && horizontalGap > lineSize * 0.8) {
    return false;
  }

  const gap = Math.hypot(dx, dy);
  if (horizontalGap > lineSize * 1.8 && verticalGap <= lineSize * 0.2) {
    if (horizontalGap > maxGap) {
      return false;
    }
  } else if (gap > maxGap) {
    return false;
  }

  if (horizontalGap > lineSize * 5) {
    return false;
  }

  const mergedLength = previous.text.length + current.item.str.length;
  if (mergedLength > 400) {
    return false;
  }

  return true;
}

function unionEntryBBoxes(entries) {
  return entries.reduce((bbox, entry) => mergePdfBBoxes(bbox, entry.bbox), { ...entries[0].bbox });
}

function finalizeSpanBBox(group) {
  const entries = group.entries;
  if (!entries.length) {
    return group.bbox;
  }

  const angle = group.angle ?? 0;
  const isHorizontal = Math.abs(angle) < 0.25;
  if (!isHorizontal || entries.length === 1) {
    return entries.length === 1 ? entries[0].bbox : unionEntryBBoxes(entries);
  }

  const fontHeight = median(entries.map((entry) => entry.metrics.fontHeight));
  const ascentRatio = getFontAscentRatio(group.style ?? {});
  const textSpaceAscent = ascentRatio;
  const textSpaceDescent = 1 - ascentRatio;

  const anchor = entries.reduce((leftmost, entry) =>
    entry.metrics.baselineX <= leftmost.metrics.baselineX ? entry : leftmost,
  );

  let minX = Infinity;
  let maxX = -Infinity;
  for (const entry of entries) {
    minX = Math.min(minX, entry.bbox.x, entry.metrics.baselineX);
    maxX = Math.max(maxX, entry.bbox.x + entry.bbox.w);
  }
  const [endX] = group.advanceEnd;
  maxX = Math.max(maxX, endX);

  const anchorTx = anchor.item.transform;
  const hScale = getHorizontalScale(anchorTx);
  const spanWidth = Math.max(maxX - minX, 0);
  const offsetX = (minX - anchor.metrics.baselineX) / hScale;
  const textSpaceWidth = spanWidth / hScale;

  const corners = [
    [offsetX, -textSpaceDescent],
    [offsetX + textSpaceWidth, -textSpaceDescent],
    [offsetX, textSpaceAscent],
    [offsetX + textSpaceWidth, textSpaceAscent],
  ].map(([x, y]) => applyPdfMatrix(anchorTx, x, y));

  return pdfPointsToBBox(corners);
}

function mergeLineItemsIntoSpans(lineItems, lineContext) {
  const sorted = [...lineItems].sort((a, b) => a.metrics.baselineX - b.metrics.baselineX);
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
      itemIndices: group.itemIndices,
      originalText: group.text,
      x: group.baselineX,
      y: group.baselineY,
      bbox: finalizeSpanBBox(group),
      width: 0,
      height: 0,
      fontSize: group.fontSize,
    });
    const last = spans[spans.length - 1];
    last.width = last.bbox.w;
    last.height = last.bbox.h;
    group = null;
  };

  for (const entry of sorted) {
    if (!group) {
      group = {
        firstIndex: entry.index,
        itemIndices: [entry.index],
        entries: [entry],
        text: entry.item.str,
        baselineX: entry.metrics.baselineX,
        baselineY: entry.metrics.baselineY,
        bbox: { ...entry.bbox },
        fontSize: entry.metrics.fontSize,
        angle: entry.angle,
        advanceEnd: entry.advanceEnd,
        item: entry.item,
        metrics: entry.metrics,
        style: entry.style,
      };
      continue;
    }

    if (shouldMergeTextItems(group, entry, lineContext)) {
      group.text += entry.item.str;
      group.itemIndices.push(entry.index);
      group.entries.push(entry);
      group.bbox = mergePdfBBoxes(group.bbox, entry.bbox);
      group.advanceEnd = entry.advanceEnd;
      group.item = entry.item;
      group.metrics = entry.metrics;
      continue;
    }

    flushGroup();
    group = {
      firstIndex: entry.index,
      itemIndices: [entry.index],
      entries: [entry],
      text: entry.item.str,
      baselineX: entry.metrics.baselineX,
      baselineY: entry.metrics.baselineY,
      bbox: { ...entry.bbox },
      fontSize: entry.metrics.fontSize,
      angle: entry.angle,
      advanceEnd: entry.advanceEnd,
      item: entry.item,
      metrics: entry.metrics,
      style: entry.style,
    };
  }

  flushGroup();
  return spans;
}

export function mergeTextItemsIntoSpans(items) {
  const lines = clusterItemsIntoLines(items);
  const spans = [];

  for (const lineItems of lines) {
    const lineContext = getLineStats(lineItems);
    spans.push(...mergeLineItemsIntoSpans(lineItems, lineContext));
  }

  spans.sort((a, b) => a.index - b.index);
  return spans;
}

export async function getTextSpansForPage(page) {
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
      style,
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

export function buildMockTextEntry({
  index,
  str,
  transform,
  width,
  hasEOL = false,
  style = {},
}) {
  const item = { str, transform, width, hasEOL };
  const metrics = getTextItemPdfBBox(item, style);
  return {
    index,
    item,
    style,
    metrics,
    angle: getTransformAngle(transform),
    advanceEnd: getTextItemAdvanceEnd(item),
    bbox: {
      x: metrics.x,
      y: metrics.y,
      w: metrics.w,
      h: metrics.h,
    },
  };
}
