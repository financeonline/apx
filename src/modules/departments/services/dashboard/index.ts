import 'server-only';
import { assertCan } from '@/core/permissions';
import { systemClock, todayInTimeZone } from '@/core/periods';
import type { AccessContext } from '@/modules/tenancy';
import {
  DEPARTMENT_IDS, DEPARTMENT_META, PERIOD_MONTHS, effectiveView,
  type DashboardParams, type DepartmentDashboard, type DepartmentId, type DepartmentView, type MonthWindow,
  type PeriodMonths, type ReportView,
} from '../../domain/dashboard';
import { buildActivityWindow } from '../../domain/dashboard-money';
import { loadAnalysisView } from './analysis';
import { loadBankingView } from './banking';
import { loadCaptureView } from './capture';
import { loadClientsView } from './clients';
import { loadDashboardExtras } from './extras';
import { loadWindowAndPeriods } from './window';
import { loadWorkflowView } from './workflow';

/**
 * The department dashboard (ADR-180; docs/DEPARTMENT_DASHBOARD_PLAN.md): the month window, then the
 * selected department and the shared panels in parallel. Null when the company has no month with
 * figures — the page shows the first-run state.
 */

const LOADERS: Readonly<Record<DepartmentId, (ctx: AccessContext, window: MonthWindow) => Promise<DepartmentView>>> = {
  analysis: loadAnalysisView,
  banking: loadBankingView,
  capture: loadCaptureView,
  workflow: loadWorkflowView,
  clients: loadClientsView,
};

type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>> | URLSearchParams;

const first = (params: SearchParams, key: string): string | undefined => {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
};

/** `?dept=` · `?months=` · `?view=`, each validated, with the prototype's defaults (analysis, 6, current). */
export function parseDashboardParams(searchParams: SearchParams): DashboardParams {
  const dept = first(searchParams, 'dept');
  const months = Number(first(searchParams, 'months'));
  const view = first(searchParams, 'view');
  return {
    dept: (DEPARTMENT_IDS as readonly string[]).includes(dept ?? '') ? (dept as DepartmentId) : 'analysis',
    months: (PERIOD_MONTHS as readonly number[]).includes(months) ? (months as PeriodMonths) : 6,
    view: view === 'last' ? 'last' : ('current' satisfies ReportView),
  };
}

export async function loadDepartmentDashboard(ctx: AccessContext, params: DashboardParams): Promise<DepartmentDashboard | null> {
  assertCan(ctx, 'dashboard.view');
  const { window, periods } = await loadWindowAndPeriods(ctx, { months: params.months, view: effectiveView(params) });
  if (window === null) return null;
  // Owner, 2026-11-02: uploads, tasks and requests are counted up to today, not in the figures' months.
  const activity = buildActivityWindow(periods, params.months, todayInTimeZone(systemClock, 'UTC'), window.currency);
  const deptWindow: MonthWindow = params.dept === 'capture' || params.dept === 'workflow' ? activity
    : params.dept === 'clients' ? { ...window, activity } : window;
  const [view, extras] = await Promise.all([
    LOADERS[params.dept](ctx, deptWindow),
    loadDashboardExtras(ctx, window, { periods }),
  ]);
  return {
    params,
    departments: DEPARTMENT_IDS.map((id) => ({ id, name: DEPARTMENT_META[id].name, caption: DEPARTMENT_META[id].caption, icon: DEPARTMENT_META[id].icon })),
    view,
    extras,
  };
}
