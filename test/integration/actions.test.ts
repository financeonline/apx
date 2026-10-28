import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { getActionsSummary, listActions, ownerLabel } from '@/modules/actions';
import type { AccessContext } from '@/modules/tenancy';
import { ensurePeriods, periodId } from '@/db/app/shared';
import { orgRows } from '@/db/rls';
import { globalRow, newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { auth } from '@/db/firestore';
import {
  clientFor, createAuthUser, deleteOrg, fs, rpc as call, serviceClientScoped, sqlstate,
} from './setup';
import { addMember, auditEvents, createOrgFixture } from './r-fixtures';

/**
 * The Action Centre against the database (SOW §17; IMPLEMENTATION_PLAN.md Phase 12).
 *
 * An action is the one object a person is accountable for, so the boundaries worth testing are the
 * ones about WHO may move WHAT. A client may move their own action along and record what came of
 * it, and nothing else — not somebody else's action, and not the title, priority or due date of
 * their own. Those are the terms of the assignment, and letting the assignee rewrite them makes the
 * assignment meaningless.
 *
 * Run-unique fixtures (ADR-052.12), on the Firestore emulator (FIRESTORE_DATA_MODEL.md §9).
 */

const RUN = `a${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.actions.itest.motion`;

let ownerId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let otherOrgId: string;
let may: string;

const owner = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });
const clientUser = () => clientFor(clientId, { email: `client@${DOMAIN}` });

const rpc = (db: ReturnType<typeof clientFor>, fn: string, args: Record<string, unknown>) => call(db, fn, args);

/** The context a page hands a service: the caller's own client and their real permission set. */
function contextFor(userId: string, role: 'owner' | 'client'): AccessContext {
  return {
    userId, orgId, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-03-15T00:00:00Z'),
    organizationStatus: 'active',
  };
}
const ownerCtx = () => contextFor(ownerId, 'owner');
const clientCtx = () => contextFor(clientId, 'client');

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientId = await createAuthUser(`client@${DOMAIN}`);
  strangerId = await createAuthUser(`stranger@${DOMAIN}`);

  orgId = (await createOrgFixture({ name: `ITest Actions ${RUN}`, ownerId })).id;
  otherOrgId = (await createOrgFixture({ name: `ITest Actions Other ${RUN}`, ownerId: strangerId })).id;
  await addMember(orgId, clientId, 'client');
  await ensurePeriods(fs(), orgId, '2026-05-01', '2026-05-01');
  may = periodId(orgId, '2026-05-01');
});

afterAll(async () => {
  await deleteOrg(orgId);
  await deleteOrg(otherOrgId);
  for (const uid of [ownerId, clientId, strangerId]) {
    await fs().collection('profiles').doc(uid).delete();
    await auth().deleteUser(uid).catch(() => undefined);
  }
});

async function newAction(over: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await rpc(owner(), 'create_action', {
    p_org: orgId,
    p_input: { title: 'Chase the overdue invoices', priority: 'high', due_date: '2026-04-30', ...over },
    p_source: { type: 'user' },
  });
  if (error) throw new Error(`fixture action failed: ${error.message}`);
  return data as unknown as string;
}

const actionRow = async (actionId: string) => (await orgRow(fs(), orgId, 'actions', actionId).get()).data()!;

const columnsOf = async (actionId: string): Promise<string> => {
  const a = await actionRow(actionId);
  return [a.title, a.priority, a.due_date ?? '-', a.status, a.outcome_notes ?? '-'].join('|');
};

describe('an owner runs the Action Centre', () => {
  it('creates, assigns, edits and completes', async () => {
    const actionId = await newAction();

    expect((await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: clientId })).error)
      .toBeNull();
    expect((await rpc(owner(), 'update_action', {
      p_action: actionId, p_patch: { priority: 'critical', due_date: '2026-05-31' },
    })).error).toBeNull();
    expect((await rpc(owner(), 'set_action_status', {
      p_action: actionId, p_status: 'completed', p_outcome: { outcome_notes: 'Collected in full' },
    })).error).toBeNull();

    expect(await columnsOf(actionId))
      .toBe('Chase the overdue invoices|critical|2026-05-31|completed|Collected in full');
    expect((await actionRow(actionId)).completed_at).not.toBeNull();
  });

  it('refuses an owner who cannot see the organisation', async () => {
    const actionId = await newAction();
    const { error } = await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: strangerId });
    expect(sqlstate(error)).toBe('22023');
  });

  it('sends an owner change through assign_action rather than the general edit', async () => {
    const actionId = await newAction();
    const { error } = await rpc(owner(), 'update_action', {
      p_action: actionId, p_patch: { owner_user_id: clientId },
    });
    expect(sqlstate(error)).toBe('22023');
  });
});

describe('a client moves their own action, and only their own (§17, RBAC_MATRIX)', () => {
  it('moves the status and records the outcome', async () => {
    const actionId = await newAction();
    await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: clientId });

    const { error } = await rpc(clientUser(), 'update_own_action', {
      p_action: actionId,
      p_patch: { status: 'in_progress', outcome_notes: 'Rang them on Tuesday' },
    });
    expect(error).toBeNull();
    expect(await columnsOf(actionId))
      .toBe('Chase the overdue invoices|high|2026-04-30|in_progress|Rang them on Tuesday');
  });

  /*
   * The plan's verification for this slice, and the reason `update_own_action` exists separately:
   * the assignee may say what happened, not rewrite what they were asked to do.
   */
  it('cannot change the title, the priority or the due date of their own action', async () => {
    const actionId = await newAction();
    await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: clientId });
    const before = await columnsOf(actionId);

    const { error } = await rpc(clientUser(), 'update_own_action', {
      p_action: actionId,
      p_patch: { title: 'Something else entirely', priority: 'low', due_date: '2027-01-01' },
    });
    expect(error, 'the call is accepted; the columns simply do not move').toBeNull();
    expect(await columnsOf(actionId)).toBe(before);
  });

  it('cannot touch an action assigned to somebody else', async () => {
    const actionId = await newAction();
    await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: ownerId });

    expect(sqlstate((await rpc(clientUser(), 'update_own_action', {
      p_action: actionId, p_patch: { status: 'completed' },
    })).error)).toBe('42501');
    expect(sqlstate((await rpc(clientUser(), 'set_action_status', {
      p_action: actionId, p_status: 'completed',
    })).error)).toBe('42501');
  });

  it('cannot create, assign or edit at all', async () => {
    const actionId = await newAction();
    expect(sqlstate((await rpc(clientUser(), 'create_action', {
      p_org: orgId, p_input: { title: 'Mine now' }, p_source: { type: 'user' },
    })).error)).toBe('42501');
    expect(sqlstate((await rpc(clientUser(), 'assign_action', {
      p_action: actionId, p_owner: clientId,
    })).error)).toBe('42501');
    expect(sqlstate((await rpc(clientUser(), 'update_action', {
      p_action: actionId, p_patch: { title: 'Mine now' },
    })).error)).toBe('42501');
  });
});

/**
 * The read path the Action Centre page renders from.
 *
 * Its own suite because the page is the only thing that exercises it, and a 500 there is invisible
 * to every test that only calls the `api.*` functions: the writes were green while the list threw.
 */
describe('the list a person actually sees', () => {
  it('reads for an owner and for a client alike', async () => {
    const actionId = await newAction({ title: `Named owner ${RUN}` });
    await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: clientId });
    await globalRow(fs(), 'profiles', clientId).update({ full_name: 'Dana Client' });

    for (const [role, ctx] of [['owner', ownerCtx()], ['client', clientCtx()]] as const) {
      const found = (await listActions(ctx)).find((a) => a.id === actionId);
      expect(found, `${role} must see the action`).toBeDefined();
    }
  });

  /*
   * Who a reader is told owns an action. A name comes from `api.org_members`, which needs
   * `users.view` — an owner has it, a client does not. A client who could read colleagues' names
   * off an action list would have been handed the team page sideways, so they see "you" against
   * their own work and "someone here" against everybody else's, which is all the list needs.
   */
  it('names a colleague to an owner, and never to a client', async () => {
    const actionId = await newAction({ title: `Named owner two ${RUN}` });
    await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: clientId });
    await globalRow(fs(), 'profiles', clientId).update({ full_name: 'Dana Client' });

    const asOwner = (await listActions(ownerCtx())).find((a) => a.id === actionId)!;
    expect(asOwner.ownerName).toBe('Dana Client');
    expect(ownerLabel(asOwner, ownerId), 'somebody else, named').toBe('Dana Client');

    const asClient = (await listActions(clientCtx())).find((a) => a.id === actionId)!;
    expect(asClient.ownerName, 'a client learns no names at all').toBeNull();
    expect(ownerLabel(asClient, clientId), 'except that it is theirs').toBe('You');

    const unassigned = (await listActions(ownerCtx()))
      .find((a) => a.ownerUserId === null);
    if (unassigned !== undefined) {
      expect(ownerLabel(unassigned, ownerId)).toBe('Nobody yet');
    }
  });

  it('summarises what is outstanding for Home, counting only what is unfinished', async () => {
    const mine = await newAction({ title: `Mine ${RUN}`, due_date: '2020-01-01' });
    await rpc(owner(), 'assign_action', { p_action: mine, p_owner: ownerId });
    const done = await newAction({ title: `Done ${RUN}` });
    await rpc(owner(), 'set_action_status', { p_action: done, p_status: 'completed' });

    const summary = await getActionsSummary(ownerCtx(), '2026-03-15');
    expect(summary.open).toBeGreaterThan(0);
    expect(summary.overdue, 'a 2020 due date is overdue').toBeGreaterThan(0);
    expect(summary.mine).toBeGreaterThan(0);
    expect(summary.top.map((a) => a.id), 'finished work is not outstanding').not.toContain(done);
  });
});

describe('an action from another organisation does not exist', () => {
  it('is NOT FOUND, never FORBIDDEN (SECURITY_MODEL.md §14)', async () => {
    const foreign = await rpc(clientFor(strangerId, { email: `stranger@${DOMAIN}` }), 'create_action', {
      p_org: otherOrgId, p_input: { title: 'Theirs' }, p_source: { type: 'user' },
    });
    expect(foreign.error).toBeNull();
    const foreignId = foreign.data as unknown as string;

    expect(sqlstate((await rpc(owner(), 'set_action_status', {
      p_action: foreignId, p_status: 'completed',
    })).error)).toBe('P0002');

    // And it is not readable either: the owner's read of their own organisation never reaches it,
    // and a read of the other organisation admits nothing.
    const own = await orgRows(owner(), orgId, 'actions', (q) => q.where('id', '==', foreignId));
    expect(own).toHaveLength(0);
    const theirs = await orgRows(owner(), otherOrgId, 'actions');
    expect(theirs).toHaveLength(0);
  });
});

/** A succeeded calculation run in May, as the engine would leave it. */
async function seedRun(): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'calculation_runs', id).set({
    id, organization_id: orgId, job_id: null, trigger: 'recalc_manual', trigger_ref_id: null,
    engine_version: '1.0.0', period_from: may, period_to: may, as_of: '2026-06-15', as_of_ts: now,
    status: 'succeeded', failure_reason: null, stale: false, input_fingerprint: null, chunks: [],
    progress: {}, started_at: now, finished_at: now, duration_ms: 1, error: null, stats: {},
    created_at: now, updated_at: now,
  });
  return id;
}

/** An alert written the way the engine writes one: through `api_server.persist_alerts`. */
async function seedAlert(input: {
  runId: string; severity: string; dedupe: string; ruleKey: string; title: string; explanation: string;
  next?: string | null; evidence?: unknown[];
}): Promise<string> {
  const { data, error } = await call(serviceClientScoped(orgId), 'persist_alerts', {
    p_org: orgId, p_run: input.runId, p_changes: [{
      kind: 'insert', dedupe_key: input.dedupe, rule_key: input.ruleKey, rule_version: '1',
      key_kind: 'state', severity: input.severity, period_id: may, subject_type: 'none', subject_id: null,
      metric_key: null, title: input.title, explanation: input.explanation,
      recommended_next_step: input.next ?? null, threshold_summary: {}, evidence: input.evidence ?? [],
    }],
  }, { server: true });
  if (error) throw new Error(`fixture alert failed: ${error.message}`);
  expect(data).toMatchObject({ inserted: 1 });
  const snap = await orgCollection(fs(), orgId, 'alerts').where('dedupe_key', '==', input.dedupe).get();
  return snap.docs[0]!.id;
}

describe('an action created from an alert keeps what the alert said (§5, ADR-034)', () => {
  let alertId: string;
  let bundleId: string;

  beforeAll(async () => {
    const runId = await seedRun();
    alertId = await seedAlert({
      runId, severity: 'high', dedupe: `itest-${RUN}`, ruleKey: 'concentration.customer',
      title: 'One customer is 41% of revenue',
      explanation: 'Acme Trading Ltd is 41% of revenue this month.',
      next: 'Talk to your second-biggest customer about more work',
      evidence: [{
        item_type: 'calculation_run', ref_id: runId, query_descriptor: null, descriptor_hash: null,
        label: 'Calculated 15 Jun 2026, engine 1.0.0', claim: null, assurance_level: 'verified',
      }],
    });
    const alert = (await orgRow(fs(), orgId, 'alerts', alertId).get()).data()!;
    const revision = (await orgRow(fs(), orgId, 'alert_revisions', alert.current_revision_id).get()).data()!;
    bundleId = revision.evidence_bundle_id;
  });

  it('copies the revision’s text and the alert’s next step', async () => {
    const { data, error } = await rpc(owner(), 'create_action_from_alert', {
      p_alert: alertId, p_input: { priority: 'high' },
    });
    expect(error).toBeNull();
    const actionId = data as unknown as string;

    const a = await actionRow(actionId);
    expect([a.title, a.issue, a.recommendation, a.source_type].join('|'))
      .toBe('One customer is 41% of revenue|Acme Trading Ltd is 41% of revenue this month.'
        + '|Talk to your second-biggest customer about more work|alert');

    // The alert points back, so the list shows "converted" rather than offering the button twice.
    expect((await orgRow(fs(), orgId, 'alerts', alertId).get()).get('action_id')).toBe(actionId);
  });

  /*
   * The evidence is COPIED, not referenced. An alert is re-evaluated whenever the figures change,
   * and an action created in March that silently started showing June's numbers would make "why did
   * we do this?" unanswerable — which is the question an action list exists to answer.
   */
  it('clones the evidence rather than pointing at the alert’s own bundle', async () => {
    const { data } = await rpc(owner(), 'create_action_from_alert', { p_alert: alertId, p_input: {} });
    const actionId = data as unknown as string;

    const cloned = (await actionRow(actionId)).evidence_bundle_id as string;
    expect(cloned).not.toBe(bundleId);

    const bundle = (await orgRow(fs(), orgId, 'evidence_bundles', cloned).get()).data()!;
    expect(`${bundle.kind}|${bundle.origin_table}|${bundle.origin_id}`).toBe(`action|actions|${actionId}`);

    const items = (await orgCollection(fs(), orgId, 'evidence_items').where('bundle_id', '==', cloned).get())
      .docs.map((d) => d.data()).sort((x, y) => x.sort_order - y.sort_order);
    expect(items.map((i) => `${i.item_type}:${i.label}`).join(','))
      .toBe('calculation_run:Calculated 15 Jun 2026, engine 1.0.0');
  });

  it('a client cannot convert an alert into an action', async () => {
    expect(sqlstate((await rpc(clientUser(), 'create_action_from_alert', {
      p_alert: alertId, p_input: {},
    })).error)).toBe('42501');
  });
});

/**
 * ADR-098: the priority of an action made from an alert is the alert's severity.
 *
 * It used to be `coalesce(p_input->>'priority', 'medium')` and the product never sent one, so every
 * action converted from an alert was medium — a critical one included. The suite below drives each
 * severity through the real function and reads the row back.
 */
describe('an alert’s severity decides the action’s priority (ADR-098)', () => {
  const alertOf = async (severity: string, key: string): Promise<string> => seedAlert({
    runId: await seedRun(), severity, dedupe: `itest-prio-${RUN}-${key}`, ruleKey: 'cash.runway_low',
    title: 'Runway is short', explanation: 'Cash would last under two months.',
  });

  const cases: ReadonlyArray<[string, string]> = [
    ['critical', 'critical'], ['high', 'high'], ['medium', 'medium'], ['low', 'low'],
    // `info` has no counterpart among the four priorities: the least urgent thing worth doing.
    ['info', 'low'],
  ];

  for (const [severity, expected] of cases) {
    it(`a ${severity} alert becomes a ${expected} action`, async () => {
      const alert = await alertOf(severity, severity);
      const created = await rpc(owner(), 'create_action_from_alert', { p_alert: alert, p_input: {} });
      expect(created.error, JSON.stringify(created.error)).toBeNull();
      expect((await actionRow(created.data as string)).priority).toBe(expected);
    });
  }

  it('ignores a priority the caller supplies rather than letting it contradict the rule', async () => {
    const alert = await alertOf('critical', 'override');
    const created = await rpc(owner(), 'create_action_from_alert', {
      p_alert: alert, p_input: { priority: 'low' },
    });
    expect(created.error).toBeNull();
    expect(
      (await actionRow(created.data as string)).priority,
      'the rule said critical; a caller saying low does not make it low',
    ).toBe('critical');
  });

  it('records the derivation on the audit row, so “why is this critical?” is answerable', async () => {
    const alert = await alertOf('critical', 'audit');
    const created = await rpc(owner(), 'create_action_from_alert', { p_alert: alert, p_input: {} });
    expect(created.error).toBeNull();

    const events = (await auditEvents(orgId, 'alert.converted_to_action')).filter((e) => e.target_id === alert);
    const after = events[events.length - 1]!.after as Record<string, unknown>;
    expect(after.severity).toBe('critical');
    expect(after.priority).toBe('critical');
  });

  it('a later change of mind is still possible, and goes through the permission', async () => {
    const alert = await alertOf('low', 'change');
    const created = await rpc(owner(), 'create_action_from_alert', { p_alert: alert, p_input: {} });
    const actionId = created.data as string;
    expect((await actionRow(actionId)).priority).toBe('low');

    // Deterministic at creation; changeable afterwards by somebody who may (RBAC_MATRIX §2.1).
    const patched = await rpc(owner(), 'update_action', { p_action: actionId, p_patch: { priority: 'high' } });
    expect(patched.error, JSON.stringify(patched.error)).toBeNull();
    expect((await actionRow(actionId)).priority).toBe('high');
  });
});

describe('an AI recommendation becomes an action only when it was grounded (ADR-032.5)', () => {
  let conversationId: string | null = null;

  async function message(status: string): Promise<string> {
    const now = nowIso();
    if (!conversationId) {
      conversationId = newId();
      await orgRow(fs(), orgId, 'ai_conversations', conversationId).set({
        id: conversationId, organization_id: orgId, user_id: ownerId, title: null, status: 'active',
        last_message_at: null, created_at: now, updated_at: now,
      });
    }
    const id = newId();
    await orgRow(fs(), orgId, 'ai_messages', id).set({
      id, organization_id: orgId, conversation_id: conversationId, role: 'assistant', content: null,
      structured_response: {
        recommended_actions: [{
          title: { statement: 'Renegotiate the marketing contract' },
          issue: { statement: 'Marketing spend rose while revenue did not' },
          recommendation: { statement: 'Ask for a lower monthly rate' },
          priority: 'high',
        }],
      },
      prompt_version: null, model: null, input_tokens: null, output_tokens: null, latency_ms: null,
      grounding_status: status, grounding_report: null, evidence_bundle_id: null, period_context: {},
      flagged: false, created_at: now,
    });
    return id;
  }

  it('creates it from a passed answer, copying the three statements verbatim', async () => {
    const { data, error } = await rpc(owner(), 'create_action_from_recommendation', {
      p_message: await message('passed'), p_index: 0, p_input: {},
    });
    expect(error).toBeNull();
    const a = await actionRow(data as unknown as string);
    expect([a.title, a.issue, a.recommendation, a.priority, a.source_type].join('|'))
      .toBe('Renegotiate the marketing contract|Marketing spend rose while revenue did not'
        + '|Ask for a lower monthly rate|high|ai');
  });

  /*
   * A degraded answer has had its unverifiable sentences REMOVED (§7.8); a failed one was never
   * shown as fact. Turning either into a task would launder it into something that looks
   * authoritative precisely because it now has an owner and a due date.
   */
  it('refuses a degraded answer', async () => {
    expect(sqlstate((await rpc(owner(), 'create_action_from_recommendation', {
      p_message: await message('degraded'), p_index: 0, p_input: {},
    })).error)).toBe('22023');
  });

  it('refuses a failed answer', async () => {
    expect(sqlstate((await rpc(owner(), 'create_action_from_recommendation', {
      p_message: await message('failed'), p_index: 0, p_input: {},
    })).error)).toBe('22023');
  });

  it('refuses a recommendation index the answer does not have', async () => {
    expect(sqlstate((await rpc(owner(), 'create_action_from_recommendation', {
      p_message: await message('passed'), p_index: 7, p_input: {},
    })).error)).toBe('P0002');
  });

  it('and the same gate holds on the general create path', async () => {
    expect(sqlstate((await rpc(owner(), 'create_action', {
      p_org: orgId,
      p_input: { title: 'Laundered' },
      p_source: { type: 'ai', id: await message('degraded') },
    })).error)).toBe('22023');
  });
});
