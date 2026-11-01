import 'server-only';
import { NotFound } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { callApi } from '@/core/db';
import type { AccessContext } from '@/modules/tenancy';
import { parseDashboardFeedback } from '../domain/feedback';

/**
 * Dashboard feedback: a member's note about the department dashboard, for APX staff
 * (`dashboard_feedback`, a platform-wide table). Written by `api.submit_dashboard_feedback`
 * (`dashboard.view`, twenty an hour per person); read only in the Platform area
 * (`api.platform_dashboard_feedback`, the super admin).
 */

export interface SubmittedFeedback {
  readonly id: string;
  readonly createdAt: string;
  readonly status: 'new' | 'read';
}

export async function submitDashboardFeedback(ctx: AccessContext, input: unknown): Promise<SubmittedFeedback> {
  assertCan(ctx, 'dashboard.view');
  if (!ctx.orgId) throw new NotFound();
  const parsed = parseDashboardFeedback(input);
  const row = await callApi<{ id: string; created_at: string; status: 'new' | 'read' }>(ctx.db, 'submit_dashboard_feedback', {
    p_org: ctx.orgId,
    p_section: parsed.section,
    p_department: parsed.department,
    p_notes: parsed.notes,
    p_context: parsed.context,
  }, ctx.requestId);
  return { id: row.id, createdAt: row.created_at, status: row.status };
}

export interface DashboardFeedbackItem {
  readonly id: string;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly authorEmail: string | null;
  readonly authorName: string | null;
  readonly section: string;
  readonly department: string | null;
  readonly notes: string;
  readonly context: Readonly<Record<string, string>>;
  readonly status: 'new' | 'read';
  readonly createdAt: string;
}

/** The Platform area's list: the latest notes from every company, newest first. */
export async function listDashboardFeedback(ctx: AccessContext, limit = 200): Promise<DashboardFeedbackItem[]> {
  assertCan(ctx, 'system.manage');
  const rows = await callApi<Array<Record<string, unknown>>>(ctx.db, 'platform_dashboard_feedback', { p_limit: limit }, ctx.requestId);
  return (rows ?? []).map((r) => ({
    id: String(r.id),
    organizationId: (r.organization_id as string | null) ?? null,
    organizationName: (r.organization_name as string | null) ?? null,
    authorEmail: (r.author_email as string | null) ?? null,
    authorName: (r.author_name as string | null) ?? null,
    section: String(r.section),
    department: (r.department as string | null) ?? null,
    notes: String(r.notes ?? ''),
    context: (r.context as Record<string, string> | null) ?? {},
    status: r.status === 'read' ? 'read' : 'new',
    createdAt: String(r.created_at),
  }));
}
