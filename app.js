import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/build/pdf.worker.mjs";

// PDF.js は図形を Path2D として組み立て、`ctx.fill(path2d)` で描画する。
// その Path2D のバウンディングボックスを記録できるよう、Path2D を差し替える。
installTrackedPath2D();

const state = {
  pdfDoc: null,
  pdfName: "",
  scale: 1,
  renderToken: 0,
  // 穴埋め解除の設定
  revealAllOverlays: false,
  recolorText: false,
  textColor: "#dd1133",
  // 「白」とみなす最小の明るさ (0-255)。値が小さいほど薄いグレーも対象になる。
  whiteThreshold: 238,
  // 個別に表示した被せ物のキー (`page:index`)
  revealedCovers: new Set(),
  // ページごとの描画情報
  pageViews: new Map(),
  // 統計
  totalCovers: 0,
};

const els = {
  fileInput: document.querySelector("#file-input"),
  sampleButton: document.querySelector("#sample-button"),
  revealOverlaysToggle: document.querySelector("#reveal-overlays"),
  recolorToggle: document.querySelector("#recolor-text"),
  colorInput: document.querySelector("#text-color"),
  thresholdInput: document.querySelector("#white-threshold"),
  thresholdValue: document.querySelector("#white-threshold-value"),
  scaleSelect: document.querySelector("#scale-select"),
  printButton: document.querySelector("#print-button"),
  resetButton: document.querySelector("#reset-button"),
  coverCount: document.querySelector("#cover-count"),
  revealedCount: document.querySelector("#revealed-count"),
  emptyState: document.querySelector("#empty-state"),
  status: document.querySelector("#status"),
  viewer: document.querySelector("#viewer"),
};

els.fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) {
    return;
  }
  await loadPdf(await file.arrayBuffer(), file.name);
});

els.sampleButton.addEventListener("click", () => loadPdf("./main.pdf", "main.pdf"));

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

els.printButton.addEventListener("click", () => window.print());

window.addEventListener("beforeprint", applyPrintLayout);
window.addEventListener("afterprint", clearPrintLayout);

els.colorInput.value = state.textColor;
els.thresholdInput.value = String(state.whiteThreshold);
els.thresholdValue.textContent = String(state.whiteThreshold);
updateControls();

async function loadPdf(source, name) {
  const token = ++state.renderToken;
  state.pdfDoc = null;
  state.pdfName = name;
  state.revealedCovers.clear();
  state.pageViews.clear();
  state.totalCovers = 0;
  els.viewer.replaceChildren();
  els.emptyState.hidden = true;
  updateControls();
  setStatus(`${name} を読み込んでいます...`);

  try {
    const loadingTask =
      typeof source === "string"
        ? pdfjsLib.getDocument({ url: source })
        : pdfjsLib.getDocument({ data: source });
    const pdfDoc = await loadingTask.promise;
    if (token !== state.renderToken) {
      return;
    }

    state.pdfDoc = pdfDoc;
    await renderDocument();
  } catch (error) {
    console.error(error);
    state.pdfDoc = null;
    els.emptyState.hidden = false;
    els.viewer.replaceChildren();
    setStatus("PDFを読み込めませんでした。ファイル形式または配置を確認してください。", "error");
    updateControls();
  }
}

async function renderDocument() {
  const token = ++state.renderToken;
  const { pdfDoc } = state;
  if (!pdfDoc) {
    return;
  }

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

  const viewport = page.getViewport({ scale: state.scale });

  const printViewport = page.getViewport({ scale: 1 });
  const widthPt = Math.round(printViewport.width * 10) / 10;
  const heightPt = Math.round(printViewport.height * 10) / 10;

  const shell = document.createElement("article");
  shell.className = "page-shell";
  shell.dataset.page = String(pageNumber);

  const label = document.createElement("div");
  label.className = "page-label";
  label.textContent = `${pageNumber} / ${state.pdfDoc.numPages}`;

  const pageNode = document.createElement("div");
  pageNode.className = "page";
  pageNode.style.width = `${viewport.width}px`;
  pageNode.style.height = `${viewport.height}px`;
  pageNode.style.setProperty("--print-width", `${widthPt}pt`);
  pageNode.style.setProperty("--print-height", `${heightPt}pt`);

  const canvas = document.createElement("canvas");
  const coverLayer = document.createElement("div");
  coverLayer.className = "cover-layer";

  pageNode.append(canvas, coverLayer);
  shell.append(label, pageNode);

  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const context = canvas.getContext("2d", { alpha: false });
  // 被せ物を消したときに下が黒くならないよう、背景を白で塗っておく。
  context.save();
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();

  const covers = [];
  const instrument = instrumentContext(context, {
    canvas,
    outputScale,
    pageNumber,
    covers,
  });

  await page.render({
    canvasContext: context,
    viewport,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
  }).promise;

  instrument.restore();

  if (token !== state.renderToken) {
    return null;
  }

  paintCoverHits(coverLayer, covers, pageNumber);

  const pageView = {
    pageNumber,
    shell,
    coverCount: covers.length,
    widthPt,
    heightPt,
  };
  state.pageViews.set(pageNumber, pageView);
  recountCovers();

  return shell;
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
  let coverIndex = 0;
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

    const id = coverIndex++;
    const key = `${info.pageNumber}:${id}`;
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
  els.printButton.disabled = !hasPdf;
  els.resetButton.disabled = !hasPdf;
  els.coverCount.textContent = String(state.totalCovers);

  const revealedVisible = state.revealAllOverlays
    ? state.totalCovers
    : state.revealedCovers.size;
  els.revealedCount.textContent = String(revealedVisible);
}

function setStatus(message, type = "") {
  els.status.textContent = message;
  els.status.className = `status ${message ? "visible" : ""} ${type}`.trim();
}

let printStyleEl = null;

function applyPrintLayout() {
  if (!state.pdfDoc || state.pageViews.size === 0) {
    return;
  }

  const rules = ["@page { margin: 0; }"];
  const sorted = [...state.pageViews.values()].sort((a, b) => a.pageNumber - b.pageNumber);

  for (const view of sorted) {
    const pageName = `pdf-page-${view.pageNumber}`;
    rules.push(
      `@page ${pageName} { size: ${view.widthPt}pt ${view.heightPt}pt; margin: 0; }`,
      `.page-shell[data-page="${view.pageNumber}"] { page: ${pageName}; }`,
    );
  }

  if (!printStyleEl) {
    printStyleEl = document.createElement("style");
    printStyleEl.id = "print-page-rules";
    document.head.append(printStyleEl);
  }
  printStyleEl.textContent = rules.join("\n");
  document.body.classList.add("is-printing");
}

function clearPrintLayout() {
  document.body.classList.remove("is-printing");
  if (printStyleEl) {
    printStyleEl.textContent = "";
  }
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
