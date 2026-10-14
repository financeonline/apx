import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMotionError } from '@/core/errors';
import type { EffectiveRole } from '@/core/permissions';
import {
  changeMemberRole,
  decideAccessRequest,
  inviteMember,
  resetMemberPermissions,
  listAccessRequests,
  listMemberPermissions,
  requestAccess,
  setMemberPermission,
  withdrawAccessRequest,
  agreedPermissions,
  parseOverrides,
  resolvePermissions,
  type AccessContext,
} from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, sqlstate } from './setup';

/**
 * ADR-172 against the database, through PostgREST with real JWTs: the two new roles, the
 * permission-based reads, the per-person switches and "Request more information".
 *
 * This is the security suite for the change, so every "cannot" is asserted at the DATABASE (a direct
 * rpc or table read with the person's own token), and the services are driven on top for the flows
 * the team page uses. Every "reads nothing" is checked against a table that holds a row.
 *
 * Run-unique fixtures (ADR-052.12): nothing here touches another suite's rows, and everything is
 * removed afterwards.
 */

const RUN = `m${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.access.itest`;

type Who = 'owner' | 'owner2' | 'admin' | 'admin2' | 'accountant' | 'client' | 'client2' | 'third' | 'ownerB' | 'thirdB';
const ids = {} as Record<Who, string>;
let orgA: string;
let orgB: string;
let slugA: string;

const email = (who: Who) => `${who}@${DOMAIN}`;
const db = (who: Who): SupabaseClient => clientFor(ids[who], { email: email(who) });
const rpc = (who: Who, fn: string, args: Record<string, unknown>) => db(who).schema('api').rpc(fn, args);

/** The context a page hands a service, built from the same api.my_access the resolver calls. */
async function ctxFor(who: Who, org = orgA): Promise<AccessContext> {
  const slug = adminSql(`select slug from public.organizations where id = '${org}'`);
  const { data, error } = await rpc(who, 'my_access', { p_slug: slug });
  if (error) throw new Error(error.message);
  const row = (data as Array<{ role: EffectiveRole; overrides: unknown; permissions: string[] }>)[0];
  if (!row) throw new Error(`${who} has no access to ${slug}`);
  return {
    userId: ids[who], orgId: org, orgSlug: slug, effectiveRole: row.role,
    permissions: agreedPermissions(row.role, row.overrides, row.permissions).agreed,
    actorType: 'user', db: db(who), requestId: `itest-${RUN}`, now: () => new Date(),
    organizationStatus: 'active',
  };
}

/** The MotionError code a service threw, or 'ok'. */
async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return isMotionError(error) ? error.code : `thrown: ${String(error)}`;
  }
}

async function rows(who: Who, table: string, org = orgA): Promise<number> {
  // `id` rather than `*`: raw bank text is column-revoked for everyone (ADR-044.2).
  const column = table === 'org_member_profiles' ? 'user_id' : table === 'health_current' ? 'period_id' : 'id';
  const { data, error } = await db(who).from(table).select(column).eq('organization_id', org);
  expect(error, `${who} reading ${table}`).toBeNull();
  return (data ?? []).length;
}

function rawRows(table: string, org = orgA): number {
  return Number(adminSql(`select count(*) from public.${table} where organization_id = '${org}'`));
}

/** One of everything a 3rd party must not read, and the overview it may. */
function seed(org: string, tag: string): void {
  adminSql(`
    do $$
    declare
      v_org uuid := '${org}'; v_period uuid; v_acct uuid; v_cp uuid; v_bank uuid; v_run uuid; v_doc uuid;
      v_inv uuid; v_batch uuid; v_health uuid; v_snap uuid; v_cp_snap uuid; v_ledger uuid; v_alert uuid; v_product uuid;
    begin
      update public.organizations set features = features || '{"funding_readiness": true}'::jsonb where id = v_org;
      insert into public.accounts (organization_id, name, normalized_name, account_type, standard_category)
      values (v_org, '${tag} Sales', '${tag} sales', 'income', 'revenue') returning id into v_acct;
      insert into public.counterparties (organization_id, name, normalized_name)
      values (v_org, '${tag} Customer', '${tag} customer') returning id into v_cp;
      insert into public.bank_accounts (organization_id, name, bank_name, account_type)
      values (v_org, '${tag} Current', 'Test Bank', 'current') returning id into v_bank;
      insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, record_status)
      values (v_org, '2026-03-10', v_acct, 'debit', 100, 'accepted') returning id, period_id into v_ledger, v_period;
      insert into public.period_balances
        (organization_id, period_start, account_id, closing_balance, balance_kind, balance_basis, record_status)
      values (v_org, '2026-03-01', v_acct, 100, 'trial_balance', 'cumulative', 'accepted');
      insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount)
      values (v_org, 'sales', v_cp, '${tag}-INV-1', '2026-03-12', 250) returning id into v_inv;
      insert into public.products (organization_id, name, normalized_name)
      values (v_org, '${tag} Widget', '${tag} widget') returning id into v_product;
      insert into public.invoice_lines (organization_id, invoice_id, product_id, amount) values (v_org, v_inv, v_product, 250);
      insert into public.bank_transactions (organization_id, bank_account_id, transaction_date, amount, description_raw)
      values (v_org, v_bank, '2026-03-14', -30, 'SO ${tag}');
      insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
      values (v_org, 'recalc_manual', '1.0.0', v_period, v_period, '2026-03-31', 'succeeded') returning id into v_run;
      insert into public.metric_snapshots (organization_id, calculation_run_id, period_id, metric_key, unit, basis, assurance_level, value)
      values (v_org, v_run, v_period, 'revenue', 'money', 'ledger', 'verified', 100) returning id into v_snap;
      insert into public.metric_current (organization_id, period_id, metric_key, snapshot_id, calculation_run_id)
      values (v_org, v_period, 'revenue', v_snap, v_run);
      insert into public.metric_snapshots
        (organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id, unit, basis, assurance_level, value)
      values (v_org, v_run, v_period, 'customer_revenue', 'counterparty', v_cp, 'money', 'ledger', 'verified', 250)
      returning id into v_cp_snap;
      insert into public.metric_current
        (organization_id, period_id, metric_key, dimension_type, dimension_id, snapshot_id, calculation_run_id)
      values (v_org, v_period, 'customer_revenue', 'counterparty', v_cp, v_cp_snap, v_run);
      insert into public.health_scores (organization_id, calculation_run_id, period_id, score, dimensions_used, dimensions_total, config_version)
      values (v_org, v_run, v_period, 70, 5, 5, 'v1') returning id into v_health;
      insert into public.health_current (organization_id, period_id, health_score_id) values (v_org, v_period, v_health);
      insert into public.alerts (organization_id, rule_key, rule_version, severity, period_id, title, explanation, dedupe_key, key_kind, calculation_run_id)
      values (v_org, 'itest.rule', '1', 'high', v_period, 'Overdue', '${tag} Customer is 60 days overdue', '${tag}-d', 'state', v_run);
      insert into public.actions (organization_id, title) values (v_org, '${tag} chase the invoice');
      insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status)
      values (v_org, v_org::text || '/doc/${tag}.csv', '${tag}.csv', 'text/csv', 10, extensions.digest('${tag}', 'sha256'), 'ready')
      returning id into v_doc;
      insert into public.import_batches (organization_id, source_document_id, import_type, target_table, period_start, period_end)
      values (v_org, v_doc, 'general_ledger', 'ledger_entries', '2026-03-01', '2026-03-31') returning id into v_batch;
      insert into public.import_rows (organization_id, batch_id, row_number) values (v_org, v_batch, 1);
      insert into public.evidence_bundles (organization_id, kind, origin_table) values (v_org, 'metric', 'metric_snapshots');
      insert into public.reports (organization_id, report_kind, window_start, window_end, origin, content, content_version)
      values (v_org, 'daily_brief', '2026-03-31', '2026-03-31', 'scheduled', '{}'::jsonb, 'brief.v1');
      insert into public.reports (organization_id, report_kind, window_start, window_end, period_id, origin, content, content_version)
      values (v_org, 'funding_readiness', '2026-03-01', '2026-03-31', v_period, 'scheduled', '{}'::jsonb, 'funding.v1');
    end $$;`);
}

const DETAIL_TABLES = [
  'accounts', 'counterparties', 'ledger_entries', 'period_balances', 'invoices', 'invoice_lines', 'products',
  'bank_accounts', 'bank_transactions', 'alerts', 'actions', 'evidence_bundles', 'source_documents',
  'import_batches', 'import_rows',
] as const;

beforeAll(async () => {
  for (const who of ['owner', 'owner2', 'admin', 'admin2', 'accountant', 'client', 'client2', 'third', 'ownerB', 'thirdB'] as Who[]) {
    ids[who] = createAuthUser(email(who));
  }
  const a = await rpc('owner', 'create_organization', { p_name: `ITest Access ${RUN}` });
  if (a.error) throw new Error(`fixture org failed: ${a.error.message}`);
  orgA = a.data as string;
  const b = await rpc('ownerB', 'create_organization', { p_name: `ITest Access Other ${RUN}` });
  if (b.error) throw new Error(`fixture org failed: ${b.error.message}`);
  orgB = b.data as string;
  slugA = adminSql(`select slug from public.organizations where id = '${orgA}'`);

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role) values
      ('${orgA}', '${ids.owner2}', 'owner'),
      ('${orgA}', '${ids.admin}', 'admin'),
      ('${orgA}', '${ids.admin2}', 'admin'),
      ('${orgA}', '${ids.accountant}', 'accountant'),
      ('${orgA}', '${ids.client}', 'client'),
      ('${orgA}', '${ids.client2}', 'client'),
      ('${orgA}', '${ids.third}', 'third_party'),
      ('${orgB}', '${ids.thirdB}', 'third_party');`);
  seed(orgA, `A${RUN}`);
  seed(orgB, `B${RUN}`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Access%${RUN}';
    delete from public.api_rate_limits where actor_user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Access %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.access.itest' and created_at < now() - interval '1 hour';`);
});

describe('a 3rd party sees the overview and the reports, and no detail record', () => {
  it.each(DETAIL_TABLES)('reads ZERO rows of %s (which holds a row)', async (table) => {
    expect(rawRows(table)).toBeGreaterThan(0);
    expect(await rows('third', table)).toBe(0);
  });

  it('reads the Business Health Score and the current headline figure, not the per-customer one', async () => {
    expect(await rows('third', 'health_current')).toBe(1);
    expect(await rows('third', 'health_scores')).toBe(1);
    const { data } = await db('third').from('metric_snapshots').select('metric_key, dimension_type').eq('organization_id', orgA);
    expect((data ?? []).map((r) => r.metric_key)).toEqual(['revenue']);
  });

  it('reads Funding Readiness, not the daily brief', async () => {
    const { data } = await db('third').from('reports').select('report_kind').eq('organization_id', orgA);
    expect((data ?? []).map((r) => r.report_kind)).toEqual(['funding_readiness']);
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
    expect(await rows('third', 'audit_events')).toBe(0);
    expect(await rows('third', 'org_member_profiles')).toBe(0);
  });

  it('reads nothing at all of another organisation', async () => {
    for (const table of ['health_current', 'metric_snapshots', 'reports', 'fiscal_periods', 'organizations'] as const) {
      const column = table === 'organizations' ? 'id' : 'organization_id';
      // A column, not `*`: `*` on metric_snapshots is refused outright since the ADR-172 hardening
      // (payload columns), and a refusal would pass this check without testing anything.
      const { data, error } = await db('third').from(table).select(column).eq(column, orgB);
      expect(error, table).toBeNull();
      expect(data ?? [], table).toHaveLength(0);
    }
  });
});

describe('an accountant captures data and keeps the books, without AI or the team', () => {
  it('reads the detail and the documents', async () => {
    for (const table of ['ledger_entries', 'invoices', 'bank_transactions', 'source_documents', 'import_batches', 'alerts'] as const) {
      expect(await rows('accountant', table), table).toBeGreaterThan(0);
    }
  });

  it('may acknowledge an alert, not resolve it', async () => {
    const alert = adminSql(`select id from public.alerts where organization_id = '${orgA}' limit 1`);
    expect(sqlstate((await rpc('accountant', 'set_alert_status', { p_alert: alert, p_status: 'resolved' })).error)).toBe('42501');
    expect((await rpc('accountant', 'set_alert_status', { p_alert: alert, p_status: 'acknowledged' })).error).toBeNull();
  });

  it('cannot use the AI, see the team or the audit log', async () => {
    expect(sqlstate((await rpc('accountant', 'create_conversation', { p_org: orgA })).error)).toBe('42501');
    expect(sqlstate((await rpc('accountant', 'org_members', { p_org: orgA })).error)).toBe('42501');
    expect(await rows('accountant', 'audit_events')).toBe(0);
    expect(sqlstate((await rpc('accountant', 'set_member_permission', {
      p_org: orgA, p_user: ids.client, p_permission: 'ai.use', p_granted: false,
    })).error)).toBe('42501');
  });
});

describe('the resolver: TypeScript and SQL compute the same effective permissions', () => {
  it.each(['owner', 'admin', 'accountant', 'client', 'third'] as Who[])('%s', async (who) => {
    const { data } = await rpc(who, 'my_access', { p_slug: slugA });
    const row = (data as Array<{ role: EffectiveRole; overrides: unknown; permissions: string[] }>)[0]!;
    const computed = [...resolvePermissions(row.role, parseOverrides(row.overrides))].sort();
    expect(computed).toEqual([...row.permissions].sort());
  });

  it('… including a person with switches', async () => {
    adminSql(`insert into public.member_permission_overrides (organization_id, user_id, permission, granted) values
      ('${orgA}', '${ids.client2}', 'documents.view', true), ('${orgA}', '${ids.client2}', 'ai.use', false)`);
    try {
      const { data } = await rpc('client2', 'my_access', { p_slug: slugA });
      const row = (data as Array<{ role: EffectiveRole; overrides: unknown; permissions: string[] }>)[0]!;
      expect(row.permissions).toContain('documents.view');
      expect(row.permissions).not.toContain('ai.use');
      expect([...resolvePermissions(row.role, parseOverrides(row.overrides))].sort()).toEqual([...row.permissions].sort());
    } finally {
      adminSql(`delete from public.member_permission_overrides where user_id = '${ids.client2}'`);
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
    expect(Number(adminSql(`select count(*) from public.audit_events where organization_id = '${orgA}' and action = 'member.permission_changed'`)))
      .toBe(3);
  });

  it('switching on something the admin does not hold is refused (service and database)', async () => {
    await setMemberPermission(await ctxFor('owner'), { userId: ids.admin2, permission: 'audit.view', granted: false });
    const admin2 = await ctxFor('admin2');
    expect(admin2.permissions.has('audit.view')).toBe(false);
    expect(await outcome(setMemberPermission(admin2, { userId: ids.client, permission: 'audit.view', granted: true })))
      .toBe('PERMISSION_DENIED');
    expect(sqlstate((await rpc('admin2', 'set_member_permission', {
      p_org: orgA, p_user: ids.client, p_permission: 'audit.view', p_granted: true,
    })).error)).toBe('42501');
    expect(await rows('client', 'audit_events')).toBe(0);
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

  it('nobody writes the switches table directly', async () => {
    const { error } = await db('owner').from('member_permission_overrides')
      .insert({ organization_id: orgA, user_id: ids.client, permission: 'ai.use', granted: false });
    expect(error).not.toBeNull();
  });

  // ADR-172 hardening (2026-10-14, migration 20261018000032): a role change CARRIES the switches an
  // owner set and clears the rest — it used to clear them all, which let a role round trip undo the
  // owner's decision.
  it('a role change carries the owner\'s switches and clears the rest', async () => {
    await setMemberPermission(await ctxFor('owner'), { userId: ids.accountant, permission: 'financials.view', granted: false });
    await setMemberPermission(await ctxFor('admin'), { userId: ids.accountant, permission: 'data.export', granted: false });
    expect(await rows('accountant', 'ledger_entries')).toBe(0);
    const changed = await rpc('owner', 'change_member_role', { p_org: orgA, p_user: ids.accountant, p_role: 'client' });
    expect(changed.error).toBeNull();
    expect(adminSql(`select string_agg(permission, ',' order by permission) from public.member_permission_overrides where user_id = '${ids.accountant}'`))
      .toBe('financials.view');
    expect(adminSql(`select count(*) from public.audit_events where organization_id = '${orgA}' and action = 'member.permissions_reset'`)).toBe('1');
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
    expect(adminSql(`select string_agg(permission, ',' order by permission) from public.member_permission_overrides where user_id = '${ids.client}'`))
      .toBe('ai.use');
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
    const stored = adminSql(`select array_to_string(permissions, ',') from public.access_requests where id = '${requestId}'`);
    expect(stored).toBe('documents.view,financials.view'); // what they already hold is dropped
    const told = adminSql(`select string_agg(user_id::text, ',' order by user_id) from public.notifications
                            where organization_id = '${orgA}' and kind = 'access_request'`).split(',').sort();
    expect(told).toEqual([ids.owner, ids.owner2, ids.admin, ids.admin2].sort());
    expect(adminSql(`select href from public.notifications where kind = 'access_request' and user_id = '${ids.owner}'`))
      .toBe(`/app/${slugA}/settings/team#requests`);
    expect(adminSql(`select count(*) from public.audit_events where organization_id = '${orgA}' and action = 'member.access_requested'`)).toBe('1');
  });

  it('one waiting request at a time', async () => {
    expect(await outcome(requestAccess(await ctxFor('third'), { permissions: ['ai.use'], message: null }))).toBe('CONFLICT');
  });

  it('the requester sees their own; a client sees none of it; a manager sees it', async () => {
    const own = await listAccessRequests(await ctxFor('third'), { status: 'pending' });
    expect(own.map((r) => r.id)).toEqual([requestId]);
    expect(own[0]!.requesterRole).toBe('third_party');
    expect(await listAccessRequests(await ctxFor('client'))).toEqual([]);
    expect((await db('client').from('access_requests').select('id').eq('organization_id', orgA)).data).toEqual([]);
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
    const row = adminSql(`select status || '|' || array_to_string(granted, ',') || '|' || note from public.access_requests where id = '${requestId}'`);
    expect(row).toBe('approved|financials.view|Ledger only for now.');
    expect(await rows('third', 'ledger_entries')).toBe(1);
    expect(await rows('third', 'source_documents')).toBe(0);
    expect(adminSql(`select title from public.notifications where kind = 'access_decision' and user_id = '${ids.third}'`))
      .toBe('Your request for more access was approved');
    expect(await outcome(decideAccessRequest(await ctxFor('owner'), { id: requestId, approve: false }))).toBe('CONFLICT');
  });

  it('an answer may only switch on what was asked', async () => {
    const { id } = await requestAccess(await ctxFor('third'), { permissions: ['documents.view'], message: null });
    expect(sqlstate((await rpc('owner', 'decide_access_request', {
      p_id: id, p_approve: true, p_permissions: ['ai.use'],
    })).error)).toBe('22023');
    await decideAccessRequest(await ctxFor('owner'), { id, approve: false, note: 'Not yet.' });
    expect(adminSql(`select status || '|' || note from public.access_requests where id = '${id}'`)).toBe('declined|Not yet.');
    expect(await rows('third', 'source_documents')).toBe(0);
  });

  it('approval needs the decider to hold each permission', async () => {
    // admin2's audit.view was switched off above.
    const { id } = await requestAccess(await ctxFor('client'), { permissions: ['audit.view'], message: null });
    expect(await outcome(decideAccessRequest(await ctxFor('admin2'), { id, approve: true }))).toBe('PERMISSION_DENIED');
    expect(sqlstate((await rpc('admin2', 'decide_access_request', { p_id: id, p_approve: true })).error)).toBe('42501');
    expect(adminSql(`select status from public.access_requests where id = '${id}'`)).toBe('pending');
    await decideAccessRequest(await ctxFor('owner'), { id, approve: true });
    expect(await rows('client', 'audit_events')).toBeGreaterThan(0);
    await setMemberPermission(await ctxFor('owner'), { userId: ids.client, permission: 'audit.view', granted: null });
    expect(await rows('client', 'audit_events')).toBe(0);
  });

  it('the requester may withdraw a waiting request; nobody else may', async () => {
    const { id } = await requestAccess(await ctxFor('third'), { permissions: [], message: 'Could I see the bank lines?' });
    expect(sqlstate((await rpc('client', 'withdraw_access_request', { p_id: id })).error)).toBe('P0002');
    await withdrawAccessRequest(await ctxFor('third'), id);
    expect(adminSql(`select status from public.access_requests where id = '${id}'`)).toBe('withdrawn');
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
    expect(adminSql(`select status from public.access_requests where id = '${id}'`)).toBe('declined');
    await setMemberPermission(await ctxFor('owner'), { userId: ids.accountant, permission: 'ai.use', granted: false });
    expect((await rpc('owner', 'remove_member', { p_org: orgA, p_user: ids.accountant })).error).toBeNull();
    expect(adminSql(`select count(*) from public.access_requests where requester_id = '${ids.accountant}'`)).toBe('0');
    expect(adminSql(`select count(*) from public.member_permission_overrides where user_id = '${ids.accountant}'`)).toBe('0');
  });
});

describe('invitations take the new roles', () => {
  it('an admin may invite an accountant and a 3rd party, never an owner', async () => {
    const admin = await ctxFor('admin');
    expect(await outcome(inviteMember(admin, { email: `acc-invite@${DOMAIN}`, role: 'accountant' }))).toBe('ok');
    expect(await outcome(inviteMember(admin, { email: `lender-invite@${DOMAIN}`, role: 'third_party' }))).toBe('ok');
    expect(await outcome(inviteMember(admin, { email: `owner-invite@${DOMAIN}`, role: 'owner' }))).toBe('PERMISSION_DENIED');
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
