import 'server-only';
import { orgRowById, orgRows } from '@/db/rls';
import { globalRow } from '@/db/schema';
import type { Db } from '@/db/types';
import {
  failImportBatch, registerDocument, finalizeUpload, setBatchValidation, writeImportRows,
} from '@/core/db';
import { ValidationError } from '@/core/errors';
import {
  decodeCsvBytes, sniffDelimiter, uploadDocument, validateFile,
} from '@/modules/documents';
import { isKnownHeader, storedNameKey, suggestCategory, suggestColumns } from '../domain/mapping';
import { resolveBankSign, type BankAccountType } from '../domain/transforms/signs';
import { runPipeline } from '../domain/pipeline';
import { parseCsv } from '../domain/parsers/csv';
import { SCANNED_PDF_MESSAGE } from '../domain/parsers/pdf-scanned';
import { parsePdfText } from '../domain/parsers/pdf-text';
import { parseXlsx } from '../domain/parsers/xlsx';
import { checkedInvoiceTable, type CheckedInvoiceInput } from '../domain/checked-invoice';
import type { ParsedTable, TargetField, Transforms } from '../domain/pipeline-types';
import type { PipelineInput } from '../domain/pipeline';
import {
  IMPORT_TYPE_SPECS, isImportType, type ExtractionMethod, type ImportTarget, type ImportType,
} from '../domain/types';
import { loadCounterparties, parseAndValidate } from './parse-and-validate';
import { createImportAccounts, createImportCounterparties, recordBatchConfirmation, startImportBatch } from './index';

/**
 * The import wizard's one server-side journey (IMPORT_ENGINE.md §2–§7).
 *
 * Upload, start a batch, parse the file, propose a column map and validate every row — in one call,
 * with the bytes still in hand. The alternative is to store the file, redirect, and read it back
 * from Storage to parse it; that costs a round trip and a second copy of the "is this file readable"
 * question, and buys nothing a reviewer can see.
 *
 * Nothing here decides whether a batch may COMMIT. That is `app.assert_batch_committable`, re-checked
 * in SQL at the moment of commit against data that may have changed since (§11).
 */

export interface StartImportInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly db: Db;
  readonly file: File;
  readonly importType: ImportType;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly bankAccountId: string | null;
  /** A reviewer's corrections to the proposed map, on a second pass (§6.4). */
  readonly columnMap?: Readonly<Record<string, TargetField>>;
  /**
   * ADR-175: the fields of ONE invoice, read in the browser from a photo, scan or PDF and checked by
   * the reviewer. When present the file is stored as the evidence and these fields are the row.
   */
  readonly checkedInvoice?: CheckedInvoiceInput;
}

export interface StartImportResult {
  readonly batchId: string;
  readonly documentId: string;
  readonly counts: Record<string, number>;
  /** Accounts the file named that the chart did not have, now created as `uncategorised` (§6.5). */
  readonly accountsCreated: number;
  /** Customers or suppliers an invoice list named that MOTION did not have, now created (§6.6). */
  readonly counterpartiesCreated: number;
  readonly requiredConfirmations: readonly string[];
  readonly columns: readonly string[];
  readonly columnMap: Readonly<Record<string, TargetField>>;
  /** True when the header row was proposed rather than recognised, so §5.1 wants confirmation. */
  readonly headerConfirmationRequired: boolean;
  /**
   * Set when the file was stored and a batch created, but no table could be read from it — a
   * text-layer PDF whose layout no grammar matched (§5.3). The batch is `failed` with this reason,
   * and the review screen is where the §5.4 "Read with AI" path starts from.
   */
  readonly parseFailure?: string;
}

/** The record table an import type commits into — `IMPORT_TYPE_SPECS`, never a local copy. */
export function targetFor(importType: ImportType): ImportTarget {
  return IMPORT_TYPE_SPECS[importType].target;
}

/** `api.create_import_counterparties` accepts at most 5,000 names a call. */
const COUNTERPARTY_SLICE = 5000;

/** What the reader calls each type, for the refusals below. */
const TYPE_NOUN: Readonly<Record<ImportType, string>> = {
  general_ledger: 'general ledger',
  trial_balance: 'trial balance',
  pnl_report: 'profit and loss report',
  balance_sheet: 'balance sheet',
  bank_statement: 'bank statement',
  sales_invoices: 'sales invoice list',
  purchase_invoices: 'purchase invoice list',
  sales_report: 'sales report',
  purchase_report: 'purchase report',
  receipts: 'receipts list',
  budget: 'budget',
};

/**
 * Refuses a combination MOTION cannot import, BEFORE anything is stored (ADR-058.1).
 *
 * The type arrives from a form field, so it is checked rather than cast. A bank account belongs on a
 * statement and nowhere else. A PDF is never refused here: what MOTION can do with one is decided by
 * `pdfHandling` below, and every PDF is at least kept as a source document.
 */
export function assertImportSupported(input: {
  readonly importType: string;
  readonly bankAccountId: string | null;
  /** The declared range, when the form gave one: checked here, before the file is stored, because a
   *  file stored and then refused stays behind and blocks the same file ("already uploaded"). */
  readonly periodStart?: string;
  readonly periodEnd?: string;
}): ImportType {
  if (!isImportType(input.importType)) {
    throw new ValidationError('Choose what kind of file this is.', [
      { path: 'import_type', message: 'Choose what kind of file this is.' },
    ]);
  }
  const spec = IMPORT_TYPE_SPECS[input.importType];
  if (spec.bankAccount === 'required' && input.bankAccountId === null) {
    throw new ValidationError('Choose which bank account this statement belongs to.', [
      { path: 'bank_account_id', message: 'Choose which bank account this statement belongs to.' },
    ]);
  }
  if (spec.bankAccount === 'not_allowed' && input.bankAccountId !== null) {
    throw new ValidationError(`A ${TYPE_NOUN[input.importType]} is not imported into a bank account.`, [
      { path: 'bank_account_id', message: 'Only a bank statement belongs to a bank account.' },
    ]);
  }
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (input.periodStart !== undefined && input.periodEnd !== undefined) {
    if (!isoDate.test(input.periodStart) || !isoDate.test(input.periodEnd)) {
      throw new ValidationError('Enter the first and last day the file covers.', [
        { path: 'period_start', message: 'Enter the first and last day the file covers.' },
      ]);
    }
    if (input.periodEnd < input.periodStart) {
      throw new ValidationError('The last day the file covers cannot be before the first.', [
        { path: 'period_end', message: 'The last day the file covers cannot be before the first.' },
      ]);
    }
  }
  return input.importType;
}

/**
 * What happens to a PDF of each type (IMPORT_ENGINE.md §5.3–§5.5; agreement §8).
 *
 * Storing a document and extracting figures from it are different promises. Every PDF is STORED as
 * a source document under its kind, access-controlled and traceable like any other file. Only a bank
 * statement is READ: the deterministic reader knows statement layouts, and the AI path is
 * statement-shaped too, so running either over an invoice or a trial balance would produce rows of
 * the wrong shape and advice about statements. Those PDFs are kept, and the reader is told how to
 * get their figures in.
 */
export function pdfHandling(importType: ImportType): 'read' | 'read_on_request' | 'store_only' {
  // ADR-150: a receipt (PDF or photo) is read with AI when a reviewer asks, never on upload.
  if (importType === 'receipts') return 'read_on_request';
  return IMPORT_TYPE_SPECS[importType].pdfSupported ? 'read' : 'store_only';
}

export function storedNotReadMessage(importType: ImportType): string {
  return `The PDF is stored as a source document, but APX reads figures from PDF bank statements only. `
    + `To import the figures, export the ${TYPE_NOUN[importType]} as CSV or Excel and upload that.`;
}

/** Reads a spreadsheet or delimited file into the shape the pipeline expects. */
/** What the wizard read, and how — the batch records the method (ADR-083). */
type Parsed =
  | { readonly kind: 'table'; readonly table: ParsedTable; readonly method: ExtractionMethod }
  /** §5.5: a PDF with no text layer. Stored as a document, never a batch. */
  | { readonly kind: 'scanned' }
  /** §5.3: a text-layer PDF whose layout no grammar matched. Stored, batched, and the batch failed. */
  | { readonly kind: 'pdf_unparsed'; readonly reason: string };

/** ADR-175: the import types whose single-invoice photos, scans and PDFs are read in the browser. */
export function readsCheckedInvoice(importType: ImportType): boolean {
  return importType === 'sales_invoices' || importType === 'purchase_invoices';
}

/** ADR-150: what a receipt upload says until a reviewer asks for it to be read. */
export const RECEIPT_WAITING_MESSAGE =
  'The receipt is stored. APX reads receipts with AI when you ask: choose the expense account and press "Read receipts with AI".';

const PDF_UNPARSED_MESSAGE =
  'APX could not find a transaction table in this PDF. The file is stored; '
  + 'export the same statement as CSV or Excel from your bank and upload that.';

async function parseTable(file: File, bytes: Uint8Array): Promise<Parsed> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    return { kind: 'table', table: await parseXlsx(bytes, { isHeaderCell: isKnownHeader }), method: 'xlsx' };
  }

  if (name.endsWith('.pdf')) {
    // §5.3: the deterministic text-layer parser. It yields a table, or says exactly why not.
    const parsed = await parsePdfText(bytes);
    if (parsed.ok) return { kind: 'table', table: parsed.table, method: 'pdf_text' };
    if (parsed.reason === 'no_text_layer') return { kind: 'scanned' };
    return { kind: 'pdf_unparsed', reason: PDF_UNPARSED_MESSAGE };
  }

  const decoded = decodeCsvBytes(bytes);
  if (!decoded.ok) {
    throw new ValidationError(
      decoded.reason === 'nul_byte'
        ? 'That file is not a text file — it looks like a spreadsheet or an image with a .csv name.'
        : 'That file could not be read as text. Export it again as CSV or Excel.',
    );
  }

  // An unsniffable delimiter falls back to a comma rather than refusing: a single-column file has
  // no delimiter to find, and refusing it would reject a perfectly importable list.
  const sniffed = sniffDelimiter(decoded.text);
  return {
    kind: 'table',
    method: 'csv',
    table: parseCsv(decoded.text, {
      delimiter: sniffed.ok ? sniffed.delimiter : ',',
      isHeaderCell: isKnownHeader,
    }),
  };
}

export function proposeColumnMap(
  table: ParsedTable, importType: ImportType,
): Record<string, TargetField> {
  const map: Record<string, TargetField> = {};
  for (const suggestion of suggestColumns(table.columns, importType)) {
    // First suggestion per column wins: `suggestColumns` returns them strongest-first, so an exact
    // header match is never displaced by a weak one later in the list.
    if (map[suggestion.sourceColumn] === undefined) {
      map[suggestion.sourceColumn] = suggestion.target;
    }
  }
  // A ledger, trial balance or budget that names its accounts only by code (Date, Journal, Code, …):
  // the code IS the account (§6.2 lets a code header stand for either). Mapped to `code` alone, every
  // row was refused "This row has no account", and the upload page has no mapping step to fix it.
  const needsAccount = ['ledger_entries', 'period_balances', 'budget_lines'].includes(targetFor(importType));
  if (needsAccount && !Object.values(map).includes('account')) {
    const codeColumn = Object.keys(map).find((column) => map[column] === 'code');
    if (codeColumn !== undefined) map[codeColumn] = 'account';
  }
  return map;
}

/**
 * The transforms a file's own shape forces (§6.4).
 *
 * A statement with one signed `amount` column cannot be read without knowing which way round it
 * writes payments out, and reading it the wrong way round inverts every cash movement in the file.
 * §6.4 gives a default for card and loan accounts only; anywhere else the answer is a human's, so
 * this REFUSES rather than guesses. That refusal happens before anything is stored, so a file
 * nobody can answer for leaves no batch behind (ADR-058.1).
 */
async function resolveTransforms(
  db: Db,
  organizationId: string,
  input: { importType: ImportType; bankAccountId: string | null },
  columnMap: Readonly<Record<string, TargetField>>,
): Promise<Transforms> {
  if (targetFor(input.importType) !== 'bank_transactions') return {};

  const targets = new Set(Object.values(columnMap));
  const singleSignedColumn = targets.has('amount')
    && !targets.has('money_in') && !targets.has('money_out');
  if (!singleSignedColumn) return {};

  const accountType = input.bankAccountId === null
    ? null
    : await loadBankAccountType(db, organizationId, input.bankAccountId);

  const bankSign = accountType === null ? null : resolveBankSign(undefined, accountType);
  if (bankSign === null) {
    throw new ValidationError(
      'This statement has a single amount column, so APX cannot tell whether payments out are '
      + 'shown as negative. Export it again with separate money-in and money-out columns.',
    );
  }
  return { bankSign };
}

async function loadBankAccountType(
  db: Db, orgId: string, bankAccountId: string,
): Promise<BankAccountType | null> {
  const data = await orgRowById<{ account_type?: BankAccountType }>(db, orgId, 'bank_accounts', bankAccountId);
  return data?.account_type ?? null;
}

export async function startImport(input: StartImportInput): Promise<StartImportResult> {
  const { db, organizationId, userId, requestId } = input;
  const actor = { userId, requestId };

  const bytes = new Uint8Array(await input.file.arrayBuffer());

  // §4: the file is checked BEFORE anything is stored, so a file MOTION will not read never
  // becomes a document, a batch or a row.
  const validation = validateFile({
    filename: input.file.name,
    declaredMimeType: input.file.type || 'application/octet-stream',
    bytes,
  });
  if (!validation.ok) {
    throw new ValidationError(
      validation.findings[0]?.message ?? 'That file could not be read.',
      validation.findings.map((f) => ({ path: 'file', message: f.message })),
    );
  }

  // ADR-175: one checked invoice covers its own date, set below, so the form's range is not its range.
  const importType = assertImportSupported({
    importType: input.importType,
    bankAccountId: input.bankAccountId,
    ...(input.checkedInvoice === undefined ? { periodStart: input.periodStart, periodEnd: input.periodEnd } : {}),
  });
  const spec = IMPORT_TYPE_SPECS[importType];
  const isPdf = validation.detectedKind === 'pdf' || input.file.name.toLowerCase().endsWith('.pdf');
  const isImage = validation.detectedKind === 'image';

  /*
   * ADR-175: one invoice as a photo, scan or PDF, with the fields the reviewer checked. The document
   * is the evidence; the fields are the row. Only for invoice types, and only for a file that IS a
   * document — a CSV with invoice fields attached would make two claims about the same invoices.
   */
  const checked = input.checkedInvoice;
  if (checked !== undefined && !(readsCheckedInvoice(importType) && (isPdf || isImage))) {
    throw new ValidationError('Checked invoice fields go with a photo, scan or PDF of a sales or purchase invoice.');
  }

  // ADR-150: a photo is a receipt, or nothing MOTION reads. Refused before it is stored.
  // ADR-175: …or one invoice whose fields the reviewer checked.
  if (isImage && checked === undefined && pdfHandling(importType) !== 'read_on_request') {
    throw new ValidationError(readsCheckedInvoice(importType)
      ? 'APX reads an invoice photo on this page before it is uploaded. Choose the file again and check the fields it finds.'
      : 'Photos can be imported as receipts or single invoices only. Choose "Receipts", or upload a CSV, Excel or PDF file.');
  }

  /*
   * ADR-150: a receipt photo or PDF is stored and a batch is started WAITING to be read. Nothing is
   * read yet — reading sends the file to the AI provider, which only a reviewer can ask for, after
   * the consent line and after naming the expense account the receipts post to.
   */
  if (pdfHandling(importType) === 'read_on_request' && (isPdf || isImage)) {
    const stored = await uploadDocument(
      {
        orgId: organizationId, userId, db, requestId,
        registerDocument: (meta) => registerDocument(actor, organizationId, meta),
        finalizeUpload: (documentId, byteSize, scanResult, status) =>
          finalizeUpload(actor, organizationId, { documentId, byteSize, scanResult, status }),
      },
      { filename: input.file.name, declaredMimeType: input.file.type || (isImage ? 'image/jpeg' : 'application/pdf'), bytes, documentKind: spec.documentKind },
    );
    if (stored.status === 'quarantined') {
      throw new ValidationError('That file did not pass the safety check, so it has not been imported.');
    }
    const batchId = await startImportBatch(db, {
      documentId: stored.documentId, importType, periodStart: input.periodStart, periodEnd: input.periodEnd, extractionMethod: 'pdf_text',
    }, requestId);
    await failImportBatch(actor, organizationId, batchId, 'parsing', RECEIPT_WAITING_MESSAGE);
    return {
      batchId, documentId: stored.documentId, accountsCreated: 0, counterpartiesCreated: 0,
      counts: {}, requiredConfirmations: [],
      columns: [], columnMap: {}, headerConfirmationRequired: false, parseFailure: RECEIPT_WAITING_MESSAGE,
    };
  }

  if (isPdf && checked === undefined && pdfHandling(importType) === 'store_only') {
    /*
     * Stored, not read (see `pdfHandling`). The document is registered under its kind, so it is
     * listed, access-controlled and linkable as evidence; no batch is started, because no rows can
     * come from it, and a failed batch would offer the statement-shaped "Read with AI" path.
     */
    const stored = await uploadDocument(
      {
        orgId: organizationId,
        userId,
        db,
        requestId,
        registerDocument: (meta) => registerDocument(actor, organizationId, meta),
        finalizeUpload: (documentId, byteSize, scanResult, status) =>
          finalizeUpload(actor, organizationId, { documentId, byteSize, scanResult, status }),
      },
      {
        filename: input.file.name,
        declaredMimeType: input.file.type || 'application/pdf',
        bytes,
        documentKind: spec.documentKind,
      },
    );
    if (stored.status === 'quarantined') {
      throw new ValidationError('That file did not pass the safety check, so it has not been imported.');
    }
    throw new ValidationError(storedNotReadMessage(importType), [
      { path: 'file', message: `Stored as document ${stored.documentId}; no figures were imported.` },
    ]);
  }

  /*
   * Parse BEFORE anything is stored.
   *
   * Starting the batch first left an orphan behind whenever the file could not be read — a document
   * and a batch in `uploaded` that would never become rows, cluttering the import history with
   * things that never happened. A file MOTION cannot parse should leave no trace but the sentence
   * explaining why (ADR-058.1).
   */
  /*
   * ADR-175: one invoice covers its own date and nothing more. Its range is the invoice date, set
   * here rather than taken from the form, so a single invoice can never be read as "every purchase
   * invoice for September" — coverage needs a batch whose range spans the whole month (§2.2).
   */
  const periodStart = checked === undefined ? input.periodStart : checked.issueDate;
  const periodEnd = checked === undefined ? input.periodEnd : checked.issueDate;

  const fromChecked = checked === undefined
    ? null
    : checkedInvoiceTable(checked, importType === 'sales_invoices' ? 'sales' : 'purchase');
  const parsed: Parsed = fromChecked === null
    ? await parseTable(input.file, bytes)
    : { kind: 'table', table: fromChecked.table, method: 'ocr' };
  // Both are decided from the parsed table alone, and either can refuse the file — so both happen
  // on the same side of the upload as the parse, for the same reason (ADR-058.1). A PDF that
  // yielded no table is the exception: §5.3 and §5.5 say it is STORED, so the refusal comes after
  // the upload, with the document kept.
  const table = parsed.kind === 'table' ? parsed.table : null;
  const columnMap = table === null ? {} : (fromChecked?.columnMap ?? input.columnMap ?? proposeColumnMap(table, input.importType));
  const transforms = table === null ? {} : await resolveTransforms(db, organizationId, input, columnMap);

  const uploaded = await uploadDocument(
    {
      orgId: organizationId,
      userId,
      db,
      requestId,
      registerDocument: (meta) => registerDocument(actor, organizationId, meta),
      finalizeUpload: (documentId, byteSize, scanResult, status) =>
        finalizeUpload(actor, organizationId, { documentId, byteSize, scanResult, status }),
    },
    {
      filename: input.file.name,
      declaredMimeType: input.file.type || 'application/octet-stream',
      bytes,
      // A `document_kind_enum` value. The import type itself is not one for invoice lists or
      // receipts, and the cast in `register_document` refused the whole upload.
      documentKind: spec.documentKind,
      // ADR-175: a scan has no text layer, but its fields were read and checked, so it is ready.
      ...(fromChecked === null ? {} : { readOutsideServer: true }),
    },
  );

  if (parsed.kind === 'scanned' || uploaded.status === 'unreadable') {
    // §5.5: stored as a source document, no batch, and the reader told what to do instead.
    throw new ValidationError(SCANNED_PDF_MESSAGE);
  }
  if (uploaded.status !== 'ready') {
    throw new ValidationError('That file did not pass the safety check, so it has not been imported.');
  }

  const batchId = await startImportBatch(db, {
    documentId: uploaded.documentId,
    importType: input.importType,
    // ABSENT, not null: `StartImportBatchInput` requires a bank account for a statement and forbids
    // one elsewhere, and it expresses "no account" as the key being missing. A null is a value.
    ...(input.bankAccountId === null ? {} : { bankAccountId: input.bankAccountId }),
    periodStart,
    periodEnd,
    extractionMethod: parsed.kind === 'table' ? parsed.method : 'pdf_text',
  }, requestId);

  if (parsed.kind !== 'table' || table === null) {
    // §5.3: the batch exists and says why it has no rows; §5.4's "Read with AI" starts from here.
    const reason = parsed.kind === 'pdf_unparsed' ? parsed.reason : PDF_UNPARSED_MESSAGE;
    await failImportBatch(actor, organizationId, batchId, 'parsing', reason);
    return {
      batchId, documentId: uploaded.documentId, accountsCreated: 0, counterpartiesCreated: 0,
      counts: {}, requiredConfirmations: [],
      columns: [], columnMap: {}, headerConfirmationRequired: false, parseFailure: reason,
    };
  }

  /*
   * The accounts the file names, created before validation (§6.5).
   *
   * A first pass tells us which account names the chart does not have. They are created with a
   * keyword-suggested category — never a trusted one: an account created here shows first on
   * `/data/accounts` and marks everything it feeds incomplete until a human confirms it. Doing this
   * BEFORE the rows are written means the rows resolve, rather than every ledger commit failing on
   * `account_id` being NOT NULL (ADR-058.3).
   *
   * The same pass names the customers or suppliers an invoice list introduces (§6.6), created for
   * the same reason: `invoices.counterparty_id` is NOT NULL.
   */
  let created: { accounts: number; counterparties: number };
  try {
    created = await createMissingReferences({
      db, organizationId, actor, batchId, importType: input.importType,
      table, columnMap, transforms, periodStart, periodEnd,
      bankAccountId: input.bankAccountId,
    });
  } catch (cause) {
    // The document and the batch exist by now: a refusal here must leave the batch FAILED with a
    // reason, never half-prepared — and the reader gets a sentence, not a SQLSTATE.
    const reason = 'APX could not add the accounts or customers this file names. Check the names, then upload it again.';
    await failImportBatch(actor, organizationId, batchId, 'mapping', reason).catch(() => undefined);
    throw new ValidationError(reason, [{ path: 'file', message: cause instanceof Error ? cause.message : String(cause) }]);
  }

  const result = await validateBatch({
    db, organizationId, actor,
    batchId,
    importType: input.importType,
    table,
    columnMap,
    transforms,
    periodStart,
    periodEnd,
    bankAccountId: input.bankAccountId,
  });

  if (checked !== undefined) {
    // R-2's question — does this list hold every invoice unpaid at its start? — has one true answer
    // for a single invoice, so it is recorded rather than asked (ADR-175).
    await recordBatchConfirmation(db, batchId, 'IMP-INV-013', { opening: 'partial' }, requestId);
  }

  return {
    batchId,
    documentId: uploaded.documentId,
    accountsCreated: created.accounts,
    counterpartiesCreated: created.counterparties,
    counts: result.counts,
    requiredConfirmations: result.requiredConfirmations,
    columns: table.columns,
    columnMap,
    headerConfirmationRequired: table.headerConfirmationRequired === true,
  };
}

export interface ValidateBatchInput {
  readonly db: Db;
  readonly organizationId: string;
  readonly actor: { userId: string; requestId: string };
  readonly batchId: string;
  readonly importType: ImportType;
  readonly table: ParsedTable;
  readonly columnMap: Readonly<Record<string, TargetField>>;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly bankAccountId: string | null;
  readonly transforms?: Transforms;
  readonly annotateRow?: PipelineInput['annotateRow'];
  readonly balancesRequired?: boolean;
}

/** Validates a parsed table into a batch's rows: the wizard's and the extraction job's shared step. */
export async function validateBatch(input: ValidateBatchInput): Promise<{
  counts: Record<string, number>;
  requiredConfirmations: readonly string[];
}> {
  const { db, organizationId, actor, batchId } = input;

  // Two settings of the organisation the caller is already working in (the batch's own functions
  // re-check access); read directly, as `organizations` has no row policy of its own in src/db/rls.ts.
  const org = await globalRow(db.fs, 'organizations', organizationId).get();
  const settings = org.exists ? (org.data() as { base_currency?: string; timezone?: string }) : null;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: settings?.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  return parseAndValidate(
    {
      db,
      actorUserId: actor.userId,
      today,
      baseCurrency: settings?.base_currency ?? 'GBP',
      requestId: actor.requestId,
      writeRows: (batch, rows) => writeImportRows(actor, organizationId, batch, rows),
      setValidation: (batch, batchIssues, required, counts, statement) =>
        setBatchValidation(actor, organizationId, batch, batchIssues, required, counts, statement),
      failBatch: (batch, stage, message) =>
        failImportBatch(actor, organizationId, batch, stage, message),
    },
    {
      organizationId,
      batchId,
      importType: input.importType,
      targetTable: targetFor(input.importType),
      table: input.table,
      columnMap: input.columnMap,
      transforms: input.transforms ?? {},
      declaredPeriodStart: input.periodStart,
      declaredPeriodEnd: input.periodEnd,
      bankAccountId: input.bankAccountId,
      ...(input.annotateRow === undefined ? {} : { annotateRow: input.annotateRow }),
      ...(input.balancesRequired === undefined ? {} : { balancesRequired: input.balancesRequired }),
    },
  );
}

/**
 * A dry run of the pipeline, purely to learn which accounts are missing.
 *
 * `runPipeline` is pure and already reports `uncategorisedAccounts`, so this costs a second pass
 * over the parsed table and no database work beyond the create. It is separate from `validateBatch`
 * because nothing should be WRITTEN until the accounts exist — otherwise the rows are written once
 * with a null account and again after the create, and a reader sees the batch change under them.
 */
async function createMissingReferences(
  input: ValidateBatchInput,
): Promise<{ accounts: number; counterparties: number }> {
  const { db, organizationId, batchId } = input;

  // Counterparties are read only where the batch may create them, so a ledger or statement import
  // does exactly the work it did before.
  const createsCounterparties = IMPORT_TYPE_SPECS[input.importType].invoiceSide !== null;
  const [accounts, counterparties] = await Promise.all([
    loadAccountRefs(db, organizationId),
    createsCounterparties ? loadCounterparties(db, organizationId, input.actor.requestId) : Promise.resolve([]),
  ]);

  const dryRun = runPipeline({
    organizationId,
    importType: input.importType,
    targetTable: targetFor(input.importType),
    table: input.table,
    columnMap: input.columnMap,
    transforms: input.transforms ?? {},
    baseCurrency: 'GBP',
    today: input.periodEnd,
    declaredPeriodStart: input.periodStart,
    declaredPeriodEnd: input.periodEnd,
    accounts,
    counterparties,
    existingRecords: [],
  });

  /*
   * One name per stored key ("Acme Ltd" and "ACME LTD" are one customer). NEW names are created;
   * MATCHED names are sent too, so a customer met on a purchase list becomes `both` (§6.6) — in SQL,
   * audited, never decided here. In slices the database accepts (5,000 a call).
   */
  const names = new Map<string, string>();
  for (const name of [...dryRun.newCounterparties, ...dryRun.matchedCounterparties]) {
    const key = storedNameKey(name);
    if (key !== '' && !names.has(key)) names.set(key, name.trim());
  }
  let counterpartiesCreated = 0;
  if (createsCounterparties) {
    const all = [...names.values()];
    for (let from = 0; from < all.length; from += COUNTERPARTY_SLICE) {
      counterpartiesCreated += await createImportCounterparties(
        db, batchId, all.slice(from, from + COUNTERPARTY_SLICE), input.actor.requestId);
    }
  }

  const missing: string[] = [...new Set(dryRun.unmappedAccounts)];
  if (missing.length === 0) return { accounts: 0, counterparties: counterpartiesCreated };

  const accountsCreated = await createImportAccounts(
    db,
    batchId,
    missing.map((name) => {
      const suggestion = suggestCategory(name);
      return {
        name,
        /*
         * Only an EXACT or STRONG keyword match becomes a category. A weak one is a guess, and a
         * guessed category silently changes which metric an account feeds — so `uncategorised` is
         * the honest answer and the Accounts page asks a human for a real one (§6.5).
         */
        standardCategory: suggestion.confidence === 'exact' || suggestion.confidence === 'strong'
          ? suggestion.category
          : 'uncategorised',
      };
    }),
  );
  return { accounts: accountsCreated, counterparties: counterpartiesCreated };
}

async function loadAccountRefs(
  db: Db, orgId: string,
): Promise<Array<{ id: string; code: string | null; normalizedName: string }>> {
  const data = await orgRows<{ id: string; code: string | null; normalized_name: string }>(db, orgId, 'accounts', (q) => q
    .select('id', 'code', 'normalized_name'));
  return data
    .map((row) => ({ id: row.id, code: row.code, normalizedName: row.normalized_name }));
}
