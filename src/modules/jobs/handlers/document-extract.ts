import 'server-only';
import type { Db } from '@/db/types';
import { orgRow } from '@/db/schema';
import {
  beginExtraction, beginReceiptExtraction, chargeExtractionPage, failImportBatch, recordExtractionPage,
} from '@/core/db';
import { QuotaExceeded, isMotionError } from '@/core/errors';
import { log } from '@/core/logging';
import { getObject, SOURCE_DOCUMENTS_BUCKET } from '@/core/storage/signer';
import { extractReceipts, extractStatementPage, isProviderOutage, type ModelTransport, type PageExtraction, type ReceiptExtraction } from '@/modules/ai';
import { tokenisePdf, type ParsedRow, type ParsedTable } from '@/modules/imports';
import { proposeColumnMap, validateBatch } from '@/modules/imports';
import type { RowIssue } from '@/modules/imports';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `document.extract` (IMPORT_ENGINE.md §5.4; AI_ARCHITECTURE.md §14; ADR-033; ADR-084; CD-11).
 *
 * Enqueued by a reviewer pressing "Read with AI" on a text-layer PDF the deterministic parser could
 * not read — never automatically (R2-C-11). The job acts as that reviewer through `api_server`
 * functions that re-check the permission and the organisation's `ai_pdf_extraction` flag on every
 * write, and holds no rule of its own:
 *
 *   1. `begin_extraction` turns the failed `pdf_text` batch into a `pdf_claude` one and writes the
 *      `document.sent_to_ai` audit BEFORE any page is sent (F-A-15).
 *   2. For each page, `charge_extraction_page` BEFORE the model call — first attempts and retries
 *      alike, so a page that fails costs every attempt (R2-C-11) — then one tools-free extraction
 *      of that page's text, then `record_extraction_page` with what it cost and how it ended.
 *   3. Every row the model produced goes through the SAME pipeline as a CSV row, plus `IMP-PDF-001`
 *      and its page, so validation, dedupe and the balance gate are the product's, not the model's.
 *
 * What the model read as the balances is recorded for the reviewer's comparison and never reaches
 * the gate (F-C-03). With no deterministic capture and nothing typed yet, the batch cannot commit:
 * the gate says so in its own words.
 *
 * A provider outage defers the batch and the job (`deferred_upstream`); a page the model answers
 * wrongly is retried within the run, then recorded failed; the daily page budget or the monthly
 * ceiling stops the run with the reset in the batch's reason.
 */

/** The one seam a test uses: the model transport. Production leaves it unset and gets the live one. */
export const extractDeps: { transport: ModelTransport | undefined } = { transport: undefined };

/** In-run retries for a page whose answer did not fit the contract, before it is recorded failed. */
const PAGE_ATTEMPTS = 3;
/** §5.4 `IMP-PDF-002`: the deterministic date-line count must be within this share of the rows read. */
export const LINE_COUNT_TOLERANCE = 0.1;

export const AI_ROW_ISSUE = 'IMP-PDF-001';
export const LINE_COUNT_ISSUE = 'IMP-PDF-002';

interface BatchRow {
  id: string; organization_id: string; source_document_id: string; import_type: string; status: string;
  extraction_method: string; period_start: string; period_end: string; bank_account_id: string | null;
}

/** Whether the reviewer may tick a whole page: `confidence = high` and the line count agreeing (§5.4). */
export function lineCountAgrees(dateLines: number, rows: number): boolean {
  if (rows === 0) return dateLines === 0;
  // ±10% of the rows read, with a floor of one line so a three-row page is not held to a fraction.
  return Math.abs(dateLines - rows) <= Math.max(1, rows * LINE_COUNT_TOLERANCE);
}

export async function runDocumentExtractJob(job: ClaimedJob, scope: { db: unknown }): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) return { status: 'failed', error: 'document.extract has no organization to scope to' };
  if (job.requestedBy === null) return { status: 'failed', error: 'document.extract acts as the reviewer who asked for it, and nobody did' };
  const documentId = typeof job.payload.document_id === 'string' ? job.payload.document_id : null;
  const batchId = typeof job.payload.batch_id === 'string' ? job.payload.batch_id : null;
  if (!documentId || !batchId) return { status: 'failed', error: 'document.extract needs a document_id and a batch_id' };

  const db = scope.db as Db;
  const actor = { userId: job.requestedBy, requestId: job.jobId };

  // The job's scoped server handle: direct reads, named by the job row's organisation.
  const [batchSnap, documentSnap] = await Promise.all([
    orgRow(db.fs, orgId, 'import_batches', batchId).get(),
    orgRow(db.fs, orgId, 'source_documents', documentId).get(),
  ]);
  const batch = batchSnap.exists ? batchSnap.data() : null;
  const document = documentSnap.exists ? documentSnap.data() : null;
  const b = batch as BatchRow | null;
  const d = document as {
    id: string; storage_bucket: string | null; storage_path: string; has_text_layer: boolean | null; deleted_at: string | null;
    page_count: number | null; mime_type: string | null; original_filename: string | null;
  } | null;
  if (!b || !d || d.deleted_at !== null || b.source_document_id !== d.id) {
    return { status: 'failed', error: 'the batch and the document do not belong together in this organisation' };
  }
  // ADR-150: receipts are read from the FILE, with the expense account the reviewer chose.
  if (b.import_type === 'receipts') {
    const accountId = typeof job.payload.account_id === 'string' ? job.payload.account_id : null;
    if (!accountId) return { status: 'failed', error: 'reading receipts needs the expense account they post to' };
    return runReceiptExtraction({ db, orgId, actor, batch: b, document: d, accountId, requestedBy: job.requestedBy });
  }
  // The model's schema is a bank statement's (`extractStatementPage`); reading an invoice or a trial
  // balance with it would charge pages for rows of the wrong shape. The wizard no longer starts a
  // batch for any other PDF, so this only guards a batch created before that.
  if (b.import_type !== 'bank_statement') {
    return { status: 'failed', error: 'only a bank statement PDF can be read with AI' };
  }

  // The text layer, page by page, with the deterministic date-line count `IMP-PDF-002` needs.
  const bytes = await getObject({ orgId, userId: job.requestedBy }, d.storage_bucket ?? SOURCE_DOCUMENTS_BUCKET, d.storage_path);
  const tokens = await tokenisePdf(bytes);
  if (!tokens.hasTextLayer) return { status: 'failed', error: 'this document has no text layer to read' };

  try {
    await beginExtraction(actor, orgId, { batchId, documentId, pagesTotal: tokens.pages.length });
  } catch (cause) {
    return { status: 'failed', error: isMotionError(cause) ? cause.message : String(cause) };
  }

  const extracted = new Map<number, PageExtraction>();
  const failedPages: number[] = [];
  let deferred = false;
  let stopped: string | null = null;

  for (const page of tokens.pages) {
    const pageText = page.lines.map((l) => l.text).join('\n');
    let lastReason = 'no attempt';
    let done = false;
    for (let attempt = 1; attempt <= PAGE_ATTEMPTS && !done; attempt += 1) {
      try {
        await chargeExtractionPage(actor, orgId, documentId);
      } catch (cause) {
        // A budget or a flag stops the whole run: the batch says so with the reset time (§5.4).
        stopped = isMotionError(cause) ? cause.message : String(cause);
        if (cause instanceof QuotaExceeded && cause.resetAt) stopped += ` AI reading is paused until ${cause.resetAt.toISOString()}; upload CSV to continue now.`;
        break;
      }
      try {
        const result = await extractStatementPage({
          pageNumber: page.pageNumber, pageText, ...(extractDeps.transport ? { transport: extractDeps.transport } : {}),
        });
        if (result.ok) {
          extracted.set(page.pageNumber, result.page);
          await recordExtractionPage(actor, orgId, {
            batchId, page: page.pageNumber, outcome: 'extracted', tokensIn: result.inputTokens, tokensOut: result.outputTokens,
            confidence: result.page.confidence, lineCount: page.dateLineCount,
            balancesRead: result.page.openingBalanceRead || result.page.closingBalanceRead
              ? { ...(result.page.openingBalanceRead ? { opening: result.page.openingBalanceRead } : {}), ...(result.page.closingBalanceRead ? { closing: result.page.closingBalanceRead } : {}) }
              : null,
          });
          done = true;
        } else {
          lastReason = result.reason;
          await recordExtractionPage(actor, orgId, {
            batchId, page: page.pageNumber, outcome: 'failed', tokensIn: result.inputTokens, tokensOut: result.outputTokens,
            lineCount: page.dateLineCount, error: result.reason,
          });
        }
      } catch (cause) {
        if (isProviderOutage(cause)) {
          deferred = true;
          await recordExtractionPage(actor, orgId, { batchId, page: page.pageNumber, outcome: 'deferred', lineCount: page.dateLineCount, error: 'provider unavailable' });
          break;
        }
        throw cause;
      }
    }
    if (stopped !== null) break;
    if (deferred) break;
    if (!done) failedPages.push(page.pageNumber);
    void lastReason;
  }

  if (stopped !== null) {
    await failImportBatch(actor, orgId, batchId, 'extracting', stopped);
    return { status: 'failed', error: stopped };
  }
  if (deferred) {
    const message = 'Waiting for the extraction service — we will keep trying for up to an hour.';
    await failImportBatch(actor, orgId, batchId, 'extracting', message, true);
    return { status: 'deferred_upstream', error: message };
  }
  if (failedPages.length > 0) {
    const message = `Page${failedPages.length === 1 ? '' : 's'} ${failedPages.join(', ')} could not be read by AI. Upload the statement as CSV, or try again.`;
    await failImportBatch(actor, orgId, batchId, 'extracting', message);
    return { status: 'failed', error: message };
  }

  // §5.4: every row the model produced, through the same pipeline as a CSV row.
  const rows: ParsedRow[] = [];
  let rowNumber = 0;
  for (const page of tokens.pages) {
    const read = extracted.get(page.pageNumber);
    if (!read) continue;
    for (const r of read.rows) {
      rowNumber += 1;
      rows.push({
        rowNumber, sourceRef: `page:${page.pageNumber};line:${r.line}`, sourcePage: page.pageNumber,
        cells: [r.date, r.description, r.amount, r.balance ?? null, r.reference ?? null],
      });
    }
  }
  const table: ParsedTable = {
    columns: ['Date', 'Description', 'Amount', 'Balance', 'Reference'],
    rows, warnings: [],
    // The deterministic date-line counts, for `IMP-PDF-002`; NEVER the model's balances (F-C-03).
    statement: { dateLineCounts: Object.fromEntries(tokens.pages.map((p) => [p.pageNumber, p.dateLineCount])) },
  };
  const rowsByPage = new Map<number, number>();
  for (const r of rows) rowsByPage.set(r.sourcePage!, (rowsByPage.get(r.sourcePage!) ?? 0) + 1);

  const importType = b.import_type as ValidateBatchInputType;
  const columnMap = proposeColumnMap(table, importType);
  const result = await validateBatch({
    db, organizationId: orgId, actor, batchId, importType, table, columnMap,
    // The model returns money out as negative (§5.4 schema); the sign question never arises.
    transforms: { bankSign: 'negative_out' },
    // §5.4: no deterministic capture exists for an AI-read document; without a typed pair, no commit.
    balancesRequired: true,
    periodStart: b.period_start, periodEnd: b.period_end, bankAccountId: b.bank_account_id,
    annotateRow: (row) => {
      const page = row.sourcePage ?? 0;
      const issues: RowIssue[] = [{
        code: AI_ROW_ISSUE, severity: 'warning' as const,
        message: `Read by AI — confirm against page ${page}.`,
        suggestion: 'Compare this row with the statement page before it is imported.',
      }];
      const dateLines = tokens.pages.find((p) => p.pageNumber === page)?.dateLineCount ?? 0;
      if (!lineCountAgrees(dateLines, rowsByPage.get(page) ?? 0)) {
        issues.push({
          code: LINE_COUNT_ISSUE, severity: 'warning' as const,
          message: `Page ${page} shows ${dateLines} dated lines but ${rowsByPage.get(page) ?? 0} rows were read; confirm each row on this page.`,
          suggestion: 'The page cannot be confirmed as a whole.',
        });
      }
      return issues;
    },
  });

  log.info('document extracted by AI', { organizationId: orgId, batchId, documentId, pages: tokens.pages.length, rows: rows.length, counts: result.counts });
  return { status: 'succeeded', result: { pages: tokens.pages.length, rows: rows.length, counts: result.counts } };
}

type ValidateBatchInputType = Parameters<typeof validateBatch>[0]['importType'];


// -----------------------------------------------------------------------------------------------
// Receipts (ADR-150)
// -----------------------------------------------------------------------------------------------

/** A receipt file is read whole; past this it is a bundle to split, not a receipt. */
export const MAX_RECEIPT_PAGES = 10;
export const RECEIPT_ROW_ISSUE = AI_ROW_ISSUE;

function receiptMediaType(mime: string | null, filename: string | null): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  const name = (filename ?? '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'application/pdf';
  if (mime === 'image/png' || name.endsWith('.png')) return 'image/png';
  if (mime === 'image/jpeg' || name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  return null;
}

async function runReceiptExtraction(input: {
  db: Db; orgId: string; actor: { userId: string; requestId: string }; batch: BatchRow;
  document: { id: string; storage_bucket: string | null; storage_path: string; page_count: number | null; mime_type: string | null; original_filename: string | null };
  accountId: string; requestedBy: string;
}): Promise<JobOutcome> {
  const { db, orgId, actor, batch: b, document: d, accountId } = input;
  const batchId = b.id;
  const mediaType = receiptMediaType(d.mime_type, d.original_filename);
  if (mediaType === null) return { status: 'failed', error: 'a receipt is read from a JPEG, PNG or PDF file' };
  const pages = mediaType === 'application/pdf' ? Math.max(1, d.page_count ?? 1) : 1;
  if (pages > MAX_RECEIPT_PAGES) {
    const message = `This file has ${pages} pages; receipts are read up to ${MAX_RECEIPT_PAGES} pages at a time. Split it and upload the parts.`;
    await failImportBatch(actor, orgId, batchId, 'extracting', message);
    return { status: 'failed', error: message };
  }

  try {
    await beginReceiptExtraction(actor, orgId, { batchId, documentId: d.id, pagesTotal: pages, accountId });
  } catch (cause) {
    return { status: 'failed', error: isMotionError(cause) ? cause.message : String(cause) };
  }
  const accountSnap = await orgRow(db.fs, orgId, 'accounts', accountId).get();
  const account = accountSnap.exists ? accountSnap.data() : null;
  if (!account) return { status: 'failed', error: 'the chosen account could not be read' };
  const accountRef = (account as { code: string | null; name: string }).code ?? (account as { name: string }).name;

  const bytes = await getObject({ orgId, userId: input.requestedBy }, d.storage_bucket ?? SOURCE_DOCUMENTS_BUCKET, d.storage_path);
  let read: ReceiptExtraction | null = null;
  let lastReason = 'no attempt';
  for (let attempt = 1; attempt <= PAGE_ATTEMPTS && read === null; attempt += 1) {
    try {
      // The whole file goes in one call, so every page is charged before it (R2-C-11).
      for (let p = 0; p < pages; p += 1) await chargeExtractionPage(actor, orgId, d.id);
    } catch (cause) {
      let stopped = isMotionError(cause) ? cause.message : String(cause);
      if (cause instanceof QuotaExceeded && cause.resetAt) stopped += ` AI reading is paused until ${cause.resetAt.toISOString()}.`;
      await failImportBatch(actor, orgId, batchId, 'extracting', stopped);
      return { status: 'failed', error: stopped };
    }
    try {
      const result = await extractReceipts({ mediaType, bytes, pages, ...(extractDeps.transport ? { transport: extractDeps.transport } : {}) });
      for (let page = 1; page <= pages; page += 1) {
        await recordExtractionPage(actor, orgId, {
          batchId, page, outcome: result.ok ? 'extracted' : 'failed',
          tokensIn: page === 1 ? result.inputTokens : 0, tokensOut: page === 1 ? result.outputTokens : 0,
          // No deterministic count exists for a receipt; 0 is recorded, never the model's own count.
          lineCount: 0,
          ...(result.ok ? { confidence: result.read.confidence } : { error: result.reason }),
        });
      }
      if (result.ok) read = result.read;
      else lastReason = result.reason;
    } catch (cause) {
      if (isProviderOutage(cause)) {
        const message = 'Waiting for the extraction service — we will keep trying for up to an hour.';
        await failImportBatch(actor, orgId, batchId, 'extracting', message, true);
        return { status: 'deferred_upstream', error: message };
      }
      throw cause;
    }
  }
  if (read === null) {
    const message = `The receipt could not be read by AI (${lastReason}). Try a clearer photo, or enter it as a CSV.`;
    await failImportBatch(actor, orgId, batchId, 'extracting', message);
    return { status: 'failed', error: message };
  }
  if (read.receipts.length === 0) {
    const message = `No receipt with a readable date and total was found${read.notes.length > 0 ? `: ${read.notes.join(' ')}` : '.'}`;
    await failImportBatch(actor, orgId, batchId, 'extracting', message);
    return { status: 'failed', error: message };
  }

  // Every receipt through the SAME pipeline as a CSV receipts row, posting to the reviewer's account.
  const ordered = [...read.receipts].sort((x, y) => x.page - y.page || x.index - y.index);
  const rows: ParsedRow[] = ordered.map((r, i) => ({
    rowNumber: i + 1, sourceRef: `page:${r.page};line:${r.index}`, sourcePage: r.page,
    cells: [r.date, r.description ? `${r.supplier} — ${r.description}` : r.supplier, r.total, accountRef, r.currency ?? null],
  }));
  const table: ParsedTable = { columns: ['Date', 'Description', 'Amount', 'Account', 'Currency'], rows, warnings: [] };
  const columnMap = proposeColumnMap(table, 'receipts');
  const result = await validateBatch({
    db, organizationId: orgId, actor, batchId, importType: 'receipts', table, columnMap,
    transforms: {},
    periodStart: b.period_start, periodEnd: b.period_end, bankAccountId: null,
    annotateRow: (row) => [{
      code: RECEIPT_ROW_ISSUE, severity: 'warning' as const,
      message: `Read by AI — confirm against the receipt${pages > 1 ? ` on page ${row.sourcePage ?? 1}` : ''}.`,
      suggestion: 'Compare the date, who was paid and the total with the receipt before it is imported.',
    }],
  });

  log.info('receipts read by AI', { organizationId: orgId, batchId, documentId: d.id, pages, receipts: rows.length, counts: result.counts });
  return { status: 'succeeded', result: { pages, rows: rows.length, counts: result.counts } };
}
