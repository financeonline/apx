import 'server-only';
import { NotFound } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { loadPeriodSnapshots, loadPeriods, statusFor, type PeriodLabel, type SnapshotRow } from '@/modules/dashboard';
import type { AccessContext } from '@/modules/tenancy';
import {
  BUDGET_LINES, budgetByCategory, computeBudgetVariance,
  type ActualFigure, type BudgetLineKey, type BudgetVariance,
} from '../domain/variance';
import * as repo from '../data/repository';

/**
 * Budget against actual (ADR-142). Reads the month's current budget lines and the actual figures the
 * engine already wrote, and lines them up through the pure `computeBudgetVariance`. Nothing is
 * computed from records here, and nothing is written.
 */

export interface BudgetView {
  readonly months: readonly PeriodLabel[];
  readonly period: PeriodLabel | null;
  readonly currency: string;
  readonly variance: BudgetVariance | null;
  readonly lines: readonly repo.BudgetLineRow[];
}

function actualOf(rows: readonly SnapshotRow[], metric: string, category?: string): ActualFigure | null {
  const row = rows.find((r) => r.metricKey === metric
    && (category === undefined ? r.dimensionType === 'none' : r.dimensionKey === category));
  if (row === undefined) return null;
  return {
    value: row.value,
    snapshotId: row.snapshotId,
    missing: row.dataQuality.missing,
    statusLabel: statusFor(row).label,
  };
}

/** For the analyst tool and the page: the variance for one month, without a permission check. */
export async function budgetVarianceFor(
  db: AccessContext['db'], orgId: string, periodId: string, requestId?: string,
): Promise<{ variance: BudgetVariance | null; lines: repo.BudgetLineRow[]; currency: string }> {
  const [lines, snapshots] = await Promise.all([
    repo.loadBudgetLines(db, orgId, periodId),
    loadPeriodSnapshots(db, orgId, periodId, requestId),
  ]);
  const currency = snapshots.find((s) => s.currency !== null)?.currency ?? 'GBP';
  if (lines.length === 0) return { variance: null, lines, currency };
  const actualByLine = new Map<BudgetLineKey, ActualFigure | null>(
    BUDGET_LINES.map((line) => [line.key, actualOf(snapshots, line.actual.metric, line.actual.category)]),
  );
  return {
    variance: computeBudgetVariance({ budgetByCategory: budgetByCategory(lines), actualByLine }),
    lines,
    currency,
  };
}

export async function getBudgetView(ctx: AccessContext, periodId?: string): Promise<BudgetView> {
  assertCan(ctx, 'financials.view');
  if (!ctx.orgId) throw new NotFound();
  const [periods, budgeted] = await Promise.all([
    loadPeriods(ctx.db, ctx.orgId, ctx.requestId),
    repo.loadBudgetPeriodIds(ctx.db, ctx.orgId),
  ]);
  const months = periods.filter((p) => budgeted.has(p.id));
  // Default: the latest complete month with a budget, else the latest budgeted month.
  const period = periodId === undefined
    ? months.find((p) => p.isComplete) ?? months[0] ?? null
    : months.find((p) => p.id === periodId) ?? null;
  if (periodId !== undefined && period === null) throw new NotFound();
  if (period === null) return { months, period: null, currency: 'GBP', variance: null, lines: [] };

  const result = await budgetVarianceFor(ctx.db, ctx.orgId, period.id, ctx.requestId);
  return { months, period, currency: result.currency, variance: result.variance, lines: result.lines };
}
