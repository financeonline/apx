import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensurePeriods, periodId } from '@/db/app/shared';
import { auth } from '@/db/firestore';
import { orgRows } from '@/db/rls';
import { newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import {
  clientFor, createAuthUser, deleteOrg, fs, rpc, serviceClientScoped, sqlstate,
} from './setup';
import { addMember, assignEmployee, auditEvents, createOrgFixture, deletePlatformUser } from './r-fixtures';

/**
 * The alert engine's write surface (FINANCIAL_ENGINE.md §8.1/§8.3; ADR-018, ADR-034, ADR-036,
 * ADR-047.2), on the Firestore emulator.
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
const DOMAIN = `${RUN}.alerts.itest.motion`;

let ownerId: string;
let clientUserId: string;
let assignedEmployeeId: string;
let strangerEmployeeId: string;
let strangerId: string;
let orgId: string;
let periodMar: string;

/** A calculation run as the engine leaves one; `persist_alerts` refuses a run that does not exist. */
async function startRun(): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'calculation_runs', id).set({
    id, organization_id: orgId, job_id: null, trigger: 'recalc_manual', trigger_ref_id: null,
    engine_version: '1.0.0', period_from: periodMar, period_to: periodMar, as_of: '2026-06-15', as_of_ts: now,
    status: 'running', failure_reason: null, stale: false, input_fingerprint: null, chunks: [],
    progress: {}, started_at: now, finished_at: null, duration_ms: null, error: null, stats: {},
    created_at: now, updated_at: now,
  });
  return id;
}

async function persist(runId: string, changes: unknown[]): Promise<Record<string, number>> {
  const { data, error } = await rpc<Record<string, number>>(serviceClientScoped(orgId), 'persist_alerts', {
    p_org: orgId, p_run: runId, p_changes: changes,
  }, { server: true });
  if (error) throw error;
  return data!;
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

const alerts = async () => (await orgCollection(fs(), orgId, 'alerts').get()).docs.map((d) => d.data());
const revisions = async (alertId?: string) => {
  let q: FirebaseFirestore.Query = orgCollection(fs(), orgId, 'alert_revisions');
  if (alertId) q = q.where('alert_id', '==', alertId);
  return (await q.get()).docs.map((d) => d.data()).sort((a, b) => a.revision_no - b.revision_no);
};
const alertDoc = async (id: string) => (await orgRow(fs(), orgId, 'alerts', id).get()).data()!;

async function alertId(): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'alerts').where('dedupe_key', '==', DEDUPE).get();
  return snap.docs[0]!.id;
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientUserId = await createAuthUser(`client@${DOMAIN}`);
  assignedEmployeeId = await createAuthUser(`assigned@${DOMAIN}`);
  strangerEmployeeId = await createAuthUser(`unassigned@${DOMAIN}`);
  strangerId = await createAuthUser(`stranger@${DOMAIN}`);

  orgId = (await createOrgFixture({ name: `ITest Alerts ${RUN}`, ownerId })).id;
  await addMember(orgId, clientUserId, 'client');

  // A platform employee ASSIGNED to this organisation, and one who is not (RBAC §3.5: a platform
  // user is never also a member, so both reach the organisation only through an assignment).
  await assignEmployee(orgId, assignedEmployeeId);
  await fs().collection('platform_users').doc(strangerEmployeeId).set({
    user_id: strangerEmployeeId, platform_role: 'employee', status: 'active', granted_by: null, notes: null,
    created_at: nowIso(), updated_at: nowIso(),
  });

  await ensurePeriods(fs(), orgId, '2026-03-01', '2026-03-01');
  periodMar = periodId(orgId, '2026-03-01');
});

afterAll(async () => {
  await deleteOrg(orgId);
  for (const uid of [ownerId, clientUserId, assignedEmployeeId, strangerEmployeeId, strangerId]) {
    await deletePlatformUser(uid);
    await fs().collection('profiles').doc(uid).delete();
    await auth().deleteUser(uid).catch(() => undefined);
  }
  const events = await fs().collection('audit_events').where('organization_id', '==', orgId).get();
  for (const d of events.docs) await d.ref.delete();
});

/** Each test starts from no alerts: the organisation's alert-side collections and guards are cleared. */
beforeEach(async () => {
  for (const table of ['alert_revisions', 'alerts', 'evidence_items', 'evidence_bundles', 'calculation_runs'] as const) {
    await fs().recursiveDelete(orgCollection(fs(), orgId, table));
  }
  const guards = await fs().collection('organizations').doc(orgId).collection('_unique').get();
  for (const g of guards.docs) {
    if (g.id.startsWith('alert_dedupe__') || g.id.startsWith('alert_revisions_no_unique__')) await g.ref.delete();
  }
  const events = await fs().collection('audit_events').where('organization_id', '==', orgId).get();
  for (const d of events.docs) await d.ref.delete();
});

describe('an alert arrives complete', () => {
  it('writes the row, a first revision and a non-empty evidence bundle', async () => {
    const run = await startRun();
    expect(await persist(run, [insertChange()])).toMatchObject({ inserted: 1 });

    const [a] = await alerts();
    expect(`${a!.title}|${a!.status}|${a!.severity}|${a!.key_kind}`)
      .toBe('Acme Ltd is a large share of revenue|open|medium|state');

    expect((await revisions()).map((r) => r.revision_no)).toEqual([1]);

    // §8: every fired alert has a bundle with at least one item.
    const bundles = (await orgCollection(fs(), orgId, 'evidence_bundles').where('kind', '==', 'alert').get()).docs;
    expect(bundles).toHaveLength(1);
    const items = await orgCollection(fs(), orgId, 'evidence_items').where('bundle_id', '==', bundles[0]!.id).get();
    expect(items.size).toBe(1);
    expect(items.docs[0]!.get('descriptor_hash'), 'bytea is lowercase hex').toBe('a'.repeat(64));

    // The alert's bundle is reached through its current revision — there is no second pointer.
    const current = (await orgRow(fs(), orgId, 'alert_revisions', a!.current_revision_id).get()).data()!;
    expect(current.evidence_bundle_id).not.toBeNull();
  });

  it('audits the creation and the run', async () => {
    const run = await startRun();
    await persist(run, [insertChange()]);
    const actions = new Set((await auditEvents(orgId)).map((e) => e.action));
    expect(actions).toContain('alert.created');
    expect(actions).toContain('alerts.evaluated');
  });
});

describe('re-running on unchanged data (dedupe)', () => {
  it('touches, and writes neither a second alert nor a revision', async () => {
    const first = await startRun();
    await persist(first, [insertChange()]);
    const id = await alertId();

    const second = await startRun();
    expect(await persist(second, [{ kind: 'touch', alert_id: id, period_id: periodMar }]))
      .toMatchObject({ touched: 1, inserted: 0, revised: 0 });

    expect(await alerts()).toHaveLength(1);
    expect(await revisions()).toHaveLength(1);
    expect(await auditEvents(orgId, 'alert.reevaluated')).toHaveLength(0);
  });

  it('refuses to duplicate a row even when handed the same insert twice (ADR-018)', async () => {
    const run = await startRun();
    await persist(run, [insertChange()]);
    expect(await persist(run, [insertChange()])).toMatchObject({ inserted: 0 });
    expect(await alerts()).toHaveLength(1);
  });

  it('preserves an acknowledgement across an unchanged re-run', async () => {
    const first = await startRun();
    await persist(first, [insertChange()]);
    const id = await alertId();
    await orgRow(fs(), orgId, 'alerts', id).update({ status: 'acknowledged' });

    const second = await startRun();
    await persist(second, [{ kind: 'touch', alert_id: id, period_id: periodMar }]);
    expect((await alertDoc(id)).status).toBe('acknowledged');
  });
});

describe('revisions (F-C-16)', () => {
  it('writes a new revision, repoints the alert and keeps the old text readable', async () => {
    const first = await startRun();
    await persist(first, [insertChange()]);
    const id = await alertId();

    const second = await startRun();
    await persist(second, [{
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

    const revs = await revisions(id);
    expect(revs.map((r) => `${r.revision_no}:${r.severity}`).join(',')).toBe('1:medium,2:high');

    // The alert now says the new thing, and points at the new revision.
    const a = await alertDoc(id);
    const current = revs.find((r) => r.id === a.current_revision_id)!;
    expect(`${a.severity}|${current.revision_no}`).toBe('high|2');

    // The old revision still resolves to what it said, with its own bundle (ADR-034).
    expect(revs[0]!.explanation).toBe('Acme Ltd makes up 55.0% of revenue this period.');
    expect(new Set(revs.map((r) => r.evidence_bundle_id)).size).toBe(2);

    expect(await auditEvents(orgId, 'alert.reevaluated')).toHaveLength(1);
  });

  it('a severity increase re-opens an acknowledged alert', async () => {
    const first = await startRun();
    await persist(first, [insertChange()]);
    const id = await alertId();
    await orgRow(fs(), orgId, 'alerts', id).update({ status: 'acknowledged' });

    const second = await startRun();
    await persist(second, [{
      kind: 'revision', alert_id: id, rule_version: 'alerts.rules.v1', severity: 'high',
      period_id: periodMar, title: 't', explanation: 'e', recommended_next_step: 'n',
      threshold_summary: {}, status: 'open', status_reason_code: 'severity_increased',
      reopened: false, evidence: [],
    }]);

    const a = await alertDoc(id);
    expect(`${a.status}|${a.status_reason_code}`).toBe('open|severity_increased');
    // The engine changed it, so no user is recorded as having done so.
    expect(a.status_changed_by).toBeNull();
  });

  it('a re-open keeps first_seen_at and stamps reopened_at (R2-B-02)', async () => {
    const first = await startRun();
    await persist(first, [insertChange()]);
    const id = await alertId();
    const firstSeen = (await alertDoc(id)).first_seen_at;
    await orgRow(fs(), orgId, 'alerts', id).update({ status: 'resolved', status_reason_code: 'condition_cleared' });

    const second = await startRun();
    await persist(second, [{
      kind: 'revision', alert_id: id, rule_version: 'alerts.rules.v1', severity: 'medium',
      period_id: periodMar, title: 't', explanation: 'e', recommended_next_step: 'n',
      threshold_summary: {}, status: 'open', status_reason_code: 'condition_returned',
      reopened: true, evidence: [],
    }]);

    const a = await alertDoc(id);
    expect(`${a.status}|${a.status_reason_code}`).toBe('open|condition_returned');
    expect(a.first_seen_at).toBe(firstSeen);
    expect(a.reopened_at).not.toBeNull();
  });
});

describe('auto-resolve', () => {
  it('resolves an open alert whose condition cleared, and audits it', async () => {
    const first = await startRun();
    await persist(first, [insertChange()]);
    const id = await alertId();

    const second = await startRun();
    expect(await persist(second, [{
      kind: 'resolve', alert_id: id, status_reason_code: 'condition_cleared',
    }])).toMatchObject({ resolved: 1 });

    const a = await alertDoc(id);
    expect(`${a.status}|${a.status_reason_code}`).toBe('resolved|condition_cleared');
    expect((await auditEvents(orgId, 'alert.status_changed')).some((e) => e.target_id === id)).toBe(true);
  });

  it('leaves a dismissed alert dismissed', async () => {
    const first = await startRun();
    await persist(first, [insertChange()]);
    const id = await alertId();
    await orgRow(fs(), orgId, 'alerts', id).update({ status: 'dismissed', dismissed_at: nowIso() });

    const second = await startRun();
    expect(await persist(second, [{
      kind: 'resolve', alert_id: id, status_reason_code: 'condition_cleared',
    }])).toMatchObject({ resolved: 0 });
    expect((await alertDoc(id)).status).toBe('dismissed');
  });
});

/*
 * The revision history and evidence bundles are immutable (ADR-046.1). On PostgreSQL a trigger
 * refused an UPDATE or DELETE issued by anyone; on Firestore there is no writer to refuse — no
 * `api.*` or `api_server.*` function updates or deletes a revision, a bundle or an item, and the
 * browser cannot reach Firestore at all (firebase/firestore.rules). The trigger tests are dropped
 * as assertions about PostgreSQL; the revision tests above show history is appended, never rewritten.
 */

describe('the surface is unreachable from a browser (ADR-043)', () => {
  it('api_server.persist_alerts cannot be executed with a user handle', async () => {
    const run = await startRun();
    const { error } = await rpc(clientFor(ownerId), 'persist_alerts', {
      p_org: orgId, p_run: run, p_changes: [],
    }, { server: true });
    expect(sqlstate(error)).toBe('42501');
  });

  it('nor by the server scoped to another organisation (ADR-090)', async () => {
    const run = await startRun();
    const { error } = await rpc(serviceClientScoped(newId()), 'persist_alerts', {
      p_org: orgId, p_run: run, p_changes: [insertChange()],
    }, { server: true });
    expect(sqlstate(error)).toBe('42501');
    expect(await alerts()).toHaveLength(0);
  });

  it('refuses a change kind it does not recognise, before writing anything', async () => {
    const run = await startRun();
    await expect(persist(run, [insertChange(), { kind: 'delete_everything' }])).rejects.toThrow(/unknown change kind/);
    expect(await alerts()).toHaveLength(0);
  });
});

describe('who may change an alert’s status (RBAC §2.1)', () => {
  it('a client may acknowledge and nothing else', async () => {
    const run = await startRun();
    await persist(run, [insertChange()]);
    const id = await alertId();

    const db = clientFor(clientUserId, { email: `client@${DOMAIN}` });
    const acknowledged = await rpc(db, 'set_alert_status', {
      p_alert: id, p_status: 'acknowledged', p_reason: null,
    });
    expect(acknowledged.error).toBeNull();
    expect((await alertDoc(id)).status).toBe('acknowledged');

    for (const status of ['resolved', 'dismissed'] as const) {
      const denied = await rpc(db, 'set_alert_status', { p_alert: id, p_status: status, p_reason: null });
      expect(sqlstate(denied.error), status).toBe('42501');
    }
    expect((await alertDoc(id)).status).toBe('acknowledged');
  });

  it('an owner may dismiss, and the cooldown clock starts', async () => {
    const run = await startRun();
    await persist(run, [insertChange()]);
    const id = await alertId();

    const { error } = await rpc(clientFor(ownerId), 'set_alert_status', {
      p_alert: id, p_status: 'dismissed', p_reason: 'known and accepted',
    });
    expect(error).toBeNull();
    const a = await alertDoc(id);
    expect(`${a.status}|${a.dismissed_at !== null}`).toBe('dismissed|true');
  });
});

describe('one tenant never sees another’s alerts', () => {
  it('reads its own and none of anyone else’s', async () => {
    const run = await startRun();
    await persist(run, [insertChange()]);

    expect(await orgRows(clientFor(ownerId), orgId, 'alerts')).toHaveLength(1);
    expect(await orgRows(clientFor(strangerId), orgId, 'alerts')).toHaveLength(0);
  });
});

/**
 * A platform employee reaches an organisation's alerts only through an assignment (Phase 7 brief;
 * RBAC_MATRIX.md §2.1, §3.5; SECURITY_MODEL.md §4; ADR-044.1).
 *
 * The alerts policy admits the organisations the caller can reach, and an employee's reachable set
 * IS their active assignments — so this holds by construction rather than by a rule written twice.
 * It is asserted here because "by construction" has been wrong before (ADR-082).
 */
describe('a platform employee sees only the organisations assigned to them', () => {
  beforeEach(async () => {
    const run = await startRun();
    await persist(run, [insertChange()]);
  });

  it('the assigned employee reads the organisation’s alerts and their revisions', async () => {
    const employee = clientFor(assignedEmployeeId, { email: `assigned@${DOMAIN}` });
    const rows = await orgRows(employee, orgId, 'alerts');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rule_key).toBe('concentration.customer');

    // The evidence behind it is reachable too, or the alert is a claim they cannot check.
    expect((await orgRows(employee, orgId, 'alert_revisions')).length).toBeGreaterThan(0);
  });

  it('an employee with no assignment to this organisation reads nothing', async () => {
    const stranger = clientFor(strangerEmployeeId, { email: `unassigned@${DOMAIN}` });
    expect(await orgRows(stranger, orgId, 'alerts')).toHaveLength(0);
    expect(await orgRows(stranger, orgId, 'alert_revisions')).toHaveLength(0);
  });

  it('the assigned employee may act on an alert; the unassigned one is refused', async () => {
    const id = await alertId();
    const employee = clientFor(assignedEmployeeId, { email: `assigned@${DOMAIN}` });
    const acted = await rpc(employee, 'set_alert_status', { p_alert: id, p_status: 'acknowledged', p_reason: null });
    expect(acted.error, JSON.stringify(acted.error)).toBeNull();

    const stranger = clientFor(strangerEmployeeId, { email: `unassigned@${DOMAIN}` });
    const refused = await rpc(stranger, 'set_alert_status', { p_alert: id, p_status: 'resolved', p_reason: null });
    // NOT_FOUND, never a denial: a stranger learns nothing about whether the alert exists (§14).
    expect(sqlstate(refused.error)).toBe('P0002');
  });

  it('the assignment is what grants it: revoking the assignment closes the door', async () => {
    const ref = orgRow(fs(), orgId, 'organization_assignments', assignedEmployeeId);
    await ref.update({ status: 'revoked' });
    const employee = clientFor(assignedEmployeeId, { email: `assigned@${DOMAIN}` });
    expect(await orgRows(employee, orgId, 'alerts')).toHaveLength(0);
    await ref.update({ status: 'active' });
  });
});
