import 'server-only';
import { assertCan } from '@/core/permissions';
import { callApi } from '../data/rpc';
import type { AccessContext } from '../context';

export interface AuditEntry {
  /** A uuid since the move to Firestore (it was a bigint identity). */
  id: string;
  action: string;
  actorType: string;
  actorName: string | null;
  targetTable: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Organization-scoped audit log (RBAC: audit.view — owner and admin only). */
export async function listOrgAuditEvents(
  ctx: AccessContext,
  options: { limit?: number; offset?: number } = {},
): Promise<AuditEntry[]> {
  assertCan(ctx, 'audit.view');
  const rows = await callApi<Array<Record<string, never>>>(
    ctx.db,
    'org_audit_events',
    { p_org: ctx.orgId, p_limit: options.limit ?? 100, p_offset: options.offset ?? 0 },
    ctx.requestId,
  );
  return (rows ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    action: String(r.action),
    actorType: String(r.actor_type),
    actorName: (r.actor_name as string | null) ?? null,
    targetTable: (r.target_table as string | null) ?? null,
    targetId: (r.target_id as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  }));
}
