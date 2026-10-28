import 'server-only';
import { NotFound, ValidationError } from '@/core/errors';
import { assertCan, can } from '@/core/permissions';
import { callApi } from '@/core/db';
import { orgRowById, orgRows } from '@/db/rls';
import type { AccessContext } from '@/modules/tenancy';
import { notificationHref, readableNotificationKinds } from '../domain/notifications';

/**
 * Team/Client Management (Agreement §4; ADR-144): comments on actions, the client's requests and the
 * team's deliverables with their history, and a per-person notification inbox. In-app only.
 *
 * Reads are made as the caller (`src/db/rls.ts`), so each table's policy decides what they see. Writes are `api.*`
 * functions, which check the permission, write the history and send the notifications.
 *
 * Names: a colleague's name is shown only to someone with `users.view` (as the Action Centre does);
 * anyone else sees "You" or "A colleague".
 */

function orgOf(ctx: AccessContext): string {
  if (!ctx.orgId) throw new NotFound();
  return ctx.orgId;
}

async function namesFor(ctx: AccessContext, ids: readonly string[]): Promise<(id: string) => string> {
  const names = new Map<string, string>();
  if (can(ctx, 'users.view') && ids.length > 0) {
    const rows = await callApi<Array<{ user_id: string; full_name: string | null; email?: string | null }>>(
      ctx.db, 'org_members', { p_org: orgOf(ctx) }, ctx.requestId);
    for (const row of rows ?? []) if (row.full_name) names.set(row.user_id, row.full_name);
  }
  return (id: string) => (id === ctx.userId ? 'You' : names.get(id) ?? 'A colleague');
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

export interface NotificationView {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly href: string | null;
  readonly read: boolean;
  readonly createdAt: string;
}

/**
 * One's own notifications in this organisation, newest first — any member with the overview
 * (`dashboard.view`) reads their own inbox (ADR-172 follow-up). RLS gives each person only their own
 * rows; the kinds are filtered again by what the person may open NOW (`readableNotificationKinds`),
 * so an inbox written before a permission was taken away does not keep showing its detail.
 */
export async function listNotifications(ctx: AccessContext, limit = 50): Promise<NotificationView[]> {
  assertCan(ctx, 'dashboard.view');
  const kinds = readableNotificationKinds((p) => can(ctx, p));
  if (kinds.length === 0) return [];
  // Composite index: notifications (user_id, kind, created_at DESC).
  const rows = await orgRows(ctx.db, orgOf(ctx), 'notifications', (q) => q
    .where('user_id', '==', ctx.userId).where('kind', 'in', [...kinds])
    .orderBy('created_at', 'desc').limit(limit));
  return (rows as Array<{ id: string; kind: string; title: string; body: string | null; href: string | null; read_at: string | null; created_at: string }>)
    .map((n) => ({
      id: n.id, kind: n.kind, title: n.title, body: n.body,
      href: notificationHref(n.kind, n.href ?? null, ctx.orgSlug), read: (n.read_at ?? null) !== null, createdAt: n.created_at,
    }));
}

/** The sidebar's unread count, over exactly the kinds `listNotifications` shows. */
export async function unreadCount(ctx: AccessContext): Promise<number> {
  if (!ctx.orgId || !can(ctx, 'dashboard.view')) return 0;
  const kinds = readableNotificationKinds((p) => can(ctx, p));
  if (kinds.length === 0) return 0;
  const rows = await orgRows(ctx.db, ctx.orgId, 'notifications', (q) => q
    .where('user_id', '==', ctx.userId).where('read_at', '==', null).where('kind', 'in', [...kinds]).select('id'));
  return rows.length;
}

export async function markNotificationsRead(ctx: AccessContext, ids: readonly string[] | null): Promise<number> {
  return callApi<number>(ctx.db, 'mark_notifications_read', { p_org: orgOf(ctx), p_ids: ids }, ctx.requestId);
}

// ---------------------------------------------------------------------------------------------
// Comments on actions
// ---------------------------------------------------------------------------------------------

export interface CommentView {
  readonly id: string;
  readonly author: string;
  readonly mine: boolean;
  readonly body: string;
  readonly createdAt: string;
}

export async function listActionComments(ctx: AccessContext, actionId: string): Promise<CommentView[]> {
  assertCan(ctx, 'actions.view');
  // Composite index: action_comments (action_id, created_at).
  const rows = await orgRows(ctx.db, orgOf(ctx), 'action_comments', (q) => q
    .where('action_id', '==', actionId).orderBy('created_at').limit(500)) as Array<{ id: string; author_id: string; body: string; created_at: string }>;
  const name = await namesFor(ctx, rows.map((r) => r.author_id));
  return rows.map((r) => ({ id: r.id, author: name(r.author_id), mine: r.author_id === ctx.userId, body: r.body, createdAt: r.created_at }));
}

export async function addActionComment(ctx: AccessContext, actionId: string, body: string): Promise<string> {
  assertCan(ctx, 'actions.view');
  if (body.trim() === '') throw new ValidationError('Write a comment.');
  return callApi<string>(ctx.db, 'add_action_comment', { p_action: actionId, p_body: body }, ctx.requestId);
}

// ---------------------------------------------------------------------------------------------
// Requests and deliverables
// ---------------------------------------------------------------------------------------------

export type EngagementKind = 'request' | 'deliverable';
export type EngagementStatus = 'open' | 'in_progress' | 'delivered' | 'closed';

export const ENGAGEMENT_STATUS_LABELS: Readonly<Record<EngagementStatus, string>> = {
  open: 'Open', in_progress: 'In progress', delivered: 'Delivered', closed: 'Closed',
};

export interface EngagementItemView {
  readonly id: string;
  readonly kind: EngagementKind;
  readonly title: string;
  readonly detail: string | null;
  readonly status: EngagementStatus;
  readonly dueDate: string | null;
  readonly createdBy: string;
  readonly mine: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EngagementEventView {
  readonly id: string;
  readonly actor: string;
  readonly event: 'created' | 'status_changed' | 'commented';
  readonly fromStatus: EngagementStatus | null;
  readonly toStatus: EngagementStatus | null;
  readonly note: string | null;
  readonly createdAt: string;
}

interface ItemRow {
  id: string; kind: EngagementKind; title: string; detail: string | null; status: EngagementStatus;
  due_date: string | null; created_by: string; created_at: string; updated_at: string;
}

function toItem(row: ItemRow, name: (id: string) => string, me: string): EngagementItemView {
  return {
    id: row.id, kind: row.kind, title: row.title, detail: row.detail ?? null, status: row.status, dueDate: row.due_date ?? null,
    createdBy: name(row.created_by), mine: row.created_by === me, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function listEngagementItems(ctx: AccessContext): Promise<EngagementItemView[]> {
  assertCan(ctx, 'actions.view');
  const rows = await orgRows<ItemRow>(ctx.db, orgOf(ctx), 'engagement_items', (q) => q
    .orderBy('updated_at', 'desc').limit(200));
  const name = await namesFor(ctx, rows.map((r) => r.created_by));
  return rows.map((r) => toItem(r, name, ctx.userId));
}

export async function getEngagementItem(ctx: AccessContext, itemId: string): Promise<{
  item: EngagementItemView; events: EngagementEventView[];
} | null> {
  assertCan(ctx, 'actions.view');
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return null;
  const orgId = orgOf(ctx);
  const data = await orgRowById<ItemRow>(ctx.db, orgId, 'engagement_items', itemId);
  if (data === null) return null;
  // Composite index: engagement_events (item_id, created_at).
  const eventRows = await orgRows(ctx.db, orgId, 'engagement_events', (q) => q
    .where('item_id', '==', itemId).orderBy('created_at').limit(500)) as Array<{ id: string; actor_id: string; event: EngagementEventView['event']; from_status: EngagementStatus | null; to_status: EngagementStatus | null; note: string | null; created_at: string }>;
  const row = data;
  const name = await namesFor(ctx, [row.created_by, ...eventRows.map((e) => e.actor_id)]);
  return {
    item: toItem(row, name, ctx.userId),
    events: eventRows.map((e) => ({
      id: e.id, actor: name(e.actor_id), event: e.event, fromStatus: e.from_status, toStatus: e.to_status, note: e.note, createdAt: e.created_at,
    })),
  };
}

export async function createEngagementItem(ctx: AccessContext, input: {
  kind: EngagementKind; title: string; detail: string | null; dueDate: string | null;
}): Promise<string> {
  assertCan(ctx, input.kind === 'deliverable' ? 'actions.assign' : 'actions.view');
  if (input.title.trim() === '') throw new ValidationError('Give it a title.');
  return callApi<string>(ctx.db, 'create_engagement_item', {
    p_org: orgOf(ctx), p_kind: input.kind, p_title: input.title, p_detail: input.detail, p_due: input.dueDate,
  }, ctx.requestId);
}

export async function updateEngagementStatus(ctx: AccessContext, itemId: string, status: EngagementStatus, note: string | null): Promise<string> {
  assertCan(ctx, 'actions.view');
  return callApi<string>(ctx.db, 'update_engagement_status', { p_item: itemId, p_status: status, p_note: note }, ctx.requestId);
}

export async function commentEngagementItem(ctx: AccessContext, itemId: string, note: string): Promise<string> {
  assertCan(ctx, 'actions.view');
  if (note.trim() === '') throw new ValidationError('Write a comment.');
  return callApi<string>(ctx.db, 'comment_engagement_item', { p_item: itemId, p_note: note }, ctx.requestId);
}
