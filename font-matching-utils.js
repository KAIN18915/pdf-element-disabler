const NOTO_SANS_JP_TTF_URL =
  "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-jp@5.0.19/files/noto-sans-jp-japanese-400-normal.ttf";

const CJK_TEXT_PATTERN =
  /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

const embeddedFontBytesCache = new Map();
const embeddedPdfFontCache = new Map();
let cjkFallbackFontPromise = null;

export function containsCjkText(text) {
  return CJK_TEXT_PATTERN.test(text);
}

export function normalizeFontKey(value) {
  if (!value) {
    return "";
  }
  return String(value)
    .replace(/^["']|["']$/g, "")
    .replace(/^[A-Z]{6}\+/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function quoteFontFamily(family) {
  if (!family) {
    return "sans-serif";
  }
  if (/^(sans-serif|serif|monospace)$/i.test(family)) {
    return family.toLowerCase();
  }
  const escaped = family.replace(/"/g, '\\"');
  return `"${escaped}", sans-serif`;
}

export function resolveCanvasFontFamily(edit) {
  const substitution = edit.fontSubstitution?.trim();
  if (substitution) {
    return quoteFontFamily(substitution);
  }

  const family = edit.fontFamily?.trim();
  if (family && !/^(sans-serif|serif|monospace)$/i.test(family)) {
    return quoteFontFamily(family);
  }

  if (family) {
    return family.toLowerCase();
  }

  return "sans-serif";
}

export function resolveCanvasFont(edit, viewportScale) {
  const fontSizeCss = edit.fontSize * viewportScale;
  return `${fontSizeCss}px ${resolveCanvasFontFamily(edit)}`;
}

function collectFontMatchKeys(edit) {
  const keys = new Set();
  for (const value of [
    edit.fontFamily,
    edit.fontSubstitution,
    edit.fontSubstitutionLoadedName,
    edit.fontName,
  ]) {
    const normalized = normalizeFontKey(value);
    if (normalized) {
      keys.add(normalized);
    }
  }
  return keys;
}

export function findEmbeddedFontMatch(fontsByKey, edit) {
  const matchKeys = collectFontMatchKeys(edit);
  if (!matchKeys.size) {
    return null;
  }

  for (const key of matchKeys) {
    const exact = fontsByKey.get(key);
    if (exact) {
      return exact;
    }
  }

  for (const key of matchKeys) {
    for (const [indexedKey, fontEntry] of fontsByKey.entries()) {
      if (indexedKey.includes(key) || key.includes(indexedKey)) {
        return fontEntry;
      }
    }
  }

  return null;
}

export function mapToStandardFont(StandardFonts, edit) {
  const hint = [
    edit.fontFamily,
    edit.fontSubstitution,
    edit.fontSubstitutionLoadedName,
    edit.fontName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const isBold = /\bbold\b|bold|black|heavy|700|800|900|semibold|demibold/.test(hint);
  const isItalic = /\bitalic\b|italic|oblique|slanted/.test(hint);

  let base = StandardFonts.Helvetica;
  if (/zapf|dingbats/.test(hint)) {
    base = StandardFonts.ZapfDingbats;
  } else if (/symbol/.test(hint)) {
    base = StandardFonts.Symbol;
  } else if (/courier|monospace|mono|consolas|menlo/.test(hint)) {
    base = StandardFonts.Courier;
  } else if (/times|serif|mincho|宋|明朝|ming|garamond|georgia/.test(hint)) {
    base = StandardFonts.TimesRoman;
  } else if (/helvetica|arial|sans|calibri|verdana|tahoma|meiryo|メイリオ|gothic|ゴシック/.test(hint)) {
    base = StandardFonts.Helvetica;
  } else if (edit.fontFamily === "serif") {
    base = StandardFonts.TimesRoman;
  } else if (edit.fontFamily === "monospace") {
    base = StandardFonts.Courier;
  }

  if (base === StandardFonts.Symbol || base === StandardFonts.ZapfDingbats) {
    return base;
  }

  if (base === StandardFonts.Courier) {
    if (isBold && isItalic) {
      return StandardFonts.CourierBoldOblique;
    }
    if (isBold) {
      return StandardFonts.CourierBold;
    }
    if (isItalic) {
      return StandardFonts.CourierOblique;
    }
    return StandardFonts.Courier;
  }

  if (base === StandardFonts.TimesRoman) {
    if (isBold && isItalic) {
      return StandardFonts.TimesRomanBoldItalic;
    }
    if (isBold) {
      return StandardFonts.TimesRomanBold;
    }
    if (isItalic) {
      return StandardFonts.TimesRomanItalic;
    }
    return StandardFonts.TimesRoman;
  }

  if (isBold && isItalic) {
    return StandardFonts.HelveticaBoldOblique;
  }
  if (isBold) {
    return StandardFonts.HelveticaBold;
  }
  if (isItalic) {
    return StandardFonts.HelveticaOblique;
  }
  return StandardFonts.Helvetica;
}

async function fetchCjkFallbackFontBytes() {
  const response = await fetch(NOTO_SANS_JP_TTF_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch CJK fallback font (${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function getCjkFallbackFontBytes() {
  if (!cjkFallbackFontPromise) {
    cjkFallbackFontPromise = fetchCjkFallbackFontBytes();
  }
  return cjkFallbackFontPromise;
}

async function embedBytesFont(outDoc, cacheKey, bytes) {
  if (embeddedPdfFontCache.has(cacheKey)) {
    return embeddedPdfFontCache.get(cacheKey);
  }

  const font = await outDoc.embedFont(bytes, { subset: true });
  embeddedPdfFontCache.set(cacheKey, font);
  return font;
}

export class PdfFontResolver {
  constructor(outDoc, { StandardFonts, indexEmbeddedPdfFonts }) {
    this.outDoc = outDoc;
    this.StandardFonts = StandardFonts;
    this.indexEmbeddedPdfFonts = indexEmbeddedPdfFonts;
    this.embeddedFontsByKey = null;
    this.standardFontCache = new Map();
    this.cjkFallbackFont = null;
  }

  ensureIndexed() {
    if (!this.embeddedFontsByKey) {
      this.embeddedFontsByKey = this.indexEmbeddedPdfFonts(this.outDoc);
    }
    return this.embeddedFontsByKey;
  }

  async getStandardFont(edit) {
    const standardName = mapToStandardFont(this.StandardFonts, edit);
    if (!this.standardFontCache.has(standardName)) {
      this.standardFontCache.set(standardName, await this.outDoc.embedFont(standardName));
    }
    return this.standardFontCache.get(standardName);
  }

  async getCjkFallbackFont() {
    if (this.cjkFallbackFont) {
      return this.cjkFallbackFont;
    }

    const bytes = await getCjkFallbackFontBytes();
    this.cjkFallbackFont = await embedBytesFont(this.outDoc, "__cjk_fallback__", bytes);
    return this.cjkFallbackFont;
  }

  async resolveEmbeddedFont(edit) {
    this.ensureIndexed();
    const match = findEmbeddedFontMatch(this.embeddedFontsByKey, edit);
    if (!match) {
      return null;
    }

    const cacheKey = `embedded:${normalizeFontKey(match.baseFont)}`;
    if (!embeddedFontBytesCache.has(cacheKey)) {
      embeddedFontBytesCache.set(cacheKey, match.bytes);
    }

    try {
      return await embedBytesFont(this.outDoc, cacheKey, embeddedFontBytesCache.get(cacheKey));
    } catch {
      return null;
    }
  }

  async resolveFontForEdit(edit) {
    const text = edit.newText ?? "";
    const needsCjk = containsCjkText(text);

    const embeddedFont = await this.resolveEmbeddedFont(edit);
    if (embeddedFont) {
      return embeddedFont;
    }

    if (needsCjk) {
      try {
        return await this.getCjkFallbackFont();
      } catch (error) {
        console.warn("CJK fallback font unavailable:", error);
      }
    }

    return this.getStandardFont(edit);
  }
}
