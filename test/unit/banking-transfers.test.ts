import { describe, expect, it } from 'vitest';

import {
  CASH_LIKE_ACCOUNT_TYPES,
  CASH_NEUTRAL_TRANSFER_KINDS,
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
  transferKindFor,
  type TransferBankAccount,
  type TransferCandidateTransaction,
} from '@/modules/banking';

/**
 * Transfer detection (FINANCIAL_ENGINE.md §4.2; CD-28, ADR-028, ADR-047.12).
 *
 * The stakes are asymmetric and that shapes every test here. A missed pair leaves two matching
 * movements in the figures, which is visible and correctable. A WRONG pair silently deletes two real
 * movements from cash — the customer receipt and the supplier payment both vanish and no line
 * anywhere says where they went. So the description gate gets the most tests.
 */

const CURRENT: TransferBankAccount = { id: 'acc-current', name: 'Barclays Current', accountType: 'current' };
const SAVINGS: TransferBankAccount = { id: 'acc-savings', name: 'Barclays Savings', accountType: 'savings' };
const CURRENT_2: TransferBankAccount = { id: 'acc-current-2', name: 'HSBC Trading', accountType: 'current' };
const CARD: TransferBankAccount = { id: 'acc-card', name: 'Barclaycard Business', accountType: 'credit_card' };
const LOAN: TransferBankAccount = { id: 'acc-loan', name: 'Iwoca Facility', accountType: 'loan' };

const ACCOUNTS = [CURRENT, SAVINGS, CURRENT_2, CARD, LOAN];

function txn(
  id: string,
  bankAccountId: string,
  transactionDate: string,
  amount: string,
  descriptionNormalized: string | null,
): TransferCandidateTransaction {
  return { id, bankAccountId, transactionDate, amount, descriptionNormalized };
}

describe('the account-type sets (§4.4, ADR-028)', () => {
  it('treats only current and savings as cash-like', () => {
    expect([...CASH_LIKE_ACCOUNT_TYPES].sort()).toEqual(['current', 'savings']);
    expect(isCashLikeAccountType('current')).toBe(true);
    expect(isCashLikeAccountType('savings')).toBe(true);
    expect(isCashLikeAccountType('credit_card')).toBe(false);
    expect(isCashLikeAccountType('loan')).toBe(false);
    expect(isCashLikeAccountType('other')).toBe(false);
  });
});

describe('the description gate (ADR-047.12)', () => {
  it('passes when either leg says "transfer"', () => {
    expect(transferDescriptionGate(
      { descriptionNormalized: 'TRANSFER TO SAVINGS', accountName: 'Barclays Current' },
      { descriptionNormalized: 'CREDIT', accountName: 'Barclays Savings' },
    )).toBe('description_pattern');
  });

  it('accepts every wording ADR-047.12 names', () => {
    for (const wording of ['transfer', 'tfr', 'to savings', 'from current', 'own account']) {
      expect(looksLikeTransfer(`bank ${wording} 123`)).toBe(true);
    }
    expect(TRANSFER_DESCRIPTION_PATTERN.global).toBe(false);
  });

  it('passes when a leg names the OTHER account', () => {
    expect(transferDescriptionGate(
      { descriptionNormalized: 'TO BARCLAYS SAVINGS', accountName: 'Barclays Current' },
      { descriptionNormalized: 'CREDIT 4471', accountName: 'Barclays Savings' },
    )).toBe('other_account_name');
  });

  it('fails when neither leg says anything about a transfer', () => {
    expect(transferDescriptionGate(
      { descriptionNormalized: 'ACME LTD INVOICE 1042', accountName: 'Barclays Current' },
      { descriptionNormalized: 'BETA SUPPLIES', accountName: 'HSBC Trading' },
    )).toBeNull();
  });

  it('does not pass on an account whose name is empty', () => {
    expect(transferDescriptionGate(
      { descriptionNormalized: 'ACME LTD', accountName: '' },
      { descriptionNormalized: 'BETA LTD', accountName: '' },
    )).toBeNull();
  });
});

describe('a customer receipt and a supplier payment are NOT paired (§4.2, the whole point)', () => {
  // £4,800 in from a customer on the 10th, £4,800 out to a supplier on the 12th. Amount, date and
  // account all match. Without the gate both would cancel and both would leave the figures.
  const rows = [
    txn('t-in', CURRENT.id, '2026-03-10', '4800.00', 'ACME LTD INVOICE 1042'),
    txn('t-out', CURRENT_2.id, '2026-03-12', '-4800.00', 'BETA SUPPLIES LTD'),
  ];

  it('pairs nothing', () => {
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).pairs).toHaveLength(0);
  });

  it('flags BOTH rows for reviewer confirmation', () => {
    const { unpairedCandidates } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(unpairedCandidates.map((c) => c.transactionId).sort()).toEqual(['t-in', 't-out']);
    for (const candidate of unpairedCandidates) {
      expect(candidate.reason).toBe('description_gate_failed');
    }
  });

  it('names the row each would have been paired with', () => {
    const { unpairedCandidates } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    const inbound = unpairedCandidates.find((c) => c.transactionId === 't-in');
    expect(inbound?.counterpartTransactionId).toBe('t-out');
  });

  it('leaves both rows in the figures — nothing is marked as a transfer', () => {
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    const pairedIds = pairs.flatMap((p) => [p.inflowTransactionId, p.outflowTransactionId]);
    expect(pairedIds).not.toContain('t-in');
    expect(pairedIds).not.toContain('t-out');
  });
});

describe('a genuine transfer IS paired and cancels out of cash (§4.2)', () => {
  const rows = [
    txn('t-out', CURRENT.id, '2026-03-10', '-5000.00', 'TRANSFER TO SAVINGS'),
    txn('t-in', SAVINGS.id, '2026-03-11', '5000.00', 'CREDIT FROM CURRENT'),
  ];

  it('pairs both legs', () => {
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.outflowTransactionId).toBe('t-out');
    expect(pairs[0]!.inflowTransactionId).toBe('t-in');
    expect(pairs[0]!.gateReason).toBe('description_pattern');
  });

  it('classifies it as a cash_transfer via transferKindFor, not by re-deriving the rule', () => {
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.transferKind).toBe('cash_transfer');
    expect(pairs[0]!.transferKind).toBe(transferKindFor('current', 'savings'));
  });

  it('maps to the system transfer category (§4.2 table)', () => {
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.categoryStandardCategory).toBe('transfer');
  });

  it('removes both legs from cash, so they cancel', () => {
    expect(legCountsInCashMetrics({ transferKind: 'cash_transfer', bankAccountType: 'current' })).toBe(false);
    expect(legCountsInCashMetrics({ transferKind: 'cash_transfer', bankAccountType: 'savings' })).toBe(false);
  });

  it('raises no unpaired candidate once the pair is made', () => {
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).unpairedCandidates).toHaveLength(0);
  });

  it('gives the pair a deterministic id built from the two transaction ids', () => {
    const forwards = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    const backwards = detectTransfers({ transactions: [...rows].reverse(), bankAccounts: ACCOUNTS });
    expect(backwards.pairs[0]!.pairId).toBe(forwards.pairs[0]!.pairId);
  });
});

describe('a payment to a credit card is a card_repayment and STAYS a cash outflow (ADR-028)', () => {
  const rows = [
    txn('t-out', CURRENT.id, '2026-03-20', '-1200.00', 'TRANSFER TO BARCLAYCARD'),
    txn('t-in', CARD.id, '2026-03-20', '1200.00', 'PAYMENT RECEIVED THANK YOU'),
  ];

  it('pairs the two legs', () => {
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).pairs).toHaveLength(1);
  });

  it('classifies the pair as card_repayment', () => {
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.transferKind).toBe('card_repayment');
  });

  it('reports the cash-like leg under category credit_card, not transfer', () => {
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.categoryStandardCategory).toBe('credit_card');
  });

  it('keeps the cash-like leg IN the cash figures — this is the ADR-028 defect', () => {
    // Excluding it overstated closing cash by every repayment, cumulatively.
    expect(legCountsInCashMetrics({ transferKind: 'card_repayment', bankAccountType: 'current' })).toBe(true);
  });

  it('keeps the CARD leg out of cash, because a card account is not cash', () => {
    expect(legCountsInCashMetrics({ transferKind: 'card_repayment', bankAccountType: 'credit_card' })).toBe(false);
  });

  it('names exactly one cash-neutral kind, deliberately', () => {
    expect([...CASH_NEUTRAL_TRANSFER_KINDS]).toEqual(['cash_transfer']);
  });
});

describe('a loan pair (§4.2 table)', () => {
  const rows = [
    txn('t-out', CURRENT.id, '2026-03-05', '-620.00', 'TRANSFER IWOCA FACILITY'),
    txn('t-in', LOAN.id, '2026-03-05', '620.00', 'REPAYMENT'),
  ];

  it('classifies as loan_repayment and maps to the loan category', () => {
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.transferKind).toBe('loan_repayment');
    expect(pairs[0]!.categoryStandardCategory).toBe('loan');
  });

  it('keeps the cash-like leg in cash', () => {
    expect(legCountsInCashMetrics({ transferKind: 'loan_repayment', bankAccountType: 'current' })).toBe(true);
    expect(legCountsInCashMetrics({ transferKind: 'loan_drawdown', bankAccountType: 'current' })).toBe(true);
  });
});

describe('the category map covers the whole enum (§4.2 table)', () => {
  it('maps every kind', () => {
    expect(transferCategoryFor('cash_transfer')).toBe('transfer');
    expect(transferCategoryFor('card_repayment')).toBe('credit_card');
    expect(transferCategoryFor('loan_repayment')).toBe('loan');
    expect(transferCategoryFor('loan_drawdown')).toBe('loan');
    expect(transferCategoryFor('other_transfer')).toBe('transfer');
    expect(transferCategoryFor('none')).toBeNull();
  });

  /**
   * DOCUMENT/CODE DIVERGENCE, pinned here rather than papered over.
   *
   * §4.2's table says a `credit_card` ↔ `loan` pair is `other_transfer`. The shared
   * `transferKindFor` — which has a SQL twin in `api.mark_transfer` — tests for `credit_card`
   * first and returns `card_repayment`. This module classifies with the shared helper as
   * instructed and does NOT re-derive the rule, so the helper's answer is what ships. The test
   * asserts the helper rather than the table so that a later fix to `transferKindFor` (and its SQL
   * twin, together) shows up here as a deliberate change rather than a silent one.
   *
   * Nothing about cash turns on it: neither leg is on a cash-like account, so neither counts in
   * cash under either classification.
   */
  it('classifies a card ↔ loan pair with the shared helper, which says card_repayment', () => {
    const rows = [
      txn('t-out', CARD.id, '2026-03-05', '-100.00', 'TRANSFER'),
      txn('t-in', LOAN.id, '2026-03-05', '100.00', 'CREDIT'),
    ];
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.transferKind).toBe(transferKindFor('credit_card', 'loan'));
    expect(pairs[0]!.transferKind).toBe('card_repayment');
    expect(legCountsInCashMetrics({ transferKind: 'card_repayment', bankAccountType: 'credit_card' })).toBe(false);
    expect(legCountsInCashMetrics({ transferKind: 'other_transfer', bankAccountType: 'loan' })).toBe(false);
  });

  it('makes a savings ↔ other pair other_transfer', () => {
    const other: TransferBankAccount = { id: 'acc-other', name: 'Wise Jar', accountType: 'other' };
    const rows = [
      txn('t-out', other.id, '2026-03-05', '-100.00', 'TRANSFER'),
      txn('t-in', 'acc-other-2', '2026-03-05', '100.00', 'CREDIT'),
    ];
    const { pairs } = detectTransfers({
      transactions: rows,
      bankAccounts: [...ACCOUNTS, other, { id: 'acc-other-2', name: 'Wise Jar 2', accountType: 'other' }],
    });
    expect(pairs[0]!.transferKind).toBe('other_transfer');
    expect(pairs[0]!.categoryStandardCategory).toBe('transfer');
  });
});

describe('the matching window (§4.2)', () => {
  it('accepts a three-day gap', () => {
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER TO SAVINGS'),
      txn('t-in', SAVINGS.id, '2026-03-13', '500.00', 'CREDIT'),
    ];
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).pairs).toHaveLength(1);
    expect(TRANSFER_MAX_DAYS_APART).toBe(3);
  });

  it('refuses a four-day gap', () => {
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER TO SAVINGS'),
      txn('t-in', SAVINGS.id, '2026-03-14', '500.00', 'CREDIT'),
    ];
    const result = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(result.pairs).toHaveLength(0);
    // The outflow still reads like a transfer, so it is flagged rather than forgotten.
    expect(result.unpairedCandidates.map((c) => c.reason)).toContain('transfer_wording_unpaired');
  });

  it('refuses a mismatched amount', () => {
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER TO SAVINGS'),
      txn('t-in', SAVINGS.id, '2026-03-10', '500.01', 'CREDIT'),
    ];
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).pairs).toHaveLength(0);
  });

  it('refuses two rows on the SAME bank_accounts row', () => {
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER'),
      txn('t-in', CURRENT.id, '2026-03-10', '500.00', 'TRANSFER'),
    ];
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).pairs).toHaveLength(0);
  });

  it('ignores a transaction on an account it was not told about', () => {
    const rows = [
      txn('t-out', 'acc-unknown', '2026-03-10', '-500.00', 'TRANSFER TO SAVINGS'),
      txn('t-in', SAVINGS.id, '2026-03-10', '500.00', 'CREDIT'),
    ];
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).pairs).toHaveLength(0);
  });

  it('measures whole days in UTC, so a clock change cannot shrink the window', () => {
    expect(daysBetween('2026-03-28', '2026-03-31')).toBe(3);
    expect(daysBetween('2026-03-31', '2026-03-28')).toBe(3);
  });
});

describe('ranking prefers the closest date, then description similarity (§4.2)', () => {
  it('takes the nearer inflow when two match', () => {
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER TO SAVINGS'),
      txn('t-far', SAVINGS.id, '2026-03-13', '500.00', 'CREDIT'),
      txn('t-near', CURRENT_2.id, '2026-03-11', '500.00', 'CREDIT'),
    ];
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.inflowTransactionId).toBe('t-near');
  });

  it('breaks a date tie on description similarity', () => {
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER TO SAVINGS ACCOUNT'),
      txn('t-plain', CURRENT_2.id, '2026-03-11', '500.00', 'CREDIT'),
      txn('t-similar', SAVINGS.id, '2026-03-11', '500.00', 'TRANSFER TO SAVINGS ACCOUNT'),
    ];
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.inflowTransactionId).toBe('t-similar');
  });

  it('breaks a distance tie on the earlier inflow date when similarity also ties', () => {
    // Both candidates are two days from the outflow, one before and one after, with identical
    // descriptions. Level 3 of the tie-break takes the earlier date.
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER'),
      txn('t-after', CURRENT_2.id, '2026-03-12', '500.00', 'CREDIT'),
      txn('t-before', SAVINGS.id, '2026-03-08', '500.00', 'CREDIT'),
    ];
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.inflowTransactionId).toBe('t-before');
  });

  it('breaks a full tie on the lowest inflow id, which uuids can never share', () => {
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER'),
      txn('t-zz', CURRENT_2.id, '2026-03-11', '500.00', 'CREDIT'),
      txn('t-aa', SAVINGS.id, '2026-03-11', '500.00', 'CREDIT'),
    ];
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.inflowTransactionId).toBe('t-aa');
  });

  it('ignores an inflow on an account it was not told about', () => {
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER TO SAVINGS'),
      txn('t-in', 'acc-unknown', '2026-03-10', '500.00', 'CREDIT'),
    ];
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).pairs).toHaveLength(0);
  });

  it('flags each side of a gate failure once, even when several outflows compete', () => {
    const rows = [
      txn('t-in', CURRENT.id, '2026-03-10', '500.00', 'ACME LTD'),
      txn('t-out-a', CURRENT_2.id, '2026-03-10', '-500.00', 'BETA LTD'),
      txn('t-out-b', SAVINGS.id, '2026-03-11', '-500.00', 'GAMMA LTD'),
    ];
    const { unpairedCandidates } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    const ids = unpairedCandidates.map((c) => c.transactionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('t-in');
  });

  it('measures similarity symmetrically', () => {
    expect(descriptionSimilarity('transfer to savings', 'transfer from current'))
      .toBe(descriptionSimilarity('transfer from current', 'transfer to savings'));
    expect(descriptionSimilarity('a b', 'a b')).toBe(1);
    expect(descriptionSimilarity('a', 'b')).toBe(0);
    expect(descriptionSimilarity(null, null)).toBe(1);
  });

  it('prefers a gate-passing candidate over a nearer one that fails the gate outright', () => {
    // The outflow itself is neutral ("FASTER PAYMENT"), so the gate has to come from the inflow.
    // The nearer inflow is a customer receipt and passes nothing; the further one names the
    // account. Pairing the receipt would delete a real receipt from cash.
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'FASTER PAYMENT 4471'),
      txn('t-receipt', CURRENT_2.id, '2026-03-10', '500.00', 'ACME LTD INVOICE 9'),
      txn('t-real', SAVINGS.id, '2026-03-12', '500.00', 'TRANSFER IN'),
    ];
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inflowTransactionId).toBe('t-real');
  });

  /**
   * A residual risk of ADR-047.12's rule, pinned so it is a known behaviour and not a surprise.
   *
   * The gate asks that AT LEAST ONE leg reads like a transfer. When the outflow itself says
   * "TRANSFER TO SAVINGS", every same-amount inflow within three days clears the gate, and §4.2's
   * ranking is "closest date, THEN description similarity" — so a customer receipt on the same day
   * beats the real savings credit two days later. The document gives no rule that would prefer the
   * more similar description over the nearer date, and inventing one here is out of scope.
   */
  it('follows the document\'s ranking even when a nearer candidate is the less likely leg', () => {
    const rows = [
      txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TRANSFER TO SAVINGS'),
      txn('t-receipt', CURRENT_2.id, '2026-03-10', '500.00', 'ACME LTD INVOICE 9'),
      txn('t-real', SAVINGS.id, '2026-03-12', '500.00', 'TRANSFER IN'),
    ];
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(pairs[0]!.inflowTransactionId).toBe('t-receipt');
    // The savings credit is not lost: it stays in the figures, flagged for the reviewer.
    const { unpairedCandidates } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(unpairedCandidates.map((c) => c.transactionId)).toContain('t-real');
  });
});

describe('unpaired transfer-looking rows are flagged, never dropped (§4.2)', () => {
  it('flags a lone row that reads like a transfer', () => {
    const rows = [txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'TFR TO SAVINGS')];
    const { unpairedCandidates } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(unpairedCandidates).toEqual([
      { transactionId: 't-out', reason: 'transfer_wording_unpaired', counterpartTransactionId: null },
    ]);
  });

  it('does not flag an ordinary lone payment', () => {
    const rows = [txn('t-out', CURRENT.id, '2026-03-10', '-500.00', 'BETA SUPPLIES LTD')];
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).unpairedCandidates).toHaveLength(0);
  });

  it('ignores a zero-amount row, which is neither an inflow nor an outflow (§3.3)', () => {
    const rows = [
      txn('t-zero', CURRENT.id, '2026-03-10', '0.00', 'TRANSFER'),
      txn('t-in', SAVINGS.id, '2026-03-10', '0.00', 'TRANSFER'),
    ];
    expect(detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS }).pairs).toHaveLength(0);
  });
});

describe('determinism: shuffling the input changes nothing', () => {
  const rows = [
    txn('t-01', CURRENT.id, '2026-03-01', '-5000.00', 'TRANSFER TO SAVINGS'),
    txn('t-02', SAVINGS.id, '2026-03-02', '5000.00', 'CREDIT FROM CURRENT'),
    txn('t-03', CURRENT.id, '2026-03-05', '-1200.00', 'TRANSFER TO BARCLAYCARD'),
    txn('t-04', CARD.id, '2026-03-06', '1200.00', 'PAYMENT RECEIVED'),
    txn('t-05', CURRENT.id, '2026-03-10', '4800.00', 'ACME LTD INVOICE 1042'),
    txn('t-06', CURRENT_2.id, '2026-03-12', '-4800.00', 'BETA SUPPLIES LTD'),
    txn('t-07', CURRENT.id, '2026-03-15', '-500.00', 'TFR TO SAVINGS'),
    txn('t-08', SAVINGS.id, '2026-03-15', '500.00', 'TRANSFER IN'),
    txn('t-09', CURRENT_2.id, '2026-03-15', '500.00', 'TRANSFER IN'),
    txn('t-10', LOAN.id, '2026-03-20', '620.00', 'REPAYMENT'),
    txn('t-11', CURRENT.id, '2026-03-20', '-620.00', 'TRANSFER IWOCA FACILITY'),
  ];

  /** A fixed permutation, so the test itself is deterministic — no randomness in a unit test. */
  function rotate<T>(items: readonly T[], by: number): T[] {
    return [...items.slice(by), ...items.slice(0, by)];
  }

  it('produces identical pairings under every rotation and under reversal', () => {
    const expected = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect(expected.pairs.length).toBeGreaterThan(0);
    for (let by = 0; by < rows.length; by += 1) {
      const shuffled = detectTransfers({ transactions: rotate(rows, by), bankAccounts: ACCOUNTS });
      expect(shuffled.pairs).toEqual(expected.pairs);
      expect(shuffled.unpairedCandidates).toEqual(expected.unpairedCandidates);
    }
    const reversed = detectTransfers({ transactions: [...rows].reverse(), bankAccounts: ACCOUNTS });
    expect(reversed.pairs).toEqual(expected.pairs);
    expect(reversed.unpairedCandidates).toEqual(expected.unpairedCandidates);
  });

  it('never uses one transaction in two pairs', () => {
    const { pairs } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    const used = pairs.flatMap((p) => [p.inflowTransactionId, p.outflowTransactionId]);
    expect(new Set(used).size).toBe(used.length);
  });

  it('keeps the receipt/payment pair out of the figures\' way and flags them', () => {
    const { unpairedCandidates } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    const flagged = unpairedCandidates.map((c) => c.transactionId);
    expect(flagged).toContain('t-05');
    expect(flagged).toContain('t-06');
  });

  it('returns pairs and candidates in a sorted, stable order', () => {
    const { pairs, unpairedCandidates } = detectTransfers({ transactions: rows, bankAccounts: ACCOUNTS });
    expect([...pairs].map((p) => p.pairId)).toEqual([...pairs].map((p) => p.pairId).sort());
    expect(unpairedCandidates.map((c) => c.transactionId))
      .toEqual([...unpairedCandidates].map((c) => c.transactionId).sort());
  });
});
