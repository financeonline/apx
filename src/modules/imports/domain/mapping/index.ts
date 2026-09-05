/**
 * Mapping (IMPORT_ENGINE.md §6.2, §6.3, §6.5, §6.6). Pure; the database lookups the resolution
 * order needs are passed in by the service layer.
 */

export {
  TARGET_FIELDS,
  SYNONYM_TABLE,
  headerSignature,
  isKnownHeader,
  normalizeHeader,
  suggestColumns,
} from './synonyms';

export {
  CATEGORY_KEYWORDS,
  normalizeAccountCode,
  normalizeAccountName,
  resolveAccountCategory,
  suggestCategory,
  suggestSupplierExpenseCategory,
  type AccountResolution,
  type AccountResolutionInput,
  type AccountResolutionSource,
  type CategoryConfidence,
  type CategorySuggestion,
  type ExistingAccount,
} from './category-keywords';

export {
  counterpartyKindFor,
  findFigureInName,
  nameCarriesFigure,
  nameFigureIssue,
  normalizedName,
  upgradeCounterpartyKind,
  type NameFigureFinding,
  type NameFigureKind,
} from './counterparty';
