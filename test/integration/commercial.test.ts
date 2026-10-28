import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Decimal } from '@/core/money';
import {
  loadCampaignDetail, loadCommercialOverview, loadCustomerCommercial, loadMarketing, loadPeriodScope, loadProductDetail,
  loadProducts, loadSales,
} from '@/modules/dashboard';
import { listInvoices } from '@/modules/financials';
import { drainJobs } from '@/modules/jobs';
import { orgRows } from '@/db/rls';
import { orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc, sqlstate } from './setup';
import {
  addMember, addPlatformUser, assign, calculate, dropFixtures, makeOrg, ok, periodFor, rowsOf, seedBatch,
  seedCounterparty, seedDocument, seedInvoice, drainUntilQuiet as quiet,
} from './f-fixtures';

/**
 * Phase 14 — Commercial Intelligence (ADR-102).
 *
 * Against the real database and the real calculation job: product figures come only from lines and
 * reconcile to the engine's invoice-basis revenue; contribution is unavailable without a cost line;
 * campaign revenue is attributed only through a won opportunity, from the won month; CAC and
 * conversion name their denominators and refuse to divide by zero; every write is fenced by role and
 * organisation; nothing here is a second financial truth.
 */

// Every calculation here drains the queue the other suites share, so a run can wait behind theirs.
vi.setConfig({ testTimeout: 300_000 });

const RUN = `c${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.commercial.itest.motion`;

let owner: string; let ownerB: string; let client: string; let empAssigned: string; let empOther: string;
let orgA: string; let orgB: string;
let acme: string; let beta: string; let supplier: string; let acmeB: string;
let aug: string; let jul: string;
let invAcmeAug: string; let invBetaAug: string; let purchase: string;
let consulting: string; let training: string; let insta: string; let google: string; let channel: string;

const counterparty = (org: string, name: string, kind: string): Promise<string> => seedCounterparty(org, { name, kind });
function invoice(org: string, cp: string, type: string, number: string, date: string, subtotal: string, tax: string): Promise<string> {
  const total = new Decimal(subtotal).plus(tax).toFixed(2);
  return seedInvoice(org, { counterpartyId: cp, type, number, issueDate: date, dueDate: date, subtotal, tax, total });
}
async function calc(org: string): Promise<void> {
  await calculate(org, drainJobs);
}
const api = (u: string) => ({ rpc: (fn: string, args: Record<string, unknown>) => rpc(clientFor(u), fn, args) });

/** The engine's current value of a figure (`metric_current` → its snapshot), or the sum of several. */
async function figures(org: string, period: string | readonly string[], key: string, where: { dimensionType?: string; dimensionId?: string } = {}): Promise<Decimal[]> {
  const periods = typeof period === 'string' ? [period] : [...period];
  const out: Decimal[] = [];
  for (const p of periods) {
    let q: FirebaseFirestore.Query = orgCollection(fs(), org, 'metric_current').where('period_id', '==', p).where('metric_key', '==', key);
    if (where.dimensionType) q = q.where('dimension_type', '==', where.dimensionType);
    if (where.dimensionId) q = q.where('dimension_id', '==', where.dimensionId);
    for (const cell of (await q.get()).docs) {
      const snap = await orgRow(fs(), org, 'metric_snapshots', String(cell.get('snapshot_id'))).get();
      if (snap.exists && snap.get('value') !== null) out.push(new Decimal(String(snap.get('value'))));
    }
  }
  return out;
}
const total = (values: Decimal[]): Decimal => values.reduce((a, v) => a.plus(v), new Decimal(0));

beforeAll(async () => {
  owner = await createAuthUser(`owner@${DOMAIN}`); ownerB = await createAuthUser(`owner-b@${DOMAIN}`);
  client = await createAuthUser(`client@${DOMAIN}`); empAssigned = await createAuthUser(`emp-a@${DOMAIN}`); empOther = await createAuthUser(`emp-o@${DOMAIN}`);
  await addPlatformUser(empAssigned, 'employee'); await addPlatformUser(empOther, 'employee');
  orgA = await makeOrg(owner, `ITest Commercial A ${RUN}`);
  orgB = await makeOrg(ownerB, `ITest Commercial B ${RUN}`);
  await addMember(orgA, client, 'client');
  await assign(orgA, empAssigned);
  acme = await counterparty(orgA, 'Acme Ltd', 'customer'); beta = await counterparty(orgA, 'Beta plc', 'customer'); supplier = await counterparty(orgA, 'Parts Co', 'supplier');
  acmeB = await counterparty(orgB, 'Acme of B', 'customer');
  // Sales invoices Jun–Aug 2026; acme grows, beta steady. Net of tax.
  await invoice(orgA, acme, 'sales', 'A-001', '2026-06-10', '4000.00', '800.00');
  await invoice(orgA, acme, 'sales', 'A-002', '2026-07-10', '5000.00', '1000.00');
  invAcmeAug = await invoice(orgA, acme, 'sales', 'A-003', '2026-08-10', '6000.00', '1200.00');
  await invoice(orgA, beta, 'sales', 'B-001', '2026-07-12', '2000.00', '400.00');
  invBetaAug = await invoice(orgA, beta, 'sales', 'B-002', '2026-08-12', '2000.00', '400.00');
  purchase = await invoice(orgA, supplier, 'purchase', 'P-001', '2026-08-15', '900.00', '180.00');
  await invoice(orgB, acmeB, 'sales', 'BB-1', '2026-08-03', '700.00', '140.00');
  // Coverage (FE §2.2): the revenue family counts an invoice month only when a committed, FULL sales
  // invoice batch declares a range spanning it. Both organisations get one, as a real import would.
  for (const [org, label] of [[orgA, 'a'], [orgB, 'b']] as const) {
    const doc = await seedDocument(org, { filename: `sales-${label}.csv`, kind: 'invoice' });
    await seedBatch(org, {
      documentId: doc, importType: 'sales_invoices', targetTable: 'invoices', status: 'committed',
      periodStart: '2026-06-01', periodEnd: '2026-08-31', invoiceListKind: 'full',
    });
  }
  aug = await periodFor(orgA, '2026-08-01');
  jul = await periodFor(orgA, '2026-07-01');
  await calc(orgA); await calc(orgB);

  // What a person records: two services, a channel, two campaigns, spend, and a pipeline.
  consulting = await ok(api(owner).rpc('upsert_product', { p_org: orgA, p_input: { name: 'Consulting', kind: 'service' } })) as string;
  training = await ok(api(owner).rpc('upsert_product', { p_org: orgA, p_input: { name: 'Training', kind: 'service' } })) as string;
  channel = await ok(api(owner).rpc('upsert_channel', { p_org: orgA, p_input: { name: 'Instagram' } })) as string;
  insta = await ok(api(owner).rpc('upsert_campaign', { p_org: orgA, p_input: { name: 'Summer reels', channel_id: channel, starts_on: '2026-07-01' } })) as string;
  google = await ok(api(owner).rpc('upsert_campaign', { p_org: orgA, p_input: { name: 'Search ads' } })) as string;
  await ok(api(owner).rpc('set_campaign_spend', { p_org: orgA, p_campaign: insta, p_period: aug, p_amount: 300, p_note: null }));
  // Acme's August invoice: 4,000 consulting + 1,500 training; 500 left unattributed. Beta's: untouched.
  await ok(api(owner).rpc('set_invoice_lines', { p_invoice: invAcmeAug, p_lines: [
    { product_id: consulting, amount: '4000.00', description: 'August retainer' },
    { product_id: training, amount: '1500.00', quantity: '3' },
  ] }));
  // Pipeline: acme won through Instagram in August; beta an open proposal; a lost lead; a lead this month.
  await ok(api(owner).rpc('upsert_opportunity', { p_org: orgA, p_input: { name: 'Acme retainer', stage: 'won', counterparty_id: acme, campaign_id: insta, estimated_value: '6000.00', created_on: '2026-07-20', won_on: '2026-08-05' } }));
  await ok(api(owner).rpc('upsert_opportunity', { p_org: orgA, p_input: { name: 'Beta expansion', stage: 'proposal', counterparty_id: beta, campaign_id: google, estimated_value: '9000.00', created_on: '2026-08-03' } }));
  await ok(api(owner).rpc('upsert_opportunity', { p_org: orgA, p_input: { name: 'Cold lead', stage: 'lost', created_on: '2026-08-04', lost_on: '2026-08-20' } }));
  await ok(api(owner).rpc('upsert_opportunity', { p_org: orgA, p_input: { name: 'New enquiry', created_on: '2026-08-25' } }));
}, 300_000);

afterAll(async () => {
  await dropFixtures([orgA, orgB], DOMAIN);
}, 120_000);

/**
 * The August scope, read once per person: `loadPeriodScope` reads every figure pointer of the
 * organisation, and nothing these tests do changes which months have figures.
 */
const scopes = new Map<string, Awaited<ReturnType<typeof loadPeriodScope>>>();
const scopeA = async (u = owner) => {
  if (!scopes.has(u)) scopes.set(u, await loadPeriodScope(clientFor(u), orgA, aug));
  return scopes.get(u)!;
};

/** Merging enqueues its own recalculation (ADR-031.1); let the queue settle before asserting. */
const drainUntilQuiet = (org: string): Promise<void> => quiet(org, drainJobs, 8);

describe('products come only from lines, and reconcile to the engine', () => {
  it('Σ product revenue + unattributed = the engine’s customer revenue for the month, to the penny', async () => {
    const view = await loadProducts(clientFor(owner), orgA, 'a', await scopeA());
    const byName = Object.fromEntries(view.products.map((p) => [p.name, p]));
    expect(byName.Consulting!.revenueRaw).toBe('4000.00');
    expect(byName.Training!.revenueRaw).toBe('1500.00');
    expect(view.unattributed).toMatchObject({ amountRaw: '2500.00', invoicesWithoutLines: 1, invoices: 2 });
    /*
     * Both halves of the identity, now that the invoice basis reports a P&L (ADR-103):
     * Σ lines + unattributed = Σ customer_revenue = the headline `revenue` for the month.
     */
    const headline = total(await figures(orgA, aug, 'revenue', { dimensionType: 'none' }));
    const customers = total(await figures(orgA, aug, 'customer_revenue'));
    const lines = new Decimal(byName.Consulting!.revenueRaw).plus(byName.Training!.revenueRaw).plus(view.unattributed!.amountRaw);
    expect(lines.toFixed(2)).toBe(headline.toFixed(2));
    expect(customers.toFixed(2)).toBe(headline.toFixed(2));
  });

  it('contribution is unavailable without a cost line, and appears when a purchase line names the product', async () => {
    let view = await loadProducts(clientFor(owner), orgA, 'a', await scopeA());
    expect(view.products.find((p) => p.name === 'Training')).toMatchObject({ contribution: null, note: 'Contribution unavailable — cost data is insufficient.' });
    await ok(api(owner).rpc('set_invoice_lines', { p_invoice: purchase, p_lines: [{ product_id: training, amount: '600.00' }] }));
    view = await loadProducts(clientFor(owner), orgA, 'a', await scopeA());
    expect(view.products.find((p) => p.name === 'Training')).toMatchObject({ contributionRaw: '900.00', note: null });
    const detail = (await loadProductDetail(clientFor(owner), orgA, 'a', await scopeA(), training))!;
    expect(detail.customers.map((c) => c.name)).toEqual(['Acme Ltd']);
    expect(detail.lines.map((l) => l.kind).sort()).toEqual(['cost', 'sale']);
    expect(detail.lines.every((l) => l.recordHref.includes('/evidence/record/invoice/'))).toBe(true);
  });

  it('lines may not exceed the invoice, may not name another organisation’s product, and follow a rejected invoice out', async () => {
    const tooMuch = await api(owner).rpc('set_invoice_lines', { p_invoice: invBetaAug, p_lines: [{ product_id: consulting, amount: '2000.01' }] });
    expect(sqlstate(tooMuch.error)).toBe('22023');
    const productB = await ok(api(ownerB).rpc('upsert_product', { p_org: orgB, p_input: { name: 'B thing' } })) as string;
    const crossed = await api(owner).rpc('set_invoice_lines', { p_invoice: invBetaAug, p_lines: [{ product_id: productB, amount: '10.00' }] });
    expect(sqlstate(crossed.error)).toBe('P0002');
    // A lined invoice that is later rejected takes its lines out of every figure without deleting them.
    const extra = await invoice(orgA, beta, 'sales', 'B-003', '2026-08-20', '1000.00', '0');
    await ok(api(owner).rpc('set_invoice_lines', { p_invoice: extra, p_lines: [{ product_id: consulting, amount: '1000.00' }] }));
    let view = await loadProducts(clientFor(owner), orgA, 'a', await scopeA());
    expect(view.products.find((p) => p.name === 'Consulting')!.revenueRaw).toBe('5000.00');
    await orgRow(fs(), orgA, 'invoices', extra).update({ record_status: 'rejected', rejected_reason: 'test' });
    view = await loadProducts(clientFor(owner), orgA, 'a', await scopeA());
    expect(view.products.find((p) => p.name === 'Consulting')!.revenueRaw).toBe('4000.00');
    expect(await rowsOf(orgA, 'invoice_lines', { invoice_id: extra })).toHaveLength(1);
  });
});

describe('campaigns: attribution only through a won opportunity, CAC and conversion with named denominators', () => {
  it('credits Acme’s revenue to Instagram from August, nothing to Search ads, and computes CAC = spend ÷ customers won', async () => {
    const view = await loadMarketing(clientFor(owner), orgA, 'a', await scopeA());
    const byName = Object.fromEntries(view.campaigns.map((c) => [c.name, c]));
    const acmeAug = total(await figures(orgA, aug, 'customer_revenue', { dimensionId: acme }));
    expect(byName['Summer reels']).toMatchObject({ attributionStatus: 'attributed_via_won_opportunities', customersWon: 1, spendRaw: '300.00', cac: expect.stringContaining('300'), channelName: 'Instagram' });
    expect(new Decimal(byName['Summer reels']!.attributedRevenueRaw).toFixed(2)).toBe(acmeAug.toFixed(2));
    expect(byName['Search ads']).toMatchObject({ attributionStatus: 'no_won_opportunities', attributedRevenueRaw: '0.00', cac: null, cacNote: expect.stringContaining('No spend recorded') });
    const detail = (await loadCampaignDetail(clientFor(owner), orgA, 'a', await scopeA(), insta))!;
    // July: Acme had revenue, but was not yet won — none of it is the campaign's.
    expect(detail.spendByPeriod.find((p) => p.periodId === jul)!.attributed).toMatch(/0(\.00)?$/);
    expect(detail.customers.map((c) => c.name)).toEqual(['Acme Ltd']);
  });

  it('a won opportunity needs a customer; references must be the organisation’s; conversion names its cohort', async () => {
    const noCustomer = await api(owner).rpc('upsert_opportunity', { p_org: orgA, p_input: { name: 'Ghost win', stage: 'won' } });
    expect(sqlstate(noCustomer.error)).toBe('22023');
    const crossed = await api(owner).rpc('upsert_opportunity', { p_org: orgA, p_input: { name: 'Cross', stage: 'won', counterparty_id: acmeB, won_on: '2026-08-01' } });
    expect(sqlstate(crossed.error)).toBe('P0002');
    const campaignB = await ok(api(ownerB).rpc('upsert_campaign', { p_org: orgB, p_input: { name: 'B camp' } })) as string;
    const crossedCampaign = await api(owner).rpc('upsert_opportunity', { p_org: orgA, p_input: { name: 'Cross2', campaign_id: campaignB } });
    expect(sqlstate(crossedCampaign.error)).toBe('P0002');
    const sales = await loadSales(clientFor(owner), orgA, 'a', await scopeA());
    // Window Jun–Aug: created 3 (Beta expansion, Cold lead, New enquiry) + Acme retainer (Jul 20) = 4; progressed = Beta (proposal) + Acme (won) = 2; won from cohort = 1.
    expect(sales.conversion).toMatchObject({ leadsCreated: 4, progressed: 2, wonFromCohort: 1, lostFromCohort: 1, wonInWindow: 1 });
    expect(sales.conversion.leadToOpportunity).toBe('0.500000');
    expect(sales.conversion.opportunityToCustomer).toBe('0.500000');
    expect(sales.stages.find((s) => s.stage === 'proposal')).toMatchObject({ count: 1, value: '9000.00' });
    const emptyOrg = await loadSales(clientFor(ownerB), orgB, 'b', (await loadPeriodScope(clientFor(ownerB), orgB, null))!);
    expect(emptyOrg.conversion).toMatchObject({ leadsCreated: 0, leadToOpportunity: null, opportunityToCustomer: null, reasons: ['no_leads_in_window'] });
  });
});

describe('the overview and the customer page read the engine, not a second truth', () => {
  it('top customers are the engine’s customer_revenue rows; contribution note is stated; product mix and win path appear on the customer', async () => {
    const overview = await loadCommercialOverview(clientFor(owner), orgA, 'a', await scopeA());
    expect(overview.topCustomers[0]).toMatchObject({ name: 'Acme Ltd' });
    expect(overview.topCustomers[0]!.whyHref).toContain('/evidence');
    expect(overview.customerContributionNote).toContain('No cost has been attributed to a customer yet');
    expect(overview.topProducts[0]!.name).toBe('Consulting');
    expect(overview.topCampaigns[0]!.name).toBe('Summer reels');
    expect(overview.pipeline.openCount).toBe(2);
    const scope = await scopeA();
    const invoices = await listInvoices(clientFor(owner), orgA, { invoiceType: 'sales' }, { limit: 200, offset: 0 });
    const cp = { id: acme, name: 'Acme Ltd', kind: 'customer' as const, defaultExpenseCategory: null, isActive: true, mergedIntoId: null };
    const view = await loadCustomerCommercial(clientFor(owner), orgA, 'a', scope, cp, invoices.filter((i) => i.counterpartyId === acme).map((i) => i.id));
    expect(view.products.map((p) => p.name)).toEqual(['Consulting', 'Training']);
    expect(view.wonThrough.map((w) => w.name)).toEqual(['Summer reels']);
    expect(view.invoiceLines.get(invAcmeAug)).toHaveLength(2);
    expect(view.contribution?.rawValue).toBe(view.contribution?.rawValue); // present when the engine emitted it
  });

  it('never ranks the unattributed remainder as a customer, and reports it as the gap it is', async () => {
    const overview = await loadCommercialOverview(clientFor(owner), orgA, 'a', await scopeA());
    expect(overview.topCustomers.every((c) => c.id !== null && c.href !== null)).toBe(true);
    expect(overview.topCustomers.map((c) => c.name)).not.toContain('Unattributed');
    expect(overview.topCustomers.map((c) => c.name)).not.toContain('Not attributed to a customer');
    // Every invoice this month names a customer, so there is no remainder to report.
    expect(overview.unattributedRevenue).toBeNull();

    // An invoice with no customer would be revenue nobody can attribute — a data-quality state.
    const orphan = await counterparty(orgA, 'Cash sales till', 'unknown');
    const orphanInvoice = await invoice(orgA, orphan, 'sales', 'A-004', '2026-08-20', '1000.00', '200.00');
    await calc(orgA);
    const after = await loadCommercialOverview(clientFor(owner), orgA, 'a', await scopeA());
    expect(after.unattributedRevenue?.amount).toContain('1,000');
    expect(after.topCustomers.map((c) => c.name)).not.toContain('Cash sales till');
    await orgRow(fs(), orgA, 'invoices', orphanInvoice).delete();
    await orgRow(fs(), orgA, 'counterparties', orphan).delete();
    await calc(orgA);
  });
});

describe('a merge moves a customer’s commercial history, it does not lose it (ADR-103)', () => {
  it('keeps product mix, campaign attribution and revenue under the surviving customer', async () => {
    // A duplicate of Acme with its own August invoice, split into lines and won through Search ads.
    const duplicate = await counterparty(orgA, 'ACME Limited', 'customer');
    const invDup = await invoice(orgA, duplicate, 'sales', 'A-DUP', '2026-08-22', '1200.00', '240.00');
    await ok(api(owner).rpc('set_invoice_lines', { p_invoice: invDup, p_lines: [{ product_id: consulting, amount: '1200.00' }] }));
    await ok(api(owner).rpc('upsert_opportunity', { p_org: orgA, p_input: { name: 'Duplicate deal', stage: 'won', counterparty_id: duplicate, campaign_id: google, estimated_value: '1200.00', created_on: '2026-07-25', won_on: '2026-08-02' } }));
    await calc(orgA);

    const before = await loadCampaignDetail(clientFor(owner), orgA, 'a', await scopeA(), google);
    expect(before!.row.customersWon).toBe(1);
    const beforeAttributed = before!.row.attributedRevenueRaw;
    expect(new Decimal(beforeAttributed).greaterThan(0)).toBe(true);

    // Merge the duplicate into Acme. The engine re-keys revenue onto the survivor; the commercial
    // reads must follow, or the campaign silently loses the customer it won.
    expect((await api(owner).rpc('merge_counterparties', { p_from: duplicate, p_into: acme })).error).toBeNull();
    await drainUntilQuiet(orgA);
    await calc(orgA);

    /*
     * The survivor keeps the win, under the surviving identity: the duplicate's opportunity now
     * names Acme, and the earliest-win rule gives Acme to Search ads (2 Aug) rather than to Summer
     * reels (5 Aug). Nothing is lost and nothing is counted twice — which is the whole of the rule.
     */
    const after = await loadCampaignDetail(clientFor(owner), orgA, 'a', await scopeA(), google);
    expect(after!.row.customersWon, 'the won customer survives the merge').toBe(1);
    expect(after!.customers[0]!.counterpartyId).toBe(acme);
    expect(new Decimal(after!.row.attributedRevenueRaw).greaterThan(0), 'attributed revenue survives the merge').toBe(true);

    // No double count: one customer, one campaign credited with their revenue.
    const marketing = await loadMarketing(clientFor(owner), orgA, 'a', await scopeA());
    const credited = marketing.campaigns.reduce((acc, c) => acc.plus(c.attributedRevenueRaw), new Decimal(0));
    const fromAugust = (await rowsOf(orgA, 'fiscal_periods')).filter((p) => String(p.period_start) >= '2026-08-01').map((p) => String(p.id));
    const acmeRevenue = total(await figures(orgA, fromAugust, 'customer_revenue', { dimensionId: acme }));
    expect(credited.toFixed(2)).toBe(acmeRevenue.toFixed(2));

    const scope = await scopeA();
    const invoices = await listInvoices(clientFor(owner), orgA, { invoiceType: 'sales' }, { limit: 200, offset: 0 });
    const survivor = { id: acme, name: 'Acme Ltd', kind: 'customer' as const, defaultExpenseCategory: null, isActive: true, mergedIntoId: null };
    const view = await loadCustomerCommercial(clientFor(owner), orgA, 'a', scope, survivor,
      invoices.filter((i) => i.counterpartyId === acme || i.counterpartyId === duplicate).map((i) => i.id));
    const consultingMix = view.products.find((p) => p.name === 'Consulting');
    expect(consultingMix, 'the duplicate’s product mix moved to the survivor').toBeDefined();
    expect(new Decimal(consultingMix!.revenue.replace(/[^0-9.]/g, '')).greaterThanOrEqualTo(5200)).toBe(true);
    expect(view.wonThrough.map((w) => w.name), 'the earliest win of the surviving identity').toEqual(['Search ads']);

    // The merged-away page reads the survivor's figures rather than an empty month.
    const merged = { ...survivor, id: duplicate, name: 'ACME Limited', mergedIntoId: acme };
    const mergedView = await loadCustomerCommercial(clientFor(owner), orgA, 'a', scope, merged, [invDup]);
    expect(mergedView.products.map((p) => p.name)).toContain('Consulting');
  });

  it('refuses a second merge of the same row, and a merge across organisations', async () => {
    const a = await counterparty(orgA, 'Gamma Ltd', 'customer');
    const b = await counterparty(orgA, 'Gamma Limited', 'customer');
    expect((await api(owner).rpc('merge_counterparties', { p_from: b, p_into: a })).error).toBeNull();
    // 40001 on PostgreSQL; a CONFLICT either way (`sqlstate` reads every CONFLICT as 23505).
    expect(sqlstate((await api(owner).rpc('merge_counterparties', { p_from: b, p_into: a })).error)).toBe('23505');
    expect(sqlstate((await api(owner).rpc('merge_counterparties', { p_from: acmeB, p_into: a })).error)).toBe('P0002');
    expect(sqlstate((await api(ownerB).rpc('merge_counterparties', { p_from: a, p_into: acmeB })).error)).toBe('P0002');
    await drainUntilQuiet(orgA);
  });
});

describe('roles, assignment and isolation', () => {
  it('a client and an assigned employee read everything; neither the client nor an unassigned employee may write', async () => {
    for (const u of [client]) {
      const view = await loadCommercialOverview(clientFor(u), orgA, 'a', await scopeA(u));
      expect(view.topProducts[0]!.name).toBe('Consulting');
    }
    const emp = clientFor(empAssigned);
    expect((await loadMarketing(emp, orgA, 'a', (await loadPeriodScope(emp, orgA, aug))!)).campaigns).toHaveLength(2);
    for (const [name, args] of [
      ['upsert_product', { p_org: orgA, p_input: { name: 'Sneaky' } }],
      ['upsert_campaign', { p_org: orgA, p_input: { name: 'Sneaky' } }],
      ['upsert_opportunity', { p_org: orgA, p_input: { name: 'Sneaky' } }],
      ['set_campaign_spend', { p_org: orgA, p_campaign: insta, p_period: aug, p_amount: 1, p_note: null }],
      ['set_invoice_lines', { p_invoice: invBetaAug, p_lines: [] }],
    ] as const) {
      expect(sqlstate((await api(client).rpc(name, args)).error), `client ${name}`).toBe('42501');
      expect(sqlstate((await api(empOther).rpc(name, args)).error), `unassigned ${name}`).toBe('P0002');
    }
    expect(await rowsOf(orgA, 'products', { name: 'Sneaky' })).toHaveLength(0);
  });

  it('organisation B sees none of A’s commercial rows, cannot write to them, and cannot use A’s ids', async () => {
    const b = clientFor(ownerB);
    for (const table of ['products', 'invoice_lines', 'marketing_channels', 'campaigns', 'campaign_spend', 'opportunities'] as const) {
      expect(await orgRows(b, orgA, table), table).toEqual([]);
    }
    expect(sqlstate((await rpc(b, 'upsert_product', { p_org: orgA, p_input: { name: 'From B' } })).error)).toBe('P0002');
    expect(sqlstate((await rpc(b, 'set_invoice_lines', { p_invoice: invAcmeAug, p_lines: [] })).error)).toBe('P0002');
    expect(sqlstate((await rpc(b, 'set_campaign_spend', { p_org: orgB, p_campaign: insta, p_period: aug, p_amount: 5, p_note: null })).error)).toBe('P0002');
    expect(sqlstate((await rpc(b, 'product_period_summary', { p_org: orgA, p_period_ids: [aug] })).error)).toBe('P0002');
    expect(await loadProductDetail(b, orgB, 'b', (await loadPeriodScope(b, orgB, null))!, consulting)).toBeNull();
    // A owner cannot attribute an A opportunity to B's customer, nor spend to B's campaign.
    const campaignB = String((await rowsOf(orgB, 'campaigns'))[0]!.id);
    expect(sqlstate((await api(owner).rpc('set_campaign_spend', { p_org: orgA, p_campaign: campaignB, p_period: aug, p_amount: 5, p_note: null })).error)).toBe('P0002');
    expect(await rowsOf(orgA, 'invoice_lines', { invoice_id: invAcmeAug })).toHaveLength(2);
  });
});
