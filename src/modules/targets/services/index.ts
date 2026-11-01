import 'server-only';
import { NotFound } from '@/core/errors';
import { assertCan, can } from '@/core/permissions';
import { callApi } from '@/core/db';
import type { AccessContext } from '@/modules/tenancy';
import {
  DEFAULT_TARGETS, parseExpectedRevision, parseMonthlyTargets, parseTargetMonth, type MonthlyTargets,
} from '../domain/targets';

/**
 * The company's monthly targets (one record per `YYYY-MM`, `monthly_targets`). Reads and writes are
 * `api.get_monthly_targets` / `api.set_monthly_targets`, which re-check the caller; the checks here
 * only fail early with the same answer.
 */

/** One month's targets as the dashboard shows them. */
export interface MonthlyTargetsRecord {
  readonly month: string;
  readonly targets: MonthlyTargets;
  /** 0 when nothing was saved for the month (the targets are then `DEFAULT_TARGETS`). */
  readonly revision: number;
  /** True when nothing was saved and the targets are the illustrative defaults. */
  readonly isDefault: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
  readonly createdAt: string | null;
}

interface TargetsRow {
  month: string; workflow: number; sales: string; marketing: string; cost_ratio: string; marketing_ratio: string;
  revision: number; updated_by: string | null; updated_at: string | null; created_at: string | null;
}

function orgOf(ctx: AccessContext): string {
  if (!ctx.orgId) throw new NotFound();
  return ctx.orgId;
}

function toRecord(row: TargetsRow): MonthlyTargetsRecord {
  return {
    month: row.month,
    targets: {
      workflow: row.workflow, sales: row.sales, marketing: row.marketing,
      costRatio: row.cost_ratio, marketingRatio: row.marketing_ratio,
    },
    revision: row.revision,
    isDefault: false,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

/** Whether this person may save targets (show the dialog's Save button only then). */
export function canManageTargets(ctx: AccessContext): boolean {
  return can(ctx, 'financials.view') && can(ctx, 'settings.manage');
}

/** The month's saved targets, or the defaults with revision 0 when none were saved. */
export async function getMonthlyTargets(ctx: AccessContext, month: string): Promise<MonthlyTargetsRecord> {
  assertCan(ctx, 'dashboard.view');
  const m = parseTargetMonth(month);
  const row = await callApi<TargetsRow | null>(ctx.db, 'get_monthly_targets', { p_org: orgOf(ctx), p_month: m }, ctx.requestId);
  if (row) return toRecord(row);
  return { month: m, targets: DEFAULT_TARGETS, revision: 0, isDefault: true, updatedBy: null, updatedAt: null, createdAt: null };
}

/**
 * Saves the month's targets. `expectedRevision` is the revision the dialog was opened with (0 for a
 * month with nothing saved); a stale one is a ConflictError (409) whose context carries the current
 * revision. Returns the saved record.
 */
export async function saveMonthlyTargets(
  ctx: AccessContext, month: string, targets: unknown, expectedRevision: unknown,
): Promise<MonthlyTargetsRecord> {
  assertCan(ctx, 'financials.view');
  assertCan(ctx, 'settings.manage');
  const m = parseTargetMonth(month);
  const parsed = parseMonthlyTargets(targets);
  const expected = parseExpectedRevision(expectedRevision);
  const row = await callApi<TargetsRow>(ctx.db, 'set_monthly_targets', {
    p_org: orgOf(ctx), p_month: m, p_targets: parsed, p_expected_revision: expected,
  }, ctx.requestId);
  return toRecord(row);
}
