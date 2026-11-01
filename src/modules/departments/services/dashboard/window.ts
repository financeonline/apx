import 'server-only';
import { NotFound } from '@/core/errors';
import { isZero } from '@/core/money';
import { loadMetricSeries, loadPeriods, loadPeriodsWithData, type PeriodLabel } from '@/modules/dashboard';
import type { AccessContext } from '@/modules/tenancy';
import * as repo from '../../data/repository';
import { buildMonthWindow } from '../../domain/dashboard-money';
import type { DashboardParams, MonthWindow } from '../../domain/dashboard';

/**
 * The selected months (ADR-180): `params.months` months ending at the latest month with figures
 * (Current) or the latest complete month with figures (Last Completed), in the organisation's base
 * currency. Null when the company has no month with figures — the page then shows the first-run state.
 *
 * `periods` is returned too, so a caller that needs the period list (the year figures) does not read
 * it a second time.
 */
export async function loadWindowAndPeriods(
  ctx: AccessContext, params: Pick<DashboardParams, 'months' | 'view'>,
): Promise<{ window: MonthWindow | null; periods: readonly PeriodLabel[] }> {
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const [periods, withData, basics] = await Promise.all([
    loadPeriods(ctx.db, orgId, ctx.requestId),
    loadPeriodsWithData(ctx.db, orgId, ctx.requestId),
    repo.organisationBasics(ctx.db, orgId),
  ]);
  return { window: buildMonthWindow(periods, await withActivity(ctx, orgId, withData), params.months, params.view, basics.currency), periods };
}

/** The headline figures that say a month had activity: sales, or money in or out of the bank. */
const ACTIVITY_KEYS = ['revenue', 'cash_inflows', 'cash_outflows'] as const;

/**
 * The months that can anchor or open a window: of the periods with any stated figure, those where
 * sales or bank money moved. A month whose only figures are known zeros (the cash family writes
 * them for a month the bank statement has not reached yet) is not "Current" — the owner's dashboard
 * would otherwise open on an empty month. Falls back to every period with data when none moved.
 */
async function withActivity(ctx: AccessContext, orgId: string, withData: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  const ids = [...withData];
  if (ids.length === 0) return withData;
  const rows = await loadMetricSeries(ctx.db, orgId, ACTIVITY_KEYS, ids, ctx.requestId);
  const active = new Set(rows.filter((r) => r.value !== null && !isZero(r.value)).map((r) => r.periodId));
  return active.size > 0 ? active : withData;
}

export async function loadWindow(ctx: AccessContext, params: Pick<DashboardParams, 'months' | 'view'>): Promise<MonthWindow | null> {
  return (await loadWindowAndPeriods(ctx, params)).window;
}
