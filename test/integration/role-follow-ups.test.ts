import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isMotionError } from '@/core/errors';
import { assignAction, assignableOwners } from '@/modules/actions';
import { loadHome } from '@/modules/dashboard';
import { loadDataCompliance } from '@/modules/departments';
import { listNotifications, unreadCount } from '@/modules/engagement';
import { getMonthlyReport, getMonthlySummary, listAvailable } from '@/modules/reporting';
import { checkAffordability, listScenarios } from '@/modules/scenarios';
import { decideAccessRequest, requestAccess, type AccessContext } from '@/modules/tenancy';
import { auth } from '@/db/firestore';
import { periodId as periodIdOf } from '@/db/app/shared';
import { globalRow, orgRow, overrideId } from '@/db/schema';
import type { Db } from '@/db/types';
import { clientFor, createAuthUser, fs, rpc as callRpc, sqlstate } from './setup';
import {
  addMember, assign, ctxFor as contextFor, dropOrg, dropPlatformUser, makePlatformUser, rawCount, seedRow,
} from './tenancy-fixtures';

/**
 * ADR-172's follow-ups against the data layer: what a 3rd party, an accountant and a Financial
 * Analyst meet on the pages that broke when the detail tables closed to the 3rd party.
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
const DOMAIN = `${RUN}.followups.itest.motion`;

type Who = 'owner' | 'accountant' | 'client' | 'third' | 'analyst';
const ids = {} as Record<Who, string>;
let orgId: string;
let slug: string;
let periodId: string;
let actionId: string;

const email = (who: Who) => `${who}@${DOMAIN}`;
const db = (who: Who): Db => clientFor(ids[who], { email: email(who) });
const rpc = (who: Who, fn: string, args: Record<string, unknown>) => callRpc(db(who), fn, args);

/** The context a page hands a service, from the same api.my_access the resolver calls. */
async function ctxFor(who: Who): Promise<AccessContext> {
  const ctx = await contextFor(ids[who], orgId, { email: email(who), requestId: `itest-${RUN}` });
  return { ...ctx, actorType: who === 'analyst' ? 'employee' : 'user', organizationStatus: 'active' };
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
  for (const who of ['owner', 'accountant', 'client', 'third', 'analyst'] as Who[]) ids[who] = await createAuthUser(email(who));
  const created = await rpc('owner', 'create_organization', { p_name: `ITest Followups ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as string;
  slug = String((await globalRow(fs(), 'organizations', orgId).get()).get('slug'));

  await addMember(orgId, ids.accountant, 'accountant');
  await addMember(orgId, ids.client, 'client');
  await addMember(orgId, ids.third, 'third_party');
  await makePlatformUser(ids.analyst, 'employee');
  await assign(orgId, ids.analyst, { endsAt: new Date(Date.now() + 365 * 86_400_000).toISOString() });
  for (const who of ['accountant', 'client', 'third', 'analyst'] as Who[]) {
    const name = `${who[0]!.toUpperCase()}${who.slice(1)} ${RUN}`;
    await globalRow(fs(), 'profiles', ids[who]).update({ full_name: name });
  }

  // One accepted record, one complete month with a figure and a score, an open action given to the
  // accountant, an open alert, and an import waiting for review.
  periodId = periodIdOf(orgId, '2026-03-01');
  const acct = await seedRow(orgId, 'accounts', {
    name: `F${RUN} Sales`, normalized_name: `f${RUN} sales`, account_type: 'income', standard_category: 'revenue',
  });
  await seedRow(orgId, 'ledger_entries', {
    entry_date: '2026-03-10', period_id: periodId, account_id: acct.id, direction: 'credit', amount: '100.00', record_status: 'accepted',
  });
  await orgRow(fs(), orgId, 'fiscal_periods', periodId).update({ is_complete: true });
  const run = await seedRow(orgId, 'calculation_runs', {
    trigger: 'recalc_manual', engine_version: '1.0.0', period_from: periodId, period_to: periodId, as_of: '2026-03-31', status: 'succeeded',
  });
  const snap = await seedRow(orgId, 'metric_snapshots', {
    calculation_run_id: run.id, period_id: periodId, metric_key: 'revenue', unit: 'money', basis: 'ledger',
    assurance_level: 'verified', value: '100.00', currency: 'GBP', data_quality: { completeness: 1, warnings: [], missing: [] },
  });
  await seedRow(orgId, 'metric_current', { period_id: periodId, metric_key: 'revenue', snapshot_id: snap.id, calculation_run_id: run.id });
  const health = await seedRow(orgId, 'health_scores', {
    calculation_run_id: run.id, period_id: periodId, score: 70, dimensions_used: 5, dimensions_total: 5, config_version: 'v1',
  });
  await seedRow(orgId, 'health_current', { period_id: periodId, health_score_id: health.id, calculation_run_id: run.id });
  await seedRow(orgId, 'alerts', {
    rule_key: 'itest.rule', rule_version: '1', severity: 'high', period_id: periodId, title: 'Overdue',
    explanation: `F${RUN} Customer is 60 days overdue`, dedupe_key: `f${RUN}-d`, key_kind: 'state', calculation_run_id: run.id,
  });
  const action = await seedRow(orgId, 'actions', { title: `F${RUN} chase the invoice`, owner_user_id: ids.accountant });
  actionId = String(action.id);
  const doc = await seedRow(orgId, 'source_documents', {
    storage_path: `${orgId}/doc/f${RUN}.csv`, original_filename: `f${RUN}.csv`, mime_type: 'text/csv', byte_size: 10,
    sha256: createHash('sha256').update(`f${RUN}`).digest('hex'), status: 'ready',
  });
  await seedRow(orgId, 'import_batches', {
    source_document_id: doc.id, import_type: 'general_ledger', target_table: 'ledger_entries',
    period_start: '2026-03-01', period_end: '2026-03-31', status: 'awaiting_review',
  });
}, 120_000);

afterAll(async () => {
  if (orgId) await dropOrg(orgId);
  await dropPlatformUser(ids.analyst);
  for (const id of Object.values(ids)) {
    await auth().deleteUser(id).catch(() => undefined);
    await fs().collection('profiles').doc(id).delete();
    const limits = await fs().collection('api_rate_limits').where('actor_user_id', '==', id).get();
    for (const d of limits.docs) await d.ref.delete();
  }
  const events = await fs().collection('audit_events').where('organization_id', '==', orgId).get();
  for (const d of events.docs) await d.ref.delete();
}, 120_000);

describe('Home and the reports, for a 3rd party', () => {
  it('shows a company with records its figures, never "upload your first file"', async () => {
    const ctx = await ctxFor('third');
    const state = await loadHome(ctx.db, orgId, slug, ctx.requestId);
    expect(state.kind).not.toBe('first_run');
    expect(state.kind === 'ready' || state.kind === 'bank_only').toBe(true);
  });

  /*
   * ADR-172 addendum (2026-10-14): a 3rd party's monthly report is the SUMMARY EDITION — figures and
   * the Business Health Score, built from the overview — and the full report (alerts, open actions)
   * is refused them rather than shown with those sections emptied. The intent is unchanged: they open
   * their month's report without the Action Centre or the alerts. (report-summary-edition.test.ts
   * checks the edition's PDF text; pgTAP 32 the database's side.)
   */
  it('opens the Monthly Management Report (its summary edition) without the Action Centre or the alerts it may not read', async () => {
    const ctx = await ctxFor('third');
    expect((await listAvailable(ctx)).map((r) => r.periodId)).toEqual([periodId]);
    const summary = await getMonthlySummary(ctx, periodId);
    expect(summary).not.toBeNull();
    expect(summary!.edition).toBe('summary');
    expect(summary!.figures.length).toBeGreaterThan(0);
    expect(summary!.health?.score).toBe(70);
    // No section for either, and neither's words anywhere in it.
    expect(Object.keys(summary!)).not.toContain('alerts');
    expect(Object.keys(summary!)).not.toContain('openActions');
    expect(JSON.stringify(summary)).not.toContain(`F${RUN}`);
    // The full report is refused them.
    expect(await outcome(getMonthlyReport(ctx, periodId))).toBe('PERMISSION_DENIED');
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
    await seedRow(orgId, 'notifications', {
      user_id: ids.third, kind: 'action_comment', title: `New comment on "F${RUN} chase the invoice"`, body: 'detail',
      href: `/app/${slug}/actions/${actionId}`,
    });
    await seedRow(orgId, 'notifications', { user_id: ids.client, kind: 'report_ready', title: "Someone else's", body: null, href: null });
    const third = await ctxFor('third');
    const { id } = await requestAccess(third, { permissions: ['financials.view'], message: 'For the loan review.' });
    await decideAccessRequest(await ctxFor('owner'), { id, approve: false, note: 'Not yet.' });

    const items = await listNotifications(third);
    expect(items.map((n) => n.kind)).toEqual(['access_decision']);
    expect(items[0]!.href).toBe(`/app/${slug}/access`);
    expect(items[0]!.body).toBe('Not yet.');
    expect(await unreadCount(third)).toBe(1);
    // The action comment is still stored — only no longer shown to someone without the Action Centre.
    expect(await rawCount(orgId, 'notifications', ['kind', 'action_comment'])).toBe(1);
  });
});

describe('an action goes only to someone who can see the Action Centre', () => {
  it('refuses a 3rd party as the assignee, at the database and through the service', async () => {
    const { error } = await rpc('owner', 'assign_action', { p_action: actionId, p_owner: ids.third });
    expect(sqlstate(error)).toBe('22023');
    expect(await outcome(assignAction(await ctxFor('owner'), actionId, ids.third))).toBe('VALIDATION');
  });

  it('refuses a client whose Action Centre is switched off, and accepts them once it is back', async () => {
    const off = orgRow(fs(), orgId, 'member_permission_overrides', overrideId(ids.client, 'actions.view'));
    await off.set({
      organization_id: orgId, user_id: ids.client, permission: 'actions.view', granted: false, set_by: null,
      set_at: new Date().toISOString(), set_by_owner: false, ceiling_withhold: false,
    });
    try {
      expect(sqlstate((await rpc('owner', 'assign_action', { p_action: actionId, p_owner: ids.client })).error)).toBe('22023');
      const offered = (await assignableOwners(await ctxFor('owner'))).map((o) => o.userId);
      expect(offered).not.toContain(ids.client);
    } finally {
      await off.delete();
    }
    expect((await rpc('owner', 'assign_action', { p_action: actionId, p_owner: ids.client })).error).toBeNull();
    expect((await rpc('owner', 'assign_action', { p_action: actionId, p_owner: ids.accountant })).error).toBeNull();
  });

  it('offers exactly the people who can see it — the assigned Financial Analyst included, the 3rd party never', async () => {
    const offered = await assignableOwners(await ctxFor('owner'));
    expect(offered.map((o) => o.userId).sort()).toEqual([ids.owner, ids.accountant, ids.client, ids.analyst].sort());
    expect(offered.find((o) => o.userId === ids.analyst)?.name).toBe(`Analyst ${RUN}`);
  });

  it('lets the Financial Analyst list and assign (since ADR-187 they also hold users.view in their companies)', async () => {
    const analyst = await ctxFor('analyst');
    expect(analyst.permissions.has('actions.assign')).toBe(true);
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
    const country = String((await globalRow(fs(), 'organizations', orgId).get()).get('country_code'));
    if (country === 'GB' || country === 'AE') expect(view.tax!.corporationTax?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('leaves out every line a 3rd party may not read, rather than saying "none"', async () => {
    const view = await loadDataCompliance(await ctxFor('third'), '2026-10-14');
    expect(view).toEqual({ imports: null, lastDataAdded: null, tax: null, myActions: null });
  });
});
