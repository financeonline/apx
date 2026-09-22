/**
 * Banking data (ADR-028, ADR-038.4). Statement accounts, transactions, categorisation and transfers.
 *
 * Transfer DETECTION and recurring-payment detection are the calculation engine's job (Phase 6,
 * FINANCIAL_ENGINE.md §4); this module holds the data boundary and the manual overrides.
 */
export {
  CASH_NEUTRAL_TRANSFER_KINDS,
  transferKindFor,
  type BankAccount,
  type BankAccountType,
  type BankTransaction,
  type CategorySource,
  type TransferKind,
} from './domain/types';

/**
 * Phase 6 (FINANCIAL_ENGINE.md §4): the pure banking rules the calculation engine runs. All four
 * are functions of typed inputs to typed outputs — no clock, no I/O, no reliance on input order.
 */
export {
  KEYWORD_RULES,
  KEYWORD_RULE_SET_VERSION,
  UNCATEGORISED_CATEGORY,
  categoriseTransaction,
  categoriseTransactions,
  descriptionSignature,
  matchKeywordRule,
  uncategorisedShare,
  type AiCategorySuggestion,
  type CategorisableTransaction,
  type CategorisationInput,
  type CategorisationResult,
  type CategorisationStage,
  type CategorisedAmount,
  type CategoryAccountRef,
  type KeywordRule,
  type KeywordRuleDirection,
  type OrganizationCategoryRule,
  type UncategorisedShare,
} from './domain/categorisation';

export {
  CASH_LIKE_ACCOUNT_TYPES,
  TRANSFER_DESCRIPTION_PATTERN,
  TRANSFER_MAX_DAYS_APART,
  daysBetween,
  descriptionSimilarity,
  detectTransfers,
  isCashLikeAccountType,
  legCountsInCashMetrics,
  looksLikeTransfer,
  transferCategoryFor,
  transferDescriptionGate,
  type TransferBankAccount,
  type TransferCandidateTransaction,
  type TransferDetectionInput,
  type TransferDetectionResult,
  type TransferLeg,
  type TransferPair,
  type UnpairedTransferCandidate,
  type UnpairedTransferReason,
} from './domain/transfers';

export {
  CADENCE_BANDS,
  RECURRING_DETECTOR_VERSION,
  RECURRING_MIN_OCCURRENCES,
  RECURRING_SIGNATURE_MAX_LENGTH,
  RECURRING_WINDOW_MONTHS,
  addDays,
  cadenceLengthDays,
  classifyCadence,
  detectRecurring,
  recurringCounterpartyKey,
  recurringGroupKey,
  recurringSignature,
  subtractMonths,
  type CadenceOutcome,
  type RecurringCadence,
  type RecurringDetectionInput,
  type RecurringGroup,
  type RecurringStatus,
  type RecurringTransaction,
} from './domain/recurring';

export {
  NON_PNL_CATEGORIES,
  UNCATEGORISED_MISSING_THRESHOLD,
  UNCATEGORISED_WARNING_THRESHOLD,
  buildBankProxy,
  cashAccountIds,
  hasUnclassifiedCardSpend,
  isNonPnlCategory,
  netOfVat,
  proxyBankAccountIds,
  type BankProxyInput,
  type BankProxyResult,
  type ProxyBankAccount,
  type ProxyCategoryAmount,
  type ProxyDescriptorFilters,
  type ProxyMissing,
  type ProxyTransaction,
  type ProxyVatSettings,
  type ProxyWarning,
} from './domain/proxy';

/**
 * Phase 13 (ADR-101): the three rules above, COMPOSED and RUN. `planBankingPass` is pure; the
 * calculation run applies its plan through `api_server.apply_banking_pass` before it fingerprints.
 */
export {
  BANKING_PASS_VERSION,
  accountForCategory,
  applyPlanInMemory,
  bankingRuleVersions,
  planBankingPass,
  type BankingPassInput,
  type BankingPassPlan,
  type CategorisationWrite,
  type GroupWrite,
  type PairWrite,
  type PassBankAccount,
  type PassTransaction,
} from './domain/pass';

export {
  countBankTransactions,
  listBankAccounts,
  listBankTransactions,
  listRecurringGroups,
  loadBankTransaction,
  loadLatestGroupMembers,
  readRawDescriptions,
  type BankTransactionFilter,
  type RecurringGroupRow,
} from './data/repository';
export { markTransfer, overrideBankCategory } from './services';
export { bankingStep, runBankingPass, type BankingStepDeps } from './services/pass';
