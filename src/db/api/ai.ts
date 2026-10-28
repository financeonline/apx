import 'server-only';
import type { DbFunctions } from '../registry';
import { arg } from '../registry';
import { raise } from '../raise';
import { newId, nowIso, orgRow } from '../schema';
import { runTx } from '../tx';
import { uidOf, type Db } from '../types';
import { hasPermission, requirePermission } from '../app/access';
import { prepareAudit } from '../app/audit';
import { throttle } from '../app/throttle';
import { aiTokensUsedThisMonth, effectiveQuota, userTurnsToday, utcNextDayStart } from '../app/ai-quota';
import { locateOrgRow } from '../app/ai-reads';

/**
 * `api.*` functions of the AI Analyst (AI_ARCHITECTURE.md §2, §13; ADR-076, ADR-079, ADR-082),
 * ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8).
 *
 * What a member may do to the analyst's records with their own session: open and archive a
 * conversation, see the allowance, report an answer, and — for platform staff — review a report.
 * Turns themselves are server facts and are written only by `api_server.ai_persist_turn`.
 *
 * Three of these take a row id and no organisation, as the SQL did (`p_conversation`, `p_message`,
 * `p_feedback`); the organisation is found among those the caller can reach (`locateOrgRow`), so an
 * id of another tenant is NOT_FOUND exactly where `v_org not in app.accessible_org_ids()` was.
 */

const FEEDBACK_TYPES: ReadonlySet<string> = new Set(['incorrect', 'unhelpful', 'helpful', 'unsafe']);
const FEEDBACK_STATUSES: ReadonlySet<string> = new Set(['open', 'reviewed', 'actioned', 'dismissed']);

/** Every `api.*` call here first spends one unit of the caller's general 120/min allowance. */
const rpcThrottle = (db: Db) => throttle(db.fs, uidOf(db), 'rpc', 120, 60);

/**
 * `api.ai_quota_status(p_org)`: the allowance as the person it applies to may see it, counted
 * exactly as `api_server.ai_persist_turn` refuses on (ADR-079).
 */
async function ai_quota_status(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const orgId = arg.str(args, 'p_org');
  await requirePermission(db, orgId, 'ai.use');
  const org = orgId!;
  const now = new Date();
  const [daily, ceiling, usedToday, usedMonth] = await Promise.all([
    effectiveQuota(db.fs, org, 'ai_quota_daily'),
    effectiveQuota(db.fs, org, 'ai_token_ceiling_monthly'),
    userTurnsToday(db.fs, org, now),
    aiTokensUsedThisMonth(db.fs, org, now),
  ]);
  return {
    used_today: usedToday,
    daily_limit: daily,
    remaining_today: daily === null ? null : Math.max(daily - usedToday, 0),
    tokens_month: usedMonth,
    monthly_ceiling: ceiling,
    monthly_exhausted: ceiling !== null && usedMonth >= ceiling,
    resets_at: utcNextDayStart(now),
  };
}

/** `api.create_conversation(p_org)`: a new conversation of the caller's, in one organisation. */
async function create_conversation(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const orgId = arg.str(args, 'p_org');
  await requirePermission(db, orgId, 'ai.use');
  const id = newId();
  const now = nowIso();
  await runTx(db, async (tx) => {
    tx.set(orgRow(db.fs, orgId!, 'ai_conversations', id), conversationRow(id, orgId!, uidOf(db)!, now));
  });
  return id;
}

/** The `ai_conversations` row a new conversation starts as (the table's defaults). */
export function conversationRow(id: string, orgId: string, userId: string, now: string): Record<string, unknown> {
  return {
    id, organization_id: orgId, user_id: userId, title: null, status: 'active',
    last_message_at: null, created_at: now, updated_at: now,
  };
}

/**
 * `api.archive_conversation(p_conversation)`: your own conversation, or a colleague's if you govern
 * the organisation (`users.manage`). Anything else is NOT_FOUND.
 */
async function archive_conversation(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const id = arg.req(args, 'p_conversation');
  const orgId = await locateOrgRow(db, 'ai_conversations', id);
  if (!orgId) raise.notFound();
  const ref = orgRow(db.fs, orgId, 'ai_conversations', id);
  await runTx(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) raise.notFound();
    if (snap.get('user_id') !== uidOf(db) && !(await hasPermission(db, orgId, 'users.manage', tx))) {
      raise.notFound();
    }
    tx.update(ref, { status: 'archived', updated_at: nowIso() });
  });
  return id;
}

/**
 * `api.submit_ai_feedback(p_message, p_alert, p_type, p_comment)`: "Report this answer" (§13). The
 * report is bound to the organisation of the message (or alert) it names; reporting does not flag
 * the message — review does.
 */
async function submit_ai_feedback(db: Db, args: Record<string, unknown>): Promise<string> {
  // `p_type` was an enum-typed argument: a value outside it failed before the body ran.
  const type = arg.str(args, 'p_type');
  if (!type || !FEEDBACK_TYPES.has(type)) raise.invalid('invalid input value for the feedback type');
  await rpcThrottle(db);
  const messageId = arg.str(args, 'p_message');
  const alertId = arg.str(args, 'p_alert');
  let orgId: string | null;
  if (messageId !== null) {
    orgId = await locateOrgRow(db, 'ai_messages', messageId);
  } else if (alertId !== null) {
    orgId = await locateOrgRow(db, 'alerts', alertId);
  } else {
    raise.invalid('feedback must name a message or an alert');
  }
  if (!orgId) raise.notFound();
  const comment = arg.str(args, 'p_comment');

  const id = newId();
  await runTx(db, async (tx) => {
    await requirePermission(db, orgId, 'ai.use', tx);
    // same_org_ref: the message (and alert) named are this organisation's rows.
    const [message, alert] = await Promise.all([
      messageId ? tx.get(orgRow(db.fs, orgId, 'ai_messages', messageId)) : null,
      alertId ? tx.get(orgRow(db.fs, orgId, 'alerts', alertId)) : null,
    ]);
    if (message && !message.exists) raise.invalid('ai_feedback.message_id references a row that does not exist');
    if (alert && !alert.exists) raise.invalid('ai_feedback.alert_id references a row that does not exist');
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'ai.feedback_submitted', targetTable: 'ai_feedback', targetId: id,
      before: null, after: { type }, metadata: {},
    }, tx);
    const now = nowIso();
    tx.set(orgRow(db.fs, orgId, 'ai_feedback', id), {
      id, organization_id: orgId, message_id: messageId, alert_id: alertId, user_id: uidOf(db),
      feedback_type: type, comment, status: 'open', reviewed_by: null, reviewed_at: null,
      resolution_note: null, created_at: now, updated_at: now,
    });
    audit.write(tx);
  });
  return id;
}

/**
 * `api.review_ai_feedback(p_feedback, p_status, p_note)`: platform review (§13; ADR-082). A message
 * under review, or acted on, wears the badge in its organisation; a dismissed report takes it off.
 */
async function review_ai_feedback(db: Db, args: Record<string, unknown>): Promise<string> {
  // `p_status` was an enum-typed argument: a value outside it failed before the body ran.
  const status = arg.str(args, 'p_status');
  if (!status || !FEEDBACK_STATUSES.has(status)) raise.invalid('invalid input value for the feedback status');
  await rpcThrottle(db);
  const id = arg.req(args, 'p_feedback');
  const orgId = await locateOrgRow(db, 'ai_feedback', id);
  if (!orgId) raise.notFound();
  const note = arg.str(args, 'p_note');
  const ref = orgRow(db.fs, orgId, 'ai_feedback', id);

  await runTx(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) raise.notFound();
    await requirePermission(db, orgId, 'platform.ai_feedback.review', tx);
    if (status === 'open') raise.invalid('a review marks feedback reviewed, actioned or dismissed');
    if (note !== null && note.length > 1000) raise.invalid('keep the note under 1000 characters');

    const before = String(snap.get('status'));
    const messageId = (snap.get('message_id') as string | null) ?? null;
    const messageRef = messageId ? orgRow(db.fs, orgId, 'ai_messages', messageId) : null;
    const message = messageRef ? await tx.get(messageRef) : null;
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'ai.feedback_reviewed', targetTable: 'ai_feedback', targetId: id,
      before: { status: before }, after: { status }, metadata: {},
    }, tx);

    const now = nowIso();
    tx.update(ref, {
      status, reviewed_by: uidOf(db), reviewed_at: now,
      resolution_note: note === null || note.trim() === '' ? null : note.trim(), updated_at: now,
    });
    if (messageRef && message?.exists) {
      tx.update(messageRef, { flagged: status === 'reviewed' || status === 'actioned' });
    }
    audit.write(tx);
  });
  return id;
}

/** `api.*` functions of this area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8). */
export const functions: DbFunctions = {
  ai_quota_status,
  archive_conversation,
  create_conversation,
  review_ai_feedback,
  submit_ai_feedback,
};
