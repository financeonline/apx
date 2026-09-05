/** Pure banking types (ADR-028, ADR-038.4). Money is a string, never a number (ADR-006). */

export type BankAccountType = 'current' | 'savings' | 'credit_card' | 'loan' | 'other';
export type CategorySource = 'rule' | 'user' | 'ai_suggested' | 'none';

/**
 * ADR-047.12: one transfer enum for the whole system. Only `cash_transfer` is excluded from cash
 * metrics (ADR-028) — a card repayment or a loan drawdown is a real movement of the company's money
 * and must stay in, or the cash figures understate what actually left the account.
 */
export type TransferKind =
  | 'none' | 'cash_transfer' | 'card_repayment' | 'loan_repayment' | 'loan_drawdown' | 'other_transfer';

/** The kinds whose paired legs cancel out of cash metrics. Exactly one, deliberately. */
export const CASH_NEUTRAL_TRANSFER_KINDS: readonly TransferKind[] = ['cash_transfer'];

export interface BankAccount {
  readonly id: string;
  readonly name: string;
  readonly bankName: string;
  readonly accountNumberMasked: string | null;
  readonly sortCodeMasked: string | null;
  readonly currency: string;
  readonly accountType: BankAccountType;
  readonly ledgerAccountId: string | null;
  readonly openingBalance: string | null;
  readonly openingBalanceDate: string | null;
  readonly isActive: boolean;
}

export interface BankTransaction {
  readonly id: string;
  readonly bankAccountId: string;
  readonly transactionDate: string;
  readonly periodId: string;
  /** Signed: positive is an inflow. A bank statement is a signed running list. */
  readonly amount: string;
  readonly currency: string;
  /**
   * The MASKED description. `description_raw` is not selectable through this table by any role
   * (ADR-044.2); it is reachable only through the `bank_transactions_raw` definer view, which
   * requires `imports.review`.
   */
  readonly descriptionNormalized: string | null;
  readonly counterpartyId: string | null;
  readonly categoryAccountId: string | null;
  readonly categorySource: CategorySource;
  readonly isTransfer: boolean;
  readonly transferKind: TransferKind;
  readonly transferPairId: string | null;
  readonly recurringGroupId: string | null;
  readonly recordStatus: string;
  readonly assuranceLevel: string;
  readonly supersededBy: string | null;
}

/**
 * The transfer kind implied by a pair of account types (ADR-028).
 *
 * This mirrors the derivation in `api.mark_transfer`. It exists in TypeScript so the UI can say what
 * marking a pair will do BEFORE the call, and a test asserts the two agree. The kind is never taken
 * from the user: letting someone assert `cash_transfer` would let them make a real outflow vanish
 * from the cash figures.
 */
export function transferKindFor(a: BankAccountType, b: BankAccountType): TransferKind {
  if ((a === 'current' || a === 'savings') && (b === 'current' || b === 'savings')) {
    return 'cash_transfer';
  }
  if (a === 'credit_card' || b === 'credit_card') return 'card_repayment';
  if (a === 'loan' || b === 'loan') return 'loan_repayment';
  return 'other_transfer';
}
