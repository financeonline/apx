/**
 * What happens to an alert that already exists (FINANCIAL_ENGINE.md §8.1, ADR-034, ADR-047.2).
 *
 * This is the half of the alert engine that decides whether a person is disturbed again. The rules
 * are asymmetric on purpose:
 *
 *   - **Nothing material changed** → only `last_evaluated_at` moves. Re-running the engine on
 *     unchanged data must not produce a new revision, an audit entry or a notification.
 *   - **Something material changed** → a new revision, and the alert may re-open.
 *   - **A dismissal holds** for ninety days, unless the situation got WORSE. Somebody said "I know";
 *     saying it again next week is how a product teaches people to ignore it.
 *   - **A resolved state alert whose condition returns re-opens** rather than starting again, so
 *     `first_seen_at` still says when the problem first appeared (R2-B-02).
 *
 * Pure: every function here takes the existing row and the new outcome and returns a decision. No
 * clock — `now` is an explicit argument, because "is this dismissal older than ninety days" must be
 * reproducible in a test.
 */

import { tryParseDecimal } from '@/core/money';
import { CONCENTRATION_MATERIAL_MOVE } from './rules/concentration';
import { SEVERITY_ORDER, type AlertSeverity, type RuleOutcome } from './types';

/** §8.1: a dismissed alert re-opens by itself after this long. */
export const DISMISSAL_COOLDOWN_DAYS = 90;

export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

export type StatusReasonCode =
  | 'user' | 'condition_cleared' | 'record_removed' | 'rule_retired'
  | 'severity_increased' | 'condition_returned';

/** An `alerts` row and its current revision, as the evaluator sees it. */
export interface ExistingAlert {
  readonly id: string;
  readonly dedupeKey: string;
  readonly ruleKey: string;
  readonly status: AlertStatus;
  readonly severity: AlertSeverity;
  readonly revisionNo: number;
  readonly thresholdSummary: Readonly<Record<string, string | null>>;
  readonly snapshotIds: readonly string[];
  readonly recordIds: readonly string[];
  readonly dismissedAt: string | null;
  readonly firstSeenAt: string;
}

/**
 * Does a dismissal still hold at `now`? (§8.1's ninety-day cooldown.)
 *
 * ONE answer, used by `userSuppressed` and by `statusOnRecurrence`, because they were written
 * separately and disagreed: an alert with no `dismissed_at` was "not suppressed" by one and "still
 * dismissed" by the other, so the engine would write a revision and then leave the status alone.
 *
 * A missing or unreadable timestamp means the cooldown CANNOT BE ESTABLISHED, and therefore does not
 * hold. The alternative — treating an undated dismissal as dismissed a moment ago — silences a real
 * finding for ever on a row whose history nobody can read (ADR-056.6).
 */
export function dismissalHolds(dismissedAt: string | null, now: string): boolean {
  if (dismissedAt === null) return false;
  const from = Date.parse(dismissedAt);
  const to = Date.parse(now);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return (to - from) / 86_400_000 < DISMISSAL_COOLDOWN_DAYS;
}

/**
 * Has the situation changed enough to be worth saying again?
 *
 * Severity, the pinned ids, and the ROUNDED threshold values (§8.1). Rounded, because a receivables
 * share that drifts from 0.3001 to 0.3002 is the same finding, and writing a revision for it would
 * fill the history with noise and re-open acknowledged alerts for nothing.
 */
export function isMaterialChange(existing: ExistingAlert, outcome: RuleOutcome): boolean {
  if (existing.severity !== outcome.severity) return true;
  if (!sameIds(existing.snapshotIds, outcome.snapshotIds)) return true;
  if (!sameIds(existing.recordIds, outcome.recordIds)) return true;
  return !sameThresholds(existing.ruleKey, existing.thresholdSummary, outcome.thresholdSummary);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, index) => id === right[index]);
}

/**
 * Threshold comparison, rounded.
 *
 * `concentration.customer` carries its own rule from §8.2 — "only re-fires when share changes ≥ 0.05
 * or crosses a band" — which is a materiality test, not a firing test, and so it lives here with the
 * others rather than inside the rule that has no way to see the previous value.
 */
function sameThresholds(
  ruleKey: string,
  before: Readonly<Record<string, string | null>>,
  after: Readonly<Record<string, string | null>>,
): boolean {
  if (ruleKey === 'concentration.customer' || ruleKey === 'concentration.supplier') {
    if (before.band !== after.band) return false;
    const previous = tryParseDecimal(before.share ?? null);
    const current = tryParseDecimal(after.share ?? null);
    if (previous === null || current === null) return previous === current;
    return current.minus(previous).abs().lessThan(CONCENTRATION_MATERIAL_MOVE);
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!sameValue(before[key] ?? null, after[key] ?? null)) return false;
  }
  return true;
}

/** Two threshold values are the same when they round the same way at two decimal places. */
function sameValue(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const left = tryParseDecimal(a);
  const right = tryParseDecimal(b);
  if (left === null || right === null) return a === b;
  return left.toDecimalPlaces(2).equals(right.toDecimalPlaces(2));
}

/**
 * Does the user's own decision suppress this re-evaluation? (§8.1 `userSuppressed`.)
 *
 * Applied ONLY when persisting. It is never visible to a rule and never reaches the health score —
 * that separation is the whole of R2-B-11, and it is why this function lives here and not in
 * `suppression.ts` beside the data-only tests.
 */
export function userSuppressed(
  existing: ExistingAlert, outcome: RuleOutcome, now: string,
): boolean {
  if (existing.status !== 'dismissed') return false;
  // A worse situation always breaks through a dismissal.
  if (SEVERITY_ORDER[outcome.severity] > SEVERITY_ORDER[existing.severity]) return false;
  return dismissalHolds(existing.dismissedAt, now);
}

export interface StatusDecision {
  readonly status: AlertStatus;
  readonly reasonCode: StatusReasonCode | null;
  /** True when `reopened_at` should be stamped. */
  readonly reopened: boolean;
}

/**
 * What status an existing alert takes when its condition still holds (§8.1, ADR-047.2).
 *
 * `first_seen_at` is never touched here. An alert that re-opens is the same problem returning, and
 * telling somebody a problem is new when it is nine months old is the failure this whole
 * state-versus-event design exists to avoid.
 */
export function statusOnRecurrence(
  existing: ExistingAlert, outcome: RuleOutcome, now: string,
): StatusDecision {
  const worse = SEVERITY_ORDER[outcome.severity] > SEVERITY_ORDER[existing.severity];

  switch (existing.status) {
    case 'open':
      return { status: 'open', reasonCode: null, reopened: false };

    case 'acknowledged':
      // Somebody has seen it. Only a WORSE version is worth putting back in front of them.
      return worse
        ? { status: 'open', reasonCode: 'severity_increased', reopened: false }
        : { status: 'acknowledged', reasonCode: null, reopened: false };

    case 'resolved':
      // R2-B-02: the condition came back. Same row, same first_seen_at, new revision.
      return { status: 'open', reasonCode: 'condition_returned', reopened: true };

    case 'dismissed':
      // The same test `userSuppressed` applies, so the two can never disagree about one row.
      return worse || !dismissalHolds(existing.dismissedAt, now)
        ? { status: 'open', reasonCode: 'condition_returned', reopened: true }
        : { status: 'dismissed', reasonCode: null, reopened: false };
  }
}

/**
 * What happens to an alert whose condition did NOT recur (§8.1).
 *
 * `open` and `acknowledged` resolve. `dismissed` and `resolved` are left exactly as they are —
 * re-resolving a resolved alert would move its status timestamp and make the history lie about when
 * the problem actually cleared.
 */
export function statusOnAbsence(existing: ExistingAlert): StatusDecision | null {
  if (existing.status === 'open' || existing.status === 'acknowledged') {
    return { status: 'resolved', reasonCode: 'condition_cleared', reopened: false };
  }
  return null;
}

export { SEVERITY_ORDER, type AlertSeverity };
