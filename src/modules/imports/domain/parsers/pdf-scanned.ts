/**
 * Scanned PDF — no text layer (IMPORT_ENGINE.md §5.5, MVP_SCOPE.md §4).
 *
 * Pure: bytes in, a report out. No I/O, no clock, no database.
 *
 * There is nothing clever to do here, and that is the point. A PDF that is a photograph of a
 * statement has no text to parse, so this module yields no rows and no balances at all. It does not
 * OCR, it does not infer from the page geometry, and it does not hand the image to a model: §5.5
 * puts OCR after the MVP, and `IMP-BAL-006` may only ever gate on balances read deterministically
 * from a text layer or typed by a reviewer (ADR-033).
 *
 * The caller sets `source_documents.status = 'unreadable'`, creates no batch, and shows the
 * message below — which names the cause and the way forward, per §15 ("Clear message naming the
 * cause and the CSV alternative; document kept"). The file itself is still stored: a customer must
 * be able to see what MOTION refused and why.
 */

import type { ParseWarning } from '../pipeline-types';
import { tokenisePdf } from './pdf-text';

/** §5.5, verbatim. */
export const SCANNED_PDF_MESSAGE =
  'This PDF is a scanned image. APX has stored it as a source document. ' +
  'Please upload the same statement as CSV or XLSX from your bank.';

export interface ScannedPdfReport {
  /** False when not one page produced a non-blank text token. */
  readonly hasTextLayer: boolean;
  readonly pageCount: number;
  /**
   * The message to show the user, present only when the document really has no text layer. A PDF
   * that does have one is not this module's problem — it goes to §5.3.
   */
  readonly message?: string;
  readonly warnings: readonly ParseWarning[];
}

/**
 * Decide whether a PDF has a usable text layer (§4 `hasTextLayer`, §5.5).
 *
 * "Has a text layer" means at least one page yields at least one non-blank token. A PDF that
 * carries a text layer of nothing but spaces is a scan with an empty OCR shell and is treated as
 * unreadable, because a parser would find no lines in it either.
 */
export async function inspectPdfTextLayer(bytes: Uint8Array): Promise<ScannedPdfReport> {
  const document = await tokenisePdf(bytes);
  if (document.hasTextLayer) {
    return { hasTextLayer: true, pageCount: document.pages.length, warnings: [] };
  }
  return {
    hasTextLayer: false,
    pageCount: document.pages.length,
    message: SCANNED_PDF_MESSAGE,
    warnings: [],
  };
}
