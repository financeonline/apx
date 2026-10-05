/**
 * Chunking and the affected-period rules (FINANCIAL_ENGINE.md §2.4).
 *
 * A run is a chain of chunks of at most `CHUNK_PERIODS` consecutive months, oldest first, because a
 * ten-year history must not hold the organization's advisory lock for ten years' worth of work. The
 * lock is taken per chunk and released between chunks; one run row persists across them.
 *
 * Pure: given the trigger and what changed, decide which periods to compute and how to slice them.
 */

import { CHUNK_PERIODS, COMPARISON_LOOKBACK_MONTHS } from './version';
import type { PeriodRef } from './types';

export type CalculationTrigger =
  | 'import_commit' | 'import_rollback' | 'recalc_manual' | 'scheduled' | 'account_remapped'
  | 'settings_changed' | 'banking_edit' | 'record_superseded' | 'counterparty_merged';

/**
 * Triggers that invalidate every period rather than a range.
 *
 * A category remap or a settings change alters how EVERY month is computed, not just the months
 * whose records moved. Treating them as local would leave last year showing figures computed under
 * a mapping that no longer exists.
 */
const FULL_RANGE_TRIGGERS = new Set<CalculationTrigger>([
  'account_remapped', 'settings_changed', 'recalc_manual',
]);

export interface AffectedPeriodsInput {
  readonly trigger: CalculationTrigger;
  /** Periods whose records changed since the last succeeded run, in any order. */
  readonly changedPeriodIds: readonly string[];
  /** Every period the organization has, oldest first. */
  readonly allPeriods: readonly PeriodRef[];
  /** The current month in the organization's timezone, for the scheduled trigger. */
  readonly currentPeriodId: string | null;
  /**
   * FU-6: the as-of date of the organisation's latest succeeded run. When it lies in an earlier month
   * than today, that month was computed while it was still current — aged at the run date, its
   * invoice coverage judged by the current-month rule, its health not scored — and every run from
   * now on must recompute it as a completed month. Absent (or null) for an organisation never run.
   */
  readonly previousAsOf?: string | null;
  /** Today in the organisation's timezone: the run's as-of date. */
  readonly asOf?: string;
}

export interface RunRange {
  /** The first period whose snapshots this run will WRITE. */
  readonly affectedFrom: string | null;
  /** The first period this run READS, for comparisons. Never written. */
  readonly readFrom: string | null;
  readonly to: string | null;
  /** True when only the as-of-dependent keys are rewritten (ADR-047.8). */
  readonly asOfDependentOnly: boolean;
}

export function affectedRange(input: AffectedPeriodsInput): RunRange {
  const { trigger, changedPeriodIds, allPeriods, currentPeriodId } = input;
  if (allPeriods.length === 0) {
    return { affectedFrom: null, readFrom: null, to: null, asOfDependentOnly: false };
  }

  const indexOf = new Map(allPeriods.map((p, i) => [p.id, i]));
  const lastIndex = allPeriods.length - 1;

  /*
   * FU-6: the month a previous run computed as CURRENT, if today is past it. Found by the previous
   * run's as-of date, not by the calendar alone: a quiet organisation with no run for three months
   * still recomputes from the month it was last current in.
   */
  const rolledOverIndex = (() => {
    const previous = input.previousAsOf ?? null;
    const today = input.asOf ?? null;
    if (previous === null || today === null) return null;
    const index = allPeriods.findIndex((p) => p.periodStart <= previous && p.periodEnd >= previous);
    if (index < 0 || allPeriods[index]!.periodEnd >= today) return null;
    return index;
  })();

  /*
   * The daily scheduled run (FU-6; ADR-047.8 as amended by ADR-131): the periods whose figures depend
   * on the date — the CURRENT period, every key (ageing, and the invoice coverage that reaches "to
   * date", move with the date, and so do the balances they age) — and, after a month end, the month
   * that has just closed, from its first day, so it is recomputed as a completed month: coverage,
   * completeness, variances and its health score. Never history no date can change.
   */
  if (trigger === 'scheduled') {
    const currentIndex = currentPeriodId !== null ? indexOf.get(currentPeriodId) : undefined;
    const from = rolledOverIndex ?? currentIndex;
    if (from === undefined) {
      return { affectedFrom: null, readFrom: null, to: null, asOfDependentOnly: false };
    }
    const to = currentIndex ?? lastIndex;
    return {
      affectedFrom: allPeriods[from]!.id,
      readFrom: allPeriods[Math.max(0, from - COMPARISON_LOOKBACK_MONTHS)]!.id,
      to: allPeriods[Math.max(from, to)]!.id,
      asOfDependentOnly: false,
    };
  }

  let firstAffectedIndex: number;
  if (FULL_RANGE_TRIGGERS.has(trigger)) {
    firstAffectedIndex = 0;
  } else {
    const indices = changedPeriodIds
      .map((id) => indexOf.get(id))
      .filter((i): i is number => i !== undefined);
    if (indices.length === 0) {
      return { affectedFrom: null, readFrom: null, to: null, asOfDependentOnly: false };
    }
    firstAffectedIndex = Math.min(...indices);
  }
  // FU-6: whatever triggered it, a run after a month end also recomputes the month that closed —
  // otherwise an import on the 2nd would leave the 1st's predecessor as computed while current.
  if (rolledOverIndex !== null) firstAffectedIndex = Math.min(firstAffectedIndex, rolledOverIndex);

  // Comparisons need twelve months of history before the first affected period. Those months are
  // READ, never written — writing them would rewrite snapshots nothing changed about.
  const readIndex = Math.max(0, firstAffectedIndex - COMPARISON_LOOKBACK_MONTHS);

  return {
    affectedFrom: allPeriods[firstAffectedIndex]!.id,
    readFrom: allPeriods[readIndex]!.id,
    to: allPeriods[lastIndex]!.id,
    asOfDependentOnly: false,
  };
}

/**
 * Slices the periods to WRITE into chunks, oldest first.
 *
 * Oldest first is not arbitrary: cross-period inputs — opening cash, trailing averages, year-on-year
 * comparisons — read the previous period's pointers, which this run wrote in the previous chunk.
 * Computing newest-first, or in parallel, would read pointers that do not exist yet.
 */
export function chunkPeriods(
  periods: readonly PeriodRef[],
  size: number = CHUNK_PERIODS,
): PeriodRef[][] {
  if (size < 1) throw new Error('A chunk must contain at least one period.');
  const chunks: PeriodRef[][] = [];
  for (let i = 0; i < periods.length; i += size) {
    chunks.push(periods.slice(i, i + size));
  }
  return chunks;
}

/**
 * The periods a chunk needs loaded: the chunk itself plus twelve months of lead-in for comparisons.
 */
export function chunkWindow(
  allPeriods: readonly PeriodRef[],
  chunk: readonly PeriodRef[],
): PeriodRef[] {
  if (chunk.length === 0) return [];
  const firstIndex = allPeriods.findIndex((p) => p.id === chunk[0]!.id);
  if (firstIndex < 0) return [...chunk];
  const start = Math.max(0, firstIndex - COMPARISON_LOOKBACK_MONTHS);
  const lastId = chunk[chunk.length - 1]!.id;
  const endIndex = allPeriods.findIndex((p) => p.id === lastId);
  return allPeriods.slice(start, endIndex + 1);
}
