export {
  containsCjkText,
  findEmbeddedFontMatch,
  mapToStandardFont,
  normalizeFontKey,
  resolveCanvasFont,
  resolveCanvasFontAsync,
  resolveCanvasFontFamily,
} from "./font-matching-utils.js";
export { indexEmbeddedPdfFonts } from "./font-pdf-extract.js";

import { PdfFontResolver as PdfFontResolverBase } from "./font-matching-utils.js";
import { indexEmbeddedPdfFonts } from "./font-pdf-extract.js";

export class PdfFontResolver extends PdfFontResolverBase {
  constructor(outDoc, options) {
    super(outDoc, {
      ...options,
      indexEmbeddedPdfFonts: options.indexEmbeddedPdfFonts ?? indexEmbeddedPdfFonts,
    });
  }
}
