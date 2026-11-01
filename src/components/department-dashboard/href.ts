import type { DashboardParams } from '@/modules/departments';

/** The dashboard's URL state (`?dept=&months=&view=`), with one part changed. */
export function dashHref(homePath: string, params: DashboardParams, patch: Partial<DashboardParams>): string {
  const next = { ...params, ...patch };
  const query = new URLSearchParams({ dept: next.dept, months: String(next.months), view: next.view });
  return `${homePath}?${query.toString()}`;
}
