/**
 * The shared contracts of the import pipeline (IMPORT_ENGINE.md §5, §6, §8, §9).
 *
 * Parsers, transforms, mapping, validation and duplicate detection are all PURE: bytes or rows in,
 * data out, no I/O and no clock. Everything that touches the database lives in `data/` or in an
 * `api.*` function. That is what makes the malformed-file catalogue (§17) testable as unit tests
 * rather than as a fixture-loaded integration suite.
 *
 * The governing rule for every type here is SOW §23: nothing a customer uploaded is silently
 * discarded. A line that is not a data row still becomes a row — with status `skipped` and issue
 * `IMP-ROW-005` — so `count(import_rows)` always equals the count of non-empty source lines.
 */

import type { ImportType, ImportTarget } from './types';

// ---------------------------------------------------------------------------------------------
// Parsing (§5)
// ---------------------------------------------------------------------------------------------

export interface ParsedCell {
  readonly value: string | null;
}

export interface ParsedRow {
  /** 1-based, counting the header as row 1 for CSV (§13). */
  readonly rowNumber: number;
  /** `csv:row:17`, `sheet:Bank!row:42`, `page:3;line:12` (§13). */
  readonly sourceRef: string;
  readonly cells: readonly (string | null)[];
  /**
   * True when this line is not part of the table: a preamble line, a report title, page furniture,
   * an unmatched PDF line. It becomes an `import_rows` row with status `skipped` and
   * `IMP-ROW-005`, never a dropped line.
   */
  readonly nonTabular?: boolean;
  /** Set when the source marked the row hidden (`IMP-ROW-003`). */
  readonly hidden?: boolean;
  /** The PDF page this line came from (`import_rows.source_page`), for per-page review (§5.4). */
  readonly sourcePage?: number;
}

/** Statement metadata a bank parser can recover from the document itself. */
export interface StatementMetadata {
  readonly openingBalance?: string;
  readonly closingBalance?: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly accountMasked?: string;
  /** Per-page brought/carried forward, checked for continuity (§5.3, `IMP-BAL-006`). */
  readonly pageBalances?: Readonly<Record<number, { broughtForward?: string; carriedForward?: string }>>;
  /**
   * Date-bearing lines counted by the tokeniser, per page. `IMP-PDF-002` compares this with the
   * number of rows an AI extraction produced, so it must be computed even when no grammar matched.
   */
  readonly dateLineCounts?: Readonly<Record<number, number>>;
}

export interface ParseWarning {
  readonly code: string;
  readonly message: string;
}

export interface ParsedTable {
  /** XLSX sheet name, or `page:N` for a PDF. */
  readonly sheet?: string;
  /** 1-based index of the header row within `rows`, undefined when the file is headerless. */
  readonly headerRow?: number;
  /** Raw header texts, or generated `col_1`… when none was found. */
  readonly columns: readonly string[];
  /**
   * True when the header row was PROPOSED rather than detected by the synonym rule, so the mapping
   * step must ask the reviewer to confirm it (§5.1, finding F-B-18). A preamble line such as
   * "Account Name,Acme Ltd" must never be taken as the header silently.
   */
  readonly headerConfirmationRequired?: boolean;
  readonly rows: readonly ParsedRow[];
  readonly statement?: StatementMetadata;
  readonly warnings: readonly ParseWarning[];
  /** Sheets the workbook offers, when the reviewer must choose (§5.2). */
  readonly availableSheets?: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// File validation (§4)
// ---------------------------------------------------------------------------------------------

export interface FileScanFinding {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}

export interface FileValidationResult {
  readonly ok: boolean;
  readonly findings: readonly FileScanFinding[];
  /** Detected encoding for a CSV, recorded into `transforms` (§4). */
  readonly encoding?: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
  readonly delimiter?: ',' | ';' | '\t' | '|';
  readonly pageCount?: number;
  readonly hasTextLayer?: boolean;
  /**
   * A quarantined file is STORED, not rejected outright: the reviewer and the platform must be able
   * to see what was refused and why (§4).
   */
  readonly quarantine?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Mapping (§6)
// ---------------------------------------------------------------------------------------------

/** Every target field any import type can map to (§6.1). */
export type TargetField =
  | 'entry_date' | 'transaction_date' | 'issue_date' | 'due_date' | 'paid_date' | 'posted_date'
  | 'period_start' | 'period_end'
  | 'account' | 'code' | 'description' | 'reference' | 'journal_ref'
  | 'counterparty' | 'customer' | 'supplier' | 'currency' | 'type'
  | 'amount' | 'debit' | 'credit' | 'money_in' | 'money_out' | 'balance_after'
  | 'opening_balance' | 'closing_balance'
  | 'invoice_number' | 'subtotal' | 'tax_amount' | 'total_amount' | 'amount_paid' | 'status';

export interface ColumnSuggestion {
  readonly sourceColumn: string;
  readonly target: TargetField;
  readonly confidence: 'exact' | 'synonym' | 'weak';
}

export type DateOrder = 'iso' | 'day_first' | 'month_first' | 'excel_serial';
export type BankSign = 'negative_out' | 'positive_out';
export type BalanceSign = 'natural' | 'reporting';
export type GlSign = 'positive_debit' | 'positive_credit';

export interface Transforms {
  readonly encoding?: string;
  readonly delimiter?: string;
  readonly sheet?: string;
  readonly dateOrder?: DateOrder;
  /** Per-column override, where one column differs from the file's dominant order. */
  readonly dateOrderByColumn?: Readonly<Record<string, DateOrder>>;
  readonly decimalSeparator?: '.' | ',';
  readonly thousandsSeparator?: '.' | ',' | ' ' | '';
  readonly bankSign?: BankSign;
  readonly balanceSign?: BalanceSign;
  readonly glSign?: GlSign;
  /** The dedupe recipe version; hashes are recomputed only when it changes (§9.1). */
  readonly dedupeVersion?: string;
}

export interface MappingSnapshot {
  readonly columnMap: Readonly<Record<string, TargetField>>;
  readonly transforms: Transforms;
  readonly accountMap: Readonly<Record<string, string>>;
  readonly headerSignature: string;
  readonly importType: ImportType;
  readonly targetTable: ImportTarget;
  readonly periodStart: string;
  readonly periodEnd: string;
}

// ---------------------------------------------------------------------------------------------
// Validation (§8)
// ---------------------------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning' | 'duplicate' | 'skipped' | 'confirmation';

export interface RowIssue {
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly field?: string;
  readonly message: string;
  readonly suggestion?: string;
}

/** One row after transforms, keyed by target field. Money is a string throughout (ADR-006). */
export type MappedRow = Readonly<Record<string, string | null>>;

export interface ValidatedRow {
  readonly rowNumber: number;
  readonly sourceRef: string;
  readonly raw: Readonly<Record<string, string | null>>;
  readonly mapped: MappedRow;
  readonly issues: readonly RowIssue[];
  readonly status:
    | 'pending' | 'valid' | 'warning' | 'error' | 'duplicate' | 'skipped' | 'committed' | 'rejected';
  readonly dedupeHash?: string;
  /** The default the review screen offers, which a reviewer may override (§9.2). */
  readonly suggestedDecision?: 'keep' | 'skip';
  readonly suggestedReason?: string;
  /** The PDF page the line came from, carried to `import_rows.source_page` (§5.4). */
  readonly sourcePage?: number;
}

export interface BatchIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'confirmation';
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ValidationResult {
  readonly rows: readonly ValidatedRow[];
  readonly batchIssues: readonly BatchIssue[];
  readonly counts: Readonly<Record<string, number>>;
}
