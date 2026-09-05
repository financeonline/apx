/**
 * Transforms (IMPORT_ENGINE.md §6.4). Pure: values in, normalised values out, money as strings.
 */

export {
  alternateOrder,
  countRowsReadDifferently,
  defaultDateOrder,
  detectDateColumn,
  fromExcelSerial,
  parseDateValue,
  readsDifferentlyUnderAlternate,
  type DateColumnDetection,
  type DateDetectionOptions,
  type DateDetectionReason,
  type IsoDate,
} from './dates';

export {
  creditDebitSign,
  detectNumberColumn,
  parseAmount,
  stripCurrency,
  type AmountParseOptions,
  type CurrencyStripResult,
  type NegativeStyle,
  type NumberColumnDetection,
  type NumberFormat,
  type ParsedAmount,
  type SeparatorEvidence,
} from './numbers';

export {
  applyBalanceSign,
  bankAmountFromInOut,
  bankAmountFromSigned,
  bankReconciliation,
  detectBalanceSign,
  glFromDebitCredit,
  glFromSigned,
  isLiabilityBankAccount,
  resolveBankSign,
  type BalanceSignDetection,
  type BalanceSignRow,
  type BalanceSignSample,
  type BankAccountType,
  type BankAmountResult,
  type DirectedAmountResult,
  type ReconciliationInput,
  type ReconciliationResult,
} from './signs';

export { maskDescription } from './masking';
