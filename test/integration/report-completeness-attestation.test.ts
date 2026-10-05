import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainJobs } from '@/modules/jobs';
import { permissionsFor } from '@/core/permissions';
import { buildBundleForMetric, loadEvidenceDrawer } from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { calculateAndAlert } from '../fixtures/adr120-orgs';
import { balanceBatch, counterparty, glBatch, invoiceBatch } from '../fixtures/audit-orgs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * Step 0F follow-up — an owner confirms what an EXISTING report covers (owner decision after the
 * N-1 re-review). The reports here are committed the way an import made before the question existed
 * is stored: no IMP-TB-016 answer. Each case seeds its own organisation inside its own test.
 *
 * Expected figures, by hand. July: a ledger stating revenue 1,100 (and its cash), and a trial balance
 * stating revenue 5,000, operating expenses 800 and cash 4,200 — it balances (−5,000 + 800 + 4,200).
 *   unconfirmed → the ledger states July (1,100, calculated), warning balance_report_incomplete;
 *   confirmed complete → the report states July: revenue 5,000, operating expenses 800, every other
 *     category zero, net profit 4,200, verified;
 *   corrected to partial → the ledger again (1,100).
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.attest.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]?.trim() ?? '';
const lines = (sql: string): string[] => adminSql(sql).split('\n').map((l) => l.trim()).filter(Boolean);
let n = 0;

interface Org { id: string; owner: string; admin: string; employee: string; client: string }

function member(org: string, role: 'admin' | 'client'): string {
  const user = createAuthUser(`${role}-${n++}@${DOMAIN}`);
  adminSql(`set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role, status) values ('${org}', '${user}', '${role}', 'active');`);
  return user;
}

/** A platform employee ASSIGNED to the organisation: holds imports.review there, but is no owner or admin. */
function employee(org: string): string {
  const user = createAuthUser(`employee-${n++}@${DOMAIN}`);
  adminSql(`insert into public.platform_users (user_id, platform_role, status) values ('${user}', 'employee', 'active');
    update public.profiles set mfa_enrolled_at = now() where id = '${user}';
    insert into public.organization_assignments (organization_id, employee_user_id, status) values ('${org}', '${user}', 'active');`);
  return user;
}

async function org(label: string): Promise<Org> {
  const owner = createAuthUser(`owner-${n++}@${DOMAIN}`);
  const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ITest Attest ${label} ${RUN}` });
  if (r.error) throw new Error(r.error.message);
  const id = r.data as unknown as string;
  return { id, owner, admin: member(id, 'admin'), employee: employee(id), client: member(id, 'client') };
}

const attest = (user: string, batch: string, month: string, coverage: string, reason = 'Compared with the full trial balance in our accounts') =>
  clientFor(user, { aal: 'aal2' }).schema('api').rpc('attest_report_completeness', { p_batch: batch, p_period_start: month, p_coverage: coverage, p_reason: reason });

/** Drains the recalculation the attestation itself queued (not a test-made one). */
async function drainQueuedRecalculation(o: string, batch: string): Promise<void> {
  const job = one(`select id from public.jobs where organization_id = '${o}' and job_type = 'calculation.run'
    and payload ->> 'triggerRefId' = '${batch}' order by created_at desc limit 1`);
  expect(job, 'the attestation queued a recalculation').not.toBe('');
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
}

function metric(o: string, ym: string, key: string): string {
  return one(`select coalesce(s.value::numeric(16, 2)::text, 'NULL') || '|' || s.assurance_level || '|' || s.basis || '|'
      || coalesce((s.data_quality -> 'missing')::text, '[]') || '|' || coalesce((s.data_quality -> 'warnings')::text, '[]')
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o}' and c.metric_key = '${key}' and c.dimension_type = 'none' and p.period_start = '${ym}-01'`);
}
const head = (o: string, ym: string, key: string) => metric(o, ym, key).split('|').slice(0, 3);

/** A July ledger (revenue 1,100) and a July trial balance with no completeness answer. */
function mixed(o: string, extraction: 'csv' | 'pdf_claude' = 'csv'): string {
  glBatch(o, { start: '2026-07-01', end: '2026-07-31', tag: `gl-${n++}`, lines: [
    { date: '2026-07-05', category: 'cash', direction: 'debit', amount: '1100' },
    { date: '2026-07-05', category: 'revenue', direction: 'credit', amount: '1100' },
  ] });
  return balanceBatch(o, { importType: 'trial_balance', basis: 'movement', start: '2026-07-01', end: '2026-07-31', tag: `tb-${n++}`,
    extraction, rows: [['revenue', '-5000'], ['operating_expense', '800'], ['cash', '4200']] });
}

beforeAll(() => { /* each test seeds its own organisation */ });
afterAll(() => {
  adminSql(`delete from public.organizations where name like 'ITest Attest %${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('confirming an existing import', () => {
  it('unconfirmed → the ledger; owner confirms complete → the report, recalculated; admin corrects → the ledger again', async () => {
    const o = await org('FLOW');
    const tb = mixed(o.id);
    await calculateAndAlert(o.id);

    // Unconfirmed: the report is passed over for the ledger that covers July. Never a zero.
    expect(head(o.id, '2026-07', 'revenue')).toEqual(['1100.00', 'calculated', 'ledger']);
    expect(metric(o.id, '2026-07', 'revenue')).toContain('balance_report_incomplete');
    const before = one(`select c.snapshot_id from public.metric_current c join public.fiscal_periods p on p.id = c.period_id
      where c.organization_id = '${o.id}' and c.metric_key = 'revenue' and c.dimension_type = 'none' and p.period_start = '2026-07-01'`);

    // The owner reviews the stored file and confirms July — no re-upload.
    const first = await attest(o.owner, tb, '2026-07-01', 'complete');
    expect(first.error, first.error?.message).toBeNull();
    await drainQueuedRecalculation(o.id, tb);
    expect(head(o.id, '2026-07', 'revenue')).toEqual(['5000.00', 'verified', 'period_balances']);
    expect(head(o.id, '2026-07', 'operating_expenses')).toEqual(['800.00', 'verified', 'period_balances']);
    expect(head(o.id, '2026-07', 'net_profit')).toEqual(['4200.00', 'verified', 'period_balances']);

    // The earlier snapshot is kept, with its own basis and assurance.
    expect(one(`select value::numeric(16, 2)::text || '|' || assurance_level || '|' || basis from public.metric_snapshots where id = '${before}'`))
      .toBe('1100.00|calculated|ledger');

    // Evidence of the recalculated figure reconciles to the report's own rows.
    const ctx: AccessContext = { userId: o.owner, orgId: o.id, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
      actorType: 'user', db: clientFor(o.owner), requestId: RUN, now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active' };
    const snap = one(`select c.snapshot_id from public.metric_current c join public.fiscal_periods p on p.id = c.period_id
      where c.organization_id = '${o.id}' and c.metric_key = 'revenue' and c.dimension_type = 'none' and p.period_start = '2026-07-01'`);
    const view = await loadEvidenceDrawer(ctx, await buildBundleForMetric(ctx, snap));
    expect(view.records.map((b) => b.reconciles)).toEqual([true]);

    // An admin corrects it: the report was an extract after all.
    const second = await attest(o.admin, tb, '2026-07-01', 'partial', 'The file omits the payroll section');
    expect(second.error, second.error?.message).toBeNull();
    await drainQueuedRecalculation(o.id, tb);
    expect(head(o.id, '2026-07', 'revenue')).toEqual(['1100.00', 'calculated', 'ledger']);

    // History: both answers kept, the correction naming the one it replaces; audited with before/after.
    expect(lines(`select coverage || '|' || attested_role || '|' || (supersedes_id is not null)::text || '|' || scope
        from public.report_completeness_attestations where import_batch_id = '${tb}' order by attested_at, id`))
      .toEqual(['complete|owner|false|all_accounts', 'partial|admin|true|all_accounts']);
    expect(one(`select supersedes_id::text from public.report_completeness_attestations where id = '${second.data as string}'`))
      .toBe(first.data as string);
    expect(lines(`select (before ->> 'coverage') || '>' || (after ->> 'coverage') || '|' || (actor_user_id is not null)::text
        from public.audit_events where organization_id = '${o.id}' and action = 'report.completeness_attested' order by id`))
      .toEqual(['unconfirmed>complete|true', 'complete>partial|true']);
  }, 300_000);

  it('a report confirmed PARTIAL with no other source: what it lacks is NULL category_not_in_report, never zero', async () => {
    const o = await org('PARTIAL');
    const tb = balanceBatch(o.id, { importType: 'trial_balance', basis: 'movement', start: '2026-07-01', end: '2026-07-31', tag: `p-${n++}`,
      rows: [['revenue', '-5000'], ['operating_expense', '800'], ['cash', '4200']] });
    await calculateAndAlert(o.id);
    // Never answered: the reason says a confirmation is still possible.
    expect(metric(o.id, '2026-07', 'net_profit')).toContain('report_completeness_unconfirmed');
    expect((await attest(o.owner, tb, '2026-07-01', 'partial', 'Only the sales and overheads pages')).error).toBeNull();
    await drainQueuedRecalculation(o.id, tb);
    expect(head(o.id, '2026-07', 'revenue')).toEqual(['5000.00', 'verified', 'period_balances']);
    const net = metric(o.id, '2026-07', 'net_profit');
    expect(net.startsWith('NULL|')).toBe(true);
    expect(net).toContain('category_not_in_report');
    expect(net).not.toContain('report_completeness_unconfirmed');
  }, 300_000);

  it('a balancing total proves nothing by itself, and a confirmed trial balance that does not balance is still not complete', async () => {
    const o = await org('BALANCE');
    // Balances, unanswered: unknown, never zero.
    balanceBatch(o.id, { importType: 'trial_balance', basis: 'movement', start: '2026-07-01', end: '2026-07-31', tag: `b-${n++}`,
      rows: [['revenue', '-5000'], ['operating_expense', '800'], ['cash', '4200']] });
    // Does not balance, confirmed complete: the file contradicts the answer.
    const unbalanced = balanceBatch(o.id, { importType: 'trial_balance', basis: 'movement', start: '2026-08-01', end: '2026-08-31', tag: `u-${n++}`,
      rows: [['revenue', '-5000'], ['operating_expense', '800']] });
    expect((await attest(o.owner, unbalanced, '2026-08-01', 'complete')).error).toBeNull();
    await calculateAndAlert(o.id);
    expect(metric(o.id, '2026-07', 'net_profit').startsWith('NULL|')).toBe(true);
    expect(metric(o.id, '2026-07', 'net_profit')).toContain('report_completeness_unconfirmed');
    expect(metric(o.id, '2026-08', 'net_profit').startsWith('NULL|')).toBe(true);
    expect(metric(o.id, '2026-08', 'net_profit')).toContain('category_not_in_report');
  }, 300_000);

  it('completeness is not accuracy: an AI-read report confirmed complete stays inferred — its zeros too', async () => {
    const o = await org('AIREAD');
    const tb = balanceBatch(o.id, { importType: 'trial_balance', basis: 'movement', start: '2026-07-01', end: '2026-07-31', tag: `ai-${n++}`,
      extraction: 'pdf_claude', rows: [['revenue', '-5000'], ['operating_expense', '800'], ['cash', '4200']] });
    expect((await attest(o.owner, tb, '2026-07-01', 'complete')).error).toBeNull();
    await drainQueuedRecalculation(o.id, tb);
    expect(head(o.id, '2026-07', 'revenue')).toEqual(['5000.00', 'inferred', 'period_balances']);
    // Marketing has no line: a zero by completeness, at the report's own assurance — never verified.
    const marketing = one(`select coalesce(s.value::numeric(16, 2)::text, 'NULL') || '|' || s.assurance_level
      from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
      join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
     where c.organization_id = '${o.id}' and c.metric_key = 'expense_by_category' and c.dimension_key = 'marketing'
       and p.period_start = '2026-07-01'`);
    if (marketing !== '') expect(marketing.split('|')[1]).toBe('inferred');
    expect(head(o.id, '2026-07', 'net_profit')).toEqual(['4200.00', 'inferred', 'period_balances']);
  }, 300_000);
});

describe('who may confirm, and what', () => {
  let o: Org; let tb: string; let bank: string; let other: Org;
  beforeAll(async () => {
    o = await org('PERMS');
    tb = mixed(o.id);
    other = await org('OUTSIDER');
    bank = one(`select id from public.import_batches where organization_id = '${o.id}' and target_table = 'ledger_entries' limit 1`);
  }, 300_000);

  it('an assigned employee, who may review imports there, cannot: PERMISSION_DENIED', async () => {
    // The employee does reach the organisation's imports (so the refusal is about the role, not access).
    const { data } = await clientFor(o.employee, { aal: 'aal2' }).from('import_batches').select('id').eq('id', tb);
    expect(data ?? []).toHaveLength(1);
    expect((await attest(o.employee, tb, '2026-07-01', 'complete')).error?.message).toContain('PERMISSION_DENIED');
  });

  it('a client cannot', async () => {
    const message = (await attest(o.client, tb, '2026-07-01', 'complete')).error?.message ?? '';
    expect(message).toMatch(/PERMISSION_DENIED|NOT_FOUND/);
  });

  it('another organisation\'s owner sees nothing: NOT_FOUND', async () => {
    expect((await attest(other.owner, tb, '2026-07-01', 'complete')).error?.message).toContain('NOT_FOUND');
  });

  it('one import, one month it states, a reason, an answer of two — or it is refused', async () => {
    for (const [batch, month, coverage, reason] of [
      [tb, '2026-08-01', 'complete', 'checked'],          // a month this import does not state
      [tb, '2026-07-15', 'complete', 'checked'],          // not a month
      [tb, '2026-07-01', 'yes', 'checked'],               // not an answer
      [tb, '2026-07-01', 'complete', '   '],              // no reason
      [bank, '2026-07-01', 'complete', 'checked'],        // not a balance report
    ] as const) {
      expect((await attest(o.owner, batch, month, coverage, reason)).error?.message, `${month} ${coverage} '${reason}'`).toContain('VALIDATION');
    }
    expect(one(`select count(*) from public.report_completeness_attestations where organization_id = '${o.id}'`)).toBe('0');
  });

  it('no client can write the table directly, and no one can rewrite an answer', async () => {
    const direct = await clientFor(o.owner).from('report_completeness_attestations').insert({
      organization_id: o.id, import_batch_id: tb, period_start: '2026-07-01', coverage: 'complete', scope: 'all_accounts',
      reason: 'x', attested_by: o.owner, attested_role: 'owner' });
    expect(direct.error).not.toBeNull();
    expect((await attest(o.owner, tb, '2026-07-01', 'complete')).error).toBeNull();
    expect(() => adminSql(`update public.report_completeness_attestations set coverage = 'partial' where organization_id = '${o.id}'`))
      .toThrow(/IMMUTABLE/);
    expect(() => adminSql(`delete from public.report_completeness_attestations where organization_id = '${o.id}'`)).toThrow(/IMMUTABLE/);
  });

  it('the owner of another organisation cannot read this one\'s answers', async () => {
    const { data } = await clientFor(other.owner).from('report_completeness_attestations').select('id').eq('organization_id', o.id);
    expect(data ?? []).toEqual([]);
  });
});

/**
 * R-2 (owner decision): a full invoice list states what is owed only once someone confirmed it holds
 * every invoice still unpaid at its start. July sales list (declared 1 Jul–31 Aug, committed 10 Sep):
 * one invoice of 2,000 issued 5 Jul, due 4 Aug, unpaid. By hand, once confirmed: receivables 31 Jul
 * 2,000; 31 Aug 2,000, all overdue.
 */
describe('R-2 · confirming an invoice list\'s opening', () => {
  it('unconfirmed: receivables NULL opening_invoices_unconfirmed, never 0 or a partial total; confirmed by the owner: 2,000', async () => {
    const o = await org('OPENING');
    const acme = counterparty(o.id, 'Acme Ltd', 'customer');
    const list = invoiceBatch(o.id, { importType: 'sales_invoices', start: '2026-07-01', end: '2026-08-31', listKind: 'full',
      committedAt: '2026-09-10T10:00:00Z', tag: `inv-${n++}`, openingConfirmed: false,
      invoices: [{ type: 'sales', party: acme, number: 'A-1', issue: '2026-07-05', due: '2026-08-04', subtotal: '2000', tax: '0', total: '2000', paid: '0', paidDate: null, status: 'open' }] });
    await calculateAndAlert(o.id);
    const before = metric(o.id, '2026-07', 'receivables');
    expect(before.startsWith('NULL|')).toBe(true);
    expect(before).toContain('opening_invoices_unconfirmed');
    // Revenue is unaffected: the list still states July's sales.
    expect(head(o.id, '2026-07', 'revenue')[0]).toBe('2000.00');

    // The opening is confirmed for the month the list STARTS in, and only that one.
    expect((await attest(o.owner, list, '2026-08-01', 'complete', 'checked')).error?.message).toContain('VALIDATION');
    const ok = await attest(o.owner, list, '2026-07-01', 'complete', 'Compared with the aged debtors report at 1 July');
    expect(ok.error, ok.error?.message).toBeNull();
    expect(one(`select scope from public.report_completeness_attestations where id = '${ok.data as string}'`)).toBe('open_invoices');
    await drainQueuedRecalculation(o.id, list);
    expect(head(o.id, '2026-07', 'receivables')).toEqual(['2000.00', 'verified', 'invoices']);
    expect(head(o.id, '2026-08', 'receivables_overdue')[0]).toBe('2000.00');
  }, 300_000);
});
