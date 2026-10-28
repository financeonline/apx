import 'server-only';
import type { DocumentData } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { arg, type DbFunction, type DbFunctions } from '../registry';
import { globalRow, newId, nowIso, orgRow } from '../schema';
import { runTx } from '../tx';
import { readerOf, uidOf, type Db } from '../types';
import {
  hasPermission, hasPermissionOf, orgRoleOf, requirePermission,
} from '../app/access';
import { prepareAudit } from '../app/audit';
import { throttle } from '../app/throttle';
import {
  ACTION_PRIORITIES, ACTION_SOURCES, ACTION_STATUSES, checkActionOwner, checkSameOrgRef, checkViolation,
  dateValue, enumValue, locateOrgRow, nonEmpty, numericString, orgPeople, sameOrgRefTarget, textOf,
} from '../app/actions-helpers';
import { prepareCloneBundleForAction } from '../app/actions-evidence';

/**
 * The Action Centre's `api.*` functions (SERVICE_ARCHITECTURE.md §4.13; SOW §17), ported from
 * PostgreSQL (FIRESTORE_DATA_MODEL.md §8). Same names, arguments, results, checks and sentences.
 *
 * What the triggers on `actions` did is done here: `set_updated_at` (every update stamps
 * `updated_at`), `same_org_ref_source` (a `source_id` names a row of this organisation, by
 * `source_type`), and the CHECKs `actions_title_len` and `actions_completed_pair`.
 *
 * Every function throttles first (`app.throttle(uid, 'rpc', 120, '1 minute')`), then does its
 * reads, permission checks and audit preparation inside one transaction before its first write.
 */

const RPC_LIMIT = 120;
const RPC_WINDOW = 60;

/** `same_org_ref_source`: what `actions.source_id` names, by `source_type`. */
const SOURCE_REF: Readonly<Record<string, string>> = {
  ai: 'ai_messages', alert: 'alerts', health_score: 'health_scores', report: 'report_files', user: '-',
};

function checkTitle(title: string): void {
  if (title.length < 1 || title.length > 300) checkViolation('actions', 'actions_title_len');
}

async function rpcThrottle(db: Db): Promise<void> {
  await throttle(db.fs, uidOf(db), 'rpc', RPC_LIMIT, RPC_WINDOW);
}

/** An action located by id, its organisation checked as the caller's (NotFound otherwise). */
async function locateAction(db: Db, id: string | null) {
  const found = await locateOrgRow(db.fs, 'actions', id);
  if (!found || !(await orgRoleOf(db.fs, uidOf(db), found.orgId))) raise.notFound();
  return found;
}

function actionRow(input: {
  orgId: string; id: string; title: string; issue: string | null; recommendation: string | null;
  priority: string; owner: string | null; dueDate: string | null; sourceType: string; sourceId: string | null;
  evidenceBundleId: string | null; createdBy: string | null;
}): DocumentData {
  const now = nowIso();
  return {
    id: input.id, organization_id: input.orgId, title: input.title, issue: input.issue,
    recommendation: input.recommendation, priority: input.priority, owner_user_id: input.owner,
    due_date: input.dueDate, status: 'open', source_type: input.sourceType, source_id: input.sourceId,
    evidence_bundle_id: input.evidenceBundleId, outcome_notes: null, outcome_value: null,
    outcome_currency: null, completed_at: null, dismissed_reason: null, created_by: input.createdBy,
    created_at: now, updated_at: now,
  };
}

/** `api.action_assignees(org)`: whom an action may be given to — people holding `actions.view`. */
const action_assignees: DbFunction = async (db, args) => {
  const orgId = arg.req(args, 'p_org');
  await requirePermission(db, orgId, 'actions.assign');
  const people = await orgPeople(db.fs, orgId);
  const rows: Array<{ user_id: string; full_name: string | null; sort: string | null }> = [];
  for (const id of people) {
    const profile = await globalRow(db.fs, 'profiles', id).get();
    if (!profile.exists) continue;
    if (!(await hasPermissionOf(db.fs, id, orgId, 'actions.view'))) continue;
    const raw = (profile.get('full_name') as string | null | undefined) ?? null;
    const trimmed = raw === null ? null : raw.trim();
    rows.push({ user_id: id, full_name: trimmed === '' ? null : trimmed, sort: raw });
  }
  // `order by pr.full_name nulls last, pr.id`.
  rows.sort((a, b) => {
    if (a.sort === null || b.sort === null) {
      if (a.sort !== b.sort) return a.sort === null ? 1 : -1;
    } else if (a.sort !== b.sort) {
      return a.sort.localeCompare(b.sort);
    }
    return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
  });
  return rows.map(({ user_id, full_name }) => ({ user_id, full_name }));
};

/** `api.assign_action(action, owner)`: ADR-172 — only to somebody who can open it. */
const assign_action: DbFunction = async (db, args) => {
  await rpcThrottle(db);
  const actionId = arg.req(args, 'p_action');
  const owner = arg.str(args, 'p_owner');
  const found = await locateAction(db, actionId);
  const orgId = found.orgId;
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const snap = await tx.get(found.ref);
    if (!snap.exists) raise.notFound();
    await requirePermission(db, orgId, 'actions.assign', tx);
    if (owner !== null && !(await orgRoleOf(db.fs, owner, orgId, r))) {
      raise.invalid('that person has no access to this organization');
    }
    if (owner !== null && !(await hasPermissionOf(db.fs, owner, orgId, 'actions.view', r))) {
      raise.invalid('that person cannot see the Action Centre, so an action cannot be given to them');
    }
    const before = (snap.get('owner_user_id') as string | null | undefined) ?? null;
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'action.assigned', targetTable: 'actions', targetId: actionId,
      before: { owner_user_id: before }, after: { owner_user_id: owner }, metadata: {},
    }, tx);
    tx.update(found.ref, { owner_user_id: owner, updated_at: nowIso() });
    audit.write(tx);
    return actionId;
  });
};

/** `api.create_action(org, input, source)`. */
const create_action: DbFunction = async (db, args) => {
  await rpcThrottle(db);
  const orgId = arg.req(args, 'p_org');
  const input = arg.obj(args, 'p_input');
  const source = args.p_source && typeof args.p_source === 'object' ? (args.p_source as Record<string, unknown>) : null;
  const owner = textOf(input, 'owner_user_id');
  const sourceType = enumValue(ACTION_SOURCES, textOf(source, 'type') ?? 'user', 'action_source_enum');
  const sourceId = textOf(source, 'id');
  const uid = uidOf(db);

  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    await requirePermission(db, orgId, 'actions.create', tx);

    const title = (textOf(input, 'title') ?? '').trim();
    if (title === '') raise.invalid('a title is required');

    // ADR-032.5: an action may be created from an AI answer only if that answer passed grounding.
    // Without this, a failed or degraded answer could be laundered into a task that looks authoritative.
    if (sourceType === 'ai') {
      const m = sourceId ? await r.get(orgRow(db.fs, orgId, 'ai_messages', sourceId)) : null;
      const grounded = m?.exists ? ((m.get('grounding_status') as string | null) ?? null) : null;
      if (grounded === null) raise.notFound();
      if (grounded !== 'passed') raise.invalid('an action cannot be created from an ungrounded answer');
    }

    // The owner must be somebody who can open the action, and naming somebody else is assigning.
    await checkActionOwner(db, orgId, owner, tx);

    const priority = enumValue(ACTION_PRIORITIES, textOf(input, 'priority') ?? 'medium', 'action_priority_enum');
    const dueDate = dateValue(textOf(input, 'due_date'));
    checkTitle(title);
    await checkSameOrgRef(r, sameOrgRefTarget(db.fs, orgId,
      { table: 'actions', idCol: 'source_id', discCol: 'source_type' }, SOURCE_REF, sourceType, sourceId),
    { table: 'actions', idCol: 'source_id' });

    const id = newId();
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'action.created', targetTable: 'actions', targetId: id,
      before: null, after: { title, source_type: sourceType }, metadata: {},
    }, tx);
    tx.set(orgRow(db.fs, orgId, 'actions', id), actionRow({
      orgId, id, title, issue: textOf(input, 'issue'), recommendation: textOf(input, 'recommendation'),
      priority, owner, dueDate, sourceType, sourceId, evidenceBundleId: null, createdBy: uid,
    }));
    audit.write(tx);
    return id;
  });
};

/** ADR-098: an alert's severity is the action's priority; `info` is the least urgent, `low`. */
const PRIORITY_OF_SEVERITY: Readonly<Record<string, string>> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'low',
};

/**
 * `api.create_action_from_alert(alert, input)`: §4.13 — the action copies the current revision's
 * evidence, and the alert points back at the action so the list shows "converted".
 *
 * A caller-supplied priority is IGNORED (ADR-098): the conversion is one click on an alert, and the
 * severity the rule already decided is the right answer; changing it afterwards is `update_action`.
 */
const create_action_from_alert: DbFunction = async (db, args) => {
  await rpcThrottle(db);
  const alertId = arg.req(args, 'p_alert');
  const input = arg.obj(args, 'p_input');
  const owner = nonEmpty(textOf(input, 'owner_user_id'));
  const found = await locateOrgRow(db.fs, 'alerts', alertId);
  if (!found || !(await orgRoleOf(db.fs, uidOf(db), found.orgId))) raise.notFound();
  const orgId = found.orgId;
  const uid = uidOf(db);

  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const alertSnap = await tx.get(found.ref);
    if (!alertSnap.exists) raise.notFound();
    const alert = alertSnap.data()!;
    await requirePermission(db, orgId, 'actions.create', tx);
    await checkActionOwner(db, orgId, owner, tx);

    const revisionId = (alert.current_revision_id as string | null | undefined) ?? null;
    const revision = revisionId ? await r.get(orgRow(db.fs, orgId, 'alert_revisions', revisionId)) : null;
    const rev = revision?.exists ? revision.data()! : null;
    const revisionNo = (rev?.revision_no as number | undefined) ?? null;
    const bundleId = (rev?.evidence_bundle_id as string | null | undefined) ?? null;

    const severity = String(alert.severity);
    const priority = PRIORITY_OF_SEVERITY[severity] ?? null;
    if (priority === null) raise.invalid('null value in column "priority" of relation "actions" violates not-null constraint');
    const title = nonEmpty((textOf(input, 'title') ?? '').trim()) ?? String(alert.title);
    checkTitle(title);
    const issue = textOf(input, 'issue') ?? ((rev?.explanation as string | undefined) ?? null);
    const recommendation = textOf(input, 'recommendation') ?? ((alert.recommended_next_step as string | null | undefined) ?? null);
    const dueDate = dateValue(textOf(input, 'due_date'));

    const actionId = newId();
    const bundle = await prepareCloneBundleForAction(db.fs, orgId, bundleId, actionId, uid, tx);
    const converted = await prepareAudit(db, {
      organizationId: orgId, action: 'alert.converted_to_action', targetTable: 'alerts', targetId: alertId,
      before: null, after: { action_id: actionId, revision_no: revisionNo, severity, priority }, metadata: {},
    }, tx);
    const created = await prepareAudit(db, {
      organizationId: orgId, action: 'action.created', targetTable: 'actions', targetId: actionId,
      before: null, after: { title, source_type: 'alert' }, metadata: {},
    }, tx);

    tx.set(orgRow(db.fs, orgId, 'actions', actionId), actionRow({
      orgId, id: actionId, title, issue, recommendation, priority, owner, dueDate,
      sourceType: 'alert', sourceId: alertId, evidenceBundleId: bundle.id, createdBy: uid,
    }));
    bundle.write(tx);
    tx.update(found.ref, { action_id: actionId, updated_at: nowIso() });
    converted.write(tx);
    created.write(tx);
    return actionId;
  });
};

/** jsonb `-> n` on an array: a negative index counts from the end; anything else is null. */
function jsonIndex(list: unknown, index: number): Record<string, unknown> | null {
  if (!Array.isArray(list) || !Number.isInteger(index)) return null;
  const i = index < 0 ? list.length + index : index;
  const v = list[i];
  return v === undefined || v === null ? null : (v as Record<string, unknown>);
}

const statementOf = (v: unknown): string | null => {
  const s = v && typeof v === 'object' ? (v as Record<string, unknown>).statement : undefined;
  if (s === undefined || s === null) return null;
  return typeof s === 'object' ? JSON.stringify(s) : String(s);
};

/**
 * `api.create_action_from_recommendation(message, index, input)`: one of a grounded answer's
 * recommended actions, its three Statement texts copied verbatim (§4.13) — grounding passed them, so
 * re-writing them here would put words in the analyst's mouth that nothing checked.
 */
const create_action_from_recommendation: DbFunction = async (db, args) => {
  await rpcThrottle(db);
  const messageId = arg.req(args, 'p_message');
  const index = arg.num(args, 'p_index');
  const input = arg.obj(args, 'p_input');
  const owner = nonEmpty(textOf(input, 'owner_user_id'));
  const found = await locateOrgRow(db.fs, 'ai_messages', messageId);
  if (!found || !(await orgRoleOf(db.fs, uidOf(db), found.orgId))) raise.notFound();
  const orgId = found.orgId;
  const uid = uidOf(db);

  return runTx(db, async (tx) => {
    const snap = await tx.get(found.ref);
    if (!snap.exists) raise.notFound();
    const m = snap.data()!;
    await requirePermission(db, orgId, 'actions.create', tx);
    if (m.grounding_status !== 'passed') raise.invalid('an action cannot be created from an ungrounded answer');
    await checkActionOwner(db, orgId, owner, tx);

    const response = m.structured_response as Record<string, unknown> | null | undefined;
    const rec = index === null ? null : jsonIndex(response?.recommended_actions, index);
    if (!rec) raise.notFound();

    const title = nonEmpty((textOf(input, 'title') ?? '').trim()) ?? statementOf(rec.title);
    if ((title ?? '').trim() === '') raise.invalid('a title is required');
    checkTitle(title!);
    const priority = enumValue(ACTION_PRIORITIES, textOf(rec, 'priority') ?? 'medium', 'action_priority_enum');
    const dueDate = dateValue(textOf(input, 'due_date'));

    const actionId = newId();
    const bundle = await prepareCloneBundleForAction(db.fs, orgId,
      (m.evidence_bundle_id as string | null | undefined) ?? null, actionId, uid, tx);
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'action.created', targetTable: 'actions', targetId: actionId,
      before: null, after: { title, source_type: 'ai', message_id: messageId }, metadata: {},
    }, tx);

    tx.set(orgRow(db.fs, orgId, 'actions', actionId), actionRow({
      orgId, id: actionId, title: title!, issue: statementOf(rec.issue), recommendation: statementOf(rec.recommendation),
      priority, owner, dueDate, sourceType: 'ai', sourceId: messageId, evidenceBundleId: bundle.id, createdBy: uid,
    }));
    bundle.write(tx);
    audit.write(tx);
    return actionId;
  });
};

/** `completed_at = case when status = 'completed' then coalesce(completed_at, now()) else null end`. */
const completedAt = (status: string, current: unknown): string | null =>
  (status === 'completed' ? ((current as string | null | undefined) ?? nowIso()) : null);

/**
 * `api.set_action_status(action, status, outcome)`: a client reaches this only for their own rows;
 * staff (`actions.create`) may move any row in their organisation.
 */
const set_action_status: DbFunction = async (db, args) => {
  await rpcThrottle(db);
  const actionId = arg.req(args, 'p_action');
  const status = enumValue(ACTION_STATUSES, args.p_status, 'action_status_enum');
  const outcome = arg.obj(args, 'p_outcome');
  const found = await locateAction(db, actionId);
  const orgId = found.orgId;
  const uid = uidOf(db);

  return runTx(db, async (tx) => {
    const snap = await tx.get(found.ref);
    if (!snap.exists) raise.notFound();
    const a = snap.data()!;
    await requirePermission(db, orgId, 'actions.update_own', tx);
    if (!(await hasPermission(db, orgId, 'actions.create', tx)) && a.owner_user_id !== uid) {
      raise.denied('this action is assigned to somebody else');
    }
    const value = textOf(outcome, 'outcome_value');
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'action.status_changed', targetTable: 'actions', targetId: actionId,
      before: null, after: { status }, metadata: {},
    }, tx);
    tx.update(found.ref, {
      status,
      outcome_notes: textOf(outcome, 'outcome_notes') ?? a.outcome_notes ?? null,
      outcome_value: value !== null ? numericString(value) : (a.outcome_value ?? null),
      dismissed_reason: textOf(outcome, 'dismissed_reason') ?? a.dismissed_reason ?? null,
      completed_at: completedAt(status, a.completed_at),
      updated_at: nowIso(),
    });
    audit.write(tx);
    return actionId;
  });
};

/** `api.update_action(action, patch)`: staff edits; the owner moves only through `assign_action`. */
const update_action: DbFunction = async (db, args) => {
  await rpcThrottle(db);
  const actionId = arg.req(args, 'p_action');
  const patch = arg.obj(args, 'p_patch');
  const found = await locateAction(db, actionId);
  const orgId = found.orgId;

  return runTx(db, async (tx) => {
    const snap = await tx.get(found.ref);
    if (!snap.exists) raise.notFound();
    const a = snap.data()!;
    await requirePermission(db, orgId, 'actions.create', tx);
    if ('owner_user_id' in patch) raise.invalid('use api.assign_action to change the owner');
    if ('title' in patch && (textOf(patch, 'title') ?? '').trim() === '') raise.invalid('a title is required');

    const title = nonEmpty((textOf(patch, 'title') ?? '').trim()) ?? String(a.title);
    checkTitle(title);
    const priorityText = textOf(patch, 'priority');
    const priority = priorityText !== null ? enumValue(ACTION_PRIORITIES, priorityText, 'action_priority_enum') : a.priority;
    const dueDate = 'due_date' in patch ? dateValue(textOf(patch, 'due_date')) : (a.due_date ?? null);
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'action.updated', targetTable: 'actions', targetId: actionId,
      before: { title: a.title, priority: a.priority, due_date: a.due_date ?? null }, after: patch, metadata: {},
    }, tx);
    tx.update(found.ref, {
      title,
      issue: textOf(patch, 'issue') ?? a.issue ?? null,
      recommendation: textOf(patch, 'recommendation') ?? a.recommendation ?? null,
      priority,
      due_date: dueDate,
      updated_at: nowIso(),
    });
    audit.write(tx);
    return actionId;
  });
};

/** `api.update_own_action(action, patch)`: the owner moves their own action's status and outcome. */
const update_own_action: DbFunction = async (db, args) => {
  await rpcThrottle(db);
  const actionId = arg.req(args, 'p_action');
  const patch = arg.obj(args, 'p_patch');
  const found = await locateAction(db, actionId);
  const orgId = found.orgId;
  const uid = uidOf(db);

  return runTx(db, async (tx) => {
    const snap = await tx.get(found.ref);
    if (!snap.exists) raise.notFound();
    const a = snap.data()!;
    await requirePermission(db, orgId, 'actions.update_own', tx);
    if (a.owner_user_id !== uid) raise.denied('this action is assigned to somebody else');

    const statusText = textOf(patch, 'status');
    const status = statusText !== null ? enumValue(ACTION_STATUSES, statusText, 'action_status_enum') : String(a.status);
    const value = textOf(patch, 'outcome_value');
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'action.status_changed', targetTable: 'actions', targetId: actionId,
      before: null, after: patch, metadata: {},
    }, tx);
    tx.update(found.ref, {
      status,
      outcome_notes: textOf(patch, 'outcome_notes') ?? a.outcome_notes ?? null,
      outcome_value: value !== null ? numericString(value) : (a.outcome_value ?? null),
      completed_at: completedAt(status, a.completed_at),
      updated_at: nowIso(),
    });
    audit.write(tx);
    return actionId;
  });
};

/** `api.*` functions of this area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8). */
export const functions: DbFunctions = {
  action_assignees,
  assign_action,
  create_action,
  create_action_from_alert,
  create_action_from_recommendation,
  set_action_status,
  update_action,
  update_own_action,
};
