/**
 * The banking pass (FINANCIAL_ENGINE.md §2.4 step 5, §4.1–4.3; DATABASE_ARCHITECTURE.md §4 "the
 * banking job"; Phase 13, ADR-101).
 *
 * Phases 6–12 built the three banking rules — the categorisation ladder, transfer pairing and
 * recurring detection — as pure functions and tested them, but nothing ever RAN them over an
 * organisation's rows: no code set `category_account_id` except a person, no code paired a transfer
 * except a person, and `recurring_payment_groups` was never written. This module is the missing
 * step. It composes the three rules into ONE plan of writes, and it is deliberately pure: the same
 * rows, accounts and `asOf` produce byte-identical plans in any input order, so the calculation
 * run's fingerprint can include the result and a second run over unchanged data can finish as
 * `no_change` (ADR-047.8, ADR-047.11).
 *
 * Three rules the plan never breaks:
 *
 *  1. **A person's decision stands.** A row with `category_source = 'user'` is never
 *     re-categorised and never auto-paired; a transfer somebody marked or unmarked is left alone.
 *     Rules fill gaps, they do not overrule people (§4.1 point 1).
 *  2. **Only what would change is written.** A categorisation is emitted only when the category
 *     account or its source differs from what the row already carries. Re-running the pass over an
 *     unchanged organisation therefore plans nothing, and `category_history` is not flooded with
 *     rows that say the same thing as the row before.
 *  3. **The transfer kind is never in the plan.** The plan names the two legs; `api_server` derives
 *     the kind from the two account types, exactly as `api.mark_transfer` does (ADR-028). A plan
 *     that could assert `cash_transfer` could make a real outflow vanish from the cash figures.
 */
import type { StandardCategory } from '@/modules/financials';
import type { CategorySource, TransferKind } from './types';
import {
  KEYWORD_RULE_SET_VERSION,
  categoriseTransactions,
  type CategoryAccountRef,
  type OrganizationCategoryRule,
} from './categorisation';
import {
  detectTransfers,
  transferCategoryFor,
  type TransferBankAccount,
  type UnpairedTransferCandidate,
} from './transfers';
import { RECURRING_DETECTOR_VERSION, detectRecurring, type RecurringGroup } from './recurring';

/**
 * Bump on any change to how the three rules are COMPOSED here — which rows are eligible, how
 * transfer legs are categorised, which rows feed recurring detection. The rule modules carry their
 * own versions; this one covers the glue, and all three enter the calculation fingerprint.
 */
export const BANKING_PASS_VERSION = 'banking.pass.v1';

/** Everything the pass needs to know about one accepted, current bank row. */
export interface PassTransaction {
  readonly id: string;
  readonly bankAccountId: string;
  readonly transactionDate: string;
  /** Signed; positive is an inflow (ADR-006 string). */
  readonly amount: string;
  readonly descriptionNormalized: string | null;
  readonly counterpartyId: string | null;
  readonly categoryAccountId: string | null;
  readonly categorySource: CategorySource;
  readonly isTransfer: boolean;
  readonly transferKind: TransferKind;
  readonly transferPairId: string | null;
}

export interface PassBankAccount extends TransferBankAccount {
  readonly isActive: boolean;
}

export interface BankingPassInput {
  readonly organizationId: string;
  /** Today in the organisation's timezone — decides `stopped` for recurring groups (§4.3 step 5). */
  readonly asOf: string;
  readonly transactions: readonly PassTransaction[];
  readonly bankAccounts: readonly PassBankAccount[];
  /** The organisation's chart, so a standard category resolves to a real account id. */
  readonly categoryAccounts: readonly CategoryAccountRef[];
  /** Saved "apply to similar" rules. None exist yet (§4.1 point 2 is a documented limitation). */
  readonly organizationRules?: readonly OrganizationCategoryRule[];
}

/** One row whose category should change. Emitted ONLY when something would differ. */
export interface CategorisationWrite {
  readonly transactionId: string;
  readonly categoryAccountId: string | null;
  readonly categorySource: 'rule' | 'none';
  readonly ruleId: string | null;
}

/** Two unpaired legs that should become one transfer. The kind is derived in SQL, never sent. */
export interface PairWrite {
  readonly outflowTransactionId: string;
  readonly inflowTransactionId: string;
  /** What the description gate accepted the pair on — recorded for the reviewer, not trusted. */
  readonly gateReason: 'description_pattern' | 'other_account_name';
}

/** One recurring group to upsert on `(organization_id, bank_account_id, counterparty_key, direction)`. */
export interface GroupWrite {
  readonly bankAccountId: string;
  readonly counterpartyKey: string;
  readonly direction: 'inflow' | 'outflow';
  readonly cadence: RecurringGroup['cadence'];
  readonly expectedAmount: string;
  readonly amountToleranceRatio: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly occurrenceCount: number;
  readonly nextExpected: string | null;
  readonly status: RecurringGroup['status'];
  readonly detectorVersion: string;
  readonly transactionIds: readonly string[];
}

export interface BankingPassPlan {
  readonly categorisations: readonly CategorisationWrite[];
  readonly pairs: readonly PairWrite[];
  readonly groups: readonly GroupWrite[];
  /** Rows that look like transfers but found no partner — surfaced, never written (ADR-047.12). */
  readonly unpairedCandidates: readonly UnpairedTransferCandidate[];
  readonly versions: {
    readonly keywordRuleSet: string;
    readonly recurringDetector: string;
    readonly pass: string;
  };
}

/**
 * One fingerprint-worthy string for the three versions, so the calculation run notices when any of
 * the rules — or their composition — changed and re-runs rather than serving stale categories.
 */
export function bankingRuleVersions(): string {
  return `${KEYWORD_RULE_SET_VERSION}|${RECURRING_DETECTOR_VERSION}|${BANKING_PASS_VERSION}`;
}

/** `standard_category → account_id`, lowest id wins — the same deterministic choice the ladder makes. */
export function accountForCategory(
  accounts: readonly CategoryAccountRef[],
): (category: StandardCategory) => string | null {
  const index = new Map<StandardCategory, string>();
  for (const account of [...accounts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!index.has(account.standardCategory)) index.set(account.standardCategory, account.id);
  }
  return (category) => index.get(category) ?? null;
}

const byId = <T extends { readonly id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function planBankingPass(input: BankingPassInput): BankingPassPlan {
  // Sorted once so nothing below depends on the order rows arrived in.
  const rows = [...input.transactions].sort(byId);
  const accounts = [...input.bankAccounts].sort(byId);
  const accountFor = accountForCategory(input.categoryAccounts);
  const accountType = new Map(accounts.map((a) => [a.id, a.accountType] as const));

  // ---- 1. Transfers: only rows nobody has decided about, on accounts the organisation has. -------
  const pairable = rows.filter(
    (t) => !t.isTransfer && t.categorySource !== 'user' && accountType.has(t.bankAccountId),
  );
  const transfers = detectTransfers({
    transactions: pairable.map((t) => ({
      id: t.id,
      bankAccountId: t.bankAccountId,
      transactionDate: t.transactionDate,
      amount: t.amount,
      descriptionNormalized: t.descriptionNormalized,
    })),
    bankAccounts: accounts,
  });
  const newLegs = new Map<string, StandardCategory | null>();
  for (const pair of transfers.pairs) {
    const category = transferCategoryFor(pair.transferKind);
    newLegs.set(pair.outflowTransactionId, category);
    newLegs.set(pair.inflowTransactionId, category);
  }
  const pairs: PairWrite[] = [...transfers.pairs]
    .sort((a, b) => (a.outflowTransactionId < b.outflowTransactionId ? -1 : 1))
    .map((pair) => ({
      outflowTransactionId: pair.outflowTransactionId,
      inflowTransactionId: pair.inflowTransactionId,
      gateReason: pair.gateReason,
    }));

  // ---- 2. Categories: the ladder over every row a person has not decided. ----------------------
  // Existing transfer legs keep the category their kind implies; new legs are written with the
  // pair in SQL (one write per row), so both are excluded here.
  const categorisable = rows.filter(
    (t) => t.categorySource !== 'user' && !t.isTransfer && !newLegs.has(t.id),
  );
  const outcomes = categoriseTransactions({
    transactions: categorisable.map((t) => ({
      id: t.id,
      amount: t.amount,
      descriptionNormalized: t.descriptionNormalized,
      counterpartyId: t.counterpartyId,
      categoryAccountId: t.categoryAccountId,
      categorySource: t.categorySource,
    })),
    organizationRules: input.organizationRules ?? [],
    categoryAccounts: input.categoryAccounts,
  });
  const current = new Map(rows.map((t) => [t.id, t] as const));
  const categorisations: CategorisationWrite[] = [];
  for (const outcome of outcomes) {
    const row = current.get(outcome.transactionId)!;
    // The ladder's `ai_suggested` rung is post-MVP and never reached here (no suggestions are
    // passed), so the only sources a pass can write are `rule` and `none`.
    const source: 'rule' | 'none' = outcome.categorySource === 'rule' ? 'rule' : 'none';
    const unchanged =
      row.categoryAccountId === outcome.categoryAccountId && row.categorySource === source;
    if (unchanged) continue;
    categorisations.push({
      transactionId: outcome.transactionId,
      categoryAccountId: outcome.categoryAccountId,
      categorySource: source,
      ruleId: outcome.ruleId,
    });
  }
  // A transfer leg somebody marked by hand may still carry no category (mark_transfer keeps
  // whatever was there). Give it the category its kind implies, once, so the P&L proxy's
  // NON_PNL exclusion sees it (ADR-047.12) — unless a person chose otherwise.
  for (const row of rows) {
    if (!row.isTransfer || row.categorySource === 'user') continue;
    const category = transferCategoryFor(row.transferKind);
    const accountId = category === null ? null : accountFor(category);
    if (accountId === null || row.categoryAccountId === accountId) continue;
    categorisations.push({
      transactionId: row.id, categoryAccountId: accountId, categorySource: 'rule', ruleId: null,
    });
  }
  categorisations.sort((a, b) => (a.transactionId < b.transactionId ? -1 : 1));

  // ---- 3. Recurring: third-party movements only. -------------------------------------------------
  // Money moved between the organisation's own accounts is not a payment to anybody, so a monthly
  // sweep to savings is not a "recurring payment" and must not raise `recurring.missed` when it
  // stops. Existing legs and the legs paired above are both left out.
  const recurringRows = rows.filter((t) => !t.isTransfer && !newLegs.has(t.id));
  const groups: GroupWrite[] = detectRecurring({
    organizationId: input.organizationId,
    asOf: input.asOf,
    transactions: recurringRows.map((t) => ({
      id: t.id,
      bankAccountId: t.bankAccountId,
      transactionDate: t.transactionDate,
      amount: t.amount,
      descriptionNormalized: t.descriptionNormalized,
      counterpartyId: t.counterpartyId,
    })),
  }).map((group) => ({
    bankAccountId: group.bankAccountId,
    counterpartyKey: group.counterpartyKey,
    direction: group.direction,
    cadence: group.cadence,
    expectedAmount: group.expectedAmount,
    amountToleranceRatio: group.amountToleranceRatio,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    occurrenceCount: group.occurrences,
    nextExpected: group.nextExpected,
    status: group.status,
    detectorVersion: group.detectorVersion,
    transactionIds: [...group.transactionIds].sort(),
  }));

  return {
    categorisations,
    pairs,
    groups,
    unpairedCandidates: [...transfers.unpairedCandidates].sort((a, b) =>
      a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0,
    ),
    versions: {
      keywordRuleSet: KEYWORD_RULE_SET_VERSION,
      recurringDetector: RECURRING_DETECTOR_VERSION,
      pass: BANKING_PASS_VERSION,
    },
  };
}

/**
 * The plan a pass would produce AFTER `plan` has been applied — what the unit test uses to prove
 * idempotence without a database. Pairs become transfer legs; categorisations become the row's
 * category; the kind is what SQL would derive from the two account types.
 */
export function applyPlanInMemory(
  transactions: readonly PassTransaction[],
  accounts: readonly PassBankAccount[],
  plan: BankingPassPlan,
  kindFor: (a: PassBankAccount['accountType'], b: PassBankAccount['accountType']) => TransferKind,
  categoryAccounts: readonly CategoryAccountRef[],
): PassTransaction[] {
  const accountFor = accountForCategory(categoryAccounts);
  const type = new Map(accounts.map((a) => [a.id, a.accountType] as const));
  const rows = new Map(transactions.map((t) => [t.id, { ...t }] as const));
  for (const write of plan.categorisations) {
    const row = rows.get(write.transactionId);
    if (row) rows.set(row.id, { ...row, categoryAccountId: write.categoryAccountId, categorySource: write.categorySource });
  }
  for (const pair of plan.pairs) {
    const out = rows.get(pair.outflowTransactionId);
    const inn = rows.get(pair.inflowTransactionId);
    if (!out || !inn) continue;
    const kind = kindFor(type.get(out.bankAccountId)!, type.get(inn.bankAccountId)!);
    const category = transferCategoryFor(kind);
    const accountId = category === null ? null : accountFor(category);
    rows.set(out.id, { ...out, isTransfer: true, transferKind: kind, transferPairId: inn.id, categoryAccountId: accountId ?? out.categoryAccountId, categorySource: 'rule' });
    rows.set(inn.id, { ...inn, isTransfer: true, transferKind: kind, transferPairId: out.id, categoryAccountId: accountId ?? inn.categoryAccountId, categorySource: 'rule' });
  }
  return [...rows.values()];
}
