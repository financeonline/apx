/**
 * Documents and imports (ADR-012, ADR-029, ADR-033).
 *
 * Phase 2 (plan Phase 4) delivers the schema, the read layer and the batch lifecycle up to review.
 * Parsing, validation issue codes, duplicate detection and commit/rollback are the import engine
 * (Phase 5) — see the note in `services/index.ts`.
 */
export {
  IMPORT_TARGET,
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
  decideImportRows,
  deleteDocument,
  rejectImportBatch,
  saveImportMapping,
  setStatementBalances,
  startImportBatch,
} from './services';
