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

export { listBankAccounts, listBankTransactions, readRawDescriptions } from './data/repository';
export { markTransfer, overrideBankCategory } from './services';
