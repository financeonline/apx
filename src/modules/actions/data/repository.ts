import 'server-only';
import { callApi } from '@/core/db';
import type { Query } from 'firebase-admin/firestore';
import { orgRowById, orgRows } from '@/db/rls';
import { orgCollection, orgRow } from '@/db/schema';
import type { Db } from '@/db/types';
import type { Action, ActionPriority, ActionSource, ActionStatus } from '../domain/types';

/**
 * Action reads (SERVICE_ARCHITECTURE.md §4.13).
 *
 * Reads go through the ported row policies (`src/db/rls.ts`) for the caller; every write goes through an `api.*` function
 * (ADR-026). Nothing here writes.
 */

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
    // NUMERIC is stored as a decimal string and stays one (ADR-006).
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
  db: Db, orgId: string, ids: readonly (string | null)[], resolve: boolean,
): Promise<Map<string, string>> {
  if (!resolve || ids.every((id) => id === null)) return new Map();

  const data = await callApi<unknown[] | null>(db, 'org_members', { p_org: orgId });

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
  /** ADR-098: the Action Centre's priority filter. */
  readonly priority?: readonly ActionPriority[];
  /** Actions due on or before this date, inclusive. A row with no date is never "due" (§17). */
  readonly dueOnOrBefore?: string;
}

/**
 * A user reads through the `actions` policy (`src/db/rls.ts`). The server — the `report.render` job
 * listing open actions for the monthly PDF — read with the service role, which bypassed RLS; a
 * service handle therefore reads the collection directly, but only of the organisation it is scoped
 * to (ADR-090), as the alerts and reporting readers do.
 */
async function actionRows(db: Db, orgId: string, refine: (q: Query) => Query): Promise<Row[]> {
  if (db.actor.kind === 'service') {
    if (db.actor.scope !== null && db.actor.scope !== orgId) return [];
    const snap = await refine(orgCollection(db.fs, orgId, 'actions')).get();
    return snap.docs.map((d) => d.data() as Row);
  }
  return orgRows<Row>(db, orgId, 'actions', refine);
}

async function actionRowById(db: Db, orgId: string, actionId: string): Promise<Row | null> {
  if (db.actor.kind === 'service') {
    if ((db.actor.scope !== null && db.actor.scope !== orgId) || !actionId) return null;
    const snap = await orgRow(db.fs, orgId, 'actions', actionId).get();
    return snap.exists ? (snap.data() as Row) : null;
  }
  return orgRowById<Row>(db, orgId, 'actions', actionId);
}

export async function listActions(
  db: Db, orgId: string, filter: ActionFilter = {}, resolveNames = false,
): Promise<Action[]> {
  /*
   * One single-field filter runs in the query (status, the common one); the rest — owner, source,
   * priority, the due-date bound — and the newest-first order are applied here, so no filter
   * combination needs a composite index. An action list is one organisation's, and small.
   */
  const rows = await actionRows(db, orgId, (q) => (
    filter.status !== undefined && filter.status.length > 0 ? q.where('status', 'in', [...filter.status]) : q));
  const bounded = rows.filter((row) => (filter.ownerUserId === undefined || row.owner_user_id === filter.ownerUserId)
    && (filter.sourceType === undefined || row.source_type === filter.sourceType)
    && (filter.priority === undefined || filter.priority.length === 0 || filter.priority.includes(row.priority))
    /*
     * A row with no due date is left out of a due-date bound, as SQL's `<=` left NULLs out.
     * An action with no due date is not due — it is simply undated, and putting it in "due soon"
     * would invent a deadline nobody set.
     */
    && (filter.dueOnOrBefore === undefined || (row.due_date !== null && row.due_date <= filter.dueOnOrBefore)));
  bounded.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  const names = await ownerNames(db, orgId, bounded.map((row) => row.owner_user_id), resolveNames);
  return bounded.map((row) => toAction(row, names));
}

export async function getAction(
  db: Db, orgId: string, actionId: string, resolveNames = false,
): Promise<Action | null> {
  const row = await actionRowById(db, orgId, actionId);
  if (row === null) return null;
  return toAction(row, await ownerNames(db, orgId, [row.owner_user_id], resolveNames));
}

/**
 * The people an action may be assigned to: active members and currently assigned Financial Analysts
 * who can see the Action Centre (`actions.view`).
 */
export async function assignableOwners(
  db: Db, orgId: string,
): Promise<Array<{ userId: string; name: string }>> {
  /*
   * ADR-172 follow-up: `api.action_assignees` — the active members and assigned Financial Analysts
   * who hold `actions.view`, which is exactly whom `api.assign_action` accepts. It asks
   * `actions.assign`, the permission the picker serves; the `api.org_members` this used needed
   * `users.view`, which a Financial Analyst does not hold, and listed people with no Action Centre.
   */
  const data = await callApi<unknown[] | null>(db, 'action_assignees', { p_org: orgId });

  return ((data ?? []) as Array<{ user_id: string; full_name: string | null }>)
    .map((row) => ({ userId: row.user_id, name: row.full_name ?? 'A colleague' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
