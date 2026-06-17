import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import { normalizeFontKey } from "../font-matching-utils.js";

function readPdfName(value) {
  if (!value) {
    return null;
  }
  if (value instanceof PDFName) {
    return value.asString();
  }
  if (value instanceof PDFString) {
    return value.decodeText();
  }
  return null;
}

function lookupDict(context, value) {
  if (!value) {
    return null;
  }
  if (value instanceof PDFRef) {
    const resolved = context.lookup(value);
    return resolved instanceof PDFDict ? resolved : null;
  }
  return value instanceof PDFDict ? value : null;
}

function decodeFontStreamBytes(streamRef, context) {
  if (!streamRef) {
    return null;
  }

  const stream =
    streamRef instanceof PDFRef
      ? context.lookupMaybe(streamRef, PDFRawStream)
      : streamRef instanceof PDFRawStream
        ? streamRef
        : null;

  if (!stream) {
    return null;
  }

  try {
    return new Uint8Array(decodePDFRawStream(stream).decode());
  } catch {
    return null;
  }
}

function readFontDescriptorBytes(descriptor, context) {
  if (!(descriptor instanceof PDFDict)) {
    return null;
  }

  for (const key of ["FontFile2", "FontFile3", "FontFile"]) {
    const bytes = decodeFontStreamBytes(descriptor.get(PDFName.of(key)), context);
    if (bytes?.length) {
      return bytes;
    }
  }

  return null;
}

function registerEmbeddedFont(fontsByKey, baseFont, bytes) {
  const normalized = normalizeFontKey(baseFont);
  if (!normalized || !bytes?.length || fontsByKey.has(normalized)) {
    return;
  }

  fontsByKey.set(normalized, {
    baseFont,
    bytes,
  });
}

function collectFontDict(fontDict, context, fontsByKey) {
  if (!(fontDict instanceof PDFDict)) {
    return;
  }

  const baseFont = readPdfName(fontDict.get(PDFName.of("BaseFont")));
  const descriptor = lookupDict(context, fontDict.get(PDFName.of("FontDescriptor")));
  const descriptorBytes = readFontDescriptorBytes(descriptor, context);
  if (baseFont && descriptorBytes) {
    registerEmbeddedFont(fontsByKey, baseFont, descriptorBytes);
  }

  const descendants = fontDict.get(PDFName.of("DescendantFonts"));
  if (descendants instanceof PDFArray) {
    for (let index = 0; index < descendants.size(); index += 1) {
      collectFontDict(lookupDict(context, descendants.get(index)), context, fontsByKey);
    }
  }
}

export function indexEmbeddedPdfFonts(pdfDoc) {
  const fontsByKey = new Map();
  const context = pdfDoc.context;

  for (const [, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) {
      continue;
    }

    const type = readPdfName(object.get(PDFName.of("Type")));
    const subtype = readPdfName(object.get(PDFName.of("Subtype")));
    if (type === "Font" || subtype === "Type0" || subtype === "Type1" || subtype === "TrueType") {
      collectFontDict(object, context, fontsByKey);
    }
  }

  return fontsByKey;
}
