import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminSql, clientFor, createAuthUser, serverSession, sqlstate } from './setup';

/**
 * The alert engine's SQL surface (FINANCIAL_ENGINE.md §8.1/§8.3; ADR-018, ADR-034, ADR-036,
 * ADR-047.2).
 *
 * What is under test is what a PERSON would notice if it were wrong:
 *   - an alert arrives with a title, an explanation, a next step and an evidence bundle with items;
 *   - re-running on unchanged data does not produce a second alert, a revision or an audit entry;
 *   - a re-evaluation that changes something writes a revision and keeps the old one readable;
 *   - a dismissal holds, and an acknowledgement survives an unchanged re-run;
 *   - the whole surface is unreachable from a browser, and a client may only acknowledge.
 *
 * Run-unique fixtures (ADR-052.12), so a concurrent suite cannot delete them mid-test.
 */

const RUN = `a${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.alerts.itest`;

let ownerId: string;
let clientUserId: string;
let assignedEmployeeId: string;
let strangerEmployeeId: string;
let orgId: string;
let periodMar: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function serverRpc(fn: string, args: Record<string, unknown>): string {
  const params = Object.entries(args)
    .map(([k, v]) => `${k} => ${v === null ? 'null'
      : typeof v === 'number' ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`}`)
    .join(', ');
  const output = adminSql(`
    ${serverSession(args.p_org as string | undefined)}
    select api_server.${fn}(${params})::text`);
  return output.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
}

/** The fingerprint column is `bytea`, so a fixture value has to be hexadecimal, not a label. */
function startRun(fingerprint: string): string {
  return (JSON.parse(serverRpc('start_calculation_run', {
    p_org: orgId, p_trigger: 'recalc_manual', p_trigger_ref: null,
    p_engine_version: '1.0.0', p_period_from: periodMar, p_period_to: periodMar,
    p_as_of: '2026-06-15', p_fingerprint: fingerprint, p_job: null, p_periods_total: 1,
  })) as { runId: string }).runId;
}

function persist(runId: string, changes: unknown[]): Record<string, number> {
  const output = adminSql(`
    ${serverSession(orgId)}
    select api_server.persist_alerts(
      '${orgId}', '${runId}',
      '${JSON.stringify(changes).replace(/'/g, "''")}'::jsonb)::text`);
  const last = output.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '{}';
  return JSON.parse(last) as Record<string, number>;
}

const DEDUPE = 'concentration.customer|state|counterparty|-';
const RUN_UUID = '00000000-0000-4000-8000-0000000000aa';

function insertChange(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'insert',
    dedupe_key: DEDUPE,
    rule_key: 'concentration.customer',
    rule_version: 'alerts.rules.v1',
    key_kind: 'state',
    severity: 'medium',
    period_id: periodMar,
    subject_type: 'none',
    subject_id: null,
    metric_key: 'customer_concentration_top1',
    title: 'Acme Ltd is a large share of revenue',
    explanation: 'Acme Ltd makes up 55.0% of revenue this period.',
    recommended_next_step: 'Reduce reliance on Acme Ltd: protect the account and grow the next tier.',
    threshold_summary: { share: '0.550000', band: 'high', customer: 'Acme Ltd' },
    evidence: [{
      item_type: 'query',
      ref_id: null,
      query_descriptor: {
        v: 1, table: 'invoices', filters: { period_ids: [periodMar] },
        as_of: { calculation_run_id: RUN_UUID, aggregated_at: '2026-04-01T00:00:00.000Z' },
        order: [{ field: 'id', dir: 'asc' }],
      },
      // `evidence_items_query_needs_hash`: a descriptor without its hash is a citation nobody can
      // verify, so the constraint refuses it (EVIDENCE_MODEL.md §3).
      descriptor_hash: 'a'.repeat(64),
      label: 'Invoices to Acme Ltd',
      claim: 'The sales behind that share',
      assurance_level: 'verified',
    }],
    ...overrides,
  };
}

function alertId(): string {
  return one(`select id::text from public.alerts
               where organization_id = '${orgId}' and dedupe_key = '${DEDUPE}'`);
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientUserId = createAuthUser(`client@${DOMAIN}`);
  assignedEmployeeId = createAuthUser(`assigned@${DOMAIN}`);
  strangerEmployeeId = createAuthUser(`unassigned@${DOMAIN}`);

  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: `ITest Alerts ${RUN}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status)
            values ('${orgId}', '${clientUserId}', 'client', 'active')`);

  // A platform employee ASSIGNED to this organisation, and one who is not (RBAC §3.5: a platform
  // user is never also a member, so both reach the organisation only through an assignment).
  adminSql(`
    insert into public.platform_users (user_id, platform_role, status) values
      ('${assignedEmployeeId}', 'employee', 'active'), ('${strangerEmployeeId}', 'employee', 'active');
    insert into public.organization_assignments (organization_id, employee_user_id, status)
    values ('${orgId}', '${assignedEmployeeId}', 'active');`);

  periodMar = one(`select id from public.fiscal_periods
                    where organization_id = '${orgId}' and period_start = '2026-03-01'`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Alerts%${RUN}';
    delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Alerts %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.alerts.itest' and created_at < now() - interval '1 hour';`);
});

beforeEach(() => {
  adminSql(`
    begin;
    set local app.purge = 'on';
    delete from public.alert_revisions where organization_id = '${orgId}';
    delete from public.alerts where organization_id = '${orgId}';
    delete from public.evidence_items where organization_id = '${orgId}';
    delete from public.evidence_bundles where organization_id = '${orgId}';
    delete from public.audit_events where organization_id = '${orgId}';
    delete from public.calculation_runs where organization_id = '${orgId}';
    commit;`);
});

describe('an alert arrives complete', () => {
  it('writes the row, a first revision and a non-empty evidence bundle', () => {
    const run = startRun('0001');
    expect(persist(run, [insertChange()])).toMatchObject({ inserted: 1 });

    const row = one(`select a.title || '|' || a.status || '|' || a.severity || '|' || a.key_kind
                       from public.alerts a where a.organization_id = '${orgId}'`);
    expect(row).toBe('Acme Ltd is a large share of revenue|open|medium|state');

    expect(one(`select revision_no::text from public.alert_revisions
                 where organization_id = '${orgId}'`)).toBe('1');

    // §8: every fired alert has a bundle with at least one item.
    expect(one(`select count(*)::text from public.evidence_items i
                  join public.evidence_bundles b
                    on b.organization_id = i.organization_id and b.id = i.bundle_id
                 where b.organization_id = '${orgId}' and b.kind = 'alert'`)).toBe('1');

    // The alert's bundle is reached through its current revision — there is no second pointer.
    expect(one(`select (r.evidence_bundle_id is not null)::text
                  from public.alerts a
                  join public.alert_revisions r
                    on r.organization_id = a.organization_id and r.id = a.current_revision_id
                 where a.organization_id = '${orgId}'`)).toBe('true');
  });

  it('audits the creation and the run', () => {
    const run = startRun('0002');
    persist(run, [insertChange()]);
    const actions = one(`select string_agg(distinct action, ',' order by action)
                           from public.audit_events where organization_id = '${orgId}'`);
    expect(actions).toContain('alert.created');
    expect(actions).toContain('alerts.evaluated');
  });
});

describe('re-running on unchanged data (dedupe)', () => {
  it('touches, and writes neither a second alert nor a revision', () => {
    const first = startRun('0003');
    persist(first, [insertChange()]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });
    const id = alertId();

    const second = startRun('0004');
    expect(persist(second, [{ kind: 'touch', alert_id: id, period_id: periodMar }]))
      .toMatchObject({ touched: 1, inserted: 0, revised: 0 });

    expect(one(`select count(*)::text from public.alerts where organization_id = '${orgId}'`)).toBe('1');
    expect(one(`select count(*)::text from public.alert_revisions where organization_id = '${orgId}'`)).toBe('1');
    expect(one(`select count(*)::text from public.audit_events
                 where organization_id = '${orgId}' and action = 'alert.reevaluated'`)).toBe('0');
  });

  it('refuses to duplicate a row even when handed the same insert twice (ADR-018)', () => {
    const run = startRun('0005');
    persist(run, [insertChange()]);
    persist(run, [insertChange()]);
    expect(one(`select count(*)::text from public.alerts where organization_id = '${orgId}'`)).toBe('1');
  });

  it('preserves an acknowledgement across an unchanged re-run', () => {
    const first = startRun('0006');
    persist(first, [insertChange()]);
    const id = alertId();
    adminSql(`update public.alerts set status = 'acknowledged'
               where organization_id = '${orgId}' and id = '${id}'`);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('0007');
    persist(second, [{ kind: 'touch', alert_id: id, period_id: periodMar }]);
    expect(one(`select status::text from public.alerts where id = '${id}'`)).toBe('acknowledged');
  });
});

describe('revisions (F-C-16)', () => {
  it('writes a new revision, repoints the alert and keeps the old text readable', () => {
    const first = startRun('0008');
    persist(first, [insertChange()]);
    const id = alertId();
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('0009');
    persist(second, [{
      kind: 'revision',
      alert_id: id,
      rule_version: 'alerts.rules.v1',
      severity: 'high',
      period_id: periodMar,
      title: 'Acme Ltd is a large share of revenue',
      explanation: 'Acme Ltd makes up 62.0% of revenue this period.',
      recommended_next_step: 'Reduce reliance on Acme Ltd.',
      threshold_summary: { share: '0.620000', band: 'high' },
      status: 'open',
      status_reason_code: 'severity_increased',
      reopened: false,
      evidence: [{
        item_type: 'query', ref_id: null,
        query_descriptor: {
          v: 1, table: 'invoices', filters: { period_ids: [periodMar] },
          as_of: { calculation_run_id: RUN_UUID, aggregated_at: '2026-04-01T00:00:00.000Z' },
        },
        descriptor_hash: 'b'.repeat(64),
        label: 'Invoices', claim: null, assurance_level: 'verified',
      }],
    }]);

    expect(one(`select string_agg(revision_no::text || ':' || severity::text, ',' order by revision_no)
                  from public.alert_revisions where alert_id = '${id}'`)).toBe('1:medium,2:high');

    // The alert now says the new thing, and points at the new revision.
    expect(one(`select a.severity::text || '|' || r.revision_no::text
                  from public.alerts a
                  join public.alert_revisions r
                    on r.organization_id = a.organization_id and r.id = a.current_revision_id
                 where a.id = '${id}'`)).toBe('high|2');

    // The old revision still resolves to what it said, with its own bundle (ADR-034).
    expect(one(`select explanation from public.alert_revisions
                 where alert_id = '${id}' and revision_no = 1`))
      .toBe('Acme Ltd makes up 55.0% of revenue this period.');
    expect(one(`select count(distinct evidence_bundle_id)::text
                  from public.alert_revisions where alert_id = '${id}'`)).toBe('2');

    expect(one(`select count(*)::text from public.audit_events
                 where organization_id = '${orgId}' and action = 'alert.reevaluated'`)).toBe('1');
  });

  it('a severity increase re-opens an acknowledged alert', () => {
    const first = startRun('000a');
    persist(first, [insertChange()]);
    const id = alertId();
    adminSql(`update public.alerts set status = 'acknowledged'
               where organization_id = '${orgId}' and id = '${id}'`);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('000b');
    persist(second, [{
      kind: 'revision', alert_id: id, rule_version: 'alerts.rules.v1', severity: 'high',
      period_id: periodMar, title: 't', explanation: 'e', recommended_next_step: 'n',
      threshold_summary: {}, status: 'open', status_reason_code: 'severity_increased',
      reopened: false, evidence: [],
    }]);

    expect(one(`select status::text || '|' || status_reason_code::text
                  from public.alerts where id = '${id}'`)).toBe('open|severity_increased');
    // The engine changed it, so no user is recorded as having done so.
    expect(one(`select (status_changed_by is null)::text from public.alerts where id = '${id}'`))
      .toBe('true');
  });

  it('a re-open keeps first_seen_at and stamps reopened_at (R2-B-02)', () => {
    const first = startRun('000c');
    persist(first, [insertChange()]);
    const id = alertId();
    const firstSeen = one(`select first_seen_at::text from public.alerts where id = '${id}'`);
    adminSql(`update public.alerts set status = 'resolved', status_reason_code = 'condition_cleared'
               where organization_id = '${orgId}' and id = '${id}'`);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('000d');
    persist(second, [{
      kind: 'revision', alert_id: id, rule_version: 'alerts.rules.v1', severity: 'medium',
      period_id: periodMar, title: 't', explanation: 'e', recommended_next_step: 'n',
      threshold_summary: {}, status: 'open', status_reason_code: 'condition_returned',
      reopened: true, evidence: [],
    }]);

    expect(one(`select status::text || '|' || status_reason_code::text
                  from public.alerts where id = '${id}'`)).toBe('open|condition_returned');
    expect(one(`select first_seen_at::text from public.alerts where id = '${id}'`)).toBe(firstSeen);
    expect(one(`select (reopened_at is not null)::text from public.alerts where id = '${id}'`))
      .toBe('true');
  });
});

describe('auto-resolve', () => {
  it('resolves an open alert whose condition cleared, and audits it', () => {
    const first = startRun('000e');
    persist(first, [insertChange()]);
    const id = alertId();
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('000f');
    expect(persist(second, [{
      kind: 'resolve', alert_id: id, status_reason_code: 'condition_cleared',
    }])).toMatchObject({ resolved: 1 });

    expect(one(`select status::text || '|' || status_reason_code::text
                  from public.alerts where id = '${id}'`)).toBe('resolved|condition_cleared');
  });

  it('leaves a dismissed alert dismissed', () => {
    const first = startRun('0010');
    persist(first, [insertChange()]);
    const id = alertId();
    adminSql(`update public.alerts set status = 'dismissed', dismissed_at = now()
               where organization_id = '${orgId}' and id = '${id}'`);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('0011');
    expect(persist(second, [{
      kind: 'resolve', alert_id: id, status_reason_code: 'condition_cleared',
    }])).toMatchObject({ resolved: 0 });
    expect(one(`select status::text from public.alerts where id = '${id}'`)).toBe('dismissed');
  });
});

describe('the revision history is immutable (ADR-046.1)', () => {
  it('refuses an update or a delete of a revision', () => {
    const run = startRun('0012');
    persist(run, [insertChange()]);
    expect(() => adminSql(`update public.alert_revisions set explanation = 'tampered'
                            where organization_id = '${orgId}'`)).toThrow(/IMMUTABLE/);
    expect(() => adminSql(`delete from public.alert_revisions
                            where organization_id = '${orgId}'`)).toThrow(/IMMUTABLE/);
  });

  it('refuses to tamper with an evidence bundle', () => {
    const run = startRun('0013');
    persist(run, [insertChange()]);
    expect(() => adminSql(`update public.evidence_items set label = 'tampered'
                            where organization_id = '${orgId}'`)).toThrow(/IMMUTABLE/);
  });
});

describe('the surface is unreachable from a browser (ADR-043)', () => {
  it('api_server.persist_alerts cannot be executed with a user JWT', async () => {
    const run = startRun('0014');
    const { error } = await clientFor(ownerId).schema('api_server').rpc('persist_alerts', {
      p_org: orgId, p_run: run, p_changes: [],
    });
    expect(error).not.toBeNull();
  });

  it('no authenticated user can write an alert directly', async () => {
    const db = clientFor(ownerId);
    for (const table of ['alerts', 'alert_revisions'] as const) {
      const { error } = await db.from(table).insert({ organization_id: orgId });
      expect(error, `${table}`).not.toBeNull();
      expect(sqlstate(error)).toBe('42501');
    }
  });

  it('refuses a change kind it does not recognise', () => {
    const run = startRun('0015');
    expect(() => persist(run, [{ kind: 'delete_everything' }])).toThrow(/unknown change kind/);
  });
});

describe('who may change an alert’s status (RBAC §2.1)', () => {
  it('a client may acknowledge and nothing else', async () => {
    const run = startRun('0016');
    persist(run, [insertChange()]);
    const id = alertId();

    const db = clientFor(clientUserId, { email: `client@${DOMAIN}` });
    const acknowledged = await db.schema('api').rpc('set_alert_status', {
      p_alert: id, p_status: 'acknowledged', p_reason: null,
    });
    expect(acknowledged.error).toBeNull();
    expect(one(`select status::text from public.alerts where id = '${id}'`)).toBe('acknowledged');

    for (const status of ['resolved', 'dismissed'] as const) {
      const denied = await db.schema('api').rpc('set_alert_status', {
        p_alert: id, p_status: status, p_reason: null,
      });
      expect(sqlstate(denied.error), status).toBe('42501');
    }
    expect(one(`select status::text from public.alerts where id = '${id}'`)).toBe('acknowledged');
  });

  it('an owner may dismiss, and the cooldown clock starts', async () => {
    const run = startRun('0017');
    persist(run, [insertChange()]);
    const id = alertId();

    const { error } = await clientFor(ownerId).schema('api').rpc('set_alert_status', {
      p_alert: id, p_status: 'dismissed', p_reason: 'known and accepted',
    });
    expect(error).toBeNull();
    expect(one(`select status::text || '|' || (dismissed_at is not null)::text
                  from public.alerts where id = '${id}'`)).toBe('dismissed|true');
  });
});

describe('one tenant never sees another’s alerts', () => {
  it('reads its own and none of anyone else’s', async () => {
    const run = startRun('0018');
    persist(run, [insertChange()]);

    const mine = await clientFor(ownerId).from('alerts').select('id').eq('organization_id', orgId);
    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);

    const stranger = createAuthUser(`stranger@${DOMAIN}`);
    const theirs = await clientFor(stranger).from('alerts').select('id').eq('organization_id', orgId);
    expect(theirs.data ?? []).toHaveLength(0);
  });
});

/**
 * A platform employee reaches an organisation's alerts only through an assignment (Phase 7 brief;
 * RBAC_MATRIX.md §2.1, §3.5; SECURITY_MODEL.md §4; ADR-044.1).
 *
 * The alerts policy is `organization_id in (select app.accessible_org_ids())`, and an employee's
 * accessible set IS their active assignments at aal2 — so this holds by construction rather than by
 * a rule written twice. It is asserted here because "by construction" has been wrong before: the
 * feedback queue's policies named owner/admin/super_admin and silently locked out the very employee
 * the matrix sends to review it (ADR-082). A financial alert is exactly the kind of row where that
 * mistake is expensive in both directions.
 */
describe('a platform employee sees only the organisations assigned to them', () => {
  beforeEach(() => {
    const run = startRun('e7');
    persist(run, [insertChange()]);
  });

  it('the assigned employee at aal2 reads the organisation’s alerts and their revisions', async () => {
    const employee = clientFor(assignedEmployeeId, { email: `assigned@${DOMAIN}`, aal: 'aal2' });
    const alerts = await employee.from('alerts').select('id, rule_key, severity').eq('organization_id', orgId);
    expect(alerts.error).toBeNull();
    expect(alerts.data).toHaveLength(1);
    expect((alerts.data as Array<{ rule_key: string }>)[0]!.rule_key).toBe('concentration.customer');

    // The evidence behind it is reachable too, or the alert is a claim they cannot check.
    const revisions = await employee.from('alert_revisions').select('id').eq('organization_id', orgId);
    expect(revisions.error).toBeNull();
    expect((revisions.data ?? []).length).toBeGreaterThan(0);
  });

  it('the same employee at aal1 reads nothing at all (ADR-044.1)', async () => {
    const employee = clientFor(assignedEmployeeId, { email: `assigned@${DOMAIN}`, aal: 'aal1' });
    const alerts = await employee.from('alerts').select('id').eq('organization_id', orgId);
    expect(alerts.error).toBeNull();
    expect(alerts.data ?? []).toHaveLength(0);
  });

  it('an employee with no assignment to this organisation reads nothing, even at aal2', async () => {
    const stranger = clientFor(strangerEmployeeId, { email: `unassigned@${DOMAIN}`, aal: 'aal2' });
    const alerts = await stranger.from('alerts').select('id').eq('organization_id', orgId);
    expect(alerts.error).toBeNull();
    expect(alerts.data ?? []).toHaveLength(0);
    const revisions = await stranger.from('alert_revisions').select('id').eq('organization_id', orgId);
    expect(revisions.data ?? []).toHaveLength(0);
  });

  it('the assigned employee may act on an alert; the unassigned one is refused', async () => {
    const id = alertId();
    const employee = clientFor(assignedEmployeeId, { email: `assigned@${DOMAIN}`, aal: 'aal2' });
    const acted = await employee.schema('api').rpc('set_alert_status', {
      p_alert: id, p_status: 'acknowledged', p_reason: null,
    });
    expect(acted.error, JSON.stringify(acted.error)).toBeNull();

    const stranger = clientFor(strangerEmployeeId, { email: `unassigned@${DOMAIN}`, aal: 'aal2' });
    const refused = await stranger.schema('api').rpc('set_alert_status', {
      p_alert: id, p_status: 'resolved', p_reason: null,
    });
    // NOT_FOUND, never a denial: a stranger learns nothing about whether the alert exists (§14).
    expect(sqlstate(refused.error)).toBe('P0002');
  });

  it('the assignment is what grants it: revoking the assignment closes the door', async () => {
    adminSql(`update public.organization_assignments set status = 'revoked'
               where organization_id = '${orgId}' and employee_user_id = '${assignedEmployeeId}'`);
    const employee = clientFor(assignedEmployeeId, { email: `assigned@${DOMAIN}`, aal: 'aal2' });
    const alerts = await employee.from('alerts').select('id').eq('organization_id', orgId);
    expect(alerts.data ?? []).toHaveLength(0);
    adminSql(`update public.organization_assignments set status = 'active'
               where organization_id = '${orgId}' and employee_user_id = '${assignedEmployeeId}'`);
  });
});
