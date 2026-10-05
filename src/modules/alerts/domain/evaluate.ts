/**
 * The two-pass evaluation (FINANCIAL_ENGINE.md §8.3, ADR-047.11).
 *
 * Pass one collects every outcome for every period. Pass two sorts them by severity and recency and
 * persists at most twenty-five NEW rows, exempting `critical`, and summarises the remainder in one
 * `info` alert. The order matters more than it sounds: a first import of twenty-four months can
 * easily produce sixty outcomes, and a one-pass loop over periods oldest-first would spend the cap
 * on 2024's expense spikes and bury this month's cash warning. The cap is not a performance
 * measure — it is the difference between a list somebody reads and a list somebody closes.
 *
 * This module PLANS; it does not write. It returns the inserts, revisions, status changes and
 * resolutions the service should apply, which is what makes the whole algorithm testable without a
 * database — including the cases that are hardest to reach through one, like a critical outcome
 * arriving after the cap is already full.
 *
 * Pure.
 */

import { RULES, RULE_ORDER, dedupeKey, overflowDedupeKey } from './catalogue';
import { dataSuppression } from './suppression';
import {
  isMaterialChange, statusOnAbsence, statusOnRecurrence, userSuppressed,
  type AlertStatus, type ExistingAlert, type StatusReasonCode,
} from './lifecycle';
import { renderAlert, renderOverflow, type RenderedAlert } from './templates';
import type { RuleContext } from './context';
import {
  OVERFLOW_RULE_KEY, SEVERITY_ORDER,
  type AlertRuleKey, type AlertSeverity, type AlertSubject, type EvidencePin, type RuleOutcome,
} from './types';

/** §8.1: at most this many NEW rows per run; `critical` is exempt. */
export const PER_RUN_CAP = 25;

export type Evaluator = (ctx: RuleContext) => readonly RuleOutcome[];

/** One period's context, plus the period's position in the run (oldest first). */
export interface PeriodPlanInput {
  readonly ctx: RuleContext;
  /** "March 2026", for the overflow alert's copy and for ordering by recency. */
  readonly periodStart: string;
}

export interface EvaluateInput {
  readonly organizationId: string;
  readonly calculationRunId: string;
  readonly currency: string;
  readonly ruleVersion: string;
  /** Ascending by period start (§8.3 "for P in periods ascending"). */
  readonly periods: readonly PeriodPlanInput[];
  /** Every non-resolved alert of the organisation, keyed by dedupe key. */
  readonly existing: ReadonlyMap<string, ExistingAlert>;
  /** Now, in ISO. Explicit so the ninety-day cooldown is reproducible in a test. */
  readonly now: string;
  readonly evaluators: Readonly<Record<AlertRuleKey, Evaluator>>;
  /**
   * The run's as-of date. The overflow summary is dated in the latest period that has begun by then,
   * never in a future month the run merely reached (ADR-124, audit N-11). Omitted, the last period.
   */
  readonly asOf?: string;
}

export interface PlannedInsert {
  readonly kind: 'insert';
  readonly dedupeKey: string;
  readonly ruleKey: AlertRuleKey | typeof OVERFLOW_RULE_KEY;
  readonly klass: 'state' | 'event';
  readonly severity: AlertSeverity;
  readonly periodId: string;
  readonly subject: AlertSubject;
  readonly metricKey: string | null;
  readonly thresholdSummary: Readonly<Record<string, string | null>>;
  readonly rendered: RenderedAlert;
  readonly evidence: readonly EvidencePin[];
  /**
   * The rows the condition rested on.
   *
   * Stored with the alert so the NEXT run can ask "same pinned ids?" (§8.1) without re-deriving
   * them. Without it, every re-evaluation looks like a material change and every acknowledged alert
   * re-opens on the next nightly run.
   */
  readonly snapshotIds: readonly string[];
  readonly recordIds: readonly string[];
}

export interface PlannedRevision {
  readonly kind: 'revision';
  readonly alertId: string;
  readonly dedupeKey: string;
  readonly severity: AlertSeverity;
  readonly periodId: string;
  readonly thresholdSummary: Readonly<Record<string, string | null>>;
  readonly rendered: RenderedAlert;
  readonly evidence: readonly EvidencePin[];
  readonly status: AlertStatus;
  readonly statusReasonCode: StatusReasonCode | null;
  readonly reopened: boolean;
  readonly previousSeverity: AlertSeverity;
  readonly snapshotIds: readonly string[];
  readonly recordIds: readonly string[];
}

/** Nothing changed: only `last_evaluated_at` moves (§8.1). */
export interface PlannedTouch {
  readonly kind: 'touch';
  readonly alertId: string;
  readonly dedupeKey: string;
  readonly periodId: string;
}

export interface PlannedResolve {
  readonly kind: 'resolve';
  readonly alertId: string;
  readonly dedupeKey: string;
  readonly statusReasonCode: StatusReasonCode;
}

export type PlannedChange = PlannedInsert | PlannedRevision | PlannedTouch | PlannedResolve;

export interface EvaluationPlan {
  readonly changes: readonly PlannedChange[];
  /** How many new rows the cap turned away. Zero means no overflow alert. */
  readonly overflow: number;
  /** Every outcome collected in pass one, for the audit counts §8.3 writes. */
  readonly outcomeCount: number;
  readonly suppressedCount: number;
}

interface Collected {
  readonly outcome: RuleOutcome;
  readonly key: string;
  readonly periodStart: string;
  readonly klass: 'state' | 'event';
}

/**
 * Pass one: collect.
 *
 * Rules run in `RULE_ORDER`, which puts `variance.significant` last so the supersession below can
 * see what already explains the period (§8.3).
 */
function collect(input: EvaluateInput): { collected: Collected[]; suppressed: number } {
  const collected: Collected[] = [];
  let suppressed = 0;

  for (const period of input.periods) {
    const firedThisPeriod = new Set<AlertRuleKey>();
    const periodOutcomes: Collected[] = [];

    for (const ruleKey of RULE_ORDER) {
      if (dataSuppression(ruleKey, period.ctx).suppressed) {
        suppressed += 1;
        continue;
      }

      const definition = RULES[ruleKey];
      // §8.2's two supersessions, applied uniformly: a rule whose more specific sibling already
      // explained this period does not also speak.
      if (definition.supersededBy.some((key) => firedThisPeriod.has(key))) continue;

      for (const outcome of input.evaluators[ruleKey](period.ctx)) {
        firedThisPeriod.add(ruleKey);
        periodOutcomes.push({
          outcome,
          key: dedupeKey(ruleKey, definition.klass, outcome.periodId, outcome.subject),
          periodStart: period.periodStart,
          klass: definition.klass,
        });
      }
    }

    collected.push(...periodOutcomes);
  }

  return { collected, suppressed };
}

/**
 * Pass two: persist, most important first.
 *
 * Sorted by severity descending, then period descending, then rule order — a total order, so two
 * runs over identical data produce the same twenty-five rows rather than an arbitrary twenty-five.
 */
function sortForPersistence(collected: readonly Collected[]): Collected[] {
  const ruleIndex = new Map(RULE_ORDER.map((key, index) => [key, index]));
  return [...collected].sort((a, b) => {
    const severity = SEVERITY_ORDER[b.outcome.severity] - SEVERITY_ORDER[a.outcome.severity];
    if (severity !== 0) return severity;
    if (a.periodStart !== b.periodStart) return b.periodStart.localeCompare(a.periodStart);
    const rule = (ruleIndex.get(a.outcome.ruleKey) ?? 0) - (ruleIndex.get(b.outcome.ruleKey) ?? 0);
    if (rule !== 0) return rule;
    return a.key.localeCompare(b.key);
  });
}

export function planEvaluation(input: EvaluateInput): EvaluationPlan {
  const { collected, suppressed } = collect(input);
  const ordered = sortForPersistence(collected);

  const changes: PlannedChange[] = [];
  const seenKeys = new Set<string>();
  let created = 0;
  let overflow = 0;

  for (const item of ordered) {
    // A state rule can produce an outcome for the same subject in several periods of one run. The
    // key is the same, so only the most important — which the sort has already put first — counts.
    if (seenKeys.has(item.key)) continue;
    seenKeys.add(item.key);

    const rendered = renderAlert(item.outcome, input.currency);
    const existing = input.existing.get(item.key);

    if (existing === undefined) {
      /*
       * §8.1: "the cap of 25 applies to *new* rows, `critical` outcomes are exempt from it".
       *
       * Exempt means exempt in both directions: a critical row is never withheld, AND it does not
       * spend the budget. Counting it against the cap would let three critical cash warnings push
       * three real findings into the overflow summary — the cap would then be deciding which
       * serious things to hide, which is the opposite of what it is for (ADR-056.3).
       */
      if (item.outcome.severity !== 'critical') {
        if (created >= PER_RUN_CAP) {
          overflow += 1;
          continue;
        }
        created += 1;
      }
      changes.push({
        kind: 'insert',
        dedupeKey: item.key,
        ruleKey: item.outcome.ruleKey,
        klass: item.klass,
        severity: item.outcome.severity,
        periodId: item.outcome.periodId,
        subject: item.outcome.subject,
        metricKey: item.outcome.metricKey ?? RULES[item.outcome.ruleKey].metricKey,
        thresholdSummary: item.outcome.thresholdSummary,
        rendered,
        evidence: item.outcome.evidence ?? [],
        snapshotIds: item.outcome.snapshotIds,
        recordIds: item.outcome.recordIds,
      });
      continue;
    }

    if (userSuppressed(existing, item.outcome, input.now)) {
      changes.push({
        kind: 'touch', alertId: existing.id, dedupeKey: item.key, periodId: item.outcome.periodId,
      });
      continue;
    }

    if (!isMaterialChange(existing, item.outcome)) {
      changes.push({
        kind: 'touch', alertId: existing.id, dedupeKey: item.key, periodId: item.outcome.periodId,
      });
      continue;
    }

    const decision = statusOnRecurrence(existing, item.outcome, input.now);
    changes.push({
      kind: 'revision',
      alertId: existing.id,
      dedupeKey: item.key,
      severity: item.outcome.severity,
      periodId: item.outcome.periodId,
      thresholdSummary: item.outcome.thresholdSummary,
      rendered,
      evidence: item.outcome.evidence ?? [],
      status: decision.status,
      statusReasonCode: decision.reasonCode,
      reopened: decision.reopened,
      previousSeverity: existing.severity,
      snapshotIds: item.outcome.snapshotIds,
      recordIds: item.outcome.recordIds,
    });
  }

  // §8.3: everything open that did not recur is resolved as `condition_cleared`.
  const evaluatedRules = new Set(RULE_ORDER);
  const evaluatedPeriods = new Set(input.periods.map((p) => p.ctx.periodId));
  for (const [key, existing] of input.existing) {
    if (seenKeys.has(key)) continue;
    // An EVENT alert belongs to one period (`rule|period|subject`, catalogue `dedupeKey`). A run that
    // did not evaluate that period did not look at it, so its absence here says nothing: a daily run
    // over the current month must not resolve last month's duplicate payment as "cleared" (FU-6).
    const [, keyPeriod] = key.split('|');
    if (keyPeriod !== undefined && keyPeriod !== 'state' && !evaluatedPeriods.has(keyPeriod)) continue;
    // Only rules this run actually evaluated may resolve their alerts. A rule that was
    // data-suppressed did not look, and "we did not look" must never read as "it cleared".
    if (!evaluatedRules.has(existing.ruleKey as AlertRuleKey)) continue;
    if (wasSuppressedEverywhere(input, existing.ruleKey as AlertRuleKey)) continue;

    const decision = statusOnAbsence(existing);
    if (decision === null) continue;
    changes.push({
      kind: 'resolve',
      alertId: existing.id,
      dedupeKey: key,
      statusReasonCode: decision.reasonCode ?? 'condition_cleared',
    });
  }

  if (overflow > 0) {
    const asOf = input.asOf;
    const begun = asOf === undefined ? input.periods : input.periods.filter((p) => p.periodStart <= asOf);
    const latest = begun[begun.length - 1] ?? input.periods[input.periods.length - 1];
    if (latest !== undefined) {
      changes.push({
        kind: 'insert',
        dedupeKey: overflowDedupeKey(latest.ctx.periodId),
        ruleKey: OVERFLOW_RULE_KEY,
        klass: 'event',
        severity: 'info',
        periodId: latest.ctx.periodId,
        subject: { type: 'none', id: null, key: null },
        metricKey: null,
        thresholdSummary: { count: String(overflow) },
        rendered: renderOverflow(overflow, input.currency),
        evidence: [],
        snapshotIds: [],
        recordIds: [],
      });
    }
  }

  return { changes, overflow, outcomeCount: collected.length, suppressedCount: suppressed };
}

/**
 * Was this rule suppressed in EVERY period of the run?
 *
 * If it was, its existing alerts are left alone. Resolving them would tell somebody their duplicate
 * payment cleared, when in truth the statement covering that month arrived half empty and the rule
 * never ran — the same failure the health engine's B3 refuses (ADR-054.8).
 */
function wasSuppressedEverywhere(input: EvaluateInput, ruleKey: AlertRuleKey): boolean {
  return input.periods.every((period) => dataSuppression(ruleKey, period.ctx).suppressed);
}
