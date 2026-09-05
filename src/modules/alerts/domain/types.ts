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
 * Pure: no Supabase, no clock, no randomness.
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
 * The six rule keys whose conditions the health score counts (§7.3 K3 and B3). The full catalogue
 * of seventeen arrives with the alert job in Phase 9; this union is deliberately not widened before
 * the rules exist, so an unimplemented rule key cannot be counted as a condition that did not fire.
 */
export const CONDITION_RULE_KEYS = [
  'expense.spike_category',
  'bank.unusual_transaction',
  'recurring.amount_changed',
  'recurring.missed',
  'recurring.inflow_missed',
  'duplicate.transaction',
] as const;
export type ConditionRuleKey = (typeof CONDITION_RULE_KEYS)[number];

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
  readonly ruleKey: ConditionRuleKey;
  readonly severity: AlertSeverity;
  readonly subject: AlertSubject;
  readonly periodId: string;
  readonly thresholdSummary: Readonly<Record<string, string | null>>;
  readonly snapshotIds: readonly string[];
  readonly recordIds: readonly string[];
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
}

/** A record-level row, as the duplicate and unusual-transaction rules see it. */
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
}
