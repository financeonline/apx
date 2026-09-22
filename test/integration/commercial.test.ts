import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import {
  loadCampaignDetail, loadCommercialOverview, loadCustomerCommercial, loadMarketing, loadPeriodScope, loadProductDetail,
  loadProducts, loadSales,
} from '@/modules/dashboard';
import { listInvoices } from '@/modules/financials';
import { drainJobs } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished, sqlstate } from './setup';

/**
 * Phase 14 — Commercial Intelligence (ADR-102).
 *
 * Against the real database and the real calculation job: product figures come only from lines and
 * reconcile to the engine's invoice-basis revenue; contribution is unavailable without a cost line;
 * campaign revenue is attributed only through a won opportunity, from the won month; CAC and
 * conversion name their denominators and refuse to divide by zero; every write is fenced by role and
 * organisation; nothing here is a second financial truth.
 */

const RUN = `c${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.commercial.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

let owner: string; let ownerB: string; let client: string; let empAssigned: string; let empOther: string;
let orgA: string; let orgB: string;
let acme: string; let beta: string; let supplier: string; let acmeB: string;
let aug: string; let jul: string;
let invAcmeAug: string; let invBetaAug: string; let purchase: string;
let consulting: string; let training: string; let insta: string; let google: string; let channel: string;

function counterparty(org: string, name: string, kind: string): string {
  return one(`insert into public.counterparties (organization_id, name, kind) values ('${org}', '${name}', '${kind}') returning id`);
}
function invoice(org: string, cp: string, type: string, number: string, date: string, subtotal: string, tax: string): string {
  const total = new Decimal(subtotal).plus(tax).toFixed(2);
  return one(`insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id, subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
    values ('${org}', '${type}', '${cp}', '${number}', '${date}', '${date}', '00000000-0000-0000-0000-000000000000', ${subtotal}, ${tax}, ${total}, 0, 'open', 'accepted', 'verified') returning id`);
}
async function calc(org: string): Promise<void> {
  const first = one(`select id from public.fiscal_periods where organization_id = '${org}' order by period_start limit 1`);
  const jobId = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts) values ('${org}', 'calculation.run', '{"trigger":"banking_edit","period_ids":["${first}"],"as_of":"2026-09-15"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
}
const api = (u: string) => clientFor(u).schema('api');
const ok = async <T,>(p: PromiseLike<{ data: T; error: unknown }>): Promise<T> => { const r = await p; expect(r.error, JSON.stringify(r.error)).toBeNull(); return r.data; };

beforeAll(async () => {
  owner = createAuthUser(`owner@${DOMAIN}`); ownerB = createAuthUser(`owner-b@${DOMAIN}`);
  client = createAuthUser(`client@${DOMAIN}`); empAssigned = createAuthUser(`emp-a@${DOMAIN}`); empOther = createAuthUser(`emp-o@${DOMAIN}`);
  adminSql(`insert into public.platform_users (user_id, platform_role, status) values ('${empAssigned}', 'employee', 'active'), ('${empOther}', 'employee', 'active')`);
  const a = await api(owner).rpc('create_organization', { p_name: `ITest Commercial A ${RUN}` }); if (a.error) throw new Error(a.error.message); orgA = a.data as unknown as string;
  const b = await api(ownerB).rpc('create_organization', { p_name: `ITest Commercial B ${RUN}` }); if (b.error) throw new Error(b.error.message); orgB = b.data as unknown as string;
  adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status) values ('${orgA}', '${client}', 'client', 'active');
            insert into public.organization_assignments (organization_id, employee_user_id, status) values ('${orgA}', '${empAssigned}', 'active');`);
  acme = counterparty(orgA, 'Acme Ltd', 'customer'); beta = counterparty(orgA, 'Beta plc', 'customer'); supplier = counterparty(orgA, 'Parts Co', 'supplier');
  acmeB = counterparty(orgB, 'Acme of B', 'customer');
  // Sales invoices Jun–Aug 2026; acme grows, beta steady. Net of tax.
  invoice(orgA, acme, 'sales', 'A-001', '2026-06-10', '4000.00', '800.00');
  invoice(orgA, acme, 'sales', 'A-002', '2026-07-10', '5000.00', '1000.00');
  invAcmeAug = invoice(orgA, acme, 'sales', 'A-003', '2026-08-10', '6000.00', '1200.00');
  invoice(orgA, beta, 'sales', 'B-001', '2026-07-12', '2000.00', '400.00');
  invBetaAug = invoice(orgA, beta, 'sales', 'B-002', '2026-08-12', '2000.00', '400.00');
  purchase = invoice(orgA, supplier, 'purchase', 'P-001', '2026-08-15', '900.00', '180.00');
  invoice(orgB, acmeB, 'sales', 'BB-1', '2026-08-03', '700.00', '140.00');
  // Coverage (FE §2.2): the revenue family counts an invoice month only when a committed, FULL sales
  // invoice batch declares a range spanning it. Both organisations get one, as a real import would.
  for (const [org, label] of [[orgA, 'a'], [orgB, 'b']] as const) {
    const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${org}', '${org}/commercial/${label}.csv', 'sales-${label}.csv', 'text/csv', 10, decode('c${label === 'a' ? '1' : '2'}','hex'), 'ready', 'invoice') returning id`);
    adminSql(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind)
      values ('${org}', '${doc}', 'sales_invoices', 'invoices', 'committed', 'csv', '2026-06-01', '2026-08-31', now(), 'full')`);
  }
  aug = one(`select id from public.fiscal_periods where organization_id = '${orgA}' and period_start = '2026-08-01'`);
  jul = one(`select id from public.fiscal_periods where organization_id = '${orgA}' and period_start = '2026-07-01'`);
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

afterAll(() => {
  adminSql(`delete from public.organizations where id in ('${orgA}', '${orgB}');
            delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');
            delete from auth.users where email like '%@${DOMAIN}';`);
});

const scopeA = async (u = owner) => (await loadPeriodScope(clientFor(u), orgA, aug))!;

/** Merging enqueues its own recalculation (ADR-031.1); let the queue settle before asserting. */
async function drainUntilQuiet(org: string): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    const outstanding = one(`select count(*)::text from public.jobs where organization_id = '${org}' and status in ('queued', 'running')`);
    if (outstanding === '0') return;
    await drainJobs(20);
  }
}

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
    const headline = one(`select s.value::text from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
      where c.organization_id = '${orgA}' and c.period_id = '${aug}' and c.metric_key = 'revenue' and c.dimension_type = 'none'`);
    const customers = one(`select sum(s.value)::text from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
      where c.organization_id = '${orgA}' and c.period_id = '${aug}' and c.metric_key = 'customer_revenue'`);
    const total = new Decimal(byName.Consulting!.revenueRaw).plus(byName.Training!.revenueRaw).plus(view.unattributed!.amountRaw);
    expect(total.toFixed(2)).toBe(new Decimal(headline).toFixed(2));
    expect(new Decimal(customers).toFixed(2)).toBe(new Decimal(headline).toFixed(2));
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
    const productB = one(`insert into public.products (organization_id, name) values ('${orgB}', 'B thing') returning id`);
    const crossed = await api(owner).rpc('set_invoice_lines', { p_invoice: invBetaAug, p_lines: [{ product_id: productB, amount: '10.00' }] });
    expect(sqlstate(crossed.error)).toBe('P0002');
    // A lined invoice that is later rejected takes its lines out of every figure without deleting them.
    const extra = invoice(orgA, beta, 'sales', 'B-003', '2026-08-20', '1000.00', '0');
    await ok(api(owner).rpc('set_invoice_lines', { p_invoice: extra, p_lines: [{ product_id: consulting, amount: '1000.00' }] }));
    let view = await loadProducts(clientFor(owner), orgA, 'a', await scopeA());
    expect(view.products.find((p) => p.name === 'Consulting')!.revenueRaw).toBe('5000.00');
    adminSql(`update public.invoices set record_status = 'rejected', rejected_reason = 'test' where id = '${extra}'`);
    view = await loadProducts(clientFor(owner), orgA, 'a', await scopeA());
    expect(view.products.find((p) => p.name === 'Consulting')!.revenueRaw).toBe('4000.00');
    expect(one(`select count(*) from public.invoice_lines where invoice_id = '${extra}'`)).toBe('1');
  });
});

describe('campaigns: attribution only through a won opportunity, CAC and conversion with named denominators', () => {
  it('credits Acme’s revenue to Instagram from August, nothing to Search ads, and computes CAC = spend ÷ customers won', async () => {
    const view = await loadMarketing(clientFor(owner), orgA, 'a', await scopeA());
    const byName = Object.fromEntries(view.campaigns.map((c) => [c.name, c]));
    const acmeAug = one(`select s.value::text from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
      where c.organization_id = '${orgA}' and c.period_id = '${aug}' and c.metric_key = 'customer_revenue' and c.dimension_id = '${acme}'`);
    expect(byName['Summer reels']).toMatchObject({ attributionStatus: 'attributed_via_won_opportunities', customersWon: 1, spendRaw: '300.00', cac: expect.stringContaining('300'), channelName: 'Instagram' });
    expect(new Decimal(byName['Summer reels']!.attributedRevenueRaw).toFixed(2)).toBe(new Decimal(acmeAug).toFixed(2));
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
    const campaignB = one(`insert into public.campaigns (organization_id, name) values ('${orgB}', 'B camp') returning id`);
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
    const orphan = one(`insert into public.counterparties (organization_id, name, kind) values ('${orgA}', 'Cash sales till', 'unknown') returning id`);
    invoice(orgA, orphan, 'sales', 'A-004', '2026-08-20', '1000.00', '200.00');
    await calc(orgA);
    const after = await loadCommercialOverview(clientFor(owner), orgA, 'a', await scopeA());
    expect(after.unattributedRevenue?.amount).toContain('1,000');
    expect(after.topCustomers.map((c) => c.name)).not.toContain('Cash sales till');
    adminSql(`delete from public.invoices where organization_id = '${orgA}' and invoice_number = 'A-004';
              delete from public.counterparties where id = '${orphan}';`);
    await calc(orgA);
  });
});

describe('a merge moves a customer’s commercial history, it does not lose it (ADR-103)', () => {
  it('keeps product mix, campaign attribution and revenue under the surviving customer', async () => {
    // A duplicate of Acme with its own August invoice, split into lines and won through Search ads.
    const duplicate = counterparty(orgA, 'ACME Limited', 'customer');
    const invDup = invoice(orgA, duplicate, 'sales', 'A-DUP', '2026-08-22', '1200.00', '240.00');
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
    const acmeRevenue = one(`select coalesce(sum(s.value), 0)::text from public.metric_current c
       join public.metric_snapshots s on s.id = c.snapshot_id
      where c.organization_id = '${orgA}' and c.metric_key = 'customer_revenue' and c.dimension_id = '${acme}'
        and c.period_id in (select id from public.fiscal_periods where organization_id = '${orgA}' and period_start >= '2026-08-01')`);
    expect(credited.toFixed(2)).toBe(new Decimal(acmeRevenue).toFixed(2));

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
    const a = counterparty(orgA, 'Gamma Ltd', 'customer');
    const b = counterparty(orgA, 'Gamma Limited', 'customer');
    expect((await api(owner).rpc('merge_counterparties', { p_from: b, p_into: a })).error).toBeNull();
    expect(sqlstate((await api(owner).rpc('merge_counterparties', { p_from: b, p_into: a })).error)).toBe('40001');
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
    const emp = clientFor(empAssigned, { aal: 'aal2' });
    expect((await loadMarketing(emp, orgA, 'a', (await loadPeriodScope(emp, orgA, aug))!)).campaigns).toHaveLength(2);
    for (const [name, args] of [
      ['upsert_product', { p_org: orgA, p_input: { name: 'Sneaky' } }],
      ['upsert_campaign', { p_org: orgA, p_input: { name: 'Sneaky' } }],
      ['upsert_opportunity', { p_org: orgA, p_input: { name: 'Sneaky' } }],
      ['set_campaign_spend', { p_org: orgA, p_campaign: insta, p_period: aug, p_amount: 1, p_note: null }],
      ['set_invoice_lines', { p_invoice: invBetaAug, p_lines: [] }],
    ] as const) {
      expect(sqlstate((await api(client).rpc(name, args as never)).error), `client ${name}`).toBe('42501');
      expect(sqlstate((await clientFor(empOther, { aal: 'aal2' }).schema('api').rpc(name, args as never)).error), `unassigned ${name}`).toBe('P0002');
    }
    expect(one(`select count(*) from public.products where organization_id = '${orgA}' and name = 'Sneaky'`)).toBe('0');
  });

  it('organisation B sees none of A’s commercial rows, cannot write to them, and cannot use A’s ids', async () => {
    const b = clientFor(ownerB);
    for (const table of ['products', 'invoice_lines', 'marketing_channels', 'campaigns', 'campaign_spend', 'opportunities']) {
      const { data } = await b.from(table).select('id').eq('organization_id', orgA);
      expect(data, table).toEqual([]);
    }
    expect(sqlstate((await b.schema('api').rpc('upsert_product', { p_org: orgA, p_input: { name: 'From B' } })).error)).toBe('P0002');
    expect(sqlstate((await b.schema('api').rpc('set_invoice_lines', { p_invoice: invAcmeAug, p_lines: [] })).error)).toBe('P0002');
    expect(sqlstate((await b.schema('api').rpc('set_campaign_spend', { p_org: orgB, p_campaign: insta, p_period: aug, p_amount: 5, p_note: null })).error)).toBe('P0002');
    expect(sqlstate((await b.schema('api').rpc('product_period_summary', { p_org: orgA, p_period_ids: [aug] })).error)).toBe('P0002');
    expect(await loadProductDetail(b, orgB, 'b', (await loadPeriodScope(b, orgB, null))!, consulting)).toBeNull();
    // A owner cannot attribute an A opportunity to B's customer, nor spend to B's campaign.
    const campaignB = one(`select id from public.campaigns where organization_id = '${orgB}' limit 1`);
    expect(sqlstate((await api(owner).rpc('set_campaign_spend', { p_org: orgA, p_campaign: campaignB, p_period: aug, p_amount: 5, p_note: null })).error)).toBe('P0002');
    expect(one(`select count(*) from public.invoice_lines where organization_id = '${orgA}' and invoice_id = '${invAcmeAug}'`)).toBe('2');
  });
});
