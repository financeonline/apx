/**
 * Pure import types (ADR-012, ADR-029, ADR-033).
 *
 * The governing rule for this module is SOW §23: nothing a customer uploaded is ever silently
 * discarded. Every parsed line becomes an `import_rows` row — including the non-tabular ones, which
 * are kept with status `skipped` — so the row count always equals the count of non-empty source
 * lines, and a reviewer can always account for what happened to their file.
 */

export type ImportType =
  | 'general_ledger' | 'trial_balance' | 'pnl_report' | 'balance_sheet' | 'bank_statement'
  | 'sales_invoices' | 'purchase_invoices' | 'sales_report' | 'purchase_report' | 'receipts'
  | 'budget';

/** `budget_lines` (ADR-142) is the one target that is not a record of what happened: a plan. */
export type ImportTarget = 'ledger_entries' | 'period_balances' | 'bank_transactions' | 'invoices' | 'budget_lines';

export type ImportBatchStatus =
  | 'created' | 'parsing' | 'mapping' | 'validating' | 'awaiting_review' | 'committing'
  | 'committed' | 'rolled_back' | 'rejected' | 'failed';

export type ImportRowStatus =
  | 'pending' | 'valid' | 'warning' | 'error' | 'duplicate' | 'skipped' | 'committed' | 'rejected';

export type ReviewerDecision = 'none' | 'keep' | 'skip' | 'fixed';

export type DocumentStatus =
  | 'uploaded' | 'scanning' | 'ready' | 'unreadable' | 'quarantined' | 'deleted';

/** `document_kind_enum`, value for value (`test/unit/import-type-spec` reads the migration). */
export const DOCUMENT_KINDS = [
  'bank_statement', 'general_ledger', 'trial_balance', 'pnl_report', 'balance_sheet',
  'sales_report', 'purchase_report', 'invoice', 'receipt', 'other', 'unknown', 'budget',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

/** Which side of the business an invoice list records; it decides `invoices.invoice_type`. */
export type InvoiceSide = 'sales' | 'purchase';

/**
 * Everything an import type decides, in one place (IMPORT_ENGINE.md §6.1).
 *
 * The wizard once kept its own copy of the target table, and the copy drifted: receipts went to
 * `bank_transactions` and sales/purchase reports to `period_balances`, while `api.start_import_batch`
 * — which is what the batch row records — sent them to `ledger_entries` and `invoices`. It also
 * passed the import type itself as the source document's kind, which `document_kind_enum` refuses
 * for `sales_invoices`, `purchase_invoices` and `receipts`, so an invoice list could not be
 * uploaded at all. Every reader now takes its answer from this table; `test/unit/import-type-spec`
 * checks it against the SQL CASE in `api.start_import_batch` and the `document_kind_enum` values.
 */
export interface ImportTypeSpec {
  /** The record table rows commit into. Must equal `api.start_import_batch`'s CASE. */
  readonly target: ImportTarget;
  /** `source_documents.document_kind` for the uploaded file. Must be a `document_kind_enum` value. */
  readonly documentKind: DocumentKind;
  /** For an invoice target: which side, so every row carries an `invoice_type`. */
  readonly invoiceSide: InvoiceSide | null;
  /** A bank statement belongs to one bank account; nothing else may name one. */
  readonly bankAccount: 'required' | 'not_allowed';
  /** The deterministic PDF reader only knows bank-statement layouts (§5.3). */
  readonly pdfSupported: boolean;
}

export const IMPORT_TYPE_SPECS: Readonly<Record<ImportType, ImportTypeSpec>> = {
  general_ledger: {
    target: 'ledger_entries', documentKind: 'general_ledger', invoiceSide: null,
    bankAccount: 'not_allowed', pdfSupported: false,
  },
  // §6.1: one ledger row per receipt, against the expense account the file names. Not a bank line:
  // a receipt is evidence of spending, and the bank statement already carries the payment.
  receipts: {
    target: 'ledger_entries', documentKind: 'receipt', invoiceSide: null,
    bankAccount: 'not_allowed', pdfSupported: false,
  },
  trial_balance: {
    target: 'period_balances', documentKind: 'trial_balance', invoiceSide: null,
    bankAccount: 'not_allowed', pdfSupported: false,
  },
  pnl_report: {
    target: 'period_balances', documentKind: 'pnl_report', invoiceSide: null,
    bankAccount: 'not_allowed', pdfSupported: false,
  },
  balance_sheet: {
    target: 'period_balances', documentKind: 'balance_sheet', invoiceSide: null,
    bankAccount: 'not_allowed', pdfSupported: false,
  },
  bank_statement: {
    target: 'bank_transactions', documentKind: 'bank_statement', invoiceSide: null,
    bankAccount: 'required', pdfSupported: true,
  },
  sales_invoices: {
    target: 'invoices', documentKind: 'invoice', invoiceSide: 'sales',
    bankAccount: 'not_allowed', pdfSupported: false,
  },
  purchase_invoices: {
    target: 'invoices', documentKind: 'invoice', invoiceSide: 'purchase',
    bankAccount: 'not_allowed', pdfSupported: false,
  },
  // §6.1: a report is accepted when it has one line per invoice, so it lands exactly where an
  // invoice list does.
  sales_report: {
    target: 'invoices', documentKind: 'sales_report', invoiceSide: 'sales',
    bankAccount: 'not_allowed', pdfSupported: false,
  },
  purchase_report: {
    target: 'invoices', documentKind: 'purchase_report', invoiceSide: 'purchase',
    bankAccount: 'not_allowed', pdfSupported: false,
  },
  // ADR-142: month, account and amount, mapped to the chart like a trial balance. A plan, not a
  // record — the engine never reads it; budget-versus-actual is computed beside it.
  budget: {
    target: 'budget_lines', documentKind: 'budget', invoiceSide: null,
    bankAccount: 'not_allowed', pdfSupported: false,
  },
};

export const IMPORT_TYPES = Object.keys(IMPORT_TYPE_SPECS) as readonly ImportType[];

export function isImportType(value: string): value is ImportType {
  return Object.prototype.hasOwnProperty.call(IMPORT_TYPE_SPECS, value);
}

/** Which record table each import type lands in. Mirrors the mapping in `api.start_import_batch`. */
export const IMPORT_TARGET: Readonly<Record<ImportType, ImportTarget>> = Object.fromEntries(
  IMPORT_TYPES.map((type) => [type, IMPORT_TYPE_SPECS[type].target]),
) as Record<ImportType, ImportTarget>;

export interface SourceDocument {
  readonly id: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly documentKind: DocumentKind;
  readonly status: DocumentStatus;
  readonly pageCount: number | null;
  readonly hasTextLayer: boolean | null;
  readonly uploadedBy: string | null;
  readonly createdAt: string;
}

/** How a batch's rows were read (`import_batches.extraction_method`). */
export type ExtractionMethod = 'csv' | 'xlsx' | 'pdf_text' | 'pdf_claude' | 'manual' | 'ocr';

export interface ImportBatch {
  readonly id: string;
  readonly sourceDocumentId: string;
  readonly importType: ImportType;
  readonly targetTable: ImportTarget;
  readonly bankAccountId: string | null;
  readonly status: ImportBatchStatus;
  readonly rowCounts: Readonly<Record<string, number>>;
  /** ADR-047.6: the DECLARED export range, not the first and last posting date. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly balanceBasis: 'cumulative' | 'movement' | null;
  readonly committedAt: string | null;
  readonly rolledBackAt: string | null;
  readonly extractionMethod: ExtractionMethod;
  /** `{stage, message}` when the batch failed (§7.2, §16). */
  readonly errorSummary: { readonly stage?: string; readonly message?: string } | null;
  /** §5.4 per-page completion (`import_batches.extraction_stats`). */
  readonly extractionStats: {
    readonly pages_total?: number; readonly pages_extracted?: number[]; readonly pages_failed?: number[]; readonly pages_deferred?: number[];
    readonly attempts?: Record<string, number>; readonly tokens_in?: number; readonly tokens_out?: number;
    readonly confidence?: Record<string, string>; readonly line_counts?: Record<string, number>;
    readonly balances_read?: { opening?: string; closing?: string }; readonly errors?: Record<string, string>;
  };
  /** Pages a reviewer has confirmed, by page number (`api.confirm_pdf_page`). */
  readonly pageConfirmations: Record<string, { by: string; at: string }>;
}

export interface ImportIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly field: string | null;
  readonly message: string;
  readonly suggestion: string | null;
}

export interface ImportRow {
  readonly id: string;
  readonly rowNumber: number;
  readonly sourceRef: string | null;
  readonly sourcePage: number | null;
  readonly rawData: Readonly<Record<string, unknown>>;
  readonly mappedData: Readonly<Record<string, unknown>> | null;
  readonly status: ImportRowStatus;
  readonly issues: readonly ImportIssue[];
  readonly reviewerDecision: ReviewerDecision;
  readonly reviewerReason: string | null;
  readonly committedTable: string | null;
  readonly committedRecordId: string | null;
}
