import { Decimal, ROUND_HALF_UP, parseDecimalOrNull, toMoneyString } from '@/core/money';
import {
  MAX_EXCLUDED_FRACTION, MAX_PERIODS, MIN_PERIODS, OUTLIER_MAD_MULTIPLE, STRONG_MIN_PERIODS,
  type ForecastBasis, type InsufficiencyReason,
} from './config';
import type { ActualPoint, Baseline, BasisPoint } from './types';

/**
 * The baseline: what this metric has been running at (ADR-099).
 *
 * Four decisions live here, and each is about refusing to say more than the history supports:
 *
 *   - **Sufficiency.** Fewer than `MIN_PERIODS` complete months and there is no forecast at all —
 *     not a cautious one, none. A number with a caveat is still a number, and a reader remembers the
 *     number.
 *   - **Continuity.** The window is the most recent CONSECUTIVE run of complete months. A gap means
 *     the months before it describe a business that has since stopped reporting the same way, and
 *     averaging across the gap would quietly treat them as if it had not.
 *   - **One-offs (§6).** A month far enough from the middle is excluded and says so. The test is
 *     median and median-absolute-deviation, not mean and standard deviation, because the one-off
 *     being looked for is exactly the thing that drags a mean and inflates a standard deviation.
 *   - **Recency.** The most recent month weighs most. A business that changed six months ago should
 *     not have its forecast held down by what it was before.
 *
 * No trend is extrapolated, deliberately. A straight line through eight noisy monthly points
 * produces a confident-looking number whose confidence comes from the arithmetic rather than from
 * the business; the honest statement a weighted average makes is "this is the level it has been
 * running at", and that is what a three-month horizon can support.
 *
 * Pure: no clock, no I/O, no randomness. The same points in the same order always give the same
 * baseline, and so does the same points in any order.
 */

export type SufficiencyVerdict =
  | { readonly ok: true; readonly window: readonly ActualPoint[] }
  | { readonly ok: false; readonly reason: InsufficiencyReason; readonly periodsFound: number };

/** Months are consecutive when each starts exactly one calendar month after the last (ADR-007). */
function isNextMonth(previousStart: string, nextStart: string): boolean {
  const [py, pm] = previousStart.split('-').map(Number);
  const [ny, nm] = nextStart.split('-').map(Number);
  if (py === undefined || pm === undefined || ny === undefined || nm === undefined) return false;
  return ny * 12 + nm === py * 12 + pm + 1;
}

/**
 * The window the baseline may use: the most recent run of consecutive complete periods that have a
 * computable value, newest last, capped at `MAX_PERIODS`.
 *
 * An incomplete period is not in the window at all. ADR-030.4 already refuses to score one, for the
 * same reason: a month with a week of data in it would be read as a month with very little business.
 */
export function selectWindow(points: readonly ActualPoint[]): SufficiencyVerdict {
  const usable = [...points]
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .filter((p) => p.isComplete && p.value !== null);

  if (points.length === 0) return { ok: false, reason: 'no_history', periodsFound: 0 };
  if (usable.length === 0) return { ok: false, reason: 'no_complete_periods', periodsFound: 0 };

  // Walk back from the newest for as long as the months stay consecutive.
  const run: ActualPoint[] = [usable[usable.length - 1]!];
  for (let i = usable.length - 2; i >= 0; i -= 1) {
    const older = usable[i]!;
    if (!isNextMonth(older.periodStart, run[0]!.periodStart)) break;
    run.unshift(older);
  }

  if (run.length < MIN_PERIODS) {
    return {
      ok: false,
      reason: usable.length >= MIN_PERIODS ? 'history_not_continuous' : 'too_few_periods',
      periodsFound: run.length,
    };
  }
  return { ok: true, window: run.slice(-MAX_PERIODS) };
}

/** The middle value; for an even count, the mean of the two middle ones. */
function median(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return sorted[mid - 1]!.plus(sorted[mid]!).dividedBy(2);
}

/**
 * Which periods are one-offs (§6).
 *
 * Returns the indices to exclude. Never excludes more than `MAX_EXCLUDED_FRACTION` of the window:
 * past that the spread IS the business, and dropping a quarter of the history to make the rest look
 * tidy would be the forecast telling the reader what they want to hear. When MAD is zero — every
 * month identical — nothing is an outlier, which is the arithmetic agreeing with common sense.
 */
export function findOneOffs(values: readonly Decimal[]): ReadonlySet<number> {
  if (values.length < 4) return new Set();

  const mid = median(values);
  const deviations = values.map((v) => v.minus(mid).abs());
  const mad = median(deviations);

  /*
   * When more than half the window is identical the MAD is zero, and a zero scale would either
   * flag everything or — if short-circuited — flag nothing. Nothing is the dangerous answer: five
   * identical months and one fifty times larger is the textbook one-off this rule exists to catch,
   * and it is exactly the shape a quiet business with one annual bill produces.
   *
   * Iglewicz and Hoaglin prescribe the mean absolute deviation as the fallback scale for precisely
   * this case. It is used here with the same multiple, so there is one threshold to justify rather
   * than two.
   */
  const scale = mad.isZero()
    ? deviations.reduce((sum, d) => sum.plus(d), new Decimal(0)).dividedBy(deviations.length)
    : mad;
  if (scale.isZero()) return new Set();

  const limit = scale.times(OUTLIER_MAD_MULTIPLE);
  const candidates = values
    .map((v, index) => ({ index, distance: v.minus(mid).abs() }))
    .filter((c) => c.distance.greaterThan(limit))
    .sort((a, b) => b.distance.comparedTo(a.distance));

  const allowed = Math.floor(values.length * MAX_EXCLUDED_FRACTION);
  return new Set(candidates.slice(0, allowed).map((c) => c.index));
}

/** How much weight to put on the answer, from conditions the server can check (§19). */
function basisFor(periodsUsed: number, anyIncomplete: boolean, anyEstimated: boolean): ForecastBasis {
  if (periodsUsed < MIN_PERIODS) return 'weak';
  if (anyIncomplete || anyEstimated) return 'limited';
  return periodsUsed >= STRONG_MIN_PERIODS ? 'strong' : 'limited';
}

/**
 * The recency-weighted average of a window, with one-offs excluded.
 *
 * Weights are assigned over the KEPT periods in chronological order, so excluding an old one-off
 * does not silently promote the month beside it to a weight it did not earn.
 */
export function buildBaseline(metricKey: string, window: readonly ActualPoint[]): Baseline {
  const parsed = window.map((p) => ({ point: p, value: parseDecimalOrNull(p.value)! }));
  const excluded = findOneOffs(parsed.map((p) => p.value));

  const kept = parsed.filter((_, index) => !excluded.has(index));
  // Every period being a one-off is arithmetically impossible under MAX_EXCLUDED_FRACTION, but a
  // baseline over nothing would be a division by zero rather than an answer, so it is stated.
  const contributing = kept.length === 0 ? parsed : kept;

  let weighted = new Decimal(0);
  let totalWeight = 0;
  const points: BasisPoint[] = [];
  let keptIndex = 0;

  for (let i = 0; i < parsed.length; i += 1) {
    const { point, value } = parsed[i]!;
    const isExcluded = excluded.has(i) && kept.length > 0;
    const weight = isExcluded ? 0 : (keptIndex += 1);
    if (!isExcluded) {
      weighted = weighted.plus(value.times(weight));
      totalWeight += weight;
    }
    points.push({
      periodId: point.periodId,
      periodLabel: point.periodLabel,
      value: value.toString(),
      weight,
      excluded: isExcluded,
      exclusionReason: isExcluded ? 'one_off' : null,
    });
  }

  const average = weighted.dividedBy(totalWeight).toDecimalPlaces(2, ROUND_HALF_UP);
  const anyIncomplete = contributing.some((p) => !p.point.isComplete);
  const anyEstimated = contributing.some(
    (p) => p.point.assurance === 'estimated' || p.point.assurance === 'inferred',
  );
  const warnings = [...new Set(contributing.flatMap((p) => p.point.warnings))].sort();

  return {
    metricKey,
    value: toMoneyString(average),
    points,
    periodsUsed: contributing.length,
    periodsExcluded: points.filter((p) => p.excluded).length,
    anyIncomplete,
    anyEstimated,
    basis: basisFor(contributing.length, anyIncomplete, anyEstimated),
    warnings,
  };
}
