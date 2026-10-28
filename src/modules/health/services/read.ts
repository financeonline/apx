import 'server-only';
import type { Db } from '@/db/types';
import { bandFor } from '../domain/config';
import type { HealthDimensionKey } from '../domain/config';
import type { DimensionBreakdown, HealthBand } from '../domain/types';
import * as repo from '../data/repository';

/**
 * Reading the score for the interface (UX_ARCHITECTURE.md §Level 1).
 *
 * Nothing here computes a score. The number, its band, its dimension count and its breakdown were
 * all decided by the engine and stored; this reads them back and works out one thing the stored row
 * cannot know on its own — the change against last month, which is a difference between two stored
 * scores rather than a new figure.
 */

export interface HealthCardView {
  readonly periodId: string;
  readonly score: number | null;
  readonly band: HealthBand | null;
  /** NULL when there is no previous month's score to compare with — not zero (§4). */
  readonly changeVsPrevious: number | null;
  readonly dimensionsUsed: number;
  readonly dimensionsTotal: number;
  /** True when any included dimension rested on bank-proxy figures (ADR-035). */
  readonly capped: boolean;
  readonly configVersion: string;
  readonly breakdown: readonly DimensionBreakdown[];
  readonly updatedAt: string;
  /** The bundle behind the score (§5); NULL for a score written before bundles existed. */
  readonly evidenceBundleId: string | null;
}

/** True when the score is absent because the engine could not include three dimensions (§7.2). */
export function isNotEnoughData(view: HealthCardView | null): boolean {
  return view !== null && view.score === null;
}

export async function loadHealthCard(
  db: Db,
  orgId: string,
  periodId: string,
  previousPeriodId: string | null,
  requestId?: string,
): Promise<HealthCardView | null> {
  const [current, previous] = await Promise.all([
    repo.loadHealthScore(db, orgId, periodId, bandFor, requestId),
    previousPeriodId === null
      ? Promise.resolve(null)
      : repo.loadHealthScore(db, orgId, previousPeriodId, bandFor, requestId),
  ]);

  if (current === null) return null;

  return {
    evidenceBundleId: await repo.loadHealthBundleId(db, orgId, current.scoreId),
    periodId: current.periodId,
    score: current.score,
    band: current.band,
    // ADR-119 / ADR-147: two scores worked out under different rules are not comparable — a change
    // would be the rules moving, not the business. Said as "no comparison", never as a movement.
    changeVsPrevious: current.score !== null && previous?.score != null
      && previous.configVersion === current.configVersion
      ? current.score - previous.score
      : null,
    dimensionsUsed: current.dimensionsUsed,
    dimensionsTotal: current.dimensionsTotal,
    capped: current.breakdown.some((d) => d.included && d.capped),
    configVersion: current.configVersion,
    breakdown: current.breakdown,
    updatedAt: current.updatedAt,
  };
}

/**
 * One dimension of a stored score, for the drill-down (`getHealthDimensionDetails` in the Phase 6
 * brief; FINANCIAL_ENGINE.md §7.4).
 *
 * Everything a reader needs to understand one area — its score, the weight it carried, the metrics
 * it rested on with the snapshot behind each, the rules that moved it, the factor sentences, the
 * cap, the exclusion reason and the data quality — is already in the breakdown the engine stored.
 * This picks one out and nothing else: recomputing a dimension on read is how a detail page comes
 * to disagree with the card that linked to it.
 */
export interface HealthDimensionView {
  readonly periodId: string;
  readonly configVersion: string;
  readonly updatedAt: string;
  /** The bundle behind the score as a whole (§5); each metric below also pins its own snapshot. */
  readonly evidenceBundleId: string | null;
  readonly dimension: DimensionBreakdown;
}

/** NULL when the period has no stored score, or the score has no such dimension. */
export async function loadHealthDimension(
  db: Db,
  orgId: string,
  periodId: string,
  dimension: HealthDimensionKey,
  requestId?: string,
): Promise<HealthDimensionView | null> {
  const current = await repo.loadHealthScore(db, orgId, periodId, bandFor, requestId);
  if (current === null) return null;

  const found = current.breakdown.find((entry) => entry.key === dimension);
  if (found === undefined) return null;

  return {
    periodId: current.periodId,
    configVersion: current.configVersion,
    updatedAt: current.updatedAt,
    evidenceBundleId: await repo.loadHealthBundleId(db, orgId, current.scoreId),
    dimension: found,
  };
}

export interface HealthHistoryPoint {
  readonly periodId: string;
  readonly score: number | null;
  readonly band: HealthBand | null;
}

/**
 * The monthly history, in the caller's period order.
 *
 * Months with no score keep their place with a NULL rather than being dropped, so the chart shows a
 * gap where a month was not scoreable instead of quietly joining the two months either side of it.
 */
export async function loadHealthHistory(
  db: Db, orgId: string, periodIds: readonly string[], requestId?: string,
): Promise<HealthHistoryPoint[]> {
  const stored = await repo.loadHealthHistory(db, orgId, periodIds, bandFor, requestId);
  const byPeriod = new Map(stored.map((s) => [s.periodId, s]));
  return periodIds.map((periodId) => {
    const found = byPeriod.get(periodId);
    return {
      periodId,
      score: found?.score ?? null,
      band: found?.band ?? null,
    };
  });
}

export interface PortfolioScore {
  readonly periodId: string;
  readonly score: number | null;
  readonly band: HealthBand | null;
  readonly dimensionsUsed: number;
  readonly dimensionsTotal: number;
}

/** Scores for the adviser's portfolio cards, keyed by organisation id (ADR-038.13). */
export async function loadPortfolioScores(
  db: Db, requestId?: string,
): Promise<Map<string, PortfolioScore>> {
  const rows = await repo.loadPortfolioScores(db, requestId);
  return new Map(rows.map((row) => [row.organizationId, {
    periodId: row.periodId,
    score: row.score,
    band: bandFor(row.score),
    dimensionsUsed: row.dimensionsUsed,
    dimensionsTotal: row.dimensionsTotal,
  }]));
}
