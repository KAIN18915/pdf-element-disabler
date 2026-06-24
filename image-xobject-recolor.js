const MIN_PIXEL_ALPHA = Math.round(255 * 0.85);

export function hexToByteRgb(hex) {
  const normalized = hex.replace("#", "");
  const full = normalized.length === 3
    ? normalized.split("").map((part) => part + part).join("")
    : normalized;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

export function recolorRgbaPixelData(data, threshold, targetRgb) {
  let changed = false;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];
    if (alpha < MIN_PIXEL_ALPHA) {
      continue;
    }
    if (red >= threshold && green >= threshold && blue >= threshold) {
      if (red !== targetRgb[0] || green !== targetRgb[1] || blue !== targetRgb[2]) {
        data[index] = targetRgb[0];
        data[index + 1] = targetRgb[1];
        data[index + 2] = targetRgb[2];
        changed = true;
      }
    }
  }
  return changed;
}

export function createBrowserImageRecolorEnv() {
  return {
    async recolorJpegBytes(jpegBytes, options) {
      const blob = new Blob([jpegBytes], { type: "image/jpeg" });
      const url = URL.createObjectURL(blob);
      try {
        const image = await loadHtmlImage(url);
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const threshold = options.whiteThreshold ?? 238;
        const targetRgb = hexToByteRgb(options.textColor ?? "#dd1133");
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const changed = recolorRgbaPixelData(imageData.data, threshold, targetRgb);
        if (!changed) {
          return jpegBytes;
        }
        context.putImageData(imageData, 0, 0);
        return await canvasToJpegBytes(canvas);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}

let nodeImageRecolorEnvPromise = null;

export async function getNodeImageRecolorEnv() {
  if (!nodeImageRecolorEnvPromise) {
    nodeImageRecolorEnvPromise = (async () => {
      const { createCanvas, loadImage } = await import("@napi-rs/canvas");
      return {
        async recolorJpegBytes(jpegBytes, options) {
          const image = await loadImage(Buffer.from(jpegBytes));
          const canvas = createCanvas(image.width, image.height);
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          const threshold = options.whiteThreshold ?? 238;
          const targetRgb = hexToByteRgb(options.textColor ?? "#dd1133");
          const imageData = context.getImageData(0, 0, image.width, image.height);
          const changed = recolorRgbaPixelData(imageData.data, threshold, targetRgb);
          if (!changed) {
            return jpegBytes;
          }
          context.putImageData(imageData, 0, 0);
          return canvas.encode("jpeg", 92);
        },
      };
    })();
  }
  return nodeImageRecolorEnvPromise;
}

export async function resolveImageRecolorEnv(options) {
  if (options.imageRecolorEnv) {
    return options.imageRecolorEnv;
  }
  if (typeof document !== "undefined") {
    return createBrowserImageRecolorEnv();
  }
  return getNodeImageRecolorEnv();
}

export async function recolorJpegImageBytes(jpegBytes, options, imageRecolorEnv) {
  const env = imageRecolorEnv ?? await resolveImageRecolorEnv(options);
  return env.recolorJpegBytes(jpegBytes, options);
}

function loadHtmlImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = url;
  });
}

function canvasToJpegBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("jpeg export failed"));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      "image/jpeg",
      0.92,
    );
  });
}
