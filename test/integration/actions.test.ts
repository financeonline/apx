import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { getActionsSummary, listActions, ownerLabel } from '@/modules/actions';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, sqlstate } from './setup';

/**
 * The Action Centre against the database (SOW §17; IMPLEMENTATION_PLAN.md Phase 12).
 *
 * An action is the one object a person is accountable for, so the boundaries worth testing are the
 * ones about WHO may move WHAT. A client may move their own action along and record what came of
 * it, and nothing else — not somebody else's action, and not the title, priority or due date of
 * their own. Those are the terms of the assignment, and letting the assignee rewrite them makes the
 * assignment meaningless.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `a${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.actions.itest`;

let ownerId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let otherOrgId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const owner = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });
const clientUser = () => clientFor(clientId, { email: `client@${DOMAIN}` });

const rpc = (db: ReturnType<typeof clientFor>, fn: string, args: Record<string, unknown>) =>
  db.schema('api').rpc(fn, args);

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
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientId = createAuthUser(`client@${DOMAIN}`);
  strangerId = createAuthUser(`stranger@${DOMAIN}`);

  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: `ITest Actions ${RUN}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  const other = await clientFor(strangerId).schema('api').rpc('create_organization', {
    p_name: `ITest Actions Other ${RUN}`,
  });
  otherOrgId = other.data as unknown as string;

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgId}', '${clientId}', 'client', 'active')`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Actions%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Actions %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.actions.itest' and created_at < now() - interval '1 hour';`);
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

const columnsOf = (actionId: string): string => one(`
  select title || '|' || priority::text || '|' || coalesce(due_date::text, '-')
         || '|' || status::text || '|' || coalesce(outcome_notes, '-')
    from public.actions where id = '${actionId}'`);

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

    expect(columnsOf(actionId))
      .toBe('Chase the overdue invoices|critical|2026-05-31|completed|Collected in full');
    expect(one(`select completed_at is not null from public.actions where id = '${actionId}'`))
      .toBe('t');
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
    expect(columnsOf(actionId))
      .toBe('Chase the overdue invoices|high|2026-04-30|in_progress|Rang them on Tuesday');
  });

  /*
   * The plan's verification for this slice, and the reason `update_own_action` exists separately:
   * the assignee may say what happened, not rewrite what they were asked to do.
   */
  it('cannot change the title, the priority or the due date of their own action', async () => {
    const actionId = await newAction();
    await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: clientId });
    const before = columnsOf(actionId);

    const { error } = await rpc(clientUser(), 'update_own_action', {
      p_action: actionId,
      p_patch: { title: 'Something else entirely', priority: 'low', due_date: '2027-01-01' },
    });
    expect(error, 'the call is accepted; the columns simply do not move').toBeNull();
    expect(columnsOf(actionId)).toBe(before);
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
 * to every test that only calls the `api.*` functions: the writes were green while the list threw
 * on an ambiguous embed.
 */
describe('the list a person actually sees', () => {
  it('reads for an owner and for a client alike', async () => {
    const actionId = await newAction({ title: `Named owner ${RUN}` });
    await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: clientId });
    adminSql(`update public.profiles set full_name = 'Dana Client' where id = '${clientId}'`);

    for (const [role, ctx] of [['owner', ownerCtx()], ['client', clientCtx()]] as const) {
      const found = (await listActions(ctx)).find((a) => a.id === actionId);
      expect(found, `${role} must see the action`).toBeDefined();
    }
  });

  /*
   * Who a reader is told owns an action.
   *
   * `profiles` is own-row-only under RLS, so a name comes from `api.org_members`, which needs
   * `users.view` — an owner has it, a client does not. A client who could read colleagues' names
   * off an action list would have been handed the team page sideways, so they see "you" against
   * their own work and "someone here" against everybody else's, which is all the list needs.
   */
  it('names a colleague to an owner, and never to a client', async () => {
    const actionId = await newAction({ title: `Named owner two ${RUN}` });
    await rpc(owner(), 'assign_action', { p_action: actionId, p_owner: clientId });
    adminSql(`update public.profiles set full_name = 'Dana Client' where id = '${clientId}'`);

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
    const foreign = await clientFor(strangerId, { email: `stranger@${DOMAIN}` })
      .schema('api').rpc('create_action', {
        p_org: otherOrgId, p_input: { title: 'Theirs' }, p_source: { type: 'user' },
      });
    const foreignId = foreign.data as unknown as string;

    expect(sqlstate((await rpc(owner(), 'set_action_status', {
      p_action: foreignId, p_status: 'completed',
    })).error)).toBe('P0002');

    const { data } = await owner().from('actions').select('id').eq('id', foreignId);
    expect(data ?? [], 'and it is not readable either').toHaveLength(0);
  });
});

describe('an action created from an alert keeps what the alert said (§5, ADR-034)', () => {
  let alertId: string;
  let bundleId: string;

  beforeAll(() => {
    const runId = one(`
      insert into public.calculation_runs
             (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
      select '${orgId}', 'recalc_manual', '1.0.0', p.id, p.id, '2026-06-15', 'succeeded'
        from public.fiscal_periods p
       where p.organization_id = '${orgId}' and p.period_start = '2026-05-01'
      returning id`);

    alertId = one(`
      insert into public.alerts
             (organization_id, period_id, rule_key, rule_version, severity, key_kind,
              calculation_run_id, title, explanation, status, recommended_next_step,
              first_seen_at, dedupe_key)
      select '${orgId}', p.id, 'concentration.customer', '1', 'high', 'state', '${runId}',
             'One customer is 41% of revenue',
             'Acme Trading Ltd is 41% of revenue this month.', 'open',
             'Talk to your second-biggest customer about more work', now(), 'itest-${RUN}'
        from public.fiscal_periods p
       where p.organization_id = '${orgId}' and p.period_start = '2026-05-01'
      returning id`);

    bundleId = one(`
      insert into public.evidence_bundles
             (organization_id, kind, origin_table, origin_id, calculation_run_id, created_by_type)
      values ('${orgId}', 'alert', 'alerts', '${alertId}', '${runId}', 'system')
      returning id`);

    adminSql(`
      insert into public.evidence_items
             (organization_id, bundle_id, sort_order, item_type, ref_id, label, assurance_level)
      values ('${orgId}', '${bundleId}', 0, 'calculation_run', '${runId}',
              'Calculated 15 Jun 2026, engine 1.0.0', 'verified')`);

    const revisionId = one(`
      insert into public.alert_revisions
             (organization_id, alert_id, revision_no, rule_version, severity, explanation,
              calculation_run_id, evidence_bundle_id)
      values ('${orgId}', '${alertId}', 1, '1', 'high',
              'Acme Trading Ltd is 41% of revenue this month.', '${runId}', '${bundleId}')
      returning id`);
    adminSql(`
      update public.alerts set current_revision_id = '${revisionId}' where id = '${alertId}'`);
  });

  it('copies the revision’s text and the alert’s next step', async () => {
    const { data, error } = await rpc(owner(), 'create_action_from_alert', {
      p_alert: alertId, p_input: { priority: 'high' },
    });
    expect(error).toBeNull();
    const actionId = data as unknown as string;

    expect(one(`
      select title || '|' || issue || '|' || recommendation || '|' || source_type::text
        from public.actions where id = '${actionId}'`))
      .toBe('One customer is 41% of revenue|Acme Trading Ltd is 41% of revenue this month.'
        + '|Talk to your second-biggest customer about more work|alert');

    // The alert points back, so the list shows "converted" rather than offering the button twice.
    expect(one(`select action_id::text from public.alerts where id = '${alertId}'`)).toBe(actionId);
  });

  /*
   * The evidence is COPIED, not referenced. An alert is re-evaluated whenever the figures change,
   * and an action created in March that silently started showing June's numbers would make "why did
   * we do this?" unanswerable — which is the question an action list exists to answer.
   */
  it('clones the evidence rather than pointing at the alert’s own bundle', async () => {
    const { data } = await rpc(owner(), 'create_action_from_alert', { p_alert: alertId, p_input: {} });
    const actionId = data as unknown as string;

    const cloned = one(`
      select evidence_bundle_id::text from public.actions where id = '${actionId}'`);
    expect(cloned).not.toBe(bundleId);

    expect(one(`
      select kind::text || '|' || origin_table || '|' || origin_id::text
        from public.evidence_bundles where id = '${cloned}'`))
      .toBe(`action|actions|${actionId}`);

    expect(one(`
      select string_agg(item_type::text || ':' || label, ',' order by sort_order)
        from public.evidence_items where bundle_id = '${cloned}'`))
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
  const seedAlert = (severity: string, key: string): string => {
    const runId = one(`
      insert into public.calculation_runs
             (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
      select '${orgId}', 'recalc_manual', '1.0.0', p.id, p.id, '2026-06-15', 'succeeded'
        from public.fiscal_periods p
       where p.organization_id = '${orgId}' and p.period_start = '2026-05-01'
      returning id`);
    return one(`
      insert into public.alerts
             (organization_id, period_id, rule_key, rule_version, severity, key_kind,
              calculation_run_id, title, explanation, status, first_seen_at, dedupe_key)
      select '${orgId}', p.id, 'cash.runway_low', '1', '${severity}', 'state', '${runId}',
             'Runway is short', 'Cash would last under two months.', 'open', now(),
             'itest-prio-${RUN}-${key}'
        from public.fiscal_periods p
       where p.organization_id = '${orgId}' and p.period_start = '2026-05-01'
      returning id`);
  };

  const cases: ReadonlyArray<[string, string]> = [
    ['critical', 'critical'], ['high', 'high'], ['medium', 'medium'], ['low', 'low'],
    // `info` has no counterpart among the four priorities: the least urgent thing worth doing.
    ['info', 'low'],
  ];

  for (const [severity, expected] of cases) {
    it(`a ${severity} alert becomes a ${expected} action`, async () => {
      const alert = seedAlert(severity, severity);
      const created = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
        .schema('api').rpc('create_action_from_alert', { p_alert: alert, p_input: {} });
      expect(created.error, JSON.stringify(created.error)).toBeNull();

      expect(one(`select priority from public.actions where id = '${created.data as string}'`))
        .toBe(expected);
    });
  }

  it('ignores a priority the caller supplies rather than letting it contradict the rule', async () => {
    const alert = seedAlert('critical', 'override');
    const created = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
      .schema('api').rpc('create_action_from_alert', {
        p_alert: alert, p_input: { priority: 'low' },
      });
    expect(created.error).toBeNull();

    expect(
      one(`select priority from public.actions where id = '${created.data as string}'`),
      'the rule said critical; a caller saying low does not make it low',
    ).toBe('critical');
  });

  it('records the derivation on the audit row, so “why is this critical?” is answerable', async () => {
    const alert = seedAlert('critical', 'audit');
    const created = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
      .schema('api').rpc('create_action_from_alert', { p_alert: alert, p_input: {} });
    expect(created.error).toBeNull();

    const after = one(`
      select after::text from public.audit_events
       where organization_id = '${orgId}' and action = 'alert.converted_to_action'
         and target_id = '${alert}' order by id desc limit 1`);
    expect(after).toMatch(/"severity": ?"critical"/);
    expect(after).toMatch(/"priority": ?"critical"/);
  });

  it('a later change of mind is still possible, and goes through the permission', async () => {
    const alert = seedAlert('low', 'change');
    const created = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
      .schema('api').rpc('create_action_from_alert', { p_alert: alert, p_input: {} });
    const actionId = created.data as string;
    expect(one(`select priority from public.actions where id = '${actionId}'`)).toBe('low');

    // Deterministic at creation; changeable afterwards by somebody who may (RBAC_MATRIX §2.1).
    const patched = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
      .schema('api').rpc('update_action', { p_action: actionId, p_patch: { priority: 'high' } });
    expect(patched.error, JSON.stringify(patched.error)).toBeNull();
    expect(one(`select priority from public.actions where id = '${actionId}'`)).toBe('high');
  });
});

describe('an AI recommendation becomes an action only when it was grounded (ADR-032.5)', () => {
  const conversation = () => one(`
    select id::text from public.ai_conversations
     where organization_id = '${orgId}' and user_id = '${ownerId}' limit 1`);

  function message(status: string): string {
    adminSql(`
      insert into public.ai_conversations (organization_id, user_id)
      select '${orgId}', '${ownerId}'
       where not exists (select 1 from public.ai_conversations
                          where organization_id = '${orgId}' and user_id = '${ownerId}')`);
    return one(`
      insert into public.ai_messages
             (organization_id, conversation_id, role, structured_response, grounding_status)
      values ('${orgId}', '${conversation()}', 'assistant',
              '{"recommended_actions":[{"title":{"statement":"Renegotiate the marketing contract"},
                 "issue":{"statement":"Marketing spend rose while revenue did not"},
                 "recommendation":{"statement":"Ask for a lower monthly rate"},
                 "priority":"high"}]}'::jsonb,
              '${status}')
      returning id`);
  }

  it('creates it from a passed answer, copying the three statements verbatim', async () => {
    const { data, error } = await rpc(owner(), 'create_action_from_recommendation', {
      p_message: message('passed'), p_index: 0, p_input: {},
    });
    expect(error).toBeNull();
    const actionId = data as unknown as string;

    expect(one(`
      select title || '|' || issue || '|' || recommendation || '|' || priority::text
             || '|' || source_type::text
        from public.actions where id = '${actionId}'`))
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
      p_message: message('degraded'), p_index: 0, p_input: {},
    })).error)).toBe('22023');
  });

  it('refuses a failed answer', async () => {
    expect(sqlstate((await rpc(owner(), 'create_action_from_recommendation', {
      p_message: message('failed'), p_index: 0, p_input: {},
    })).error)).toBe('22023');
  });

  it('refuses a recommendation index the answer does not have', async () => {
    expect(sqlstate((await rpc(owner(), 'create_action_from_recommendation', {
      p_message: message('passed'), p_index: 7, p_input: {},
    })).error)).toBe('P0002');
  });

  it('and the same gate holds on the general create path', async () => {
    expect(sqlstate((await rpc(owner(), 'create_action', {
      p_org: orgId,
      p_input: { title: 'Laundered' },
      p_source: { type: 'ai', id: message('degraded') },
    })).error)).toBe('22023');
  });
});
