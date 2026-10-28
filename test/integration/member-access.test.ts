import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isMotionError } from '@/core/errors';
import type { EffectiveRole } from '@/core/permissions';
import { auth } from '@/db/firestore';
import { orgRowById, orgRows } from '@/db/rls';
import { globalRow, orgRow, overrideId, type OrgTable } from '@/db/schema';
import { periodId } from '@/db/app/shared';
import type { Db } from '@/db/types';
import {
  changeMemberRole,
  decideAccessRequest,
  inviteMember,
  resetMemberPermissions,
  listAccessRequests,
  listMemberPermissions,
  organizationDoc,
  requestAccess,
  setMemberPermission,
  withdrawAccessRequest,
  parseOverrides,
  resolvePermissions,
  type AccessContext,
} from '@/modules/tenancy';
import { clientFor, createAuthUser, fs, rpc as callRpc, sqlstate } from './setup';
import { addMember, ctxFor as contextFor, dropOrg, rawCount, seedRow } from './tenancy-fixtures';

/**
 * ADR-172 against the data layer: the two new roles, the permission-based reads, the per-person
 * switches and "Request more information".
 *
 * This is the security suite for the change, so every "cannot" is asserted where the application
 * meets the data — a direct `api.*` call or a policy read (`src/db/rls.ts`) as the person — and the
 * services are driven on top for the flows the team page uses. Every "reads nothing" is checked
 * against a collection that holds a row.
 *
 * Run-unique fixtures (ADR-052.12): nothing here touches another suite's documents, and everything
 * is removed afterwards.
 */

const RUN = `m${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.access.itest.motion`;

type Who = 'owner' | 'owner2' | 'admin' | 'admin2' | 'accountant' | 'client' | 'client2' | 'third' | 'ownerB' | 'thirdB';
const ids = {} as Record<Who, string>;
let orgA: string;
let orgB: string;
let slugA: string;

const email = (who: Who) => `${who}@${DOMAIN}`;
const db = (who: Who): Db => clientFor(ids[who], { email: email(who) });
const rpc = (who: Who, fn: string, args: Record<string, unknown>) => callRpc(db(who), fn, args);

/** The context a page hands a service, built from the same api.my_access the resolver calls. */
const ctxFor = (who: Who, org = orgA): Promise<AccessContext> =>
  contextFor(ids[who], org, { email: email(who), requestId: `itest-${RUN}` });

/** The MotionError code a service threw, or 'ok'. */
async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return isMotionError(error) ? error.code : `thrown: ${String(error)}`;
  }
}

/** What the person reads of an organisation table, through the read policies. */
async function rows(who: Who, table: OrgTable, org = orgA): Promise<number> {
  return (await orgRows(db(who), org, table)).length;
}

/** Whether the person may read the organisation's audit log (`api.org_audit_events`, audit.view). */
async function readsAudit(who: Who, org = orgA): Promise<boolean> {
  const { data, error } = await rpc(who, 'org_audit_events', { p_org: org });
  if (error) {
    expect(['42501', 'P0002']).toContain(sqlstate(error));
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

const overridesOf = async (who: Who): Promise<string> => {
  const snap = await fs().collection('organizations').doc(orgA).collection('member_permission_overrides')
    .where('user_id', '==', ids[who]).get();
  return snap.docs.map((d) => String(d.get('permission'))).sort().join(',');
};

const auditCount = async (action: string, org = orgA): Promise<number> =>
  (await fs().collection('audit_events').where('organization_id', '==', org).where('action', '==', action).count().get()).data().count;

const requestRow = async (id: string) => (await orgRow(fs(), orgA, 'access_requests', id).get()).data()!;

/** One of everything a 3rd party must not read, and the overview it may. */
async function seed(org: string, tag: string): Promise<void> {
  const period = periodId(org, '2026-03-01');
  await fs().collection('organizations').doc(org).update({ 'features.funding_readiness': true });
  const acct = await seedRow(org, 'accounts', {
    name: `${tag} Sales`, normalized_name: `${tag.toLowerCase()} sales`, account_type: 'income', standard_category: 'revenue',
  });
  const cp = await seedRow(org, 'counterparties', { name: `${tag} Customer`, normalized_name: `${tag.toLowerCase()} customer` });
  const bank = await seedRow(org, 'bank_accounts', { name: `${tag} Current`, bank_name: 'Test Bank', account_type: 'current' });
  await seedRow(org, 'ledger_entries', {
    entry_date: '2026-03-10', period_id: period, account_id: acct.id, direction: 'debit', amount: '100.00', record_status: 'accepted',
  });
  await seedRow(org, 'period_balances', {
    period_start: '2026-03-01', period_id: period, account_id: acct.id, closing_balance: '100.00',
    balance_kind: 'trial_balance', balance_basis: 'cumulative', record_status: 'accepted',
  });
  const inv = await seedRow(org, 'invoices', {
    invoice_type: 'sales', counterparty_id: cp.id, invoice_number: `${tag}-INV-1`, issue_date: '2026-03-12',
    period_id: period, total_amount: '250.00', balance_due: '250.00',
  });
  const product = await seedRow(org, 'products', { name: `${tag} Widget`, normalized_name: `${tag.toLowerCase()} widget` });
  await seedRow(org, 'invoice_lines', { invoice_id: inv.id, product_id: product.id, amount: '250.00' });
  await seedRow(org, 'bank_transactions', {
    bank_account_id: bank.id, transaction_date: '2026-03-14', period_id: period, amount: '-30.00', description_raw: `SO ${tag}`,
  });
  const run = await seedRow(org, 'calculation_runs', {
    trigger: 'recalc_manual', engine_version: '1.0.0', period_from: period, period_to: period, as_of: '2026-03-31', status: 'succeeded',
  });
  const snap = await seedRow(org, 'metric_snapshots', {
    calculation_run_id: run.id, period_id: period, metric_key: 'revenue', unit: 'money', basis: 'ledger',
    assurance_level: 'verified', value: '100.00',
  });
  await seedRow(org, 'metric_current', { period_id: period, metric_key: 'revenue', snapshot_id: snap.id, calculation_run_id: run.id });
  const cpSnap = await seedRow(org, 'metric_snapshots', {
    calculation_run_id: run.id, period_id: period, metric_key: 'customer_revenue', dimension_type: 'counterparty',
    dimension_id: cp.id, unit: 'money', basis: 'ledger', assurance_level: 'verified', value: '250.00',
  });
  await seedRow(org, 'metric_current', {
    period_id: period, metric_key: 'customer_revenue', dimension_type: 'counterparty', dimension_id: cp.id,
    snapshot_id: cpSnap.id, calculation_run_id: run.id,
  });
  const health = await seedRow(org, 'health_scores', {
    calculation_run_id: run.id, period_id: period, score: 70, dimensions_used: 5, dimensions_total: 5, config_version: 'v1',
  });
  await seedRow(org, 'health_current', { period_id: period, health_score_id: health.id, calculation_run_id: run.id });
  await seedRow(org, 'alerts', {
    rule_key: 'itest.rule', rule_version: '1', severity: 'high', period_id: period, title: 'Overdue',
    explanation: `${tag} Customer is 60 days overdue`, dedupe_key: `${tag}-d`, key_kind: 'state', calculation_run_id: run.id,
  });
  await seedRow(org, 'actions', { title: `${tag} chase the invoice` });
  const doc = await seedRow(org, 'source_documents', {
    storage_path: `${org}/doc/${tag}.csv`, original_filename: `${tag}.csv`, mime_type: 'text/csv', byte_size: 10,
    sha256: createHash('sha256').update(tag).digest('hex'), status: 'ready',
  });
  const batch = await seedRow(org, 'import_batches', {
    source_document_id: doc.id, import_type: 'general_ledger', target_table: 'ledger_entries',
    period_start: '2026-03-01', period_end: '2026-03-31',
  });
  await seedRow(org, 'import_rows', { batch_id: batch.id, row_number: 1 });
  await seedRow(org, 'evidence_bundles', { kind: 'metric', origin_table: 'metric_snapshots' });
  await seedRow(org, 'reports', {
    report_kind: 'daily_brief', window_start: '2026-03-31', window_end: '2026-03-31', origin: 'scheduled',
    content: {}, content_version: 'brief.v1',
  });
  await seedRow(org, 'reports', {
    report_kind: 'funding_readiness', window_start: '2026-03-01', window_end: '2026-03-31', period_id: period,
    origin: 'scheduled', content: {}, content_version: 'funding.v1',
  });
}

const DETAIL_TABLES = [
  'accounts', 'counterparties', 'ledger_entries', 'period_balances', 'invoices', 'invoice_lines', 'products',
  'bank_accounts', 'bank_transactions', 'alerts', 'actions', 'evidence_bundles', 'source_documents',
  'import_batches', 'import_rows',
] as const;

beforeAll(async () => {
  for (const who of ['owner', 'owner2', 'admin', 'admin2', 'accountant', 'client', 'client2', 'third', 'ownerB', 'thirdB'] as Who[]) {
    ids[who] = await createAuthUser(email(who));
  }
  const a = await rpc('owner', 'create_organization', { p_name: `ITest Access ${RUN}` });
  if (a.error) throw new Error(`fixture org failed: ${a.error.message}`);
  orgA = a.data as string;
  const b = await rpc('ownerB', 'create_organization', { p_name: `ITest Access Other ${RUN}` });
  if (b.error) throw new Error(`fixture org failed: ${b.error.message}`);
  orgB = b.data as string;
  slugA = String((await globalRow(fs(), 'organizations', orgA).get()).get('slug'));

  await addMember(orgA, ids.owner2, 'owner');
  await addMember(orgA, ids.admin, 'admin');
  await addMember(orgA, ids.admin2, 'admin');
  await addMember(orgA, ids.accountant, 'accountant');
  await addMember(orgA, ids.client, 'client');
  await addMember(orgA, ids.client2, 'client');
  await addMember(orgA, ids.third, 'third_party');
  await addMember(orgB, ids.thirdB, 'third_party');
  await seed(orgA, `A${RUN}`);
  await seed(orgB, `B${RUN}`);
}, 120_000);

afterAll(async () => {
  for (const org of [orgA, orgB]) if (org) await dropOrg(org);
  for (const id of Object.values(ids)) {
    await auth().deleteUser(id).catch(() => undefined);
    await fs().collection('profiles').doc(id).delete();
    const limits = await fs().collection('api_rate_limits').where('actor_user_id', '==', id).get();
    for (const d of limits.docs) await d.ref.delete();
  }
  const events = await fs().collection('audit_events').where('organization_id', 'in', [orgA, orgB].filter(Boolean)).get();
  for (const d of events.docs) await d.ref.delete();
}, 120_000);

describe('a 3rd party sees the overview and the reports, and no detail record', () => {
  it.each(DETAIL_TABLES)('reads ZERO rows of %s (which holds a row)', async (table) => {
    expect(await rawCount(orgA, table)).toBeGreaterThan(0);
    expect(await rows('third', table)).toBe(0);
  });

  it('reads the Business Health Score and the current headline figure, not the per-customer one', async () => {
    expect(await rows('third', 'health_current')).toBe(1);
    expect(await rows('third', 'health_scores')).toBe(1);
    const snaps = await orgRows<{ metric_key: string }>(db('third'), orgA, 'metric_snapshots');
    expect(snaps.map((r) => r.metric_key)).toEqual(['revenue']);
  });

  it('reads Funding Readiness, not the daily brief', async () => {
    const reports = await orgRows<{ report_kind: string }>(db('third'), orgA, 'reports');
    expect(reports.map((r) => r.report_kind)).toEqual(['funding_readiness']);
  });

  it('is told the company holds records (Home), without reading them', async () => {
    const { data, error } = await rpc('third', 'has_accepted_records', { p_org: orgA });
    expect(error).toBeNull();
    expect(data).toBe(true);
    const other = await rpc('third', 'has_accepted_records', { p_org: orgB });
    expect(sqlstate(other.error)).toBe('P0002');
  });

  it('cannot use the AI, list the team, or read the audit log', async () => {
    expect(sqlstate((await rpc('third', 'create_conversation', { p_org: orgA })).error)).toBe('42501');
    expect(sqlstate((await rpc('third', 'org_members', { p_org: orgA })).error)).toBe('42501');
    expect(await readsAudit('third')).toBe(false);
  });

  it('reads nothing at all of another organisation', async () => {
    for (const table of ['health_current', 'metric_snapshots', 'reports', 'fiscal_periods'] as const) {
      expect(await rows('third', table, orgB), table).toBe(0);
    }
    expect(await organizationDoc(db('third'), orgB)).toBeNull();
    expect(await organizationDoc(db('third'), orgA)).not.toBeNull();
  });
});

describe('an accountant captures data and keeps the books, without AI or the team', () => {
  it('reads the detail and the documents', async () => {
    for (const table of ['ledger_entries', 'invoices', 'bank_transactions', 'source_documents', 'import_batches', 'alerts'] as const) {
      expect(await rows('accountant', table), table).toBeGreaterThan(0);
    }
  });

  it('may acknowledge an alert, not resolve it', async () => {
    const alert = (await fs().collection('organizations').doc(orgA).collection('alerts').limit(1).get()).docs[0]!.id;
    expect(sqlstate((await rpc('accountant', 'set_alert_status', { p_alert: alert, p_status: 'resolved' })).error)).toBe('42501');
    expect((await rpc('accountant', 'set_alert_status', { p_alert: alert, p_status: 'acknowledged' })).error).toBeNull();
  });

  it('cannot use the AI, see the team or the audit log', async () => {
    expect(sqlstate((await rpc('accountant', 'create_conversation', { p_org: orgA })).error)).toBe('42501');
    expect(sqlstate((await rpc('accountant', 'org_members', { p_org: orgA })).error)).toBe('42501');
    expect(await readsAudit('accountant')).toBe(false);
    expect(sqlstate((await rpc('accountant', 'set_member_permission', {
      p_org: orgA, p_user: ids.client, p_permission: 'ai.use', p_granted: false,
    })).error)).toBe('42501');
  });
});

describe('the resolver: TypeScript and the data layer compute the same effective permissions', () => {
  it.each(['owner', 'admin', 'accountant', 'client', 'third'] as Who[])('%s', async (who) => {
    const { data } = await rpc(who, 'my_access', { p_slug: slugA });
    const row = (data as Array<{ role: EffectiveRole; overrides: unknown; permissions: string[] }>)[0]!;
    const computed = [...resolvePermissions(row.role, parseOverrides(row.overrides))].sort();
    expect(computed).toEqual([...row.permissions].sort());
  });

  it('… including a person with switches', async () => {
    const put = (permission: string, granted: boolean) => orgRow(fs(), orgA, 'member_permission_overrides', overrideId(ids.client2, permission)).set({
      organization_id: orgA, user_id: ids.client2, permission, granted, set_by: null, set_at: new Date().toISOString(),
      set_by_owner: false, ceiling_withhold: false,
    });
    await put('documents.view', true);
    await put('ai.use', false);
    try {
      const { data } = await rpc('client2', 'my_access', { p_slug: slugA });
      const row = (data as Array<{ role: EffectiveRole; overrides: unknown; permissions: string[] }>)[0]!;
      expect(row.permissions).toContain('documents.view');
      expect(row.permissions).not.toContain('ai.use');
      expect([...resolvePermissions(row.role, parseOverrides(row.overrides))].sort()).toEqual([...row.permissions].sort());
    } finally {
      for (const p of ['documents.view', 'ai.use']) await orgRow(fs(), orgA, 'member_permission_overrides', overrideId(ids.client2, p)).delete();
    }
  });
});

describe('per-person switches', () => {
  it('the team page lists everyone with defaults, switches, and what the viewer may change', async () => {
    const members = await listMemberPermissions(await ctxFor('owner'));
    const by = new Map(members.map((m) => [m.userId, m]));
    expect(by.get(ids.owner)!.editable).toBe(false); // oneself
    expect(by.get(ids.owner2)!.editable).toBe(false); // an owner
    expect(by.get(ids.third)!.editable).toBe(true);
    expect(by.get(ids.third)!.defaults).toEqual(['dashboard.view', 'reports.view']);
    expect(by.get(ids.accountant)!.grantable).toContain('ai.use');

    const asAdmin = new Map((await listMemberPermissions(await ctxFor('admin'))).map((m) => [m.userId, m]));
    expect(asAdmin.get(ids.admin2)!.editable).toBe(true); // admin ↔ admin, as for role changes
    expect(asAdmin.get(ids.owner)!.editable).toBe(false);
    expect(await outcome(listMemberPermissions(await ctxFor('client')))).toBe('PERMISSION_DENIED');
  });

  it('documents.view switched on for a client opens the documents to that client; off closes them', async () => {
    expect(await rows('client', 'source_documents')).toBe(0);
    await setMemberPermission(await ctxFor('owner'), { userId: ids.client, permission: 'documents.view', granted: true });
    expect(await rows('client', 'source_documents')).toBe(1);
    expect(await rows('client2', 'source_documents')).toBe(0);
    expect((await ctxFor('client')).permissions.has('documents.view')).toBe(true);

    await setMemberPermission(await ctxFor('owner'), { userId: ids.client, permission: 'documents.view', granted: false });
    expect(await rows('client', 'source_documents')).toBe(0);
    await setMemberPermission(await ctxFor('owner'), { userId: ids.client, permission: 'documents.view', granted: null });
    expect(await rows('client', 'source_documents')).toBe(0);
    expect(await auditCount('member.permission_changed')).toBe(3);
  });

  it('switching on something the admin does not hold is refused (service and data layer)', async () => {
    await setMemberPermission(await ctxFor('owner'), { userId: ids.admin2, permission: 'audit.view', granted: false });
    const admin2 = await ctxFor('admin2');
    expect(admin2.permissions.has('audit.view')).toBe(false);
    expect(await outcome(setMemberPermission(admin2, { userId: ids.client, permission: 'audit.view', granted: true })))
      .toBe('PERMISSION_DENIED');
    expect(sqlstate((await rpc('admin2', 'set_member_permission', {
      p_org: orgA, p_user: ids.client, p_permission: 'audit.view', p_granted: true,
    })).error)).toBe('42501');
    expect(await readsAudit('client')).toBe(false);
  });

  it('an owner cannot be switched, by an admin or by another owner', async () => {
    expect(sqlstate((await rpc('admin', 'set_member_permission', {
      p_org: orgA, p_user: ids.owner, p_permission: 'ai.use', p_granted: false,
    })).error)).toBe('42501');
    expect(sqlstate((await rpc('owner2', 'set_member_permission', {
      p_org: orgA, p_user: ids.owner, p_permission: 'ai.use', p_granted: false,
    })).error)).toBe('42501');
  });

  it('nobody can switch themselves', async () => {
    expect(await outcome(setMemberPermission(await ctxFor('admin'), { userId: ids.admin, permission: 'ai.use', granted: false })))
      .toBe('PERMISSION_DENIED');
    expect(sqlstate((await rpc('admin', 'set_member_permission', {
      p_org: orgA, p_user: ids.admin, p_permission: 'ai.use', p_granted: false,
    })).error)).toBe('42501');
  });

  it('only a switchable permission, and only for a member of this organisation', async () => {
    expect(sqlstate((await rpc('owner', 'set_member_permission', {
      p_org: orgA, p_user: ids.client, p_permission: 'users.manage', p_granted: true,
    })).error)).toBe('22023');
    expect(sqlstate((await rpc('owner', 'set_member_permission', {
      p_org: orgA, p_user: ids.thirdB, p_permission: 'ai.use', p_granted: true,
    })).error)).toBe('P0002');
    expect(sqlstate((await rpc('ownerB', 'set_member_permission', {
      p_org: orgA, p_user: ids.client, p_permission: 'ai.use', p_granted: true,
    })).error)).toBe('P0002');
  });

  // "nobody writes the switches table directly" was a PostgREST INSERT refused by SQL grants. There
  // is no client write path at all now (firebase/firestore.rules refuse every client request), so
  // the assertion has nothing left to test and is dropped.

  // ADR-172 hardening (2026-10-14, migration 20261018000032): a role change CARRIES the switches an
  // owner set and clears the rest — it used to clear them all, which let a role round trip undo the
  // owner's decision.
  it('a role change carries the owner\'s switches and clears the rest', async () => {
    await setMemberPermission(await ctxFor('owner'), { userId: ids.accountant, permission: 'financials.view', granted: false });
    await setMemberPermission(await ctxFor('admin'), { userId: ids.accountant, permission: 'data.export', granted: false });
    expect(await rows('accountant', 'ledger_entries')).toBe(0);
    const changed = await rpc('owner', 'change_member_role', { p_org: orgA, p_user: ids.accountant, p_role: 'client' });
    expect(changed.error).toBeNull();
    expect(await overridesOf('accountant')).toBe('financials.view');
    expect(await auditCount('member.permissions_reset')).toBe(1);
    // Back to an accountant: the owner's decision still holds…
    expect((await rpc('owner', 'change_member_role', { p_org: orgA, p_user: ids.accountant, p_role: 'accountant' })).error).toBeNull();
    expect(await rows('accountant', 'ledger_entries')).toBe(0);
    // …until the owner puts it back: the accountant's defaults again, the ledger included.
    await setMemberPermission(await ctxFor('owner'), { userId: ids.accountant, permission: 'financials.view', granted: null });
    expect(await rows('accountant', 'ledger_entries')).toBe(1);
  });

  it('an admin cannot change or reset a switch the owner set, and "Reset all" leaves it alone', async () => {
    await setMemberPermission(await ctxFor('owner'), { userId: ids.client, permission: 'ai.use', granted: false });
    await setMemberPermission(await ctxFor('admin'), { userId: ids.client, permission: 'data.export', granted: true });
    const asAdmin = (await listMemberPermissions(await ctxFor('admin'))).find((m) => m.userId === ids.client)!;
    expect(asAdmin.ownerLocked).toEqual(['ai.use']);
    expect(asAdmin.grantable).not.toContain('ai.use');
    expect(asAdmin.overrides.find((o) => o.permission === 'ai.use')?.setByOwner).toBe(true);
    expect(await outcome(setMemberPermission(await ctxFor('admin'), { userId: ids.client, permission: 'ai.use', granted: null })))
      .toBe('PERMISSION_DENIED');
    const result = await resetMemberPermissions(await ctxFor('admin'), ids.client);
    expect(result.reset).toEqual(['data.export']);
    expect(result.lockedByOwner).toEqual(['ai.use']);
    expect(await overridesOf('client')).toBe('ai.use');
    // The owner sees no lock and may reset it.
    const asOwner = (await listMemberPermissions(await ctxFor('owner'))).find((m) => m.userId === ids.client)!;
    expect(asOwner.ownerLocked).toEqual([]);
    await setMemberPermission(await ctxFor('owner'), { userId: ids.client, permission: 'ai.use', granted: null });
  });

  it('nobody changes their own role', async () => {
    expect(await outcome(changeMemberRole(await ctxFor('admin'), { userId: ids.admin, fromRole: 'admin', toRole: 'client' })))
      .toBe('PERMISSION_DENIED');
    expect(sqlstate((await rpc('admin', 'change_member_role', { p_org: orgA, p_user: ids.admin, p_role: 'client' })).error))
      .toBe('42501');
  });
});

describe('"Request more information"', () => {
  let requestId: string;

  it('a 3rd party asks; every owner and admin is told, nobody else', async () => {
    const result = await requestAccess(await ctxFor('third'), {
      permissions: ['financials.view', 'documents.view', 'dashboard.view'],
      message: 'For the loan review, please.',
    });
    requestId = result.id;
    expect((await requestRow(requestId)).permissions).toEqual(['documents.view', 'financials.view']); // what they already hold is dropped
    const notes = await fs().collection('organizations').doc(orgA).collection('notifications').where('kind', '==', 'access_request').get();
    expect(notes.docs.map((d) => String(d.get('user_id'))).sort()).toEqual([ids.owner, ids.owner2, ids.admin, ids.admin2].sort());
    expect(notes.docs.find((d) => d.get('user_id') === ids.owner)!.get('href')).toBe(`/app/${slugA}/settings/team#requests`);
    expect(await auditCount('member.access_requested')).toBe(1);
  });

  it('one waiting request at a time', async () => {
    expect(await outcome(requestAccess(await ctxFor('third'), { permissions: ['ai.use'], message: null }))).toBe('CONFLICT');
  });

  it('the requester sees their own; a client sees none of it; a manager sees it', async () => {
    const own = await listAccessRequests(await ctxFor('third'), { status: 'pending' });
    expect(own.map((r) => r.id)).toEqual([requestId]);
    expect(own[0]!.requesterRole).toBe('third_party');
    expect(await listAccessRequests(await ctxFor('client'))).toEqual([]);
    expect(await rows('client', 'access_requests')).toBe(0);
    expect(await orgRowById(db('client'), orgA, 'access_requests', requestId)).toBeNull();
    const managed = await listAccessRequests(await ctxFor('admin'), { status: 'pending' });
    expect(managed.map((r) => r.id)).toContain(requestId);
    expect(managed.find((r) => r.id === requestId)!.message).toBe('For the loan review, please.');
  });

  it('only a manager of THIS organisation may answer', async () => {
    expect(await outcome(decideAccessRequest(await ctxFor('client'), { id: requestId, approve: true }))).toBe('PERMISSION_DENIED');
    expect(sqlstate((await rpc('client', 'decide_access_request', { p_id: requestId, p_approve: true })).error)).toBe('42501');
    expect(sqlstate((await rpc('ownerB', 'decide_access_request', { p_id: requestId, p_approve: true })).error)).toBe('P0002');
    expect(sqlstate((await rpc('thirdB', 'withdraw_access_request', { p_id: requestId })).error)).toBe('P0002');
  });

  it('approving a subset switches exactly that on, and tells the requester', async () => {
    expect(await rows('third', 'ledger_entries')).toBe(0);
    await decideAccessRequest(await ctxFor('admin'), { id: requestId, approve: true, permissions: ['financials.view'], note: 'Ledger only for now.' });
    const row = await requestRow(requestId);
    expect(`${row.status}|${(row.granted as string[]).join(',')}|${row.note}`).toBe('approved|financials.view|Ledger only for now.');
    expect(await rows('third', 'ledger_entries')).toBe(1);
    expect(await rows('third', 'source_documents')).toBe(0);
    const decided = await fs().collection('organizations').doc(orgA).collection('notifications')
      .where('kind', '==', 'access_decision').where('user_id', '==', ids.third).get();
    expect(decided.docs.map((d) => d.get('title'))).toEqual(['Your request for more access was approved']);
    expect(await outcome(decideAccessRequest(await ctxFor('owner'), { id: requestId, approve: false }))).toBe('CONFLICT');
  });

  it('an answer may only switch on what was asked', async () => {
    const { id } = await requestAccess(await ctxFor('third'), { permissions: ['documents.view'], message: null });
    expect(sqlstate((await rpc('owner', 'decide_access_request', {
      p_id: id, p_approve: true, p_permissions: ['ai.use'],
    })).error)).toBe('22023');
    await decideAccessRequest(await ctxFor('owner'), { id, approve: false, note: 'Not yet.' });
    const row = await requestRow(id);
    expect(`${row.status}|${row.note}`).toBe('declined|Not yet.');
    expect(await rows('third', 'source_documents')).toBe(0);
  });

  it('approval needs the decider to hold each permission', async () => {
    // admin2's audit.view was switched off above.
    const { id } = await requestAccess(await ctxFor('client'), { permissions: ['audit.view'], message: null });
    expect(await outcome(decideAccessRequest(await ctxFor('admin2'), { id, approve: true }))).toBe('PERMISSION_DENIED');
    expect(sqlstate((await rpc('admin2', 'decide_access_request', { p_id: id, p_approve: true })).error)).toBe('42501');
    expect((await requestRow(id)).status).toBe('pending');
    await decideAccessRequest(await ctxFor('owner'), { id, approve: true });
    expect(await readsAudit('client')).toBe(true);
    await setMemberPermission(await ctxFor('owner'), { userId: ids.client, permission: 'audit.view', granted: null });
    expect(await readsAudit('client')).toBe(false);
  });

  it('the requester may withdraw a waiting request; nobody else may', async () => {
    const { id } = await requestAccess(await ctxFor('third'), { permissions: [], message: 'Could I see the bank lines?' });
    expect(sqlstate((await rpc('client', 'withdraw_access_request', { p_id: id })).error)).toBe('P0002');
    await withdrawAccessRequest(await ctxFor('third'), id);
    expect((await requestRow(id)).status).toBe('withdrawn');
    expect(await outcome(withdrawAccessRequest(await ctxFor('third'), id))).toBe('CONFLICT');
  });

  it('an owner cannot ask (they hold everything); nor can anyone ask for what they hold, or say nothing', async () => {
    expect(await outcome(requestAccess(await ctxFor('owner'), { permissions: ['ai.use'], message: null }))).toBe('PERMISSION_DENIED');
    expect(sqlstate((await rpc('owner', 'request_access', { p_org: orgA, p_permissions: ['ai.use'], p_message: null })).error)).toBe('42501');
    expect(await outcome(requestAccess(await ctxFor('client2'), { permissions: ['ai.use'], message: null }))).toBe('VALIDATION');
    expect(await outcome(requestAccess(await ctxFor('client2'), { permissions: [], message: '   ' }))).toBe('VALIDATION');
    expect(await outcome(requestAccess(await ctxFor('client2'), { permissions: [], message: 'x'.repeat(1001) }))).toBe('VALIDATION');
    expect(sqlstate((await rpc('client2', 'request_access', { p_org: orgA, p_permissions: ['users.manage'], p_message: null })).error))
      .toBe('22023');
    expect(sqlstate((await rpc('thirdB', 'request_access', { p_org: orgA, p_permissions: ['ai.use'], p_message: null })).error))
      .toBe('P0002');
  });

  it('is throttled at five a day per person', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { id } = await requestAccess(await ctxFor('client2'), { permissions: ['documents.view'], message: null });
      await withdrawAccessRequest(await ctxFor('client2'), id);
    }
    expect(await outcome(requestAccess(await ctxFor('client2'), { permissions: ['documents.view'], message: null }))).toBe('QUOTA');
  });

  it('a role change closes a waiting request; removing the member removes their requests and switches', async () => {
    const { id } = await requestAccess(await ctxFor('accountant'), { permissions: ['ai.use'], message: null });
    expect((await rpc('owner', 'change_member_role', { p_org: orgA, p_user: ids.accountant, p_role: 'client' })).error).toBeNull();
    expect((await requestRow(id)).status).toBe('declined');
    await setMemberPermission(await ctxFor('owner'), { userId: ids.accountant, permission: 'ai.use', granted: false });
    expect((await rpc('owner', 'remove_member', { p_org: orgA, p_user: ids.accountant })).error).toBeNull();
    expect(await rawCount(orgA, 'access_requests', ['requester_id', ids.accountant])).toBe(0);
    expect(await rawCount(orgA, 'member_permission_overrides', ['user_id', ids.accountant])).toBe(0);
  });
});

describe('invitations take the new roles', () => {
  it('an owner may invite an accountant and a 3rd party; an admin may invite nobody (ADR-174)', async () => {
    const owner = await ctxFor('owner');
    expect(await outcome(inviteMember(owner, { email: `acc-invite@${DOMAIN}`, role: 'accountant' }))).toBe('ok');
    expect(await outcome(inviteMember(owner, { email: `lender-invite@${DOMAIN}`, role: 'third_party' }))).toBe('ok');
    const admin = await ctxFor('admin');
    for (const role of ['accountant', 'third_party', 'client', 'owner'] as const) {
      expect(await outcome(inviteMember(admin, { email: `${role}-by-admin@${DOMAIN}`, role }))).toBe('PERMISSION_DENIED');
    }
    expect(sqlstate((await rpc('admin', 'invite_member_with_token', {
      p_org: orgA, p_email: `owner-invite2@${DOMAIN}`, p_role: 'owner',
    })).error)).toBe('42501');
  });

  it('an accountant and a 3rd party may invite nobody', async () => {
    for (const who of ['accountant', 'third'] as Who[]) {
      const { error } = await rpc(who, 'invite_member_with_token', { p_org: orgA, p_email: `x-${who}@${DOMAIN}`, p_role: 'client' });
      expect(['42501', 'P0002']).toContain(sqlstate(error));
    }
  });
});
