import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/build/pdf.worker.mjs";

const state = {
  pdfDoc: null,
  pdfName: "",
  scale: 1,
  tool: "text",
  masks: [],
  history: [],
  pageViews: new Map(),
  nextMaskId: 1,
  renderToken: 0,
};

const els = {
  fileInput: document.querySelector("#file-input"),
  sampleButton: document.querySelector("#sample-button"),
  textTool: document.querySelector("#text-tool"),
  areaTool: document.querySelector("#area-tool"),
  toolHelp: document.querySelector("#tool-help"),
  scaleSelect: document.querySelector("#scale-select"),
  printButton: document.querySelector("#print-button"),
  undoButton: document.querySelector("#undo-button"),
  resetButton: document.querySelector("#reset-button"),
  hiddenCount: document.querySelector("#hidden-count"),
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
els.textTool.addEventListener("click", () => setTool("text"));
els.areaTool.addEventListener("click", () => setTool("area"));
els.undoButton.addEventListener("click", undoLastMask);
els.resetButton.addEventListener("click", resetMasks);
els.printButton.addEventListener("click", () => window.print());

setTool("text");
updateControls();

async function loadPdf(source, name) {
  const token = ++state.renderToken;
  state.pdfDoc = null;
  state.pdfName = name;
  state.masks = [];
  state.history = [];
  state.pageViews.clear();
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
  els.viewer.replaceChildren();
  els.emptyState.hidden = true;
  setStatus(`${state.pdfName} を描画しています...`);

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    if (token !== state.renderToken) {
      return;
    }
    await renderPage(pageNumber, token);
  }

  if (token === state.renderToken) {
    setStatus(`${state.pdfName} を表示中: ${pdfDoc.numPages}ページ`);
    updateControls();
  }
}

async function renderPage(pageNumber, token) {
  const page = await state.pdfDoc.getPage(pageNumber);
  if (token !== state.renderToken) {
    return;
  }

  const viewport = page.getViewport({ scale: state.scale });
  const shell = document.createElement("article");
  shell.className = "page-shell";

  const label = document.createElement("div");
  label.className = "page-label";
  label.textContent = `${pageNumber} / ${state.pdfDoc.numPages}`;

  const pageNode = document.createElement("div");
  pageNode.className = "page";
  pageNode.style.width = `${viewport.width}px`;
  pageNode.style.height = `${viewport.height}px`;

  const canvas = document.createElement("canvas");
  const maskLayer = document.createElement("div");
  maskLayer.className = "mask-layer";
  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";

  pageNode.append(canvas, maskLayer, textLayer);
  shell.append(label, pageNode);
  els.viewer.append(shell);

  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const context = canvas.getContext("2d", { alpha: false });
  await page.render({
    canvasContext: context,
    viewport,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
  }).promise;

  const pageView = {
    pageNumber,
    width: viewport.width,
    height: viewport.height,
    node: pageNode,
    maskLayer,
    textLayer,
  };
  state.pageViews.set(pageNumber, pageView);

  attachAreaEvents(pageView);
  await renderTextHitTargets(page, viewport, pageView);
  renderStoredMasks(pageView);
}

async function renderTextHitTargets(page, viewport, pageView) {
  const textContent = await page.getTextContent();
  const fragment = document.createDocumentFragment();

  textContent.items.forEach((item, itemIndex) => {
    if (!item.str || !item.str.trim()) {
      return;
    }

    const rect = getTextRect(item, viewport);
    if (!rect || rect.width < 4 || rect.height < 4) {
      return;
    }

    const hit = document.createElement("button");
    hit.type = "button";
    hit.className = "text-hit";
    hit.dataset.page = String(pageView.pageNumber);
    hit.dataset.itemIndex = String(itemIndex);
    hit.style.left = `${rect.x}px`;
    hit.style.top = `${rect.y}px`;
    hit.style.width = `${rect.width}px`;
    hit.style.height = `${rect.height}px`;
    hit.title = `非表示: ${item.str.trim()}`;
    hit.setAttribute("aria-label", `テキストを非表示: ${item.str.trim()}`);

    if (isTextHidden(pageView.pageNumber, itemIndex)) {
      hit.classList.add("hidden");
      hit.disabled = true;
    }

    hit.addEventListener("click", (event) => {
      event.preventDefault();
      if (state.tool !== "text" || isTextHidden(pageView.pageNumber, itemIndex)) {
        return;
      }

      addMask(pageView, rect, "text", {
        itemIndex,
        label: item.str.trim(),
      });
      hit.classList.add("hidden");
      hit.disabled = true;
    });

    fragment.append(hit);
  });

  pageView.textLayer.replaceChildren(fragment);
}

function getTextRect(item, viewport) {
  const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const fontHeight = Math.hypot(transform[2], transform[3]);
  const width = Math.max(item.width * viewport.scale, Math.hypot(transform[0], transform[1]));
  const height = Math.max(fontHeight, item.height ? item.height * viewport.scale : fontHeight);
  const padding = Math.min(3, Math.max(1, height * 0.12));

  return clampRect(
    {
      x: transform[4] - padding,
      y: transform[5] - height - padding,
      width: width + padding * 2,
      height: height + padding * 2,
    },
    viewport.width,
    viewport.height,
  );
}

function attachAreaEvents(pageView) {
  let drag = null;

  pageView.node.addEventListener("pointerdown", (event) => {
    if (state.tool !== "area" || event.button !== 0) {
      return;
    }

    event.preventDefault();
    const start = getLocalPoint(event, pageView);
    const draft = document.createElement("div");
    draft.className = "hide-mask draft";
    pageView.maskLayer.append(draft);
    pageView.node.setPointerCapture(event.pointerId);
    drag = { start, current: start, draft };
    updateDraftMask(drag, pageView);
  });

  pageView.node.addEventListener("pointermove", (event) => {
    if (!drag) {
      return;
    }

    drag.current = getLocalPoint(event, pageView);
    updateDraftMask(drag, pageView);
  });

  pageView.node.addEventListener("pointerup", (event) => {
    if (!drag) {
      return;
    }

    drag.current = getLocalPoint(event, pageView);
    const rect = getDragRect(drag.start, drag.current, pageView);
    drag.draft.remove();
    pageView.node.releasePointerCapture(event.pointerId);
    drag = null;

    if (rect.width >= 8 && rect.height >= 8) {
      addMask(pageView, rect, "area", { label: "手動選択範囲" });
    }
  });

  pageView.node.addEventListener("pointercancel", () => {
    if (!drag) {
      return;
    }

    drag.draft.remove();
    drag = null;
  });
}

function getLocalPoint(event, pageView) {
  const bounds = pageView.node.getBoundingClientRect();
  const x = ((event.clientX - bounds.left) / bounds.width) * pageView.width;
  const y = ((event.clientY - bounds.top) / bounds.height) * pageView.height;
  return {
    x: clamp(x, 0, pageView.width),
    y: clamp(y, 0, pageView.height),
  };
}

function updateDraftMask(drag, pageView) {
  const rect = getDragRect(drag.start, drag.current, pageView);
  Object.assign(drag.draft.style, {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function getDragRect(start, current, pageView) {
  return clampRect(
    {
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x),
      height: Math.abs(current.y - start.y),
    },
    pageView.width,
    pageView.height,
  );
}

function addMask(pageView, rect, kind, details = {}) {
  const record = {
    id: `mask-${state.nextMaskId}`,
    pageNumber: pageView.pageNumber,
    kind,
    itemIndex: details.itemIndex ?? null,
    label: details.label ?? "",
    x: rect.x / pageView.width,
    y: rect.y / pageView.height,
    width: rect.width / pageView.width,
    height: rect.height / pageView.height,
  };

  state.nextMaskId += 1;
  state.masks.push(record);
  state.history.push(record);
  paintMask(pageView, record);
  updateControls();
}

function renderStoredMasks(pageView) {
  for (const record of state.masks) {
    if (record.pageNumber === pageView.pageNumber) {
      paintMask(pageView, record);
    }
  }
}

function paintMask(pageView, record) {
  const mask = document.createElement("div");
  mask.className = `hide-mask ${record.kind}`;
  mask.dataset.maskId = record.id;
  mask.title = record.label ? `非表示: ${record.label}` : "非表示範囲";
  Object.assign(mask.style, {
    left: `${record.x * pageView.width}px`,
    top: `${record.y * pageView.height}px`,
    width: `${record.width * pageView.width}px`,
    height: `${record.height * pageView.height}px`,
  });
  pageView.maskLayer.append(mask);
}

function undoLastMask() {
  const record = state.history.pop();
  if (!record) {
    return;
  }

  state.masks = state.masks.filter((mask) => mask.id !== record.id);
  document.querySelectorAll(`[data-mask-id="${record.id}"]`).forEach((node) => node.remove());

  if (record.kind === "text") {
    const selector = `.text-hit[data-page="${record.pageNumber}"][data-item-index="${record.itemIndex}"]`;
    const hit = document.querySelector(selector);
    if (hit) {
      hit.classList.remove("hidden");
      hit.disabled = false;
    }
  }

  updateControls();
}

function resetMasks() {
  state.masks = [];
  state.history = [];
  document.querySelectorAll(".hide-mask").forEach((node) => node.remove());
  document.querySelectorAll(".text-hit.hidden").forEach((node) => {
    node.classList.remove("hidden");
    node.disabled = false;
  });
  updateControls();
}

function isTextHidden(pageNumber, itemIndex) {
  return state.masks.some(
    (mask) => mask.kind === "text" && mask.pageNumber === pageNumber && mask.itemIndex === itemIndex,
  );
}

function setTool(tool) {
  state.tool = tool;
  document.body.classList.toggle("area-mode", tool === "area");
  els.textTool.classList.toggle("active", tool === "text");
  els.areaTool.classList.toggle("active", tool === "area");
  els.textTool.setAttribute("aria-pressed", String(tool === "text"));
  els.areaTool.setAttribute("aria-pressed", String(tool === "area"));
  els.toolHelp.textContent =
    tool === "text"
      ? "テキスト上にカーソルを重ね、薄い枠が出た要素をクリックすると隠せます。"
      : "PDF上で隠したい範囲をドラッグしてください。画像や図の一部も隠せます。";
}

function updateControls() {
  const hasPdf = Boolean(state.pdfDoc);
  const hasMasks = state.masks.length > 0;
  els.printButton.disabled = !hasPdf;
  els.undoButton.disabled = !hasMasks;
  els.resetButton.disabled = !hasMasks;
  els.hiddenCount.textContent = String(state.masks.length);
}

function setStatus(message, type = "") {
  els.status.textContent = message;
  els.status.className = `status ${message ? "visible" : ""} ${type}`.trim();
}

function clampRect(rect, maxWidth, maxHeight) {
  const x = clamp(rect.x, 0, maxWidth);
  const y = clamp(rect.y, 0, maxHeight);
  return {
    x,
    y,
    width: clamp(rect.width, 0, maxWidth - x),
    height: clamp(rect.height, 0, maxHeight - y),
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
