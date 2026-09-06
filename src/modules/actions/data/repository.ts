import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { Action, ActionPriority, ActionSource, ActionStatus } from '../domain/types';

/**
 * Action reads (SERVICE_ARCHITECTURE.md §4.13).
 *
 * Reads go through RLS on the caller's client; every write goes through an `api.*` function
 * (ADR-026). Nothing here writes.
 */

const SELECT = `
  id, title, issue, recommendation, priority, owner_user_id, due_date, status,
  source_type, source_id, evidence_bundle_id, outcome_notes, outcome_value, outcome_currency,
  completed_at, dismissed_reason, created_at`;

interface Row {
  id: string;
  title: string;
  issue: string | null;
  recommendation: string | null;
  priority: ActionPriority;
  owner_user_id: string | null;
  due_date: string | null;
  status: ActionStatus;
  source_type: ActionSource;
  source_id: string | null;
  evidence_bundle_id: string | null;
  outcome_notes: string | null;
  outcome_value: string | number | null;
  outcome_currency: string | null;
  completed_at: string | null;
  dismissed_reason: string | null;
  created_at: string;
}

function toAction(row: Row, names: ReadonlyMap<string, string>): Action {
  return {
    id: row.id,
    title: row.title,
    issue: row.issue,
    recommendation: row.recommendation,
    priority: row.priority,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_user_id === null ? null : names.get(row.owner_user_id) ?? null,
    dueDate: row.due_date,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidenceBundleId: row.evidence_bundle_id,
    outcomeNotes: row.outcome_notes,
    // NUMERIC arrives as a string from PostgREST and stays one (ADR-006).
    outcomeValue: row.outcome_value === null ? null : String(row.outcome_value),
    outcomeCurrency: row.outcome_currency,
    completedAt: row.completed_at,
    dismissedReason: row.dismissed_reason,
    createdAt: row.created_at,
  };
}

/**
 * The owners' display names, through `api.org_members`.
 *
 * NOT by embedding `profiles`: that table is own-row-only under RLS (TENANCY_MODEL.md), so an owner
 * reading the list would see their own name and `null` against everybody else's action — a list
 * that looks like nobody owns anything. `api.org_members` is the function the Team page already
 * uses, and it is the one place that decides who may learn a colleague's name.
 *
 * A CLIENT may not: `users.view` is not theirs, and a client who could enumerate the staff by
 * reading an action list would have been handed the team page sideways. They see "you" against
 * their own work and "someone here" against everybody else's, which is all the list needs to say.
 */
async function ownerNames(
  db: SupabaseClient, orgId: string, ids: readonly (string | null)[], resolve: boolean,
): Promise<Map<string, string>> {
  if (!resolve || ids.every((id) => id === null)) return new Map();

  const { data, error } = await db.schema('api').rpc('org_members', { p_org: orgId });
  if (error) throw toMotionError(error);

  return new Map(
    ((data ?? []) as Array<{ user_id: string; full_name: string | null }>)
      .filter((row): row is { user_id: string; full_name: string } => row.full_name !== null)
      .map((row) => [row.user_id, row.full_name]),
  );
}

export interface ActionFilter {
  readonly status?: readonly ActionStatus[];
  readonly ownerUserId?: string;
  readonly sourceType?: ActionSource;
}

export async function listActions(
  db: SupabaseClient, orgId: string, filter: ActionFilter = {}, resolveNames = false,
): Promise<Action[]> {
  let query = db.from('actions').select(SELECT).eq('organization_id', orgId);
  if (filter.status !== undefined && filter.status.length > 0) {
    query = query.in('status', [...filter.status]);
  }
  if (filter.ownerUserId !== undefined) query = query.eq('owner_user_id', filter.ownerUserId);
  if (filter.sourceType !== undefined) query = query.eq('source_type', filter.sourceType);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw toMotionError(error);

  const rows = (data ?? []) as unknown as Row[];
  const names = await ownerNames(db, orgId, rows.map((row) => row.owner_user_id), resolveNames);
  return rows.map((row) => toAction(row, names));
}

export async function getAction(
  db: SupabaseClient, orgId: string, actionId: string, resolveNames = false,
): Promise<Action | null> {
  const { data, error } = await db
    .from('actions').select(SELECT)
    .eq('organization_id', orgId).eq('id', actionId).maybeSingle();
  if (error) throw toMotionError(error);
  if (data === null) return null;

  const row = data as unknown as Row;
  return toAction(row, await ownerNames(db, orgId, [row.owner_user_id], resolveNames));
}

/** The people an action may be assigned to: members and currently assigned employees. */
export async function assignableOwners(
  db: SupabaseClient, orgId: string,
): Promise<Array<{ userId: string; name: string }>> {
  const { data, error } = await db.schema('api').rpc('org_members', { p_org: orgId });
  if (error) throw toMotionError(error);

  return ((data ?? []) as Array<{ user_id: string; full_name: string | null; status: string }>)
    .filter((row) => row.status === 'active')
    .map((row) => ({ userId: row.user_id, name: row.full_name ?? 'A colleague' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
