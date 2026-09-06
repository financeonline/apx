/**
 * The financial data module (ADR-004): chart of accounts, counterparties and the three
 * accounting record tables, plus the fiscal calendar they hang off.
 *
 * Reads go through RLS on the caller's client; writes go through `api.*` functions. Nothing here
 * calculates a financial figure — the deterministic engine is Phase 6 (`FINANCIAL_ENGINE.md`) and
 * lives in its own module, so that this one stays a data boundary rather than becoming a place
 * where a metric quietly gets defined twice.
 */

export {
  CATEGORY_ACCOUNT_TYPE,
  PNL_CATEGORIES,
  STANDARD_CATEGORIES,
  type Account,
  type AccountSource,
  type AccountType,
  type AssuranceLevel,
  type BalanceBasis,
  type BalanceKind,
  type Counterparty,
  type CounterpartyKind,
  type EntryDirection,
  type FinancialRecordTable,
  type FiscalPeriod,
  type Invoice,
  type InvoiceStatus,
  type InvoiceType,
  type LedgerEntry,
  type MappingConfidence,
  type PeriodBalance,
  type RecordStatus,
  type StandardCategory,
} from './domain/types';

export {
  CreateBankAccountInput,
  IsoDateSchema,
  MergeCounterpartiesInput,
  MoneyStringSchema,
  PageInput,
  RemapAccountInput,
  SetOpeningBalanceInput,
  StandardCategorySchema,
  SupersedeRecordInput,
  UpdateCounterpartyInput,
} from './domain/validation';

export {
  listAccounts,
  listCounterparties,
  listInvoices,
  listLedgerEntries,
  listPeriodBalances,
  listPeriods,
} from './data/repository';

export {
  createBankAccount,
  mergeCounterparties,
  remapAccount,
  setOpeningBalance,
  setOpeningBalanceFlag,
  supersedeRecord,
  updateCounterparty,
} from './services';

export { BASIS_TEXT, METRIC_LABELS, labelFor } from './domain/vocabulary';
