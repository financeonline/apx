import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { resolvePeriodContext, TOOLS } from '@/modules/ai';
import { loadHome, loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * Home and the analyst answer the gross-profit question the same way (ADR-106).
 *
 * The engine writes gross profit AS revenue when there is no cost of sales to subtract, so the
 * statement adds up, and says so with the `no_cost_of_sales` warning. Home has omitted the card
 * since ADR-105. The analyst was still handed £9,000 with `assurance_level: calculated` and
 * `completeness: 1.00`, which is the same misleading figure dressed as an established conclusion —
 * the very impression CD-05 exists to prevent.
 *
 * Two organisations, because the fix must not be "hide gross profit": one with no direct-cost
 * accounts, one with a real cost line whose figure must still come through.
 */

const RUN = `gp${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.grossprofit.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).trim();

let owner: string;
let noCost: string;
let withCost: string;

const ctxFor = (orgId: string): AccessContext => ({
  userId: owner, orgId, orgSlug: 'gp', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner), requestId: `itest-${RUN}`,
  now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});

async function callContext(orgId: string) {
  const rows = await loadPeriods(clientFor(owner), orgId, `itest-${RUN}`);
  const withData = await loadPeriodsWithData(clientFor(owner), orgId, `itest-${RUN}`);
  const periodContext = resolvePeriodContext({
    question: 'how did Aug 2026 go?',
    fiscalYearStartMonth: 1,
    periods: rows.map((p) => ({
      id: p.id, label: p.label, periodStart: p.periodStart, isComplete: p.isComplete, hasData: withData.has(p.id),
    })),
  });
  return { ctx: ctxFor(orgId), periodContext, knownPeriods: [], now: new Date('2026-09-15T00:00:00Z') };
}

interface ToolMetric {
  readonly metric_key: string;
  readonly value: { readonly display: string } | null;
  readonly availability: { readonly state: string; readonly reason?: string; readonly explanation?: string };
}

const summaryMetric = async (orgId: string, key: string): Promise<ToolMetric | undefined> => {
  const outcome = await TOOLS.find((t) => t.name === 'get_business_summary')!.run({}, await callContext(orgId));
  const data = (outcome as { ok: boolean; data: { metrics?: ToolMetric[] } }).data;
  return (data.metrics ?? []).find((m) => m.metric_key === key);
};

const metricTool = async (orgId: string, key: string): Promise<ToolMetric> => {
  const outcome = await TOOLS.find((t) => t.name === 'get_metric')!.run({ metric_key: key }, await callContext(orgId));
  return (outcome as { ok: boolean; data: ToolMetric }).data;
};

async function seed(name: string, withCostOfSales: boolean): Promise<string> {
  const created = await clientFor(owner).schema('api').rpc('create_organization', { p_name: name });
  if (created.error) throw new Error(created.error.message);
  const org = created.data as unknown as string;

  const customer = one(`insert into public.counterparties (organization_id, name, kind)
    values ('${org}', 'Big Client', 'customer') returning id`);
  const invoice = (type: string, cp: string, num: string, sub: string, tax: string, total: string) =>
    one(`insert into public.invoices
        (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
         subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
      values ('${org}', '${type}', '${cp}', '${num}', '2026-08-10', '2026-09-09', '00000000-0000-0000-0000-000000000000',
              ${sub}, ${tax}, ${total}, 0, 'open', 'accepted', 'verified') returning id`);

  invoice('sales', customer, 'S-1', '9000.00', '1800.00', '10800.00');
  if (withCostOfSales) {
    const stock = one(`insert into public.counterparties (organization_id, name, kind, default_expense_category)
      values ('${org}', 'Stock Co', 'supplier', 'cost_of_sales') returning id`);
    invoice('purchase', stock, 'P-1', '2000.00', '400.00', '2400.00');
  }
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event)
            select organization_id, 'invoices', id, 'accepted' from public.invoices where organization_id = '${org}'`);
  const doc = one(`insert into public.source_documents
      (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${org}', '${org}/gp/i.csv', 'i.csv', 'text/csv', 10, digest('${org}gp', 'sha256'), 'ready', 'invoice') returning id`);
  adminSql(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind)
    values ('${org}', '${doc}', 'sales_invoices', 'invoices', 'committed', 'csv', '2026-08-01', '2026-08-31', now(), 'full')`);
  const jobId = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${org}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-09-15"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
  return org;
}

beforeAll(async () => {
  owner = createAuthUser(`owner@${DOMAIN}`);
  noCost = await seed(`ITest GP none ${RUN}`, false);
  withCost = await seed(`ITest GP real ${RUN}`, true);
}, 300_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in ('${noCost}', '${withCost}');
            delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('no cost of sales: every surface says the same thing (ADR-106)', () => {
  it('Home omits the card and gives the engine’s reason', async () => {
    const home = await loadHome(clientFor(owner), noCost, 'gp');
    expect(home.kind).toBe('ready');
    if (home.kind !== 'ready') return;
    expect(home.view.cards.map((c) => c.metricKey)).not.toContain('gross_profit');
    expect(home.view.grossProfitNote).toBe('You have no direct-cost accounts, so this does not apply.');
  });

  it('get_business_summary hands the model no value, and the same reason in the same words', async () => {
    const gp = await summaryMetric(noCost, 'gross_profit');
    expect(gp, 'the key is still present, so the model need not infer from an absence').toBeDefined();
    expect(gp!.value, 'there is no figure to quote').toBeNull();
    expect(gp!.availability.state).toBe('not_applicable');
    expect(gp!.availability.reason).toBe('no_cost_of_sales_accounts');
    expect(gp!.availability.explanation).toBe('You have no direct-cost accounts, so this does not apply.');
    // Revenue is a real figure and is untouched: the fix is about one limitation, not about hiding.
    const revenue = await summaryMetric(noCost, 'revenue');
    expect(revenue!.value?.display).toBe('£9,000');
    expect(revenue!.availability.state).toBe('available');
  });

  it('get_metric gross_profit gives no value and no components to rebuild it from', async () => {
    const data = await metricTool(noCost, 'gross_profit') as ToolMetric & { components?: unknown[] };
    expect(data.value).toBeNull();
    expect(data.availability.state).toBe('not_applicable');
    // Gross profit's components are revenue and cost of sales; handing over "revenue 9,000" under a
    // gross-profit result would re-offer the number that suppressing the value just removed.
    expect(data.components).toEqual([]);
  });

  it('cost of sales keeps its OWN reason and is not relabelled by this rule', async () => {
    const cos = await metricTool(noCost, 'cost_of_sales');
    expect(cos.value).toBeNull();
    expect(cos.availability.state).toBe('available');
  });
});

describe('a real cost of sales: the figure still comes through everywhere', () => {
  it('Home shows the card', async () => {
    const home = await loadHome(clientFor(owner), withCost, 'gp');
    expect(home.kind).toBe('ready');
    if (home.kind !== 'ready') return;
    expect(home.view.cards.map((c) => c.metricKey)).toContain('gross_profit');
    expect(home.view.grossProfitNote).toBeNull();
  });

  it('the analyst gets 7,000 on both tools, marked available', async () => {
    const summary = await summaryMetric(withCost, 'gross_profit');
    expect(summary!.value?.display).toBe('£7,000');
    expect(summary!.availability.state).toBe('available');
    const metric = await metricTool(withCost, 'gross_profit');
    expect(metric.value?.display).toBe('£7,000');
    expect(metric.availability.state).toBe('available');
  });
});
