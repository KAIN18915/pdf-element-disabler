import "./path2d-tracker.js";
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.624/legacy/build/pdf.mjs";
import * as pdfLib from "./pdf-lib-shim.js";
import {
  makeCoverKey,
  needsContentStreamTransform,
  shouldRecolorNearWhiteStroke,
  transformPdfContent,
} from "./pdf-content-transform.js";
import {
  estimateTextWidth,
  extractSpanFontFields,
  getTextSpansForPage,
  pdfBBoxToCssBox,
} from "./text-span-utils.js";
import {
  PdfFontResolver,
  indexEmbeddedPdfFonts,
  resolveCanvasFont,
  resolveCanvasFontAsync,
} from "./font-matching.js";
const EXPORT_RENDER_SCALE = 2;
const PDFJS_DIST_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.624";
const MAX_EDIT_HISTORY = 50;
const MIN_IMAGE_SIZE_PT = 8;
const IMAGE_RESIZE_CORNERS = ["nw", "ne", "sw", "se"];
const DEFAULT_NEW_TEXT_SIZE = 12;
// 被せ物判定: この面積 (pt²) 未満の白塗りは被せ物候補にしない。
const SMALL_WHITE_ELEMENT_MAX_PDF_AREA = 400;
// 白ストローク（括弧など）の明るさ判定上限。
const STROKE_WHITE_THRESHOLD_CAP = 220;
const LINEAR_SYMBOL_ASPECT_RATIO = 6;
const PAGE_BACKGROUND_AREA_RATIO = 0.9;
const SAMPLE_PDF_CANDIDATES = [
  { url: "./main.pdf", name: "main.pdf" },
  {
    url: "https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf",
    name: "サンプルPDF",
  },
];

let pdfLibPromise = null;

function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = Promise.resolve(pdfLib);
  }
  return pdfLibPromise;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_DIST_URL}/legacy/build/pdf.worker.mjs`;

const state = {
  pdfDoc: null,
  pdfBytes: null,
  pdfName: "",
  scale: 1,
  viewerWidth: 0,
  renderToken: 0,
  // 穴埋め解除の設定
  revealAllOverlays: false,
  recolorText: true,
  textColor: "#dd1133",
  // 「白」とみなす最小の明るさ (0-255)。値が小さいほど薄いグレーも対象になる。
  whiteThreshold: 238,
  // 個別に表示した被せ物のキー (PDF user-space bbox)
  revealedCovers: new Set(),
  // ページごとの描画情報
  pageViews: new Map(),
  // 統計
  totalCovers: 0,
  // 編集
  editMode: null,
  textEdits: [],
  imagePlacements: [],
  pendingImage: null,
  selectedImageId: null,
  editIdCounter: 0,
  textEditTarget: null,
  editHistory: {
    past: [],
    future: [],
  },
  suppressHistory: false,
};

let imageResizeSession = null;

const els = {
  themeToggle: document.querySelector("#theme-toggle"),
  themeIcon: document.querySelector("#theme-icon"),
  fileInput: document.querySelector("#file-input"),
  emptyFileInput: document.querySelector("#empty-file-input"),
  sampleButton: document.querySelector("#sample-button"),
  emptySampleButton: document.querySelector("#empty-sample-button"),
  revealOverlaysToggle: document.querySelector("#reveal-overlays"),
  recolorToggle: document.querySelector("#recolor-text"),
  colorInput: document.querySelector("#text-color"),
  thresholdInput: document.querySelector("#white-threshold"),
  thresholdValue: document.querySelector("#white-threshold-value"),
  scaleSelect: document.querySelector("#scale-select"),
  downloadRasterButton: document.querySelector("#download-raster-button"),
  downloadVectorButton: document.querySelector("#download-vector-button"),
  resetButton: document.querySelector("#reset-button"),
  coverCount: document.querySelector("#cover-count"),
  revealedCount: document.querySelector("#revealed-count"),
  emptyState: document.querySelector("#empty-state"),
  status: document.querySelector("#status"),
  viewerWrap: document.querySelector(".viewer-wrap"),
  viewer: document.querySelector("#viewer"),
  textEditModeButton: document.querySelector("#text-edit-mode-button"),
  addTextModeButton: document.querySelector("#add-text-mode-button"),
  imageInsertModeButton: document.querySelector("#image-insert-mode-button"),
  undoButton: document.querySelector("#undo-button"),
  redoButton: document.querySelector("#redo-button"),
  mergePdfInput: document.querySelector("#merge-pdf-input"),
  imageFileInput: document.querySelector("#image-file-input"),
  clearEditsButton: document.querySelector("#clear-edits-button"),
  textEditCount: document.querySelector("#text-edit-count"),
  imageEditCount: document.querySelector("#image-edit-count"),
  editModeHint: document.querySelector("#edit-mode-hint"),
  textEditDialog: document.querySelector("#text-edit-dialog"),
  textEditTitle: document.querySelector("#text-edit-title"),
  textEditInput: document.querySelector("#text-edit-input"),
  textEditOriginal: document.querySelector("#text-edit-original"),
  textEditExtraFields: document.querySelector("#text-edit-extra-fields"),
  textEditSize: document.querySelector("#text-edit-size"),
  textEditColor: document.querySelector("#text-edit-color"),
  textEditDelete: document.querySelector("#text-edit-delete"),
  textEditCancel: document.querySelector("#text-edit-cancel"),
  stickyHeader: document.querySelector("#sticky-header"),
};

let layoutRerenderFrame = 0;

initThemeToggle();
wireFileInputs();
wireSampleButtons();

els.sampleButton.addEventListener("click", () => loadSamplePdf());

els.scaleSelect.addEventListener("change", () => {
  state.scale = Number(els.scaleSelect.value);
  if (state.pdfDoc) {
    renderDocument();
  }
});

els.revealOverlaysToggle.addEventListener("change", () => {
  state.revealAllOverlays = els.revealOverlaysToggle.checked;
  if (state.pdfDoc) {
    renderDocument();
  }
});

els.recolorToggle.addEventListener("change", () => {
  state.recolorText = els.recolorToggle.checked;
  if (state.pdfDoc) {
    renderDocument();
  }
});

els.colorInput.addEventListener("change", () => {
  state.textColor = els.colorInput.value;
  if (state.pdfDoc && state.recolorText) {
    renderDocument();
  }
});

els.thresholdInput.addEventListener("input", () => {
  state.whiteThreshold = Number(els.thresholdInput.value);
  els.thresholdValue.textContent = String(state.whiteThreshold);
});
els.thresholdInput.addEventListener("change", () => {
  if (state.pdfDoc) {
    renderDocument();
  }
});

els.resetButton.addEventListener("click", () => {
  pushEditHistory();
  state.revealedCovers.clear();
  state.revealAllOverlays = false;
  state.recolorText = false;
  els.revealOverlaysToggle.checked = false;
  els.recolorToggle.checked = false;
  if (state.pdfDoc) {
    renderDocument();
  } else {
    updateControls();
  }
});

wireUndoRedo();
syncStickyHeaderHeight();

els.downloadRasterButton.addEventListener("click", () => downloadModifiedPdf());
els.downloadVectorButton.addEventListener("click", () => downloadModifiedPdfVector());

wireEditControls();

els.colorInput.value = state.textColor;
els.thresholdInput.value = String(state.whiteThreshold);
els.thresholdValue.textContent = String(state.whiteThreshold);
updateControls();

window.addEventListener("resize", () => {
  requestLayoutAwareRender();
  syncStickyHeaderHeight();
}, { passive: true });
if (typeof ResizeObserver === "function" && els.viewerWrap) {
  const layoutObserver = new ResizeObserver(() => requestLayoutAwareRender());
  layoutObserver.observe(els.viewerWrap);
}

async function loadPdf(source, name, options = {}) {
  const { preserveEdits = false } = options;
  const token = ++state.renderToken;
  state.pdfDoc = null;
  if (!preserveEdits) {
    state.pdfBytes = null;
  }
  state.pdfName = name;
  state.revealedCovers.clear();
  state.pageViews.clear();
  state.totalCovers = 0;
  if (!preserveEdits) {
    clearEdits({ rerender: false });
  } else {
    setEditMode(null);
  }
  resetEditHistory();
  els.viewer.replaceChildren();
  els.emptyState.hidden = true;
  updateControls();
  setStatus(`${name} を読み込んでいます...`);

  try {
    let pdfBytes = null;
    let documentSource = source;

    if (typeof source === "string") {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Unexpected server response (${response.status})`);
      }
      const buffer = await response.arrayBuffer();
      pdfBytes = new Uint8Array(buffer);
    } else {
      pdfBytes = source instanceof Uint8Array ? new Uint8Array(source) : new Uint8Array(source);
    }

    // PDF.js may transfer the ArrayBuffer to its worker and detach it.
    // Keep an independent copy for vector export and PDF merge.
    const exportBytes = pdfBytes.slice();
    documentSource = pdfBytes;

    const loadingTask = pdfjsLib.getDocument(buildPdfDocumentOptions(documentSource));
    const pdfDoc = await loadingTask.promise;
    if (token !== state.renderToken) {
      return false;
    }

    state.pdfDoc = pdfDoc;
    state.pdfBytes = exportBytes;
    await renderDocument();
    return true;
  } catch (error) {
    console.error(error);
    state.pdfDoc = null;
    state.pdfBytes = null;
    els.emptyState.hidden = false;
    els.viewer.replaceChildren();
    setStatus(formatPdfLoadError(error, name), "error");
    updateControls();
    return false;
  }
}

async function loadSamplePdf() {
  for (const candidate of SAMPLE_PDF_CANDIDATES) {
    if (await loadPdf(candidate.url, candidate.name)) {
      return;
    }
  }
}

function formatPdfLoadError(error, name) {
  const message = String(error?.message || "");

  if (message.includes("Missing PDF") || message.includes("Unexpected server response (404)")) {
    return `${name} が見つかりません。リポジトリ直下に main.pdf を置くか、「PDFを選択」から開いてください。`;
  }

  if (message.includes("Invalid PDF") || error?.name === "InvalidPDFException") {
    return `${name} は有効なPDFではありません。別のPDFファイルを選んでください。`;
  }

  if (window.location.protocol === "file:") {
    return "file:// ではサンプルPDFを開けません。ローカルサーバーで index.html を開くか、「PDFを選択」を使ってください。";
  }

  return "PDFを読み込めませんでした。ファイル形式または配置を確認してください。";
}

function buildPdfDocumentOptions(source) {
  const sourceOption = typeof source === "string" ? { url: source } : { data: source };

  return {
    ...sourceOption,
    cMapUrl: `${PDFJS_DIST_URL}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_DIST_URL}/standard_fonts/`,
    fontExtraProperties: true,
  };
}

async function renderDocument() {
  const token = ++state.renderToken;
  const { pdfDoc } = state;
  if (!pdfDoc) {
    return;
  }

  state.viewerWidth = getAvailableViewerWidth();
  state.pageViews.clear();
  state.totalCovers = 0;
  els.viewer.replaceChildren();
  els.emptyState.hidden = true;
  setStatus(`${state.pdfName} を解析しています...`);

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    if (token !== state.renderToken) {
      return;
    }
    const shell = await buildPageShell(pageNumber, token);
    if (token !== state.renderToken || !shell) {
      return;
    }
    els.viewer.append(shell);
  }

  if (token === state.renderToken) {
    setStatus(
      `${state.pdfName}: ${pdfDoc.numPages}ページ / 白い被せ物 ${state.totalCovers} 個を検出`,
    );
    updateControls();
  }
}

async function rerenderPage(pageNumber) {
  const pageView = state.pageViews.get(pageNumber);
  if (!pageView) {
    return;
  }
  const token = state.renderToken;
  const newShell = await buildPageShell(pageNumber, token);
  if (token !== state.renderToken || !newShell) {
    return;
  }
  pageView.shell.replaceWith(newShell);
  recountCovers();
  updateControls();
}

async function buildPageShell(pageNumber, token) {
  const page = await state.pdfDoc.getPage(pageNumber);
  if (token !== state.renderToken) {
    return null;
  }

  const baseViewport = page.getViewport({ scale: 1 });
  const renderScale = getRenderScaleForWidth(baseViewport.width);
  const viewport = page.getViewport({ scale: renderScale });
  const widthPt = Math.round(baseViewport.width * 10) / 10;
  const heightPt = Math.round(baseViewport.height * 10) / 10;

  const shell = document.createElement("article");
  shell.className = "page-shell";

  const label = document.createElement("div");
  label.className = "page-label";
  label.textContent = `${pageNumber} / ${state.pdfDoc.numPages}`;

  const pageNode = document.createElement("div");
  pageNode.className = "page";
  pageNode.style.width = `${viewport.width}px`;
  pageNode.style.height = `${viewport.height}px`;

  const coverLayer = document.createElement("div");
  coverLayer.className = "cover-layer";

  const editLayer = document.createElement("div");
  editLayer.className = "edit-layer";

  const outputScale = window.devicePixelRatio || 1;
  const { canvas, covers } = await paintPdfPage(page, pageNumber, viewport, renderScale, outputScale);
  if (token !== state.renderToken) {
    return null;
  }

  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  pageNode.append(canvas, coverLayer, editLayer);
  shell.append(label, pageNode);

  paintCoverHits(coverLayer, covers, pageNumber);
  await paintEditLayer(editLayer, page, pageNumber, viewport, pageNode);

  const pageView = {
    pageNumber,
    shell,
    coverCount: covers.length,
    coverKeys: covers.map((cover) => cover.key),
    widthPt,
    heightPt,
    viewport,
    renderScale,
  };
  state.pageViews.set(pageNumber, pageView);
  recountCovers();

  return shell;
}

async function paintPdfPage(page, pageNumber, viewport, renderScale, outputScale) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);

  const context = canvas.getContext("2d", { alpha: false });
  context.save();
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();

  const covers = [];
  const instrument = instrumentContext(context, {
    canvas,
    outputScale,
    pageNumber,
    viewport,
    covers,
  });

  await page.render({
    canvasContext: context,
    viewport,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
  }).promise;

  instrument.restore();
  await drawUserEditsOnCanvas(context, pageNumber, viewport, outputScale);
  return { canvas, covers };
}

async function downloadModifiedPdf() {
  const { pdfDoc, pdfName } = state;
  if (!pdfDoc || state.pageViews.size === 0) {
    return;
  }

  const token = state.renderToken;
  els.downloadRasterButton.disabled = true;
  els.downloadVectorButton.disabled = true;
  setStatus("PDFを作成しています（画像）...");

  try {
    const { PDFDocument } = await loadPdfLib();
    const outDoc = await PDFDocument.create();
    const pageCount = pdfDoc.numPages;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      if (token !== state.renderToken) {
        return;
      }

      const page = await pdfDoc.getPage(pageNumber);
      const view = state.pageViews.get(pageNumber);
      const widthPt = view?.widthPt ?? page.getViewport({ scale: 1 }).width;
      const heightPt = view?.heightPt ?? page.getViewport({ scale: 1 }).height;

      const exportViewport = page.getViewport({ scale: EXPORT_RENDER_SCALE });
      const { canvas } = await paintPdfPage(
        page,
        pageNumber,
        exportViewport,
        EXPORT_RENDER_SCALE,
        EXPORT_RENDER_SCALE,
      );

      const pngBytes = await canvasToPngBytes(canvas);
      const image = await outDoc.embedPng(pngBytes);
      const pdfPage = outDoc.addPage([widthPt, heightPt]);
      pdfPage.drawImage(image, {
        x: 0,
        y: 0,
        width: widthPt,
        height: heightPt,
      });
    }

    if (token !== state.renderToken) {
      return;
    }

    const bytes = await outDoc.save();
    triggerDownload(bytes, buildDownloadName(pdfName));
    setStatus(`${pdfName} の編集済みPDF（画像）をダウンロードしました。`);
  } catch (error) {
    console.error(error);
    setStatus(
      "PDFの作成に失敗しました。ネットワーク接続を確認するか、時間をおいて再試行してください。",
      "error",
    );
  } finally {
    if (token === state.renderToken) {
      updateControls();
    }
  }
}

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("canvas export failed"));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      "image/png",
    );
  });
}

function buildRevealedCoversForExport() {
  if (state.revealAllOverlays) {
    const keys = new Set();
    for (const view of state.pageViews.values()) {
      for (const key of view.coverKeys ?? []) {
        keys.add(key);
      }
    }
    return keys;
  }
  return new Set(state.revealedCovers);
}

async function downloadModifiedPdfVector() {
  const { pdfBytes, pdfName } = state;
  if (!pdfBytes || state.pageViews.size === 0) {
    return;
  }

  const token = state.renderToken;
  els.downloadRasterButton.disabled = true;
  els.downloadVectorButton.disabled = true;
  setStatus("PDFを作成しています（ベクター）...");

  try {
    const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
    const outDoc = await PDFDocument.load(pdfBytes.slice());
    const revealedCovers = buildRevealedCoversForExport();
    const transformOptions = {
      whiteThreshold: state.whiteThreshold,
      strokeWhiteThreshold: Math.min(state.whiteThreshold, STROKE_WHITE_THRESHOLD_CAP),
      revealedCovers,
      recolorText: state.recolorText,
      textColor: state.textColor,
    };
    if (needsContentStreamTransform(transformOptions)) {
      await transformPdfContent(outDoc, transformOptions);
    }
    await applyUserEditsToVectorPdf(outDoc, { StandardFonts, rgb });

    if (token !== state.renderToken) {
      return;
    }

    const bytes = await outDoc.save();
    triggerDownload(bytes, buildVectorDownloadName(pdfName));
    setStatus(`${pdfName} の編集済みPDF（ベクター）をダウンロードしました。`);
  } catch (error) {
    console.error("Vector PDF export failed:", error?.message ?? error, error);
    setStatus(
      "ベクターPDFの作成に失敗しました。画像で保存を試すか、別のPDFで再試行してください。",
      "error",
    );
  } finally {
    if (token === state.renderToken) {
      updateControls();
    }
  }
}

function buildDownloadName(name) {
  const base = name.replace(/\.pdf$/i, "") || "document";
  return `${base}_編集済み.pdf`;
}

function buildVectorDownloadName(name) {
  const base = name.replace(/\.pdf$/i, "") || "document";
  return `${base}_編集済み_ベクター.pdf`;
}

function triggerDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  URL.revokeObjectURL(url);
}

// PDF.js は要素をすべて 2D canvas に描画する。fillStyle が白に近い塗りつぶし
// (＝答えを隠す被せ物) や、白に近い文字をここで横取りして「消す / 色を変える」。
function instrumentContext(ctx, info) {
  const orig = {
    beginPath: ctx.beginPath.bind(ctx),
    moveTo: ctx.moveTo.bind(ctx),
    lineTo: ctx.lineTo.bind(ctx),
    rect: ctx.rect.bind(ctx),
    bezierCurveTo: ctx.bezierCurveTo.bind(ctx),
    quadraticCurveTo: ctx.quadraticCurveTo.bind(ctx),
    arc: ctx.arc.bind(ctx),
    arcTo: ctx.arcTo.bind(ctx),
    ellipse: ctx.ellipse.bind(ctx),
    closePath: ctx.closePath.bind(ctx),
    fill: ctx.fill.bind(ctx),
    fillRect: ctx.fillRect.bind(ctx),
    fillText: ctx.fillText.bind(ctx),
    stroke: ctx.stroke.bind(ctx),
    strokeRect: ctx.strokeRect.bind(ctx),
    strokeText: ctx.strokeText.bind(ctx),
  };

  let bbox = newBBox();
  let pathState = {
    hasCurve: false,
    hasLine: false,
    hasRect: false,
    opCount: 0,
    rectCount: 0,
  };
  const canvasArea = info.canvas.width * info.canvas.height;

  const resetPathState = () => {
    pathState = {
      hasCurve: false,
      hasLine: false,
      hasRect: false,
      opCount: 0,
      rectCount: 0,
    };
  };

  const isPureRectPath = () => pathState.hasRect && !pathState.hasLine && !pathState.hasCurve;

  const include = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    if (x < bbox.minX) bbox.minX = x;
    if (y < bbox.minY) bbox.minY = y;
    if (x > bbox.maxX) bbox.maxX = x;
    if (y > bbox.maxY) bbox.maxY = y;
  };

  ctx.beginPath = () => {
    bbox = newBBox();
    resetPathState();
    return orig.beginPath();
  };
  ctx.closePath = () => {
    pathState.opCount += 1;
    return orig.closePath();
  };
  ctx.moveTo = (x, y) => {
    include(x, y);
    pathState.hasLine = true;
    pathState.opCount += 1;
    return orig.moveTo(x, y);
  };
  ctx.lineTo = (x, y) => {
    include(x, y);
    pathState.hasLine = true;
    pathState.opCount += 1;
    return orig.lineTo(x, y);
  };
  ctx.rect = (x, y, w, h) => {
    include(x, y);
    include(x + w, y + h);
    pathState.hasRect = true;
    pathState.rectCount += 1;
    pathState.opCount += 1;
    return orig.rect(x, y, w, h);
  };
  ctx.bezierCurveTo = (cp1x, cp1y, cp2x, cp2y, x, y) => {
    include(cp1x, cp1y);
    include(cp2x, cp2y);
    include(x, y);
    pathState.hasCurve = true;
    pathState.opCount += 1;
    return orig.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  };
  ctx.quadraticCurveTo = (cpx, cpy, x, y) => {
    include(cpx, cpy);
    include(x, y);
    pathState.hasCurve = true;
    pathState.opCount += 1;
    return orig.quadraticCurveTo(cpx, cpy, x, y);
  };
  ctx.arc = (x, y, r, ...rest) => {
    include(x - r, y - r);
    include(x + r, y + r);
    pathState.hasCurve = true;
    pathState.opCount += 1;
    return orig.arc(x, y, r, ...rest);
  };
  ctx.arcTo = (x1, y1, x2, y2, r) => {
    include(x1, y1);
    include(x2, y2);
    pathState.hasCurve = true;
    pathState.opCount += 1;
    return orig.arcTo(x1, y1, x2, y2, r);
  };
  ctx.ellipse = (x, y, rx, ry, ...rest) => {
    include(x - rx, y - ry);
    include(x + rx, y + ry);
    pathState.hasCurve = true;
    pathState.opCount += 1;
    return orig.ellipse(x, y, rx, ry, ...rest);
  };

  const recolorThresholdFor = (styleProp) =>
    styleProp === "strokeStyle"
      ? Math.min(state.whiteThreshold, STROKE_WHITE_THRESHOLD_CAP)
      : state.whiteThreshold;

  // 被せ物候補かどうか判定し、必要なら描画をスキップする共通処理。
  const shouldRecolorNearWhite = (styleProp, threshold = recolorThresholdFor(styleProp)) => {
    const color = parseColor(ctx[styleProp]);
    return Boolean(color && isNearWhite(color, threshold));
  };

  const drawWithNearWhiteRecolor = (styleProp, drawOriginal) => {
    if (!shouldRecolorNearWhite(styleProp)) {
      drawOriginal();
      return;
    }
    const prev = ctx[styleProp];
    ctx[styleProp] = state.textColor;
    drawOriginal();
    ctx[styleProp] = prev;
  };

  const isSmallWhiteContent = (pdfBBox) =>
    pdfBBox.w * pdfBBox.h < SMALL_WHITE_ELEMENT_MAX_PDF_AREA;

  const cssBoxFromDevice = (device) => ({
    w: device.w / info.outputScale,
    h: device.h / info.outputScale,
  });

  const isThinWhiteBar = (cssBox) => cssBox.w < 3 || cssBox.h < 3;

  const isLinearWhiteSymbol = (cssBox) => {
    const minDim = Math.min(cssBox.w, cssBox.h);
    const maxDim = Math.max(cssBox.w, cssBox.h);
    return minDim > 0 && maxDim / minDim >= LINEAR_SYMBOL_ASPECT_RATIO;
  };

  const isWhiteOutlineGlyph = (pdfBBox, cssBox, coverMeta = {}) => {
    if (coverMeta.isAxisAlignedRect) {
      return isThinWhiteBar(cssBox);
    }
    if (isThinWhiteBar(cssBox) || isLinearWhiteSymbol(cssBox)) {
      return true;
    }
    if (coverMeta.hasCurve) {
      return true;
    }
    if (coverMeta.hasLine && isSmallWhiteContent(pdfBBox)) {
      return true;
    }
    return false;
  };

  const buildCoverMeta = (pathArg) => {
    if (pathArg?.__pathMeta) {
      return {
        isAxisAlignedRect: Boolean(pathArg.__pathMeta.isPureRect),
        hasCurve: Boolean(pathArg.__pathMeta.hasCurve),
        hasLine: Boolean(pathArg.__pathMeta.hasLine),
      };
    }
    return {
      isAxisAlignedRect: isPureRectPath(),
      hasCurve: pathState.hasCurve,
      hasLine: pathState.hasLine,
    };
  };

  const isPageBackgroundDevice = (device) => {
    const deviceArea = device.w * device.h;
    return canvasArea > 0 && deviceArea / canvasArea >= PAGE_BACKGROUND_AREA_RATIO;
  };

  const handleCover = (userBox, drawOriginal, styleProp = "fillStyle", coverMeta = {}) => {
    const color = parseColor(ctx[styleProp]);
    if (!color || !isNearWhite(color, recolorThresholdFor(styleProp))) {
      drawOriginal();
      return;
    }

    const device = transformBox(userBox, ctx.getTransform());
    if (!device) {
      drawOriginal();
      return;
    }

    const pdfBBox = deviceBoxToPdfBBox(device, info.outputScale, info.viewport);
    const cssBox = cssBoxFromDevice(device);

    if (isPageBackgroundDevice(device)) {
      drawOriginal();
      return;
    }

    if (isWhiteOutlineGlyph(pdfBBox, cssBox, coverMeta)) {
      drawOriginal();
      return;
    }

    const key = makeCoverKey(info.pageNumber, pdfBBox);
    const revealed = state.revealAllOverlays || state.revealedCovers.has(key);

    info.covers.push({
      key,
      revealed,
      x: device.x / info.outputScale,
      y: device.y / info.outputScale,
      w: cssBox.w,
      h: cssBox.h,
    });

    if (!revealed) {
      drawOriginal();
    }
  };

  const shouldRecolorWhiteStroke = (userBox) => {
    if (!state.recolorText || !shouldRecolorNearWhite("strokeStyle")) {
      return false;
    }
    const device = transformBox(userBox, ctx.getTransform());
    if (!device || isPageBackgroundDevice(device)) {
      return false;
    }
    const pdfBBox = deviceBoxToPdfBBox(device, info.outputScale, info.viewport);
    return shouldRecolorNearWhiteStroke(pdfBBox, ctx.lineWidth, pageRecolorOptions());
  };

  ctx.fill = (...args) => {
    const pathArg = args.find((a) => a && typeof a === "object" && a.__bbox);
    const source = pathArg ? pathArg.__bbox : bbox;
    if (!Number.isFinite(source.minX)) {
      return orig.fill(...args);
    }
    handleCover({ ...source }, () => orig.fill(...args), "fillStyle", buildCoverMeta(pathArg));
  };

  ctx.fillRect = (x, y, w, h) => {
    const userBox = {
      minX: Math.min(x, x + w),
      minY: Math.min(y, y + h),
      maxX: Math.max(x, x + w),
      maxY: Math.max(y, y + h),
    };
    handleCover(userBox, () => orig.fillRect(x, y, w, h), "fillStyle", { isAxisAlignedRect: true });
  };

  ctx.fillText = (...args) => {
    if (state.recolorText) {
      drawWithNearWhiteRecolor("fillStyle", () => orig.fillText(...args));
      return;
    }
    return orig.fillText(...args);
  };

  ctx.strokeText = (...args) => {
    if (state.recolorText) {
      drawWithNearWhiteRecolor("strokeStyle", () => orig.strokeText(...args));
      return;
    }
    return orig.strokeText(...args);
  };

  ctx.stroke = (...args) => {
    const pathArg = args.find((a) => a && typeof a === "object" && a.__bbox);
    const source = pathArg ? pathArg.__bbox : bbox;
    if (!Number.isFinite(source.minX)) {
      return orig.stroke(...args);
    }
    const userBox = { ...source };
    if (shouldRecolorWhiteStroke(userBox)) {
      drawWithNearWhiteRecolor("strokeStyle", () => orig.stroke(...args));
      return;
    }
    orig.stroke(...args);
  };

  ctx.strokeRect = (x, y, w, h) => {
    const userBox = {
      minX: Math.min(x, x + w),
      minY: Math.min(y, y + h),
      maxX: Math.max(x, x + w),
      maxY: Math.max(y, y + h),
    };
    if (shouldRecolorWhiteStroke(userBox)) {
      drawWithNearWhiteRecolor("strokeStyle", () => orig.strokeRect(x, y, w, h));
      return;
    }
    orig.strokeRect(x, y, w, h);
  };

  return {
    restore() {
      Object.assign(ctx, {
        beginPath: orig.beginPath,
        moveTo: orig.moveTo,
        lineTo: orig.lineTo,
        rect: orig.rect,
        bezierCurveTo: orig.bezierCurveTo,
        quadraticCurveTo: orig.quadraticCurveTo,
        arc: orig.arc,
        arcTo: orig.arcTo,
        ellipse: orig.ellipse,
        closePath: orig.closePath,
        fill: orig.fill,
        fillRect: orig.fillRect,
        fillText: orig.fillText,
        stroke: orig.stroke,
        strokeRect: orig.strokeRect,
        strokeText: orig.strokeText,
      });
    },
  };
}

function paintCoverHits(layer, covers, pageNumber) {
  const fragment = document.createDocumentFragment();

  covers.forEach((cover) => {
    const hit = document.createElement("button");
    hit.type = "button";
    hit.className = `cover-hit${cover.revealed ? " revealed" : ""}`;
    hit.style.left = `${cover.x}px`;
    hit.style.top = `${cover.y}px`;
    hit.style.width = `${cover.w}px`;
    hit.style.height = `${cover.h}px`;
    hit.title = cover.revealed
      ? "クリックで再び隠す"
      : "クリックでこの被せ物を消して答えを表示";
    hit.setAttribute(
      "aria-label",
      cover.revealed ? "被せ物を再表示" : "被せ物を消して答えを表示",
    );

    hit.addEventListener("click", (event) => {
      event.preventDefault();
      pushEditHistory();
      if (state.revealedCovers.has(cover.key)) {
        state.revealedCovers.delete(cover.key);
      } else {
        state.revealedCovers.add(cover.key);
      }
      rerenderPage(pageNumber);
    });

    fragment.append(hit);
  });

  layer.replaceChildren(fragment);
}

function recountCovers() {
  let total = 0;
  for (const view of state.pageViews.values()) {
    total += view.coverCount || 0;
  }
  state.totalCovers = total;
}

function syncStickyHeaderHeight() {
  if (!els.stickyHeader) {
    return;
  }
  const height = Math.ceil(els.stickyHeader.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--header-height", `${height}px`);
}

function cloneImagePlacements(placements) {
  return placements.map((placement) => ({
    ...placement,
    imageBytes: placement.imageBytes instanceof Uint8Array
      ? new Uint8Array(placement.imageBytes)
      : placement.imageBytes,
  }));
}

function createEditSnapshot() {
  return {
    textEdits: structuredClone(state.textEdits),
    imagePlacements: cloneImagePlacements(state.imagePlacements),
    revealedCovers: [...state.revealedCovers],
    revealAllOverlays: state.revealAllOverlays,
    recolorText: state.recolorText,
    textColor: state.textColor,
    whiteThreshold: state.whiteThreshold,
    editIdCounter: state.editIdCounter,
  };
}

function applyEditSnapshot(snapshot) {
  state.textEdits = structuredClone(snapshot.textEdits);
  state.imagePlacements = cloneImagePlacements(snapshot.imagePlacements);
  state.revealedCovers = new Set(snapshot.revealedCovers);
  state.revealAllOverlays = snapshot.revealAllOverlays;
  state.recolorText = snapshot.recolorText;
  state.textColor = snapshot.textColor;
  state.whiteThreshold = snapshot.whiteThreshold;
  state.editIdCounter = snapshot.editIdCounter;
  state.textEditTarget = null;
  state.pendingImage = null;
  state.selectedImageId = null;
  imageResizeSession = null;

  els.revealOverlaysToggle.checked = state.revealAllOverlays;
  els.recolorToggle.checked = state.recolorText;
  els.colorInput.value = state.textColor;
  els.thresholdInput.value = String(state.whiteThreshold);
  els.thresholdValue.textContent = String(state.whiteThreshold);
}

function resetEditHistory() {
  state.editHistory.past = [];
  state.editHistory.future = [];
  updateControls();
}

function pushEditHistory() {
  if (state.suppressHistory) {
    return;
  }
  state.editHistory.past.push(createEditSnapshot());
  if (state.editHistory.past.length > MAX_EDIT_HISTORY) {
    state.editHistory.past.shift();
  }
  state.editHistory.future = [];
  updateControls();
}

function undoEdit() {
  if (!state.editHistory.past.length) {
    return;
  }
  state.editHistory.future.push(createEditSnapshot());
  const snapshot = state.editHistory.past.pop();
  applyEditSnapshot(snapshot);
  setEditMode(null);
  if (state.pdfDoc) {
    renderDocument();
  } else {
    updateControls();
  }
  setStatus("編集を元に戻しました。");
}

function redoEdit() {
  if (!state.editHistory.future.length) {
    return;
  }
  state.editHistory.past.push(createEditSnapshot());
  const snapshot = state.editHistory.future.pop();
  applyEditSnapshot(snapshot);
  setEditMode(null);
  if (state.pdfDoc) {
    renderDocument();
  } else {
    updateControls();
  }
  setStatus("編集をやり直しました。");
}

function wireUndoRedo() {
  els.undoButton?.addEventListener("click", () => undoEdit());
  els.redoButton?.addEventListener("click", () => redoEdit());

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || key !== "z") {
      return;
    }

    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      active?.isContentEditable
    ) {
      return;
    }

    if (event.shiftKey) {
      if (!state.editHistory.future.length) {
        return;
      }
      event.preventDefault();
      redoEdit();
      return;
    }

    if (!state.editHistory.past.length) {
      return;
    }
    event.preventDefault();
    undoEdit();
  });
}

function updateControls() {
  const hasPdf = Boolean(state.pdfDoc);
  const hasEdits = state.textEdits.length > 0 || state.imagePlacements.length > 0;
  els.downloadRasterButton.disabled = !hasPdf;
  els.downloadVectorButton.disabled = !hasPdf || !state.pdfBytes;
  els.resetButton.disabled = !hasPdf;
  els.coverCount.textContent = String(state.totalCovers);

  const revealedVisible = state.revealAllOverlays
    ? state.totalCovers
    : state.revealedCovers.size;
  els.revealedCount.textContent = String(revealedVisible);

  if (els.textEditModeButton) {
    els.textEditModeButton.disabled = !hasPdf;
    els.textEditModeButton.classList.toggle("active", state.editMode === "text");
  }
  if (els.addTextModeButton) {
    els.addTextModeButton.disabled = !hasPdf;
    els.addTextModeButton.classList.toggle("active", state.editMode === "add-text");
  }
  if (els.imageInsertModeButton) {
    els.imageInsertModeButton.disabled = !hasPdf;
    els.imageInsertModeButton.classList.toggle("active", state.editMode === "image");
  }
  if (els.mergePdfInput) {
    els.mergePdfInput.disabled = !hasPdf;
  }
  if (els.clearEditsButton) {
    els.clearEditsButton.disabled = !hasPdf || !hasEdits;
  }
  if (els.textEditCount) {
    els.textEditCount.textContent = String(state.textEdits.length);
  }
  if (els.imageEditCount) {
    els.imageEditCount.textContent = String(state.imagePlacements.length);
  }
  if (els.undoButton) {
    els.undoButton.disabled = state.editHistory.past.length === 0;
  }
  if (els.redoButton) {
    els.redoButton.disabled = state.editHistory.future.length === 0;
  }
  updateEditModeHint();
}

function setStatus(message, type = "") {
  els.status.textContent = message;
  els.status.className = `status ${message ? "visible" : ""} ${type}`.trim();
}

function getAvailableViewerWidth() {
  const width = els.viewerWrap?.clientWidth ?? els.viewer?.clientWidth ?? window.innerWidth;
  return Math.max(0, Math.floor(width));
}

function getRenderScaleForWidth(baseWidth) {
  if (!Number.isFinite(baseWidth) || baseWidth <= 0) {
    return state.scale;
  }

  const availableWidth = getAvailableViewerWidth();
  if (availableWidth <= 0) {
    return state.scale;
  }

  const fitScale = availableWidth / baseWidth;
  if (window.matchMedia('(max-width: 860px)').matches) {
    return fitScale;
  }

  return Math.min(state.scale, fitScale);
}

function requestLayoutAwareRender() {
  if (!state.pdfDoc) {
    return;
  }

  const nextViewerWidth = getAvailableViewerWidth();
  if (Math.abs(nextViewerWidth - state.viewerWidth) < 1) {
    return;
  }

  if (layoutRerenderFrame) {
    cancelAnimationFrame(layoutRerenderFrame);
  }

  layoutRerenderFrame = requestAnimationFrame(() => {
    layoutRerenderFrame = 0;
    renderDocument();
  });
}

function newBBox() {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
}

function includeInto(bbox, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }
  if (x < bbox.minX) bbox.minX = x;
  if (y < bbox.minY) bbox.minY = y;
  if (x > bbox.maxX) bbox.maxX = x;
  if (y > bbox.maxY) bbox.maxY = y;
}

function transformBox(box, matrix) {
  if (!Number.isFinite(box.minX) || !Number.isFinite(box.maxX)) {
    return null;
  }
  const corners = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [px, py] of corners) {
    const dx = matrix.a * px + matrix.c * py + matrix.e;
    const dy = matrix.b * px + matrix.d * py + matrix.f;
    if (dx < minX) minX = dx;
    if (dy < minY) minY = dy;
    if (dx > maxX) maxX = dx;
    if (dy > maxY) maxY = dy;
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function deviceBoxToPdfBBox(device, outputScale, viewport) {
  const x1 = device.x / outputScale;
  const y1 = device.y / outputScale;
  const x2 = (device.x + device.w) / outputScale;
  const y2 = (device.y + device.h) / outputScale;
  const corners = [
    viewport.convertToPdfPoint(x1, y1),
    viewport.convertToPdfPoint(x2, y1),
    viewport.convertToPdfPoint(x1, y2),
    viewport.convertToPdfPoint(x2, y2),
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [px, py] of corners) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function isNearWhite(color, threshold) {
  return (
    color.a >= 0.85 &&
    color.r >= threshold &&
    color.g >= threshold &&
    color.b >= threshold
  );
}

function parseColor(value) {
  if (typeof value !== "string") {
    return null;
  }
  const s = value.trim().toLowerCase();

  if (s === "white") {
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    return null;
  }

  const match = s.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(",").map((p) => p.trim());
    if (parts.length >= 3) {
      return {
        r: parseChannel(parts[0]),
        g: parseChannel(parts[1]),
        b: parseChannel(parts[2]),
        a: parts[3] === undefined ? 1 : Number(parts[3]),
      };
    }
  }

  return null;
}

function parseChannel(part) {
  if (part.endsWith("%")) {
    return Math.round((Number(part.slice(0, -1)) / 100) * 255);
  }
  const value = Number(part);
  if (value >= 0 && value <= 1) {
    return Math.round(value * 255);
  }
  return value;
}

function initThemeToggle() {
  if (!els.themeToggle) {
    return;
  }

  const syncThemeIcon = () => {
    const isDark = document.documentElement.classList.contains("dark");
    if (els.themeIcon) {
      els.themeIcon.textContent = isDark ? "☀" : "☾";
    }
    els.themeToggle.setAttribute("aria-label", isDark ? "ライトモードに切り替え" : "ダークモードに切り替え");
  };

  syncThemeIcon();

  els.themeToggle.addEventListener("click", () => {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("theme", isDark ? "dark" : "light");
    syncThemeIcon();
  });
}

function wireFileInputs() {
  const inputs = [els.fileInput, els.emptyFileInput].filter(Boolean);
  for (const input of inputs) {
    input.addEventListener("change", async (event) => {
      const [file] = event.target.files;
      if (!file) {
        return;
      }
      for (const other of inputs) {
        if (other !== input) {
          other.value = "";
        }
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      await loadPdf(bytes, file.name);
    });
  }
}

function wireSampleButtons() {
  if (els.emptySampleButton) {
    els.emptySampleButton.addEventListener("click", () => loadSamplePdf());
  }
}

function wireEditControls() {
  if (els.textEditModeButton) {
    els.textEditModeButton.addEventListener("click", () => {
      setEditMode(state.editMode === "text" ? null : "text");
    });
  }

  if (els.addTextModeButton) {
    els.addTextModeButton.addEventListener("click", () => {
      setEditMode(state.editMode === "add-text" ? null : "add-text");
    });
  }

  if (els.imageInsertModeButton) {
    els.imageInsertModeButton.addEventListener("click", () => {
      if (state.editMode === "image") {
        setEditMode(null);
        return;
      }
      els.imageFileInput?.click();
    });
  }

  if (els.imageFileInput) {
    els.imageFileInput.addEventListener("change", async (event) => {
      const [file] = event.target.files;
      event.target.value = "";
      if (!file) {
        return;
      }
      await setPendingImage(file);
      setEditMode("image");
    });
  }

  if (els.mergePdfInput) {
    els.mergePdfInput.addEventListener("change", async (event) => {
      const [file] = event.target.files;
      event.target.value = "";
      if (!file) {
        return;
      }
      await mergePdfFile(file);
    });
  }

  if (els.clearEditsButton) {
    els.clearEditsButton.addEventListener("click", () => {
      pushEditHistory();
      clearEdits();
    });
  }

  if (els.textEditDelete) {
    els.textEditDelete.addEventListener("click", () => {
      deleteTextEditFromDialog();
    });
  }

  if (els.textEditDialog) {
    els.textEditDialog.addEventListener("close", () => {
      state.textEditTarget = null;
    });
  }

  if (els.textEditCancel) {
    els.textEditCancel.addEventListener("click", () => {
      els.textEditDialog?.close("cancel");
    });
  }

  const textEditForm = els.textEditDialog?.querySelector("form");
  if (textEditForm) {
    textEditForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveTextEditFromDialog();
    });
  }
}

function setEditMode(mode) {
  state.editMode = mode;
  if (mode !== "image") {
    state.pendingImage = null;
  }
  if (state.pdfDoc) {
    void refreshEditLayers();
  } else {
    updateControls();
  }
}

async function refreshEditLayers() {
  const pages = [...state.pageViews.keys()];
  for (const pageNumber of pages) {
    await rerenderPage(pageNumber);
  }
  updateControls();
}

function updateEditModeHint() {
  if (!els.editModeHint) {
    return;
  }
  if (state.editMode === "text") {
    els.editModeHint.textContent =
      "文字をクリックして編集します。元の文字は白で覆い、新しい文字を重ねて表示します。";
  } else if (state.editMode === "add-text") {
    els.editModeHint.textContent =
      "配置したい位置をクリックして、新しいテキストボックスを追加します。追加したボックスは再度クリックして編集・削除できます。";
  } else if (state.editMode === "image" && state.pendingImage) {
    els.editModeHint.textContent =
      "配置したいページをクリックしてください。画像はクリック位置を左上として配置されます。配置後は角をドラッグしてサイズ変更できます（Shift で縦横比固定）。";
  } else if (state.editMode === "image") {
    els.editModeHint.textContent = "画像ファイルを選択してください。";
  } else if (state.imagePlacements.length > 0) {
    els.editModeHint.textContent =
      "挿入した画像をクリックして選択し、角のハンドルをドラッグしてサイズを変更できます（Shift で縦横比固定）。";
  } else {
    els.editModeHint.textContent =
      "編集モードを選ぶと、PDF上で文字をクリックして変更するか、画像を配置できます。穴埋め解除のクリック操作は一時的に無効になります。";
  }
}

function generateEditId(prefix) {
  state.editIdCounter += 1;
  return `${prefix}-${state.editIdCounter}`;
}

function clearEdits({ rerender = true } = {}) {
  state.textEdits = [];
  state.imagePlacements = [];
  state.pendingImage = null;
  state.selectedImageId = null;
  imageResizeSession = null;
  state.textEditTarget = null;
  setEditMode(null);
  if (rerender && state.pdfDoc) {
    renderDocument();
  } else {
    updateControls();
  }
}

async function setPendingImage(file) {
  const mimeType = file.type || guessImageMimeType(file.name);
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    setStatus("PNG / JPEG / WebP 形式の画像を選んでください。", "error");
    return;
  }

  const imageBytes = new Uint8Array(await file.arrayBuffer());
  const dimensions = await readImageDimensions(imageBytes, mimeType);
  state.pendingImage = {
    imageBytes,
    mimeType,
    width: dimensions.width,
    height: dimensions.height,
    name: file.name,
  };
  updateEditModeHint();
}

function guessImageMimeType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  return "image/jpeg";
}

function readImageDimensions(imageBytes, mimeType) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([imageBytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    image.src = url;
  });
}

async function mergePdfFile(file) {
  if (!state.pdfBytes) {
    return;
  }

  pushEditHistory();
  setStatus(`${file.name} を結合しています...`);
  try {
    const { PDFDocument } = await loadPdfLib();
    const appendBytes = new Uint8Array(await file.arrayBuffer());
    const baseDoc = await PDFDocument.load(state.pdfBytes.slice());
    const appendDoc = await PDFDocument.load(appendBytes);
    const copiedPages = await baseDoc.copyPages(appendDoc, appendDoc.getPageIndices());
    for (const page of copiedPages) {
      baseDoc.addPage(page);
    }
    const mergedBytes = await baseDoc.save();
    const mergedName = state.pdfName.replace(/\.pdf$/i, "") + "_結合.pdf";
    await loadPdf(mergedBytes, mergedName, { preserveEdits: true });
    setStatus(`${file.name} の ${appendDoc.getPageCount()} ページを結合しました。`);
  } catch (error) {
    console.error(error);
    setStatus("PDFの結合に失敗しました。別のPDFで再試行してください。", "error");
  }
}

function findTextEditForSpan(pageNumber, span) {
  return state.textEdits.find(
    (edit) =>
      edit.pageNumber === pageNumber &&
      edit.originalText === span.originalText &&
      Math.abs((edit.baselineX ?? edit.x) - span.x) < 0.5 &&
      Math.abs((edit.baselineY ?? edit.y) - span.y) < 0.5,
  );
}

function makeTextEditId(pageNumber, span) {
  return `text:${pageNumber}:${Math.round(span.x * 10)}:${Math.round(span.y * 10)}:${span.index}`;
}

async function paintEditLayer(layer, page, pageNumber, viewport, pageNode) {
  layer.replaceChildren();
  pageNode.classList.remove("edit-mode-text", "edit-mode-image", "edit-mode-add-text");
  if (state.editMode === "text") {
    pageNode.classList.add("edit-mode-text");
    await paintTextEditHits(layer, page, pageNumber, viewport);
    paintAddedTextHits(layer, pageNumber, viewport);
  } else if (state.editMode === "add-text") {
    pageNode.classList.add("edit-mode-add-text");
    paintAddTextPlacementHandler(layer, pageNumber, viewport, pageNode, page);
    paintAddedTextHits(layer, pageNumber, viewport);
  } else if (state.editMode === "image") {
    pageNode.classList.add("edit-mode-image");
    paintImagePlacementHandler(layer, pageNumber, viewport, pageNode);
  } else {
    paintAddedTextHits(layer, pageNumber, viewport, { passive: true });
  }

  paintImagePlacements(layer, pageNumber, viewport, pageNode);
  paintImageSelectionDeselect(layer, pageNumber);
}

async function paintTextEditHits(layer, page, pageNumber, viewport) {
  const spans = await getTextSpansForPage(page);
  const fragment = document.createDocumentFragment();

  for (const span of spans) {
    const cssBox = pdfBBoxToCssBox(span.bbox, viewport);
    const existingEdit = findTextEditForSpan(pageNumber, span);
    const hit = document.createElement("button");
    hit.type = "button";
    hit.className = `text-hit${existingEdit ? " edited" : ""}`;
    hit.style.left = `${cssBox.x}px`;
    hit.style.top = `${cssBox.y}px`;
    hit.style.width = `${Math.max(cssBox.w, 6)}px`;
    hit.style.height = `${Math.max(cssBox.h, 4)}px`;
    hit.title = existingEdit
      ? `編集済み: ${existingEdit.newText}`
      : `クリックして編集: ${span.originalText}`;
    hit.setAttribute("aria-label", hit.title);

    hit.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTextEditDialog(pageNumber, span, existingEdit);
    });

    fragment.append(hit);
  }

  layer.append(fragment);
}

function paintAddedTextHits(layer, pageNumber, viewport, options = {}) {
  const { passive = false } = options;
  const newEdits = state.textEdits.filter(
    (edit) => edit.pageNumber === pageNumber && edit.isNew,
  );
  if (!newEdits.length) {
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const edit of newEdits) {
    const cssBox = pdfBBoxToCssBox(
      {
        x: edit.x,
        y: edit.y,
        w: Math.max(edit.width, estimateTextWidth(edit.newText, edit.fontSize)),
        h: edit.height,
      },
      viewport,
    );
    const hit = document.createElement("button");
    hit.type = "button";
    hit.className = "text-hit new-text edited";
    hit.style.left = `${cssBox.x}px`;
    hit.style.top = `${cssBox.y}px`;
    hit.style.width = `${Math.max(cssBox.w, 12)}px`;
    hit.style.height = `${Math.max(cssBox.h, 4)}px`;
    hit.title = `追加テキスト: ${edit.newText}`;
    hit.setAttribute("aria-label", hit.title);

    if (!passive) {
      hit.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openTextEditDialogForEdit(edit);
      });
    } else {
      hit.style.pointerEvents = "none";
    }

    fragment.append(hit);
  }

  layer.append(fragment);
}

function paintAddTextPlacementHandler(layer, pageNumber, viewport, pageNode, page) {
  if (layer._addTextPlacementHandler) {
    layer.removeEventListener("click", layer._addTextPlacementHandler);
  }

  const handler = (event) => {
    if (state.editMode !== "add-text") {
      return;
    }
    const rect = pageNode.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const pdfPoint = viewport.convertToPdfPoint(cssX, cssY);
    void openAddTextDialog(pageNumber, pdfPoint[0], pdfPoint[1], page);
  };

  layer._addTextPlacementHandler = handler;
  layer.addEventListener("click", handler);
}

async function inferFontNearPoint(page, pdfX, pdfY) {
  const spans = await getTextSpansForPage(page);
  let nearest = null;
  let minDistance = Infinity;

  for (const span of spans) {
    const distance = Math.hypot(span.x - pdfX, span.y - pdfY);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = span;
    }
  }

  if (nearest && minDistance <= 72) {
    return extractSpanFontFields(
      {
        fontFamily: nearest.fontFamily,
        fontSubstitution: nearest.fontSubstitution,
        fontSubstitutionLoadedName: nearest.fontSubstitutionLoadedName,
        vertical: nearest.fontVertical,
      },
      {
        fontName: nearest.fontName,
      },
    );
  }

  return {
    fontName: null,
    fontFamily: null,
    fontSubstitution: null,
    fontSubstitutionLoadedName: null,
    fontVertical: false,
  };
}

function buildTextEditMetrics(text, fontSize, baselineX, baselineY) {
  const width = estimateTextWidth(text, fontSize);
  const height = fontSize * 1.2;
  return {
    x: baselineX,
    y: baselineY - fontSize * 0.85,
    width,
    height,
    baselineX,
    baselineY,
    fontSize,
  };
}

async function openAddTextDialog(pageNumber, pdfX, pdfY, page) {
  if (!els.textEditDialog || !els.textEditInput) {
    return;
  }

  const fontFields = await inferFontNearPoint(page, pdfX, pdfY);
  state.textEditTarget = {
    mode: "add",
    pageNumber,
    pdfX,
    pdfY,
    fontFields,
  };

  configureTextEditDialog({
    title: "テキストを追加",
    originalLabel: `ページ ${pageNumber} のクリック位置に追加`,
    value: "",
    showExtra: true,
    showDelete: false,
    fontSize: DEFAULT_NEW_TEXT_SIZE,
    color: state.textColor === "#ffffff" ? "#000000" : state.textColor,
  });

  els.textEditDialog.showModal();
  els.textEditInput.focus();
}

function openTextEditDialogForEdit(edit) {
  if (!els.textEditDialog || !els.textEditInput) {
    return;
  }

  state.textEditTarget = {
    mode: "edit-existing",
    existingEdit: edit,
    id: edit.id,
    pageNumber: edit.pageNumber,
  };

  configureTextEditDialog({
    title: edit.isNew ? "追加テキストを編集" : "文字を編集",
    originalLabel: edit.isNew ? "追加したテキストボックス" : `元の文字: ${edit.originalText}`,
    value: edit.newText,
    showExtra: Boolean(edit.isNew),
    showDelete: true,
    fontSize: edit.fontSize,
    color: edit.textColor ?? "#000000",
  });

  els.textEditDialog.showModal();
  els.textEditInput.focus();
  els.textEditInput.select();
}

function configureTextEditDialog({
  title,
  originalLabel,
  value,
  showExtra,
  showDelete,
  fontSize,
  color,
}) {
  if (els.textEditTitle) {
    els.textEditTitle.textContent = title;
  }
  if (els.textEditOriginal) {
    els.textEditOriginal.textContent = originalLabel;
    els.textEditOriginal.hidden = !originalLabel;
  }
  els.textEditInput.value = value;
  if (els.textEditExtraFields) {
    els.textEditExtraFields.hidden = !showExtra;
  }
  if (els.textEditSize) {
    els.textEditSize.value = String(fontSize ?? DEFAULT_NEW_TEXT_SIZE);
  }
  if (els.textEditColor) {
    els.textEditColor.value = color ?? "#000000";
  }
  if (els.textEditDelete) {
    els.textEditDelete.hidden = !showDelete;
  }
}

function openTextEditDialog(pageNumber, span, existingEdit) {
  if (!els.textEditDialog || !els.textEditInput || !els.textEditOriginal) {
    return;
  }

  state.textEditTarget = {
    mode: "edit-span",
    pageNumber,
    span,
    existingEdit,
    id: existingEdit?.id ?? makeTextEditId(pageNumber, span),
  };

  configureTextEditDialog({
    title: "文字を編集",
    originalLabel: `元の文字: ${span.originalText}`,
    value: existingEdit?.newText ?? span.originalText,
    showExtra: false,
    showDelete: Boolean(existingEdit),
    fontSize: span.fontSize,
    color: existingEdit?.textColor ?? "#000000",
  });

  els.textEditDialog.showModal();
  els.textEditInput.focus();
  els.textEditInput.select();
}

function parseTextEditDialogOptions() {
  const fontSize = Number(els.textEditSize?.value) || DEFAULT_NEW_TEXT_SIZE;
  const textColor = els.textEditColor?.value || "#000000";
  return {
    fontSize: Math.min(200, Math.max(4, fontSize)),
    textColor,
  };
}

function saveTextEditFromDialog() {
  const target = state.textEditTarget;
  if (!target || !els.textEditInput) {
    return;
  }

  const newText = els.textEditInput.value;
  if (!newText.trim()) {
    setStatus("空の文字には変更できません。", "error");
    return;
  }

  pushEditHistory();

  if (target.mode === "add") {
    saveNewTextEditFromDialog(target, newText);
    return;
  }

  if (target.mode === "edit-existing") {
    updateExistingTextEditFromDialog(target.existingEdit, newText);
    return;
  }

  saveSpanTextEditFromDialog(target, newText);
}

function saveNewTextEditFromDialog(target, newText) {
  const { fontSize, textColor } = parseTextEditDialogOptions();
  const metrics = buildTextEditMetrics(newText, fontSize, target.pdfX, target.pdfY);
  const edit = {
    id: generateEditId("newtext"),
    pageNumber: target.pageNumber,
    isNew: true,
    newText,
    originalText: "",
    textColor,
    ...metrics,
    ...target.fontFields,
  };

  state.textEdits.push(edit);
  els.textEditDialog?.close("save");
  rerenderPage(target.pageNumber);
  setStatus(`ページ ${target.pageNumber} にテキストを追加しました。`);
  updateControls();
}

function updateExistingTextEditFromDialog(existingEdit, newText) {
  const index = state.textEdits.findIndex((item) => item.id === existingEdit.id);
  if (index < 0) {
    return;
  }

  const { fontSize, textColor } = existingEdit.isNew
    ? parseTextEditDialogOptions()
    : { fontSize: existingEdit.fontSize, textColor: existingEdit.textColor ?? "#000000" };

  const baselineX = existingEdit.baselineX ?? existingEdit.x;
  const baselineY = existingEdit.baselineY ?? existingEdit.y;
  const metrics = existingEdit.isNew
    ? buildTextEditMetrics(newText, fontSize, baselineX, baselineY)
    : {
        x: existingEdit.x,
        y: existingEdit.y,
        width: Math.max(existingEdit.width, estimateTextWidth(newText, fontSize)),
        height: existingEdit.height,
        baselineX,
        baselineY,
        fontSize,
      };

  state.textEdits[index] = {
    ...existingEdit,
    ...metrics,
    newText,
    textColor,
  };

  els.textEditDialog?.close("save");
  rerenderPage(existingEdit.pageNumber);
  setStatus(`ページ ${existingEdit.pageNumber} の文字を更新しました。`);
  updateControls();
}

function saveSpanTextEditFromDialog(target, newText) {
  const { pageNumber, span, existingEdit, id } = target;
  const edit = {
    id,
    pageNumber,
    x: span.bbox.x,
    y: span.bbox.y,
    width: span.bbox.w,
    height: span.bbox.h,
    baselineX: span.x,
    baselineY: span.y,
    fontSize: span.fontSize,
    fontName: span.fontName ?? null,
    fontFamily: span.fontFamily ?? null,
    fontSubstitution: span.fontSubstitution ?? null,
    fontSubstitutionLoadedName: span.fontSubstitutionLoadedName ?? null,
    fontVertical: span.fontVertical ?? false,
    textColor: "#000000",
    newText,
    originalText: span.originalText,
  };

  if (existingEdit) {
    const index = state.textEdits.findIndex((item) => item.id === existingEdit.id);
    if (index >= 0) {
      state.textEdits[index] = edit;
    }
  } else {
    state.textEdits.push(edit);
  }

  els.textEditDialog?.close("save");
  rerenderPage(pageNumber);
  setStatus(`ページ ${pageNumber} の文字を編集しました。`);
  updateControls();
}

function deleteTextEditFromDialog() {
  const edit = state.textEditTarget?.existingEdit;
  if (!edit) {
    return;
  }

  pushEditHistory();
  state.textEdits = state.textEdits.filter((item) => item.id !== edit.id);
  els.textEditDialog?.close("delete");
  rerenderPage(edit.pageNumber);
  setStatus(`ページ ${edit.pageNumber} の編集を削除しました。`);
  updateControls();
}

function paintImagePlacementHandler(layer, pageNumber, viewport, pageNode) {
  if (!state.pendingImage) {
    return;
  }

  if (layer._imagePlacementHandler) {
    layer.removeEventListener("click", layer._imagePlacementHandler);
  }

  const handler = (event) => {
    if (!state.pendingImage || state.editMode !== "image") {
      return;
    }
    const rect = pageNode.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const pdfPoint = viewport.convertToPdfPoint(cssX, cssY);
    placeImageOnPage(pageNumber, pdfPoint[0], pdfPoint[1], viewport);
  };

  layer._imagePlacementHandler = handler;
  layer.addEventListener("click", handler);
}

function placeImageOnPage(pageNumber, pdfX, pdfY, viewport) {
  if (!state.pendingImage) {
    return;
  }

  pushEditHistory();

  const pageView = state.pageViews.get(pageNumber);
  const pageWidth = pageView?.widthPt ?? viewport.width;
  const maxWidth = Math.min(200, pageWidth * 0.4);
  const aspect = state.pendingImage.width / state.pendingImage.height;
  const width = maxWidth;
  const height = width / aspect;

  const placement = {
    id: generateEditId("image"),
    pageNumber,
    x: pdfX,
    y: pdfY - height,
    width,
    height,
    imageBytes: state.pendingImage.imageBytes,
    mimeType: state.pendingImage.mimeType,
  };

  state.imagePlacements.push(placement);
  state.selectedImageId = placement.id;
  rerenderPage(pageNumber);
  setStatus(`ページ ${pageNumber} に画像を配置しました。角をドラッグしてサイズを変更できます。`);
  updateControls();
}

function findImagePlacement(placementId) {
  return state.imagePlacements.find((item) => item.id === placementId) ?? null;
}

function getPdfPointFromPageEvent(event, pageNode, viewport) {
  const rect = pageNode.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  const cssY = event.clientY - rect.top;
  return viewport.convertToPdfPoint(cssX, cssY);
}

function applyPlacementBoxToWrap(wrap, placement, viewport) {
  const cssBox = pdfBBoxToCssBox(
    { x: placement.x, y: placement.y, w: placement.width, h: placement.height },
    viewport,
  );
  wrap.style.left = `${cssBox.x}px`;
  wrap.style.top = `${cssBox.y}px`;
  wrap.style.width = `${cssBox.w}px`;
  wrap.style.height = `${cssBox.h}px`;
}

function computeResizedImagePlacement(placement, corner, pdfPoint, keepAspect) {
  const anchorRight = placement.x + placement.width;
  const anchorTop = placement.y + placement.height;
  const aspect = placement.width / placement.height;
  let x;
  let y;
  let width;
  let height;

  switch (corner) {
    case "se": {
      width = pdfPoint[0] - placement.x;
      height = anchorTop - pdfPoint[1];
      break;
    }
    case "sw": {
      width = anchorRight - pdfPoint[0];
      height = anchorTop - pdfPoint[1];
      break;
    }
    case "ne": {
      width = pdfPoint[0] - placement.x;
      height = pdfPoint[1] - placement.y;
      break;
    }
    case "nw": {
      width = anchorRight - pdfPoint[0];
      height = pdfPoint[1] - placement.y;
      break;
    }
    default:
      return {
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
      };
  }

  if (keepAspect) {
    if (width / height > aspect) {
      width = height * aspect;
    } else {
      height = width / aspect;
    }
  }

  width = Math.max(MIN_IMAGE_SIZE_PT, width);
  height = Math.max(MIN_IMAGE_SIZE_PT, height);

  switch (corner) {
    case "se":
      x = placement.x;
      y = anchorTop - height;
      break;
    case "sw":
      x = anchorRight - width;
      y = anchorTop - height;
      break;
    case "ne":
      x = placement.x;
      y = placement.y;
      break;
    case "nw":
      x = anchorRight - width;
      y = placement.y;
      break;
    default:
      x = placement.x;
      y = placement.y;
      break;
  }

  return { x, y, width, height };
}

function startImageResize(event, placement, corner, viewport, pageNumber, pageNode, wrap) {
  event.preventDefault();
  event.stopPropagation();
  pushEditHistory();

  imageResizeSession = {
    placementId: placement.id,
    corner,
    viewport,
    pageNumber,
    pageNode,
    wrap,
    startPlacement: {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
    },
  };

  const onMove = (moveEvent) => {
    if (!imageResizeSession) {
      return;
    }
    const session = imageResizeSession;
    const current = findImagePlacement(session.placementId);
    if (!current) {
      return;
    }

    const pdfPoint = getPdfPointFromPageEvent(moveEvent, session.pageNode, session.viewport);
    const next = computeResizedImagePlacement(
      session.startPlacement,
      session.corner,
      pdfPoint,
      moveEvent.shiftKey,
    );
    current.x = next.x;
    current.y = next.y;
    current.width = next.width;
    current.height = next.height;
    applyPlacementBoxToWrap(session.wrap, current, session.viewport);
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    if (!imageResizeSession) {
      return;
    }
    const session = imageResizeSession;
    imageResizeSession = null;
    rerenderPage(session.pageNumber);
    setStatus(`ページ ${session.pageNumber} の画像サイズを変更しました。`);
    updateControls();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function wireImagePlacementWrap(wrap, placement, viewport, pageNumber, pageNode) {
  wrap.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.classList.contains("image-resize-handle")) {
      return;
    }
    event.stopPropagation();
    if (state.selectedImageId !== placement.id) {
      state.selectedImageId = placement.id;
      rerenderPage(pageNumber);
    }
  });

  for (const handle of wrap.querySelectorAll(".image-resize-handle")) {
    handle.addEventListener("pointerdown", (event) => {
      const corner = handle.dataset.corner;
      if (!corner) {
        return;
      }
      startImageResize(event, placement, corner, viewport, pageNumber, pageNode, wrap);
    });
  }
}

function paintImageSelectionDeselect(layer, pageNumber) {
  if (layer._imageSelectionDeselectHandler) {
    layer.removeEventListener("pointerdown", layer._imageSelectionDeselectHandler);
  }

  const handler = (event) => {
    if (event.target instanceof Element && event.target.closest(".image-placement-wrap")) {
      return;
    }
    if (state.selectedImageId) {
      state.selectedImageId = null;
      rerenderPage(pageNumber);
    }
  };

  layer._imageSelectionDeselectHandler = handler;
  layer.addEventListener("pointerdown", handler);
}

function paintImagePlacements(layer, pageNumber, viewport, pageNode) {
  const placements = state.imagePlacements.filter((item) => item.pageNumber === pageNumber);
  const fragment = document.createDocumentFragment();

  for (const placement of placements) {
    const cssBox = pdfBBoxToCssBox(
      { x: placement.x, y: placement.y, w: placement.width, h: placement.height },
      viewport,
    );
    const wrap = document.createElement("div");
    wrap.className = "image-placement-wrap";
    if (state.selectedImageId === placement.id) {
      wrap.classList.add("selected");
    }
    wrap.dataset.placementId = placement.id;
    wrap.style.left = `${cssBox.x}px`;
    wrap.style.top = `${cssBox.y}px`;
    wrap.style.width = `${cssBox.w}px`;
    wrap.style.height = `${cssBox.h}px`;

    const image = document.createElement("img");
    image.className = "image-placement";
    image.alt = "挿入画像";
    image.draggable = false;
    const blob = new Blob([placement.imageBytes], { type: placement.mimeType });
    image.src = URL.createObjectURL(blob);
    image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
    wrap.append(image);

    if (state.selectedImageId === placement.id) {
      for (const corner of IMAGE_RESIZE_CORNERS) {
        const handle = document.createElement("div");
        handle.className = `image-resize-handle image-resize-handle-${corner}`;
        handle.dataset.corner = corner;
        handle.setAttribute("aria-label", "画像サイズを変更");
        wrap.append(handle);
      }
    }

    wireImagePlacementWrap(wrap, placement, viewport, pageNumber, pageNode);
    fragment.append(wrap);
  }

  layer.append(fragment);
}

async function drawUserEditsOnCanvas(context, pageNumber, viewport, outputScale) {
  const textEdits = state.textEdits.filter((edit) => edit.pageNumber === pageNumber);
  const imagePlacements = state.imagePlacements.filter((item) => item.pageNumber === pageNumber);
  if (textEdits.length === 0 && imagePlacements.length === 0) {
    return;
  }

  context.save();
  if (outputScale !== 1) {
    context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
  }

  for (const edit of textEdits) {
    await drawTextEditOnCanvas(context, edit, viewport);
  }

  for (const placement of imagePlacements) {
    await drawImagePlacementOnCanvas(context, placement, viewport);
  }

  context.restore();
}

async function drawTextEditOnCanvas(context, edit, viewport) {
  const pad = 1;
  const whiteoutWidth = Math.max(
    edit.width,
    estimateTextWidth(edit.newText, edit.fontSize) + pad * 2,
  );
  const cssBox = pdfBBoxToCssBox(
    {
      x: edit.x - pad,
      y: edit.y - pad,
      w: whiteoutWidth + pad,
      h: edit.height + pad * 2,
    },
    viewport,
  );

  context.fillStyle = "#ffffff";
  context.fillRect(cssBox.x, cssBox.y, cssBox.w, cssBox.h);

  const baseline = viewport.convertToViewportPoint(
    edit.baselineX ?? edit.x,
    edit.baselineY ?? edit.y,
  );
  context.fillStyle = edit.textColor ?? "#000000";
  context.font = state.pdfBytes
    ? await resolveCanvasFontAsync(edit, viewport.scale, state.pdfBytes, {
        loadPdfLib,
        indexEmbeddedPdfFonts,
      })
    : resolveCanvasFont(edit, viewport.scale);
  context.textBaseline = "alphabetic";
  context.fillText(edit.newText, baseline[0], baseline[1]);
}

async function drawImagePlacementOnCanvas(context, placement, viewport) {
  const cssBox = pdfBBoxToCssBox(
    { x: placement.x, y: placement.y, w: placement.width, h: placement.height },
    viewport,
  );
  const blob = new Blob([placement.imageBytes], { type: placement.mimeType });
  const url = URL.createObjectURL(blob);

  try {
    const image = await loadHtmlImage(url);
    context.drawImage(image, cssBox.x, cssBox.y, cssBox.w, cssBox.h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadHtmlImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = url;
  });
}

async function applyUserEditsToVectorPdf(outDoc, { StandardFonts, rgb }) {
  if (state.textEdits.length === 0 && state.imagePlacements.length === 0) {
    return;
  }

  const fontResolver = new PdfFontResolver(outDoc, { StandardFonts });
  fontResolver.ensureIndexed();

  for (const edit of state.textEdits) {
    const page = outDoc.getPage(edit.pageNumber - 1);
    const font = await fontResolver.resolveFontForEdit(edit);
    const pad = 1;
    const whiteoutWidth = Math.max(
      edit.width,
      estimateTextWidth(edit.newText, edit.fontSize) + pad * 2,
    );
    page.drawRectangle({
      x: edit.x - pad,
      y: edit.y - pad,
      width: whiteoutWidth + pad,
      height: edit.height + pad * 2,
      color: rgb(1, 1, 1),
      borderWidth: 0,
    });
    page.drawText(edit.newText, {
      x: edit.baselineX ?? edit.x,
      y: edit.baselineY ?? edit.y,
      size: edit.fontSize,
      font,
      color: parseHexColorRgb(edit.textColor ?? "#000000", rgb),
    });
  }

  for (const placement of state.imagePlacements) {
    const page = outDoc.getPage(placement.pageNumber - 1);
    let embeddedImage;
    if (placement.mimeType === "image/png") {
      embeddedImage = await outDoc.embedPng(placement.imageBytes);
    } else if (placement.mimeType === "image/jpeg") {
      embeddedImage = await outDoc.embedJpg(placement.imageBytes);
    } else {
      const pngBytes = await convertImageToPngBytes(placement.imageBytes, placement.mimeType);
      embeddedImage = await outDoc.embedPng(pngBytes);
    }
    page.drawImage(embeddedImage, {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
    });
  }
}

async function convertImageToPngBytes(imageBytes, mimeType) {
  const blob = new Blob([imageBytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadHtmlImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return canvasToPngBytes(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseHexColorRgb(hex, rgb) {
  const color = parseColor(hex);
  if (!color) {
    return rgb(0, 0, 0);
  }
  return rgb(color.r / 255, color.g / 255, color.b / 255);
}
