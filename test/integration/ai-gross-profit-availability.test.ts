import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { resolvePeriodContext, TOOLS } from '@/modules/ai';
import { loadHome, loadPeriodScope, loadPeriods, loadPeriodsWithData, loadProfitAndLoss } from '@/modules/dashboard';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { addCommittedBatch, addCounterparty, addInvoice, dropUsers, dropWhere, enqueue, makeOrg } from './ai-fixtures';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished } from './setup';

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
const DOMAIN = `${RUN}.grossprofit.itest.motion`;

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
  const org = await makeOrg(owner, name);

  const customer = await addCounterparty(org, 'Big Client', 'customer');
  const invoice = (type: 'sales' | 'purchase', cp: string, num: string, subtotal: string, tax: string, total: string) =>
    addInvoice(org, { type, counterpartyId: cp, number: num, issueDate: '2026-08-10', dueDate: '2026-09-09', subtotal, tax, total });

  await invoice('sales', customer, 'S-1', '9000.00', '1800.00', '10800.00');
  if (withCostOfSales) {
    const stock = await addCounterparty(org, 'Stock Co', 'supplier', 'cost_of_sales');
    await invoice('purchase', stock, 'P-1', '2000.00', '400.00', '2400.00');
  }
  const sales = await addCommittedBatch(org, {
    importType: 'sales_invoices', targetTable: 'invoices', periodStart: '2026-08-01', periodEnd: '2026-08-31',
    filename: 'i.csv', documentKind: 'invoice', invoiceListKind: 'full',
  });
  // FU-12: costs need a full purchase list (ADR-126). Both organisations get one over the same range
  // as the sales list, so the no-cost organisation still reaches the ADR-106 no-direct-cost-accounts
  // reason rather than FU-12's no-coverage one.
  await addCommittedBatch(org, {
    importType: 'purchase_invoices', targetTable: 'invoices', periodStart: '2026-08-01', periodEnd: '2026-08-31',
    filename: 'i.csv', documentKind: 'invoice', invoiceListKind: 'full', documentId: sales.documentId,
  });
  const jobId = await enqueue(org, 'calculation.run', { trigger: 'recalc_manual', as_of: '2026-09-15' });
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
  return org;
}

beforeAll(async () => {
  owner = await createAuthUser(`owner@${DOMAIN}`);
  noCost = await seed(`ITest GP none ${RUN}`, false);
  withCost = await seed(`ITest GP real ${RUN}`, true);
}, 300_000);

afterAll(async () => {
  for (const org of [noCost, withCost]) if (org) await deleteOrg(org);
  await dropWhere('jobs', 'organization_id', [noCost, withCost].filter(Boolean));
  await dropUsers(DOMAIN);
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

describe('no cost of sales: the Profit & loss page reads the same rule (ADR-106, closed by ADR-108’s pass)', () => {
  it('prints gross profit as "—" with the engine’s reason, between a cost of sales and a margin that already did', async () => {
    const scope = await loadPeriodScope(clientFor(owner), noCost, null, `itest-${RUN}`);
    const pnl = await loadProfitAndLoss(clientFor(owner), noCost, 'gp', scope!, `itest-${RUN}`);
    const line = (key: string) => pnl.above.find((f) => f.metricKey === key)!;
    // Before this pass the page printed "£9,000.00 · Partial data" here, the figure Home omits.
    expect(line('gross_profit').value).toBe('—');
    expect(line('gross_profit').rawValue).toBeNull();
    expect(line('gross_profit').status.kind).toBe('not_available');
    expect(line('gross_profit').status.tooltip).toBe('You have no direct-cost accounts, so this does not apply.');
    expect(line('gross_margin').value).toBe('—');
    expect(line('cost_of_sales').value).toBe('—');
    // Revenue is a real figure and is untouched.
    expect(line('revenue').value).toBe('£9,000.00');
    expect(line('revenue').status.kind).toBe('calculated');
  });
});

describe('a real cost of sales: the figure still comes through everywhere', () => {
  it('the Profit & loss page shows the real gross profit and margin', async () => {
    const scope = await loadPeriodScope(clientFor(owner), withCost, null, `itest-${RUN}`);
    const pnl = await loadProfitAndLoss(clientFor(owner), withCost, 'gp', scope!, `itest-${RUN}`);
    const line = (key: string) => pnl.above.find((f) => f.metricKey === key)!;
    expect(line('gross_profit').value).toBe('£7,000.00');
    expect(line('gross_profit').status.kind).toBe('calculated');
    expect(line('gross_margin').value).not.toBe('—');
  });

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
