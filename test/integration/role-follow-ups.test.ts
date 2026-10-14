import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMotionError } from '@/core/errors';
import type { EffectiveRole } from '@/core/permissions';
import { assignAction, assignableOwners } from '@/modules/actions';
import { loadHome } from '@/modules/dashboard';
import { loadDataCompliance } from '@/modules/departments';
import { listNotifications, unreadCount } from '@/modules/engagement';
import { getMonthlyReport, listAvailable } from '@/modules/reporting';
import { checkAffordability, listScenarios } from '@/modules/scenarios';
import {
  agreedPermissions, decideAccessRequest, requestAccess, type AccessContext,
} from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, sqlstate } from './setup';

/**
 * ADR-172's follow-ups against the database: what a 3rd party, an accountant and a Financial Analyst
 * meet on the pages that broke when the detail tables closed to the 3rd party.
 *
 *   - Home: a 3rd party in a company WITH records is shown its figures, never "upload your first
 *     file" (`api.has_accepted_records`), and the Monthly Management Report opens without the Action
 *     Centre it may not read.
 *   - The inbox: one's own notifications, filtered by what one may still open, and the answer to an
 *     access request opening "Your access".
 *   - Actions: `api.assign_action` refuses an assignee without `actions.view` (a 3rd party, a client
 *     switched off), and `api.action_assignees` lists exactly whom it accepts — to a Financial Analyst
 *     too, who holds `actions.assign` and not `users.view`.
 *   - "Data & compliance" for an accountant; What-if refused without the figures.
 *
 * Run-unique fixtures (ADR-052.12), removed afterwards.
 */

const RUN = `f${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.followups.itest`;

type Who = 'owner' | 'accountant' | 'client' | 'third' | 'analyst';
const ids = {} as Record<Who, string>;
let orgId: string;
let slug: string;
let periodId: string;
let actionId: string;

const email = (who: Who) => `${who}@${DOMAIN}`;
const db = (who: Who): SupabaseClient => clientFor(ids[who], { email: email(who) });
const rpc = (who: Who, fn: string, args: Record<string, unknown>) => db(who).schema('api').rpc(fn, args);

/** The context a page hands a service, from the same api.my_access the resolver calls. */
async function ctxFor(who: Who): Promise<AccessContext> {
  const { data, error } = await rpc(who, 'my_access', { p_slug: slug });
  if (error) throw new Error(error.message);
  const row = (data as Array<{ role: EffectiveRole; overrides: unknown; permissions: string[] }>)[0];
  if (!row) throw new Error(`${who} has no access to ${slug}`);
  return {
    userId: ids[who], orgId, orgSlug: slug, effectiveRole: row.role,
    permissions: agreedPermissions(row.role, row.overrides, row.permissions).agreed,
    actorType: who === 'analyst' ? 'employee' : 'user', db: db(who), requestId: `itest-${RUN}`,
    now: () => new Date(), organizationStatus: 'active',
  };
}

async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return isMotionError(error) ? error.code : `thrown: ${String(error)}`;
  }
}

beforeAll(async () => {
  for (const who of ['owner', 'accountant', 'client', 'third', 'analyst'] as Who[]) ids[who] = createAuthUser(email(who));
  const created = await rpc('owner', 'create_organization', { p_name: `ITest Followups ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as string;
  slug = adminSql(`select slug from public.organizations where id = '${orgId}'`);

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role) values
      ('${orgId}', '${ids.accountant}', 'accountant'),
      ('${orgId}', '${ids.client}', 'client'),
      ('${orgId}', '${ids.third}', 'third_party');
    insert into public.platform_users (user_id, platform_role) values ('${ids.analyst}', 'employee');
    insert into public.organization_assignments (organization_id, employee_user_id) values ('${orgId}', '${ids.analyst}');
    update public.profiles set full_name = 'Accountant ${RUN}' where id = '${ids.accountant}';
    update public.profiles set full_name = 'Client ${RUN}' where id = '${ids.client}';
    update public.profiles set full_name = 'Third ${RUN}' where id = '${ids.third}';
    update public.profiles set full_name = 'Analyst ${RUN}' where id = '${ids.analyst}';`);

  // One accepted record, one complete month with a figure and a score, an open action given to the
  // accountant, an open alert, and an import waiting for review.
  periodId = adminSql(`
    do $$
    declare v_org uuid := '${orgId}'; v_acct uuid; v_period uuid; v_run uuid; v_snap uuid; v_health uuid; v_doc uuid;
    begin
      insert into public.accounts (organization_id, name, normalized_name, account_type, standard_category)
      values (v_org, 'F${RUN} Sales', 'f${RUN} sales', 'income', 'revenue') returning id into v_acct;
      insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, record_status)
      values (v_org, '2026-03-10', v_acct, 'credit', 100, 'accepted') returning period_id into v_period;
      update public.fiscal_periods set is_complete = true where id = v_period;
      insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
      values (v_org, 'recalc_manual', '1.0.0', v_period, v_period, '2026-03-31', 'succeeded') returning id into v_run;
      insert into public.metric_snapshots
        (organization_id, calculation_run_id, period_id, metric_key, unit, basis, assurance_level, value, currency, data_quality)
      values (v_org, v_run, v_period, 'revenue', 'money', 'ledger', 'verified', 100, 'GBP',
              '{"completeness": 1, "warnings": [], "missing": []}'::jsonb) returning id into v_snap;
      insert into public.metric_current (organization_id, period_id, metric_key, snapshot_id, calculation_run_id)
      values (v_org, v_period, 'revenue', v_snap, v_run);
      insert into public.health_scores (organization_id, calculation_run_id, period_id, score, dimensions_used, dimensions_total, config_version)
      values (v_org, v_run, v_period, 70, 5, 5, 'v1') returning id into v_health;
      insert into public.health_current (organization_id, period_id, health_score_id) values (v_org, v_period, v_health);
      insert into public.alerts (organization_id, rule_key, rule_version, severity, period_id, title, explanation, dedupe_key, key_kind, calculation_run_id)
      values (v_org, 'itest.rule', '1', 'high', v_period, 'Overdue', 'F${RUN} Customer is 60 days overdue', 'f${RUN}-d', 'state', v_run);
      insert into public.actions (organization_id, title, owner_user_id) values (v_org, 'F${RUN} chase the invoice', '${ids.accountant}');
      insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status)
      values (v_org, v_org::text || '/doc/f${RUN}.csv', 'f${RUN}.csv', 'text/csv', 10, extensions.digest('f${RUN}', 'sha256'), 'ready')
      returning id into v_doc;
      insert into public.import_batches (organization_id, source_document_id, import_type, target_table, period_start, period_end, status)
      values (v_org, v_doc, 'general_ledger', 'ledger_entries', '2026-03-01', '2026-03-31', 'awaiting_review');
    end $$;
    select period_id from public.ledger_entries where organization_id = '${orgId}' limit 1;`).split('\n').pop()!.trim();
  actionId = adminSql(`select id from public.actions where organization_id = '${orgId}' limit 1`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Followups%${RUN}';
    delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from public.api_rate_limits where actor_user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Followups %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.followups.itest' and created_at < now() - interval '1 hour';`);
});

describe('Home and the reports, for a 3rd party', () => {
  it('shows a company with records its figures, never "upload your first file"', async () => {
    const ctx = await ctxFor('third');
    const state = await loadHome(ctx.db, orgId, slug, ctx.requestId);
    expect(state.kind).not.toBe('first_run');
    expect(state.kind === 'ready' || state.kind === 'bank_only').toBe(true);
  });

  it('opens the Monthly Management Report without the Action Centre or the alerts it may not read', async () => {
    const ctx = await ctxFor('third');
    expect((await listAvailable(ctx)).map((r) => r.periodId)).toEqual([periodId]);
    const report = await getMonthlyReport(ctx, periodId);
    expect(report).not.toBeNull();
    expect(report!.openActions).toEqual([]);
    expect(report!.alerts).toEqual([]);
    expect(report!.cards.length).toBeGreaterThan(0);
  });

  it('… while an owner reads the same report with its open action and alert', async () => {
    const report = await getMonthlyReport(await ctxFor('owner'), periodId);
    expect(report!.openActions.map((a) => a.id)).toEqual([actionId]);
    expect(report!.alerts).toHaveLength(1);
  });

  it('refuses the What-if reads without the figures beneath the overview', async () => {
    const third = await ctxFor('third');
    expect(await outcome(listScenarios(third))).toBe('PERMISSION_DENIED');
    expect(await outcome(checkAffordability(third, { amount: '100', recurrence: 'one_off', startsInMonth: 1 })))
      .toBe('PERMISSION_DENIED');
    expect(await outcome(listScenarios(await ctxFor('client')))).toBe('ok');
  });
});

describe('the inbox is personal and shows only what one may still open', () => {
  it('gives a 3rd party their own notifications, drops kinds they cannot open, and opens a decision on "Your access"', async () => {
    adminSql(`insert into public.notifications (organization_id, user_id, kind, title, body, href) values
      ('${orgId}', '${ids.third}', 'action_comment', 'New comment on "F${RUN} chase the invoice"', 'detail', '/app/${slug}/actions/${actionId}'),
      ('${orgId}', '${ids.client}', 'report_ready', 'Someone else''s', null, null)`);
    const third = await ctxFor('third');
    const { id } = await requestAccess(third, { permissions: ['financials.view'], message: 'For the loan review.' });
    await decideAccessRequest(await ctxFor('owner'), { id, approve: false, note: 'Not yet.' });

    const items = await listNotifications(third);
    expect(items.map((n) => n.kind)).toEqual(['access_decision']);
    expect(items[0]!.href).toBe(`/app/${slug}/access`);
    expect(items[0]!.body).toBe('Not yet.');
    expect(await unreadCount(third)).toBe(1);
    // The action comment is still stored — only no longer shown to someone without the Action Centre.
    expect(Number(adminSql(`select count(*) from public.notifications where user_id = '${ids.third}' and kind = 'action_comment'`))).toBe(1);
  });
});

describe('an action goes only to someone who can see the Action Centre', () => {
  it('refuses a 3rd party as the assignee, at the database and through the service', async () => {
    const { error } = await rpc('owner', 'assign_action', { p_action: actionId, p_owner: ids.third });
    expect(sqlstate(error)).toBe('22023');
    expect(await outcome(assignAction(await ctxFor('owner'), actionId, ids.third))).toBe('VALIDATION');
  });

  it('refuses a client whose Action Centre is switched off, and accepts them once it is back', async () => {
    adminSql(`insert into public.member_permission_overrides (organization_id, user_id, permission, granted)
      values ('${orgId}', '${ids.client}', 'actions.view', false)`);
    try {
      expect(sqlstate((await rpc('owner', 'assign_action', { p_action: actionId, p_owner: ids.client })).error)).toBe('22023');
      const offered = (await assignableOwners(await ctxFor('owner'))).map((o) => o.userId);
      expect(offered).not.toContain(ids.client);
    } finally {
      adminSql(`delete from public.member_permission_overrides where organization_id = '${orgId}' and user_id = '${ids.client}'`);
    }
    expect((await rpc('owner', 'assign_action', { p_action: actionId, p_owner: ids.client })).error).toBeNull();
    expect((await rpc('owner', 'assign_action', { p_action: actionId, p_owner: ids.accountant })).error).toBeNull();
  });

  it('offers exactly the people who can see it — the assigned Financial Analyst included, the 3rd party never', async () => {
    const offered = await assignableOwners(await ctxFor('owner'));
    expect(offered.map((o) => o.userId).sort()).toEqual([ids.owner, ids.accountant, ids.client, ids.analyst].sort());
    expect(offered.find((o) => o.userId === ids.analyst)?.name).toBe(`Analyst ${RUN}`);
  });

  it('lets the Financial Analyst — actions.assign without users.view — list and assign', async () => {
    const analyst = await ctxFor('analyst');
    expect(analyst.permissions.has('users.view')).toBe(false);
    expect((await assignableOwners(analyst)).map((o) => o.userId)).toContain(ids.accountant);
    expect(await outcome(assignAction(analyst, actionId, ids.accountant))).toBe('ok');
  });

  it('refuses the list to someone who may not assign', async () => {
    expect(sqlstate((await rpc('client', 'action_assignees', { p_org: orgId })).error)).toBe('42501');
    expect(sqlstate((await rpc('third', 'action_assignees', { p_org: orgId })).error)).toBe('42501');
  });
});

describe('"Data & compliance" for an accountant', () => {
  it('counts the upload waiting, names their own open action and the Corporation Tax date', async () => {
    const view = await loadDataCompliance(await ctxFor('accountant'), '2026-10-14');
    expect(view.imports).toEqual({ awaitingReview: 1, failed: 0 });
    expect(view.myActions?.open).toBe(1);
    expect(view.myActions?.top.map((a) => a.id)).toEqual([actionId]);
    expect(view.tax).not.toBeNull();
    const country = adminSql(`select country_code from public.organizations where id = '${orgId}'`);
    if (country === 'GB' || country === 'AE') expect(view.tax!.corporationTax?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('leaves out every line a 3rd party may not read, rather than saying "none"', async () => {
    const view = await loadDataCompliance(await ctxFor('third'), '2026-10-14');
    expect(view).toEqual({ imports: null, lastDataAdded: null, tax: null, myActions: null });
  });
});
