/**
 * Documents and imports (ADR-012, ADR-029, ADR-033).
 *
 * Phase 2 (plan Phase 4) delivers the schema, the read layer and the batch lifecycle up to review.
 * Parsing, validation issue codes, duplicate detection and commit/rollback are the import engine
 * (Phase 5) — see the note in `services/index.ts`.
 */
export {
  DOCUMENT_KINDS,
  IMPORT_TARGET,
  IMPORT_TYPES,
  isDocumentKind,
  IMPORT_TYPE_SPECS,
  isImportType,
  type ImportTypeSpec,
  type InvoiceSide,
  type DocumentKind,
  type DocumentStatus,
  type ImportBatch,
  type ImportBatchStatus,
  type ImportIssue,
  type ImportRow,
  type ImportRowStatus,
  type ImportTarget,
  type ImportType,
  type ReviewerDecision,
  type SourceDocument,
} from './domain/types';

export {
  DecideImportRowsInput,
  SaveImportMappingInput,
  SetStatementBalancesInput,
  StartImportBatchInput,
} from './domain/validation';

export { countRowsByStatus, listBatchRows, listBatches, listDocuments } from './data/repository';

export {
  commitImportBatch,
  confirmPdfPage,
  decideImportRows,
  recordBatchConfirmation,
  rejectImportBatch,
  replaceImportBatch,
  rollbackImportBatch,
  saveImportMapping,
  setStatementBalances,
  startImportBatch,
  type CommitResult,
} from './services';

export {
  SYNC_ROW_LIMIT,
  parseAndValidate,
  type ParseAndValidateDeps,
  type ParseAndValidateInput,
} from './services/parse-and-validate';

// ---------------------------------------------------------------------------------------------
// The Phase 3 (plan Phase 5) import pipeline. Exposed through the barrel because the parsers, the
// transforms and the tests all speak these types, and `motion/no-deep-module-import` — correctly —
// refuses a path into `domain/`.
// ---------------------------------------------------------------------------------------------
export type {
  BatchIssue,
  ColumnSuggestion,
  FileValidationResult,
  IssueSeverity,
  MappedRow,
  MappingSnapshot,
  ParsedRow,
  ParsedTable,
  RowIssue,
  StatementMetadata,
  TargetField,
  Transforms,
  ValidatedRow,
  ValidationResult,
} from './domain/pipeline-types';

export { parseCsv, type CsvParseOptions } from './domain/parsers/csv';
export * from './domain/parsers/xlsx';
export * from './domain/parsers/pdf-text';
export * from './domain/parsers/pdf-scanned';

export {
  DEDUPE_VERSION,
  absoluteAmountKey,
  dedupeHash,
  detectDuplicates,
  detectReExport,
  normalizeBankName,
  normalizeDescription,
  scopeKey,
} from './domain/dedupe';

export {
  REQUIRED_FIELDS,
  checkBatch,
  looksLikeOpenItems,
  requiredConfirmations,
  satisfiedFieldSet,
  statusForIssues,
  validateRow,
} from './domain/validate-rows';

export { runPipeline, type PipelineInput, type PipelineResult } from './domain/pipeline';

export * from './domain/mapping';
export * from './domain/transforms';

/**
 * The wizard (§2–§8) and the two screens it feeds. Server-only; the pages render their view models.
 */
export {
  startImport,
  assertImportSupported,
  pdfHandling,
  targetFor,
  type StartImportInput,
  type StartImportResult,
} from './services/wizard';

export {
  groupIssues,
  loadBatchReview,
  loadImportHistory,
  type BatchIssueGroup,
  type BatchReview,
  type ImportHistoryRow,
} from './services/review';
export { validateBatch, proposeColumnMap, type ValidateBatchInput } from './services/wizard';
export {
  attestReportCompleteness, loadReportCompleteness,
  type CompletenessAnswer, type CompletenessAttestationView, type CompletenessMonth, type ReportCompletenessView, type ReportScope,
} from './services/completeness';
export { setStatementBalancesAndRevalidate, type BalanceComparison, type RevalidationResult } from './services/statement-balances';
