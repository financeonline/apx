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
  | 'sales_invoices' | 'purchase_invoices' | 'sales_report' | 'purchase_report' | 'receipts';

export type ImportTarget = 'ledger_entries' | 'period_balances' | 'bank_transactions' | 'invoices';

export type ImportBatchStatus =
  | 'created' | 'parsing' | 'mapping' | 'validating' | 'awaiting_review' | 'committing'
  | 'committed' | 'rolled_back' | 'rejected' | 'failed';

export type ImportRowStatus =
  | 'pending' | 'valid' | 'warning' | 'error' | 'duplicate' | 'skipped' | 'committed' | 'rejected';

export type ReviewerDecision = 'none' | 'keep' | 'skip' | 'fixed';

export type DocumentStatus =
  | 'uploaded' | 'scanning' | 'ready' | 'unreadable' | 'quarantined' | 'deleted';

export type DocumentKind =
  | 'bank_statement' | 'general_ledger' | 'trial_balance' | 'pnl_report' | 'balance_sheet'
  | 'sales_report' | 'purchase_report' | 'invoice' | 'receipt' | 'other' | 'unknown';

/** Which record table each import type lands in. Mirrors the mapping in `api.start_import_batch`. */
export const IMPORT_TARGET: Readonly<Record<ImportType, ImportTarget>> = {
  general_ledger: 'ledger_entries',
  receipts: 'ledger_entries',
  trial_balance: 'period_balances',
  pnl_report: 'period_balances',
  balance_sheet: 'period_balances',
  bank_statement: 'bank_transactions',
  sales_invoices: 'invoices',
  purchase_invoices: 'invoices',
  sales_report: 'invoices',
  purchase_report: 'invoices',
} as const;

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
export type ExtractionMethod = 'csv' | 'xlsx' | 'pdf_text' | 'pdf_claude' | 'manual';

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
  readonly rawData: Readonly<Record<string, unknown>>;
  readonly mappedData: Readonly<Record<string, unknown>> | null;
  readonly status: ImportRowStatus;
  readonly issues: readonly ImportIssue[];
  readonly reviewerDecision: ReviewerDecision;
  readonly reviewerReason: string | null;
  readonly committedTable: string | null;
  readonly committedRecordId: string | null;
}
