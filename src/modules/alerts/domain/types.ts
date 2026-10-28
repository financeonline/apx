/**
 * The alert vocabulary (FINANCIAL_ENGINE.md §8).
 *
 * Phase 8 builds the part of this module the HEALTH SCORE needs and nothing more. §7.3 rules K3 and
 * B3 count *conditions*, and §8.3 is explicit that "the same functions, behind the same
 * `dataSuppressed()` filter, are called by the health engine inside the calculation chunk, so score
 * and alerts can never disagree about whether a condition holds, and neither depends on
 * dismissals". A second implementation of "did marketing spend spike?" written later for the alert
 * job would be a second answer to the same question, and the two would drift the first time a
 * threshold moved.
 *
 * So the six condition rules health reads are written here now, as pure functions, with the
 * severity and `threshold_summary` fields the alert job will need in Phase 9. What Phase 9 adds is
 * the other eleven rules, persistence, revisions, dedupe keys, the per-run cap and `userSuppressed`
 * — none of which health may touch, because a dismissed alert must never move a score (R2-B-11).
 *
 * Pure: no database, no clock, no randomness.
 */

import type {
  AssuranceLevel, DataQuality, DimensionType, MetricBasis, MetricUnit,
} from '@/modules/financial-engine';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Ordered worst-first, for the two-pass sort in §8.3 and for "worst severity" comparisons. */
export const SEVERITY_ORDER: Readonly<Record<AlertSeverity, number>> = {
  critical: 4, high: 3, medium: 2, low: 1, info: 0,
};

export type AlertSubjectType =
  'none' | 'account' | 'counterparty' | 'bank_transaction' | 'recurring_group' | 'standard_category';

/**
 * What an outcome is about.
 *
 * `id` is a row id; `key` carries a subject that is NOT a row — a standard category is a name, the
 * same gap `dimension_key` closes on `metric_snapshots` (ADR-053). A rule sets exactly one.
 */
export interface AlertSubject {
  readonly type: AlertSubjectType;
  readonly id: string | null;
  readonly key: string | null;
}

export const NO_SUBJECT: AlertSubject = { type: 'none', id: null, key: null };

/**
 * Every rule key in the §8.2 catalogue.
 *
 * Seventeen rows, eighteen keys — `recurring.missed` and `recurring.inflow_missed` share a row
 * because they are the same test in opposite directions, and §8.2 gives the inflow case its own key
 * and severity. `attention.overflow` is the nineteenth and is not a rule: it is the summary the
 * per-run cap writes, and it is listed here because it needs a dedupe key like any other alert.
 */
export const ALERT_RULE_KEYS = [
  'expense.spike_category',
  'expense.spike_account',
  'revenue.decline',
  'margin.deterioration',
  'cash.decline',
  'cash.runway_low',
  'receivables.deterioration',
  'payables.deterioration',
  'concentration.customer',
  'concentration.supplier',
  'recurring.amount_changed',
  'recurring.missed',
  'recurring.inflow_missed',
  'recurring.new',
  'duplicate.transaction',
  'bank.unusual_transaction',
  'deviation.large_transaction',
  'variance.significant',
] as const;
export type AlertRuleKey = (typeof ALERT_RULE_KEYS)[number];

/** The cap's summary row (§8.1). Not a rule: nothing evaluates it, the two-pass persist writes it. */
export const OVERFLOW_RULE_KEY = 'attention.overflow';

/**
 * The six whose conditions the HEALTH SCORE counts (§7.3 K3 and B3).
 *
 * Kept as its own list rather than derived from a family prefix: K3 and B3 name specific rules, and
 * a future `bank.*` rule must not silently start moving a health score because its key happens to
 * begin with the right word.
 */
export const CONDITION_RULE_KEYS = [
  'expense.spike_category',
  'bank.unusual_transaction',
  'recurring.amount_changed',
  'recurring.missed',
  'recurring.inflow_missed',
  'duplicate.transaction',
] as const satisfies readonly AlertRuleKey[];
export type ConditionRuleKey = (typeof CONDITION_RULE_KEYS)[number];

/**
 * Rule class (ADR-036).
 *
 * An EVENT happened in a period and is keyed per period, so six months of spikes are six alerts. A
 * STATE persists and is keyed per subject only, so six months of the same 55% customer are ONE
 * alert whose `first_seen_at` is the first month. Getting this backwards is the difference between
 * a useful list and an inbox nobody opens (F-D-12).
 */
export type AlertRuleClass = 'state' | 'event';

/** The families B3 counts (§7.3): `bank.*`, `recurring.*` and `duplicate.*`. */
export const BANKING_ANOMALY_RULE_KEYS: readonly ConditionRuleKey[] = [
  'bank.unusual_transaction',
  'recurring.amount_changed',
  'recurring.missed',
  'recurring.inflow_missed',
  'duplicate.transaction',
];

/**
 * One firing of one rule.
 *
 * `thresholdSummary` holds every number the explanation will render, as strings (ADR-032.7): the
 * template never re-derives a figure, and the AI reads these typed fields rather than the prose.
 * `snapshotIds` and `recordIds` are what the health breakdown pins so a reader can see exactly which
 * rows produced a count (§7.4).
 */
export interface RuleOutcome {
  readonly ruleKey: AlertRuleKey;
  readonly severity: AlertSeverity;
  readonly subject: AlertSubject;
  readonly periodId: string;
  /** The metric the alert is about, for `alerts.metric_key`. NULL for record-level rules. */
  readonly metricKey?: string | null;
  readonly thresholdSummary: Readonly<Record<string, string | null>>;
  /**
   * The snapshots and records the CONDITION rests on — what the health breakdown pins so a reader
   * can see which rows produced a count (§7.4).
   *
   * Deliberately not the same as `evidence` below. The condition for a category spike rests on one
   * variance snapshot; the evidence a reader wants is the five largest transactions in that category.
   * Collapsing the two would either under-pin the count or over-pin the explanation.
   */
  readonly snapshotIds: readonly string[];
  readonly recordIds: readonly string[];
  /** What the alert's evidence bundle should contain (§8.2 "Evidence pinned", EVIDENCE_MODEL.md §5). */
  readonly evidence?: readonly EvidencePin[];
}

/** One row destined for `evidence_items` (DATABASE_ARCHITECTURE.md §6). */
export interface EvidencePin {
  readonly itemType:
    | 'metric_snapshot' | 'calculation_run' | 'ledger_entry' | 'bank_transaction' | 'invoice'
    | 'period_balance' | 'counterparty' | 'account' | 'fiscal_period' | 'query';
  /** Exactly one of `refId` and `queryDescriptor` is set (`evidence_item_xor`). */
  readonly refId: string | null;
  readonly queryDescriptor: Readonly<Record<string, unknown>> | null;
  readonly label: string;
  /** The statement this item supports. */
  readonly claim: string | null;
  readonly assuranceLevel: AssuranceLevel;
}

// ---------------------------------------------------------------------------------------------
// The snapshot view both engines read
// ---------------------------------------------------------------------------------------------

/**
 * One `metric_snapshots` row as a rule sees it.
 *
 * This is the bridge that lets the SAME rule function run inside the calculation chunk (over the
 * `MetricResult`s the run just computed, before they are written) and afterwards in the alert job
 * (over rows read back through `metric_current`). If the two paths took different shapes, "the same
 * pure rule function" in §7.3 would be a claim nobody could check.
 */
export interface MetricObservation {
  /** NULL while the snapshot is still in flight inside the chunk that computed it. */
  readonly snapshotId: string | null;
  readonly periodId: string;
  readonly metricKey: string;
  readonly dimensionType: DimensionType;
  readonly dimensionId: string | null;
  readonly dimensionKey: string | null;
  readonly value: string | null;
  readonly unit: MetricUnit;
  readonly basis: MetricBasis;
  readonly assurance: AssuranceLevel;
  readonly components: Readonly<Record<string, unknown>>;
  readonly dataQuality: DataQuality;
  /**
   * N-5 (Step 0F): the snapshot's own `evidence_query` — which records the figure was read from — so
   * a rule citing "what the figure was made of" cites the source that actually won, not a guess.
   */
  readonly evidenceQuery?: unknown;
}

/**
 * A record-level row, as the record-level rules see it.
 *
 * One shape for all four record tables rather than four. The rules that care about the difference
 * filter on `table`; the ones that do not — the amount floor, the trailing median — would otherwise
 * need a copy each.
 */
export interface RecordObservation {
  readonly id: string;
  readonly table: 'ledger_entries' | 'bank_transactions' | 'invoices' | 'period_balances';
  readonly periodId: string;
  /** ISO `yyyy-mm-dd`. */
  readonly date: string;
  /** Signed: positive is an inflow / a credit to the business. */
  readonly amount: string;
  readonly descriptionNormalized: string | null;
  readonly counterpartyId: string | null;
  readonly bankAccountId: string | null;
  /** Hex sha256 of the canonical record identity, as stored. */
  readonly dedupeHash: string | null;
  readonly duplicateReviewed: boolean;
  readonly isTransfer: boolean;
  readonly recurringGroupId: string | null;
  /** The account a ledger entry was coded to, or a bank transaction categorised into. */
  readonly accountId?: string | null;
  /** Invoices only: what is still owed, and when it was due (§8.2 receivables/payables). */
  readonly outstanding?: string | null;
  readonly dueDate?: string | null;
  readonly invoiceType?: string | null;
}

/** An account, as the rules that name one in a sentence see it. */
export interface AccountObservation {
  readonly id: string;
  readonly name: string;
  readonly standardCategory: string;
}
