import 'server-only';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { arg, type DbFunctions } from '../registry';
import { raise } from '../raise';
import { globalRow, newId, nowIso, orgCollection, orgRow } from '../schema';
import { runTx } from '../tx';
import { readerOf, uidOf, type Db } from '../types';
import { hasPermissionOf, orgRoleOf, requireOrg, requirePermission } from '../app/access';
import { prepareAudit } from '../app/audit';
import { prepareNotify } from '../app/shared';
import {
  btrim, charLength, checkViolation, dateValue, leftChars, locateOrNotFound, readRow, rpcThrottle,
} from '../app/financials-helpers';

/**
 * `api.*` functions of Team/Client Management (Agreement §4; ADR-144), ported from PostgreSQL
 * (FIRESTORE_DATA_MODEL.md §8): comments on actions, the client's requests and the team's
 * deliverables with their append-only history, and marking one's notifications read. Every write
 * tells the people concerned (`app.notify`), in the same transaction.
 */

/** `app.org_people(org)`: active members, and employees with an active, in-window assignment. */
async function orgPeople(fs: Firestore, tx: Transaction, orgId: string): Promise<string[]> {
  const [members, assignments] = await Promise.all([
    tx.get(orgCollection(fs, orgId, 'organization_memberships').where('status', '==', 'active')),
    tx.get(orgCollection(fs, orgId, 'organization_assignments').where('status', '==', 'active')),
  ]);
  const now = Date.now();
  const inWindow = (a: FirebaseFirestore.DocumentData) => (!a.starts_at || new Date(String(a.starts_at)).getTime() <= now)
    && (!a.ends_at || new Date(String(a.ends_at)).getTime() > now);
  return [...new Set([
    ...members.docs.map((d) => String(d.get('user_id'))),
    ...assignments.docs.filter((d) => inWindow(d.data())).map((d) => String(d.get('employee_user_id'))),
  ])];
}

/**
 * `app.engagement_audience(org, item)`: who hears about an item — its creator, its owner, everyone
 * who has acted on it, and for a deliverable every active client member.
 */
async function engagementAudience(
  fs: Firestore, tx: Transaction, orgId: string, item: FirebaseFirestore.DocumentData, extraActor: string | null,
): Promise<string[]> {
  const [events, clients] = await Promise.all([
    tx.get(orgCollection(fs, orgId, 'engagement_events').where('item_id', '==', item.id)),
    item.kind === 'deliverable'
      ? tx.get(orgCollection(fs, orgId, 'organization_memberships').where('status', '==', 'active').where('role', '==', 'client'))
      : Promise.resolve(null),
  ]);
  const people = [
    item.created_by, item.owner_user_id, extraActor,
    ...events.docs.map((d) => d.get('actor_id')),
    ...(clients?.docs.map((d) => d.get('user_id')) ?? []),
  ].filter((p): p is string => typeof p === 'string' && p !== '');
  return [...new Set(people)];
}

async function slugOf(fs: Firestore, tx: Transaction, orgId: string): Promise<string> {
  return String((await tx.get(globalRow(fs, 'organizations', orgId))).get('slug') ?? '');
}

/** `api.add_action_comment(p_action, p_body)` → the comment's id. */
async function add_action_comment(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db, 60);
  const actionId = arg.str(args, 'p_action');
  const found = await locateOrNotFound(db.fs, 'actions', actionId);
  const org = found.orgId;
  await requirePermission(db, org, 'actions.view');
  const raw = arg.str(args, 'p_body');
  if (raw === null || btrim(raw).length === 0) raise.invalid('write a comment');
  const body = btrim(raw);
  if (charLength(body) > 4000) checkViolation('action_comments', 'action_comments_body');
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    const action = await readRow(tx, db.fs, org, 'actions', actionId!);
    const earlier = await tx.get(orgCollection(db.fs, org, 'action_comments').where('action_id', '==', actionId));
    const slug = await slugOf(db.fs, tx, org);
    const id = newId();
    const event = await prepareAudit(db, {
      organizationId: org, action: 'action.commented', targetTable: 'actions', targetId: actionId, after: { comment_id: id },
    }, tx);
    // The owner, the creator and everyone who has commented before.
    const people = [...new Set([action.owner_user_id, action.created_by, actor, ...earlier.docs.map((d) => d.get('author_id'))]
      .filter((p): p is string => typeof p === 'string' && p !== ''))];
    const notices = await Promise.all(people.map((person) => prepareNotify(db.fs, {
      orgId: org, userId: person, actorId: actor, permission: 'actions.view', kind: 'action_comment',
      title: `New comment on "${leftChars(String(action.title ?? ''), 150)}"`, body: leftChars(body, 300),
      href: `/app/${slug}/actions/${actionId}`,
    }, readerOf(tx))));

    tx.set(orgRow(db.fs, org, 'action_comments', id), {
      id, organization_id: org, action_id: actionId, author_id: actor, body, created_at: nowIso(),
    });
    event.write(tx);
    for (const n of notices) n.write(tx);
    return id;
  });
}

/** `api.comment_engagement_item(p_item, p_note)` → the event's id. */
async function comment_engagement_item(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db, 60);
  const itemId = arg.str(args, 'p_item');
  const found = await locateOrNotFound(db.fs, 'engagement_items', itemId);
  const org = found.orgId;
  await requirePermission(db, org, 'actions.view');
  const raw = arg.str(args, 'p_note');
  if (raw === null || btrim(raw).length === 0) raise.invalid('write a comment');
  const note = btrim(raw);
  if (charLength(note) > 4000) checkViolation('engagement_events', 'engagement_events_note');
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    const item = await readRow(tx, db.fs, org, 'engagement_items', itemId!);
    const slug = await slugOf(db.fs, tx, org);
    const people = await engagementAudience(db.fs, tx, org, item, actor);
    const notices = await Promise.all(people.map((person) => prepareNotify(db.fs, {
      orgId: org, userId: person, actorId: actor, permission: 'actions.view', kind: 'engagement_comment',
      title: `New comment on "${leftChars(String(item.title ?? ''), 150)}"`, body: leftChars(note, 300),
      href: `/app/${slug}/engagement/${itemId}`,
    }, readerOf(tx))));
    const id = newId();
    tx.set(orgRow(db.fs, org, 'engagement_events', id), {
      id, organization_id: org, item_id: itemId, actor_id: actor, event: 'commented',
      from_status: null, to_status: null, note, created_at: nowIso(),
    });
    for (const n of notices) n.write(tx);
    return id;
  });
}

/** `api.create_engagement_item(p_org, p_kind, p_title, p_detail, p_due)` → the item's id. */
async function create_engagement_item(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db, 60);
  const org = arg.str(args, 'p_org');
  await requireOrg(db, org);
  const kind = arg.str(args, 'p_kind');
  if (kind === 'request') await requirePermission(db, org, 'actions.view');
  else if (kind === 'deliverable') await requirePermission(db, org, 'actions.assign');
  else raise.invalid('an item is a request or a deliverable');
  const rawTitle = arg.str(args, 'p_title');
  if (rawTitle === null || btrim(rawTitle).length === 0) raise.invalid('give it a title');
  const title = btrim(rawTitle);
  if (charLength(title) > 200) checkViolation('engagement_items', 'engagement_items_title');
  const detailText = btrim(arg.str(args, 'p_detail') ?? '');
  const detail = detailText === '' ? null : detailText;
  if (detail !== null && charLength(detail) > 4000) checkViolation('engagement_items', 'engagement_items_detail');
  const due = dateValue(args.p_due);
  const orgId = org!;
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    const id = newId();
    const event = await prepareAudit(db, {
      organizationId: orgId, action: 'engagement.created', targetTable: 'engagement_items', targetId: id, after: { kind },
    }, tx);
    const slug = await slugOf(db.fs, tx, orgId);
    const r = readerOf(tx);
    // A request goes to the team (who can act on it); a deliverable to the clients (whose it is).
    const people = await orgPeople(db.fs, tx, orgId);
    const audience: string[] = [];
    for (const person of people) {
      if (kind === 'request' ? await hasPermissionOf(db.fs, person, orgId, 'actions.assign', r)
        : (await orgRoleOf(db.fs, person, orgId, r)) === 'client') audience.push(person);
    }
    const notices = await Promise.all(audience.map((person) => prepareNotify(db.fs, {
      orgId, userId: person, actorId: actor, permission: 'actions.view', kind: 'engagement_created',
      title: `${kind === 'request' ? 'New request: ' : 'New deliverable: '}${leftChars(title, 150)}`,
      body: detail === null ? null : leftChars(detail, 300), href: `/app/${slug}/engagement/${id}`,
    }, r)));

    const now = nowIso();
    tx.set(orgRow(db.fs, orgId, 'engagement_items', id), {
      id, organization_id: orgId, kind, title, detail, status: 'open', due_date: due, created_by: actor,
      owner_user_id: null, closed_at: null, created_at: now, updated_at: now,
    });
    const eventId = newId();
    tx.set(orgRow(db.fs, orgId, 'engagement_events', eventId), {
      id: eventId, organization_id: orgId, item_id: id, actor_id: actor, event: 'created',
      from_status: null, to_status: 'open', note: null, created_at: now,
    });
    event.write(tx);
    for (const n of notices) n.write(tx);
    return id;
  });
}

const STATUSES = ['open', 'in_progress', 'delivered', 'closed'];

/** `api.update_engagement_status(p_item, p_status, p_note)` → p_item. */
async function update_engagement_status(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db, 60);
  const itemId = arg.str(args, 'p_item');
  const found = await locateOrNotFound(db.fs, 'engagement_items', itemId);
  const org = found.orgId;
  await requirePermission(db, org, 'actions.view');
  const status = arg.str(args, 'p_status');
  if (status === null || !STATUSES.includes(status)) raise.invalid('that is not a status');
  const noteText = btrim(arg.str(args, 'p_note') ?? '');
  const note = noteText === '' ? null : noteText;
  if (note !== null && charLength(note) > 4000) checkViolation('engagement_events', 'engagement_events_note');
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    const item = await readRow(tx, db.fs, org, 'engagement_items', itemId!);
    const team = await hasPermissionOf(db.fs, actor, org, 'actions.assign', readerOf(tx));
    // The team moves any item; a requester may only withdraw their own request.
    if (!team && !(item.kind === 'request' && item.created_by === actor && status === 'closed')) {
      raise.denied('actions.assign');
    }
    if (status === item.status) raise.conflict(`it is already ${status}`);
    const slug = await slugOf(db.fs, tx, org);
    const people = await engagementAudience(db.fs, tx, org, item, actor);
    const event = await prepareAudit(db, {
      organizationId: org, action: 'engagement.status_changed', targetTable: 'engagement_items', targetId: itemId,
      before: { status: item.status }, after: { status },
    }, tx);
    const notices = await Promise.all(people.map((person) => prepareNotify(db.fs, {
      orgId: org, userId: person, actorId: actor, permission: 'actions.view', kind: 'engagement_status',
      title: `"${leftChars(String(item.title ?? ''), 150)}" is now ${status!.replace(/_/g, ' ')}`,
      body: note === null ? null : leftChars(note, 300), href: `/app/${slug}/engagement/${itemId}`,
    }, readerOf(tx))));

    const now = nowIso();
    tx.update(orgRow(db.fs, org, 'engagement_items', itemId!), {
      status,
      closed_at: status === 'delivered' || status === 'closed' ? now : null,
      owner_user_id: item.owner_user_id ?? (team ? actor : null),
      updated_at: now,
    });
    const eventId = newId();
    tx.set(orgRow(db.fs, org, 'engagement_events', eventId), {
      id: eventId, organization_id: org, item_id: itemId, actor_id: actor, event: 'status_changed',
      from_status: item.status, to_status: status, note, created_at: now,
    });
    event.write(tx);
    for (const n of notices) n.write(tx);
    return itemId!;
  });
}

/** `api.mark_notifications_read(p_org, p_ids)` → how many were marked. Null ids: all of one's own. */
async function mark_notifications_read(db: Db, args: Record<string, unknown>): Promise<number> {
  await rpcThrottle(db);
  const org = arg.str(args, 'p_org');
  await requireOrg(db, org);
  const ids = arg.arr<string>(args, 'p_ids');
  const only = ids === null ? null : new Set(ids.map(String));
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    const unread = await tx.get(orgCollection(db.fs, org!, 'notifications')
      .where('user_id', '==', actor).where('read_at', '==', null));
    const docs = unread.docs.filter((d) => only === null || only.has(d.id));
    const now = nowIso();
    for (const d of docs) tx.update(d.ref, { read_at: now });
    return docs.length;
  });
}

export const functions: DbFunctions = {
  add_action_comment,
  comment_engagement_item,
  create_engagement_item,
  update_engagement_status,
  mark_notifications_read,
};
