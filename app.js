import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.624/legacy/build/pdf.mjs";
import { makeCoverKey, transformPdfContent } from "./pdf-content-transform.js";
const EXPORT_RENDER_SCALE = 2;
const PDFJS_DIST_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.624";
const PDF_LIB_URL = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js";
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
    pdfLibPromise = import(PDF_LIB_URL);
  }
  return pdfLibPromise;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_DIST_URL}/legacy/build/pdf.worker.mjs`;

// PDF.js は図形を Path2D として組み立て、`ctx.fill(path2d)` で描画する。
// その Path2D のバウンディングボックスを記録できるよう、Path2D を差し替える。
installTrackedPath2D();

const state = {
  pdfDoc: null,
  pdfBytes: null,
  pdfName: "",
  scale: 1,
  viewerWidth: 0,
  renderToken: 0,
  // 穴埋め解除の設定
  revealAllOverlays: false,
  recolorText: false,
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
  editIdCounter: 0,
  textEditTarget: null,
};

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
  imageInsertModeButton: document.querySelector("#image-insert-mode-button"),
  mergePdfInput: document.querySelector("#merge-pdf-input"),
  imageFileInput: document.querySelector("#image-file-input"),
  clearEditsButton: document.querySelector("#clear-edits-button"),
  textEditCount: document.querySelector("#text-edit-count"),
  imageEditCount: document.querySelector("#image-edit-count"),
  editModeHint: document.querySelector("#edit-mode-hint"),
  textEditDialog: document.querySelector("#text-edit-dialog"),
  textEditInput: document.querySelector("#text-edit-input"),
  textEditOriginal: document.querySelector("#text-edit-original"),
  textEditCancel: document.querySelector("#text-edit-cancel"),
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

els.downloadRasterButton.addEventListener("click", () => downloadModifiedPdf());
els.downloadVectorButton.addEventListener("click", () => downloadModifiedPdfVector());

wireEditControls();

els.colorInput.value = state.textColor;
els.thresholdInput.value = String(state.whiteThreshold);
els.thresholdValue.textContent = String(state.whiteThreshold);
updateControls();

window.addEventListener("resize", requestLayoutAwareRender, { passive: true });
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
      documentSource = pdfBytes;
    } else {
      pdfBytes = source instanceof Uint8Array ? source : new Uint8Array(source);
      documentSource = pdfBytes;
    }

    const loadingTask = pdfjsLib.getDocument(buildPdfDocumentOptions(documentSource));
    const pdfDoc = await loadingTask.promise;
    if (token !== state.renderToken) {
      return false;
    }

    state.pdfDoc = pdfDoc;
    state.pdfBytes = pdfBytes;
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
    await transformPdfContent(outDoc, {
      whiteThreshold: state.whiteThreshold,
      revealAllOverlays: state.revealAllOverlays,
      revealedCovers: state.revealedCovers,
      recolorText: state.recolorText,
      textColor: state.textColor,
    });
    await applyUserEditsToVectorPdf(outDoc, { StandardFonts, rgb });

    if (token !== state.renderToken) {
      return;
    }

    const bytes = await outDoc.save();
    triggerDownload(bytes, buildVectorDownloadName(pdfName));
    setStatus(`${pdfName} の編集済みPDF（ベクター）をダウンロードしました。`);
  } catch (error) {
    console.error(error);
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
    strokeText: ctx.strokeText.bind(ctx),
  };

  let bbox = newBBox();
  const canvasArea = info.canvas.width * info.canvas.height;

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
    return orig.beginPath();
  };
  ctx.closePath = () => orig.closePath();
  ctx.moveTo = (x, y) => {
    include(x, y);
    return orig.moveTo(x, y);
  };
  ctx.lineTo = (x, y) => {
    include(x, y);
    return orig.lineTo(x, y);
  };
  ctx.rect = (x, y, w, h) => {
    include(x, y);
    include(x + w, y + h);
    return orig.rect(x, y, w, h);
  };
  ctx.bezierCurveTo = (cp1x, cp1y, cp2x, cp2y, x, y) => {
    include(cp1x, cp1y);
    include(cp2x, cp2y);
    include(x, y);
    return orig.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  };
  ctx.quadraticCurveTo = (cpx, cpy, x, y) => {
    include(cpx, cpy);
    include(x, y);
    return orig.quadraticCurveTo(cpx, cpy, x, y);
  };
  ctx.arc = (x, y, r, ...rest) => {
    include(x - r, y - r);
    include(x + r, y + r);
    return orig.arc(x, y, r, ...rest);
  };
  ctx.arcTo = (x1, y1, x2, y2, r) => {
    include(x1, y1);
    include(x2, y2);
    return orig.arcTo(x1, y1, x2, y2, r);
  };
  ctx.ellipse = (x, y, rx, ry, ...rest) => {
    include(x - rx, y - ry);
    include(x + rx, y + ry);
    return orig.ellipse(x, y, rx, ry, ...rest);
  };

  // 被せ物候補かどうか判定し、必要なら描画をスキップする共通処理。
  const handleCover = (userBox, drawOriginal) => {
    const color = parseColor(ctx.fillStyle);
    if (!color || !isNearWhite(color, state.whiteThreshold)) {
      drawOriginal();
      return;
    }

    const device = transformBox(userBox, ctx.getTransform());
    if (!device) {
      drawOriginal();
      return;
    }

    const deviceArea = device.w * device.h;
    // ページ全体を覆う白塗り (背景) はそのまま描く。
    if (canvasArea > 0 && deviceArea / canvasArea >= 0.9) {
      drawOriginal();
      return;
    }

    const cssW = device.w / info.outputScale;
    const cssH = device.h / info.outputScale;
    if (cssW < 3 || cssH < 3) {
      // 細すぎる線などは対象外。
      drawOriginal();
      return;
    }

    const pdfBBox = deviceBoxToPdfBBox(device, info.outputScale, info.viewport);
    const key = makeCoverKey(info.pageNumber, pdfBBox);
    const revealed = state.revealAllOverlays || state.revealedCovers.has(key);

    info.covers.push({
      key,
      revealed,
      x: device.x / info.outputScale,
      y: device.y / info.outputScale,
      w: cssW,
      h: cssH,
    });

    if (!revealed) {
      drawOriginal();
    }
  };

  ctx.fill = (...args) => {
    // PDF.js は `ctx.fill(path2d)` の形で図形を描く。Path2D 側に記録した
    // バウンディングボックスがあればそれを使い、無ければ ctx のパスを使う。
    const pathArg = args.find((a) => a && typeof a === "object" && a.__bbox);
    const source = pathArg ? pathArg.__bbox : bbox;
    if (!Number.isFinite(source.minX)) {
      return orig.fill(...args);
    }
    const userBox = { ...source };
    handleCover(userBox, () => orig.fill(...args));
  };

  ctx.fillRect = (x, y, w, h) => {
    const userBox = {
      minX: Math.min(x, x + w),
      minY: Math.min(y, y + h),
      maxX: Math.max(x, x + w),
      maxY: Math.max(y, y + h),
    };
    handleCover(userBox, () => orig.fillRect(x, y, w, h));
  };

  ctx.fillText = (...args) => {
    if (state.recolorText) {
      const color = parseColor(ctx.fillStyle);
      if (color && isNearWhite(color, state.whiteThreshold)) {
        const prev = ctx.fillStyle;
        ctx.fillStyle = state.textColor;
        const result = orig.fillText(...args);
        ctx.fillStyle = prev;
        return result;
      }
    }
    return orig.fillText(...args);
  };

  ctx.strokeText = (...args) => {
    if (state.recolorText) {
      const color = parseColor(ctx.strokeStyle);
      if (color && isNearWhite(color, state.whiteThreshold)) {
        const prev = ctx.strokeStyle;
        ctx.strokeStyle = state.textColor;
        const result = orig.strokeText(...args);
        ctx.strokeStyle = prev;
        return result;
      }
    }
    return orig.strokeText(...args);
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

function installTrackedPath2D() {
  const Native = globalThis.Path2D;
  if (!Native || Native.__tracked) {
    return;
  }

  class TrackedPath2D extends Native {
    constructor(arg) {
      super(arg);
      this.__bbox = newBBox();
      // 既存パスを複製する場合は bbox も引き継ぐ。
      if (arg && typeof arg === "object" && arg.__bbox) {
        const b = arg.__bbox;
        includeInto(this.__bbox, b.minX, b.minY);
        includeInto(this.__bbox, b.maxX, b.maxY);
      }
    }

    moveTo(x, y) {
      includeInto(this.__bbox, x, y);
      return super.moveTo(x, y);
    }
    lineTo(x, y) {
      includeInto(this.__bbox, x, y);
      return super.lineTo(x, y);
    }
    rect(x, y, w, h) {
      includeInto(this.__bbox, x, y);
      includeInto(this.__bbox, x + w, y + h);
      return super.rect(x, y, w, h);
    }
    roundRect(x, y, w, h, r) {
      includeInto(this.__bbox, x, y);
      includeInto(this.__bbox, x + w, y + h);
      return super.roundRect(x, y, w, h, r);
    }
    bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
      includeInto(this.__bbox, cp1x, cp1y);
      includeInto(this.__bbox, cp2x, cp2y);
      includeInto(this.__bbox, x, y);
      return super.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
    quadraticCurveTo(cpx, cpy, x, y) {
      includeInto(this.__bbox, cpx, cpy);
      includeInto(this.__bbox, x, y);
      return super.quadraticCurveTo(cpx, cpy, x, y);
    }
    arc(x, y, r, ...rest) {
      includeInto(this.__bbox, x - r, y - r);
      includeInto(this.__bbox, x + r, y + r);
      return super.arc(x, y, r, ...rest);
    }
    arcTo(x1, y1, x2, y2, r) {
      includeInto(this.__bbox, x1, y1);
      includeInto(this.__bbox, x2, y2);
      return super.arcTo(x1, y1, x2, y2, r);
    }
    ellipse(x, y, rx, ry, ...rest) {
      includeInto(this.__bbox, x - rx, y - ry);
      includeInto(this.__bbox, x + rx, y + ry);
      return super.ellipse(x, y, rx, ry, ...rest);
    }
    addPath(path, transform) {
      if (path && path.__bbox && Number.isFinite(path.__bbox.minX)) {
        const b = path.__bbox;
        const corners = [
          [b.minX, b.minY],
          [b.maxX, b.minY],
          [b.minX, b.maxY],
          [b.maxX, b.maxY],
        ];
        for (const [px, py] of corners) {
          if (transform) {
            includeInto(
              this.__bbox,
              transform.a * px + transform.c * py + transform.e,
              transform.b * px + transform.d * py + transform.f,
            );
          } else {
            includeInto(this.__bbox, px, py);
          }
        }
      }
      return super.addPath(path, transform);
    }
  }

  TrackedPath2D.__tracked = true;
  globalThis.Path2D = TrackedPath2D;
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
  return Number(part);
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
    els.clearEditsButton.addEventListener("click", () => clearEdits());
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
  } else if (state.editMode === "image" && state.pendingImage) {
    els.editModeHint.textContent =
      "配置したいページをクリックしてください。画像はクリック位置を左上として配置されます。";
  } else if (state.editMode === "image") {
    els.editModeHint.textContent = "画像ファイルを選択してください。";
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

function getTextItemPdfBBox(item, style = {}) {
  const transform = item.transform;
  const fontSize = Math.hypot(transform[0], transform[1]);
  const fontHeight = Math.hypot(transform[2], transform[3]) || item.height || fontSize;
  const width = item.width || estimateTextWidth(item.str, fontSize);
  const ascent = (style.ascent ?? 0.75) * fontHeight;
  const descent = Math.abs(style.descent ?? 0.25) * fontHeight;

  const textSpaceCorners = [
    [0, -descent],
    [width, -descent],
    [0, ascent],
    [width, ascent],
  ];
  const userSpacePoints = textSpaceCorners.map(([tx, ty]) => applyPdfMatrix(transform, tx, ty));
  const bbox = pdfPointsToBBox(userSpacePoints);

  return {
    ...bbox,
    baselineX: transform[4],
    baselineY: transform[5],
    fontSize,
  };
}

async function getTextSpansForPage(page) {
  const textContent = await page.getTextContent();
  const spans = [];

  for (let index = 0; index < textContent.items.length; index += 1) {
    const item = textContent.items[index];
    if (!item.str || !item.str.trim()) {
      continue;
    }

    const style = textContent.styles[item.fontName] ?? {};
    const metrics = getTextItemPdfBBox(item, style);

    spans.push({
      index,
      originalText: item.str,
      x: metrics.baselineX,
      y: metrics.baselineY,
      bbox: {
        x: metrics.x,
        y: metrics.y,
        w: metrics.w,
        h: metrics.h,
      },
      width: metrics.w,
      height: metrics.h,
      fontSize: metrics.fontSize,
    });
  }

  return spans;
}

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * 0.55;
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
  pageNode.classList.remove("edit-mode-text", "edit-mode-image");
  if (state.editMode === "text") {
    pageNode.classList.add("edit-mode-text");
    await paintTextEditHits(layer, page, pageNumber, viewport);
  } else if (state.editMode === "image") {
    pageNode.classList.add("edit-mode-image");
    paintImagePlacementHandler(layer, pageNumber, viewport, pageNode);
  }

  paintImagePlacements(layer, pageNumber, viewport);
}

async function paintTextEditHits(layer, page, pageNumber, viewport) {
  const spans = await getTextSpansForPage(page);
  const fragment = document.createDocumentFragment();

  for (const span of spans) {
    const cssBox = pdfBoxToCssBox(span.bbox, viewport);
    const existingEdit = findTextEditForSpan(pageNumber, span);
    const hit = document.createElement("button");
    hit.type = "button";
    hit.className = `text-hit${existingEdit ? " edited" : ""}`;
    hit.style.left = `${cssBox.x}px`;
    hit.style.top = `${cssBox.y}px`;
    hit.style.width = `${Math.max(cssBox.w, 8)}px`;
    hit.style.height = `${Math.max(cssBox.h, 8)}px`;
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

function openTextEditDialog(pageNumber, span, existingEdit) {
  if (!els.textEditDialog || !els.textEditInput || !els.textEditOriginal) {
    return;
  }

  state.textEditTarget = {
    pageNumber,
    span,
    existingEdit,
    id: existingEdit?.id ?? makeTextEditId(pageNumber, span),
  };
  els.textEditOriginal.textContent = `元の文字: ${span.originalText}`;
  els.textEditInput.value = existingEdit?.newText ?? span.originalText;
  els.textEditDialog.showModal();
  els.textEditInput.focus();
  els.textEditInput.select();
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
  rerenderPage(pageNumber);
  setStatus(`ページ ${pageNumber} に画像を配置しました。`);
  updateControls();
}

function paintImagePlacements(layer, pageNumber, viewport) {
  const placements = state.imagePlacements.filter((item) => item.pageNumber === pageNumber);
  const fragment = document.createDocumentFragment();

  for (const placement of placements) {
    const cssBox = pdfBoxToCssBox(
      { x: placement.x, y: placement.y, w: placement.width, h: placement.height },
      viewport,
    );
    const image = document.createElement("img");
    image.className = "image-placement";
    image.alt = "挿入画像";
    image.style.left = `${cssBox.x}px`;
    image.style.top = `${cssBox.y}px`;
    image.style.width = `${cssBox.w}px`;
    image.style.height = `${cssBox.h}px`;
    const blob = new Blob([placement.imageBytes], { type: placement.mimeType });
    image.src = URL.createObjectURL(blob);
    image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
    fragment.append(image);
  }

  layer.append(fragment);
}

function pdfBoxToCssBox(pdfBBox, viewport) {
  const x1 = pdfBBox.x;
  const y1 = pdfBBox.y;
  const x2 = pdfBBox.x + pdfBBox.w;
  const y2 = pdfBBox.y + pdfBBox.h;
  const corners = [
    viewport.convertToViewportPoint(x1, y1),
    viewport.convertToViewportPoint(x2, y1),
    viewport.convertToViewportPoint(x1, y2),
    viewport.convertToViewportPoint(x2, y2),
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [px, py] of corners) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
    drawTextEditOnCanvas(context, edit, viewport);
  }

  for (const placement of imagePlacements) {
    await drawImagePlacementOnCanvas(context, placement, viewport);
  }

  context.restore();
}

function drawTextEditOnCanvas(context, edit, viewport) {
  const pad = 1;
  const whiteoutWidth = Math.max(
    edit.width,
    estimateTextWidth(edit.newText, edit.fontSize) + pad * 2,
  );
  const cssBox = pdfBoxToCssBox(
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
  const fontSizeCss = edit.fontSize * viewport.scale;
  context.fillStyle = "#000000";
  context.font = `${fontSizeCss}px Helvetica, Arial, sans-serif`;
  context.textBaseline = "alphabetic";
  context.fillText(edit.newText, baseline[0], baseline[1]);
}

async function drawImagePlacementOnCanvas(context, placement, viewport) {
  const cssBox = pdfBoxToCssBox(
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

  const helvetica = await outDoc.embedFont(StandardFonts.Helvetica);

  for (const edit of state.textEdits) {
    const page = outDoc.getPage(edit.pageNumber - 1);
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
      font: helvetica,
      color: rgb(0, 0, 0),
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
