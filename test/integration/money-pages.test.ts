import { randomUUID } from 'node:crypto';

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertCan, can, permissionsFor } from '@/core/permissions';
import { remapAccount, setOpeningBalance } from '@/modules/financials';
import {
  formatFigure,
  loadAccountsPage,
  loadBanking,
  loadCash,
  loadCustomerDetail,
  loadCustomers,
  loadLedgerBook,
  loadMoneyIndex,
  loadPeriodScope,
  loadPeriodSnapshots,
  loadProfitAndLoss,
  type PeriodScope,
} from '@/modules/dashboard';
import { periodId as periodIdOf } from '@/db/app/shared';
import { orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc } from './setup';
import {
  addMember, dropFixtures, parkQueuedJobs, rowOf, seedAccount, seedBankAccount, seedBankTxn, seedCounterparty, seedInvoice,
  systemAccount, writeRun,
} from './f-fixtures';

/**
 * The Money section, Customers and the chart of accounts, against the database
 * (IMPLEMENTATION_PLAN.md Phase 7 slice 4).
 *
 * Five properties, each of which a wrong answer would hide rather than announce:
 *
 *   - every figure a Money page renders is the `metric_current` snapshot for that month, unaltered;
 *   - a client reads the same numbers an owner does, and a stranger reads nothing;
 *   - `description_raw` is not selectable by anyone, so the Bank activity page cannot leak it;
 *   - the opening-balance form's action is refused for a caller without `financials.edit`;
 *   - a system account cannot be re-mapped (ADR-004).
 *
 * The assertions are made against the data, not the DOM: what matters is that the page's data
 * equals its evidence, and a rendering test cannot show that.
 *
 * The fixtures deliberately do NOT use `resetFixtures()`: other suites share the emulator. This file
 * owns a uniquely named organisation and a domain of its own, creates it once and removes exactly
 * that, so it neither depends on nor disturbs anything else.
 */

// `loadPeriodScope` reads every figure pointer of the organisation; give the page readers room.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** Unique per run, so two runs of this file can never collide on the organisation slug. */
const SUITE = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = `${SUITE}.moneyfix.itest.motion`;

let ownerId: string;
let clientUserId: string;
let strangerId: string;
let orgId: string;
let orgSlug: string;
let march: string;
let february: string;
let april: string;
let bankAccountId: string;
let customerId: string;
let otherCustomerId: string;
let systemRevenueAccount: string;
let importedAccount: string;
let uncategorisedAccount: string;

/** Writes a snapshot and its pointer, exactly as a calculation run would (a run of its own). */
async function writeMetric(periodId: string, key: string, value: string | null, over: {
  unit?: string;
  basis?: string;
  assurance?: string;
  quality?: Record<string, unknown>;
  components?: Record<string, unknown>;
  dimensionType?: string;
  dimensionId?: string | null;
  /** A standard category has no row to point at, so it travels here (ADR-053). */
  dimensionKey?: string | null;
} = {}): Promise<string> {
  // `on conflict do nothing`: the first pointer of a cell stays.
  const existing = await orgCollection(fs(), orgId, 'metric_current').where('period_id', '==', periodId)
    .where('metric_key', '==', key).where('dimension_type', '==', over.dimensionType ?? 'none')
    .where('dimension_id', '==', over.dimensionId ?? null).where('dimension_key', '==', over.dimensionKey ?? null).limit(1).get();
  if (!existing.empty) return String(existing.docs[0]!.get('snapshot_id'));
  const { snapshotIds } = await writeRun(orgId, [{
    periodId, key, value, unit: over.unit ?? 'money', basis: over.basis ?? 'ledger',
    currency: over.unit === 'ratio' || over.unit === 'days' || over.unit === 'count' ? null : 'GBP',
    dataQuality: over.quality ?? { completeness: 1, proxy: false, warnings: [], missing: [] },
    components: over.components ?? {}, dimensionType: over.dimensionType ?? 'none',
    dimensionId: over.dimensionId ?? null, dimensionKey: over.dimensionKey ?? null,
  }], { asOf: '2026-06-15' });
  return snapshotIds[0]!;
}

async function markComplete(periodId: string, complete: boolean): Promise<void> {
  await orgRow(fs(), orgId, 'fiscal_periods', periodId).update({ is_complete: complete });
}

/** March, fully stated: the month every "equals its snapshot" assertion is made against. */
async function seedMarch(): Promise<void> {
  await markComplete(february, true);
  await markComplete(march, true);

  await writeMetric(february, 'revenue', '18000.00');
  await writeMetric(february, 'closing_cash', '21000.00');

  await writeMetric(march, 'revenue', '20000.50');
  await writeMetric(march, 'cost_of_sales', '6000.25');
  await writeMetric(march, 'gross_profit', '14000.25');
  await writeMetric(march, 'gross_margin', '0.7000', { unit: 'ratio' });
  await writeMetric(march, 'operating_expenses', '6000.00');
  await writeMetric(march, 'operating_profit', '8000.25');
  await writeMetric(march, 'operating_margin', '0.4000', { unit: 'ratio' });
  await writeMetric(march, 'interest_expense', '120.00');
  await writeMetric(march, 'tax_expense', '1400.00');
  await writeMetric(march, 'net_profit', '6480.25');
  await writeMetric(march, 'net_margin', '0.3239', { unit: 'ratio' });
  await writeMetric(march, 'revenue.variance.prev_period', '2000.50', {
    components: { pct_change: 0.1111 },
  });

  // The dimensioned spending breakdown. `dimension_id` is a uuid column, so the category travels in
  // the components — which is where the page reads it from.
  await writeMetric(march, 'expense_by_category', '4000.00', {
    dimensionType: 'standard_category', dimensionKey: 'payroll',
  });
  await writeMetric(march, 'expense_by_category', '1500.00', {
    dimensionType: 'standard_category', dimensionKey: 'marketing',
  });

  await writeMetric(march, 'cash_inflows', '24000.00', { basis: 'bank' });
  await writeMetric(march, 'cash_outflows', '19000.00', { basis: 'bank' });
  await writeMetric(march, 'net_cash_movement', '5000.00', { basis: 'bank' });
  await writeMetric(march, 'opening_cash', '21000.00', { basis: 'bank' });
  await writeMetric(march, 'closing_cash', '26000.00', { basis: 'bank' });
  await writeMetric(march, 'cash_runway_months', '9.5', { unit: 'count', basis: 'bank' });

  await writeMetric(march, 'receivables', '12000.00', { basis: 'invoices' });
  await writeMetric(march, 'receivables_overdue', '3000.00', { basis: 'invoices' });
  await writeMetric(march, 'receivables_days', '42', { unit: 'days', basis: 'invoices' });
  await writeMetric(march, 'payables', '4500.00', { basis: 'invoices' });
  await writeMetric(march, 'payables_overdue', '0.00', { basis: 'invoices' });
  await writeMetric(march, 'payables_days', '31', { unit: 'days', basis: 'invoices' });

  await writeMetric(march, 'customer_revenue', '15000.00', {
    basis: 'invoices', dimensionType: 'counterparty', dimensionId: customerId,
  });
  await writeMetric(march, 'customer_revenue', '5000.50', {
    basis: 'invoices', dimensionType: 'counterparty', dimensionId: otherCustomerId,
  });
  await writeMetric(march, 'customer_revenue_share', '0.7498', {
    unit: 'ratio', basis: 'invoices', dimensionType: 'counterparty', dimensionId: customerId,
  });
  await writeMetric(march, 'customer_concentration_top1', '0.7498', { unit: 'ratio', basis: 'invoices' });
  await writeMetric(february, 'customer_revenue', '9000.00', {
    basis: 'invoices', dimensionType: 'counterparty', dimensionId: customerId,
  });
}

async function scopeFor(userId: string): Promise<PeriodScope> {
  const scope = await loadPeriodScope(clientFor(userId), orgId, null);
  if (!scope) throw new Error('expected a month with figures');
  return scope;
}

beforeAll(async () => {
  ownerId = await createAuthUser(`money-owner-${SUITE}@${EMAIL_DOMAIN}`);
  clientUserId = await createAuthUser(`money-client-${SUITE}@${EMAIL_DOMAIN}`);
  strangerId = await createAuthUser(`money-stranger-${SUITE}@${EMAIL_DOMAIN}`);

  const created = await rpc<string>(clientFor(ownerId), 'create_organization', { p_name: `Moneyfix ${SUITE}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as string;
  orgSlug = String((await fs().collection('organizations').doc(orgId).get()).get('slug'));
  // The snapshots here are written by hand: no real calculation may run for this organisation.
  await parkQueuedJobs(orgId);
  await addMember(orgId, clientUserId, 'client');

  february = periodIdOf(orgId, '2026-02-01');
  march = periodIdOf(orgId, '2026-03-01');
  april = periodIdOf(orgId, '2026-04-01');

  bankAccountId = await seedBankAccount(orgId, {
    name: 'Business current account', bankName: 'Barclays', sortCode: '20-**-**', accountNumber: '****1234', type: 'current',
  });

  customerId = await seedCounterparty(orgId, { name: 'Northwind Ltd', kind: 'customer' });
  otherCustomerId = await seedCounterparty(orgId, { name: 'Initech', kind: 'customer' });

  systemRevenueAccount = await systemAccount(orgId, 'revenue');
  uncategorisedAccount = await systemAccount(orgId, 'uncategorised');
  importedAccount = await seedAccount(orgId, { name: 'Software subscriptions', category: 'uncategorised', accountType: 'asset', code: '7200' });

  // Two unpaid sales invoices, one of them well overdue, and one purchase invoice.
  for (const [type, cp, number, issue, due, total] of [
    ['sales', customerId, 'INV-014', '2026-02-10', '2026-03-12', '9000.00'],
    ['sales', otherCustomerId, 'INV-015', '2026-03-20', '2026-04-20', '3000.00'],
    ['purchase', customerId, 'BILL-7', '2026-03-02', '2026-04-02', '4500.00'],
  ] as const) {
    await seedInvoice(orgId, { counterpartyId: cp, type, number, issueDate: issue, dueDate: due, total });
  }

  // A month of statement lines: one categorised, one nobody has classified, one pointing at the
  // holding account — which is the same thing to a reader.
  await seedBankTxn(orgId, {
    bankAccountId, date: '2026-03-05', amount: '9000.00', descriptionRaw: 'FPS CREDIT NORTHWIND 20-11-22 12345678',
    description: 'FPS CREDIT NORTHWIND', categoryAccountId: systemRevenueAccount, categorySource: 'rule',
  });
  await seedBankTxn(orgId, {
    bankAccountId, date: '2026-03-14', amount: '-420.75', descriptionRaw: 'CARD PAYMENT TO ACME 12344321',
    description: 'CARD PAYMENT TO ACME ****4321', categoryAccountId: null, categorySource: 'none',
  });
  await seedBankTxn(orgId, {
    bankAccountId, date: '2026-03-18', amount: '-95.00', descriptionRaw: 'DD SOMETHING 9999',
    description: 'DD SOMETHING', categoryAccountId: uncategorisedAccount, categorySource: 'none',
  });
});

afterAll(async () => {
  await dropFixtures([orgId], EMAIL_DOMAIN);
});

beforeEach(async () => {
  await parkQueuedJobs(orgId);
  const writer = fs().bulkWriter();
  for (const table of ['metric_current', 'metric_snapshots', 'calculation_runs'] as const) {
    for (const d of (await orgCollection(fs(), orgId, table).get()).docs) void writer.delete(d.ref);
  }
  for (const d of (await orgCollection(fs(), orgId, 'fiscal_periods').get()).docs) void writer.update(d.ref, { is_complete: false });
  await writer.close();
});

// -----------------------------------------------------------------------------------------------
// Every figure equals its snapshot
// -----------------------------------------------------------------------------------------------

describe('every figure a Money page renders is the snapshot for that month', () => {
  beforeEach(seedMarch);

  it('opens on the latest complete month and offers only months with figures', async () => {
    const scope = await scopeFor(ownerId);
    expect(scope.period.id).toBe(march);
    expect(scope.previous?.id).toBe(february);
    // April has no figures, so the picker must not offer it: a month behind the picker is never
    // an empty page (§5).
    expect(scope.periods.map((p) => p.id)).not.toContain(april);
  });

  it('renders the P&L lines as the snapshots wrote them, to the penny', async () => {
    const db = clientFor(ownerId);
    const scope = await scopeFor(ownerId);
    const view = await loadProfitAndLoss(db, orgId, orgSlug, scope);

    const snapshots = await loadPeriodSnapshots(db, orgId, march);
    const byKey = new Map(snapshots.filter((s) => s.dimensionType === 'none').map((s) => [s.metricKey, s]));

    for (const figure of [...view.above, ...view.below]) {
      const snapshot = byKey.get(figure.metricKey);
      expect(snapshot, `${figure.metricKey} has no snapshot`).toBeDefined();
      expect(figure.rawValue, figure.metricKey).toBe(snapshot!.value);
      expect(figure.value, figure.metricKey).toBe(formatFigure(snapshot!));
    }

    // §8.2: pence on a Money sub-page. Home would round this to £20,001.
    expect(view.above.find((f) => f.metricKey === 'revenue')?.value).toBe('£20,000.50');
    expect(view.above.map((f) => f.metricKey))
      .toEqual(['revenue', 'cost_of_sales', 'gross_profit', 'gross_margin']);
    expect(view.below.map((f) => f.metricKey)).toEqual([
      'operating_expenses', 'operating_profit', 'operating_margin',
      'interest_expense', 'tax_expense', 'net_profit', 'net_margin',
    ]);
  });

  it('shows the change against the previous month from the variance snapshot', async () => {
    const scope = await scopeFor(ownerId);
    const view = await loadProfitAndLoss(clientFor(ownerId), orgId, orgSlug, scope);
    const revenue = view.above.find((f) => f.metricKey === 'revenue');
    expect(revenue?.change?.text).toContain('+£2,000.50');
    expect(revenue?.change?.text).toContain('Feb 2026');
    // A rise in revenue is good news; the direction is metric-aware (§4).
    expect(revenue?.change?.favourable).toBe(true);
  });

  it('lists spending by category from the dimensioned snapshots, biggest first', async () => {
    const scope = await scopeFor(ownerId);
    const view = await loadProfitAndLoss(clientFor(ownerId), orgId, orgSlug, scope);
    expect(view.spending.map((row) => row.key)).toEqual(['payroll', 'marketing']);
    expect(view.spending.map((row) => row.label)).toEqual(['Payroll', 'Marketing']);
    expect(view.spending[0]?.figure.value).toBe('£4,000.00');
  });

  it('renders the cash figures, including a runway that is a count and not money', async () => {
    const db = clientFor(ownerId);
    const scope = await scopeFor(ownerId);
    const view = await loadCash(db, orgId, orgSlug, scope);

    const snapshots = await loadPeriodSnapshots(db, orgId, march);
    const byKey = new Map(snapshots.map((s) => [s.metricKey, s]));
    for (const figure of view.figures) {
      expect(figure.rawValue, figure.metricKey).toBe(byKey.get(figure.metricKey)!.value);
    }
    expect(view.figures.find((f) => f.metricKey === 'closing_cash')?.value).toBe('£26,000.00');
    expect(view.figures.find((f) => f.metricKey === 'cash_runway_months')?.value).toBe('9.5');
  });

  it('puts the same month behind every link on the Money index', async () => {
    const scope = await scopeFor(ownerId);
    const view = await loadMoneyIndex(clientFor(ownerId), orgId, orgSlug, scope);
    const figures = new Map(view.links.map((l) => [l.title, l.figure?.value]));
    expect(figures.get('Profit & loss')).toBe('£20,000.50');
    expect(figures.get('Cash')).toBe('£26,000.00');
    expect(figures.get('Owed to you')).toBe('£12,000.00');
    expect(figures.get('You owe')).toBe('£4,500.00');
  });
});

describe('a figure that cannot be computed', () => {
  it('is a dash with the reason, never a zero (§4)', async () => {
    await markComplete(march, true);
    await writeMetric(march, 'cash_inflows', '4000.00', { basis: 'bank' });
    await writeMetric(march, 'closing_cash', null, {
      basis: 'bank',
      quality: { completeness: 0, proxy: false, warnings: [], missing: ['no_opening_cash'] },
    });

    const scope = await scopeFor(ownerId);
    const view = await loadCash(clientFor(ownerId), orgId, orgSlug, scope);
    const cash = view.figures.find((f) => f.metricKey === 'closing_cash');

    expect(cash?.value).toBe('—');
    expect(cash?.rawValue).toBeNull();
    expect(cash?.status.kind).toBe('not_available');
    expect(cash?.status.tooltip).toContain('opening bank balance');
  });
});

// -----------------------------------------------------------------------------------------------
// What each role can see
// -----------------------------------------------------------------------------------------------

describe('what each role can read behind these pages', () => {
  beforeEach(seedMarch);

  it('shows a client exactly the figures an owner sees', async () => {
    const scope = await scopeFor(ownerId);
    const owner = await loadProfitAndLoss(clientFor(ownerId), orgId, orgSlug, scope);
    const clientView = await loadProfitAndLoss(clientFor(clientUserId), orgId, orgSlug, scope);
    expect(clientView.above.map((f) => f.value)).toEqual(owner.above.map((f) => f.value));
    expect(clientView.below.map((f) => f.value)).toEqual(owner.below.map((f) => f.value));
  });

  it('lets a client read cash, bank activity, the invoice books and customers', async () => {
    const db = clientFor(clientUserId);
    const scope = await scopeFor(clientUserId);
    expect((await loadCash(db, orgId, orgSlug, scope)).figures.length).toBeGreaterThan(0);
    expect((await loadBanking(db, orgId, orgSlug, scope, 'all')).transactions).toHaveLength(3);
    expect((await loadLedgerBook(db, orgId, orgSlug, scope, 'receivables', '2026-03-31')).invoices)
      .toHaveLength(2);
    expect((await loadCustomers(db, orgId, orgSlug, scope)).customers).toHaveLength(2);
    expect((await loadAccountsPage(db, orgId)).rows.length).toBeGreaterThan(0);
  });

  it('gives a stranger nothing at all — no months, no figures, no records', async () => {
    const db = clientFor(strangerId);

    // RLS, not a filter in the query: the read layer would return nothing even if the
    // organization_id fence were removed (ADR-013).
    expect(await loadPeriodScope(db, orgId, null)).toBeNull();
    expect(await loadPeriodSnapshots(db, orgId, march)).toEqual([]);
    expect((await loadAccountsPage(db, orgId)).rows).toEqual([]);

    const scope = await scopeFor(ownerId);
    const view = await loadBanking(db, orgId, orgSlug, scope, 'all');
    expect(view.transactions).toEqual([]);
    expect(view.accounts).toEqual([]);
    expect((await loadCustomers(db, orgId, orgSlug, scope)).customers).toEqual([]);
    expect(await loadCustomerDetail(db, orgId, orgSlug, scope, customerId, '2026-03-31')).toBeNull();
  });
});

// -----------------------------------------------------------------------------------------------
// The raw statement text (ADR-044.2, R2-A-04)
// -----------------------------------------------------------------------------------------------

describe('description_raw is never read out, so the Bank activity page cannot leak it', () => {
  beforeEach(seedMarch);

  // On PostgreSQL the column privilege was revoked from `authenticated` outright (42501 for every
  // role). The documents carry the field; what holds now is that the page's readers never return it
  // — asserted below on the rendered view, for an owner and a client alike.
  it('is absent from the view for an owner and a client alike', async () => {
    for (const userId of [ownerId, clientUserId]) {
      const view = await loadBanking(clientFor(userId), orgId, orgSlug, await scopeFor(userId), 'all');
      expect(JSON.stringify(view)).not.toContain('12345678');
    }
  });

  it('renders the normalised description instead, with nothing raw anywhere in the view', async () => {
    const scope = await scopeFor(ownerId);
    const view = await loadBanking(clientFor(ownerId), orgId, orgSlug, scope, 'all');

    const descriptions = view.transactions.map((t) => t.description);
    expect(descriptions).toContain('CARD PAYMENT TO ACME ****4321');
    // The raw text carried a third party's sort code and account number.
    expect(JSON.stringify(view)).not.toContain('20-11-22');
    expect(JSON.stringify(view)).not.toContain('12345678');
    expect(JSON.stringify(view)).not.toContain('description_raw');
  });
});

// -----------------------------------------------------------------------------------------------
// Bank activity filters
// -----------------------------------------------------------------------------------------------

describe('the uncategorised filter the Data quality card links to', () => {
  beforeEach(seedMarch);

  it('counts both an absent category and the holding account', async () => {
    const scope = await scopeFor(ownerId);
    const all = await loadBanking(clientFor(ownerId), orgId, orgSlug, scope, 'all');
    expect(all.transactions).toHaveLength(3);
    expect(all.uncategorisedCount).toBe(2);
  });

  it('shows only those transactions under ?filter=uncategorised', async () => {
    const scope = await scopeFor(ownerId);
    const filtered = await loadBanking(clientFor(ownerId), orgId, orgSlug, scope, 'uncategorised');
    expect(filtered.transactions).toHaveLength(2);
    expect(filtered.transactions.every((t) => t.uncategorised)).toBe(true);
    // The count is of the whole month, not of the filtered list, so the link keeps its meaning.
    expect(filtered.uncategorisedCount).toBe(2);
  });
});

// -----------------------------------------------------------------------------------------------
// Owed to you / You owe
// -----------------------------------------------------------------------------------------------

describe('the invoice books', () => {
  beforeEach(seedMarch);

  it('states the totals from snapshots and lists the invoices behind them', async () => {
    const scope = await scopeFor(ownerId);
    const view = await loadLedgerBook(
      clientFor(ownerId), orgId, orgSlug, scope, 'receivables', '2026-03-31',
    );

    expect(view.figures.map((f) => f.metricKey))
      .toEqual(['receivables', 'receivables_overdue', 'receivables_days']);
    expect(view.figures[0]?.value).toBe('£12,000.00');
    expect(view.figures[2]?.value).toBe('42 days');

    const overdue = view.invoices.find((i) => i.number === 'INV-014');
    expect(overdue?.bucketLabel).toBe('1–30 days late');
    expect(overdue?.balanceDue).toBe('£9,000.00');
    expect(view.invoices.find((i) => i.number === 'INV-015')?.bucketLabel).toBe('Not due yet');
  });

  it('keeps the two books apart: a purchase invoice never appears under Owed to you', async () => {
    const scope = await scopeFor(ownerId);
    const db = clientFor(ownerId);
    const owed = await loadLedgerBook(db, orgId, orgSlug, scope, 'receivables', '2026-03-31');
    const owe = await loadLedgerBook(db, orgId, orgSlug, scope, 'payables', '2026-03-31');

    expect(owed.invoices.map((i) => i.number)).toEqual(['INV-014', 'INV-015']);
    expect(owe.invoices.map((i) => i.number)).toEqual(['BILL-7']);
    expect(owe.figures[0]?.value).toBe('£4,500.00');
  });
});

// -----------------------------------------------------------------------------------------------
// Customers
// -----------------------------------------------------------------------------------------------

describe('customers', () => {
  beforeEach(seedMarch);

  it('ranks them by the revenue snapshot, biggest first, with concentration above', async () => {
    const scope = await scopeFor(ownerId);
    const view = await loadCustomers(clientFor(ownerId), orgId, orgSlug, scope);

    expect(view.customers.map((c) => c.name)).toEqual(['Northwind Ltd', 'Initech']);
    expect(view.customers[0]?.revenue.value).toBe('£15,000.00');
    expect(view.customers[0]?.share).toBe('75.0%');
    expect(view.concentration.map((f) => f.metricKey)).toEqual(['customer_concentration_top1']);
    expect(view.concentration[0]?.value).toBe('75.0%');
  });

  it('shows one customer their own months and their own invoices', async () => {
    const scope = await scopeFor(ownerId);
    const view = await loadCustomerDetail(
      clientFor(ownerId), orgId, orgSlug, scope, customerId, '2026-03-31',
    );
    expect(view?.counterparty.name).toBe('Northwind Ltd');
    expect(view?.revenue?.value).toBe('£15,000.00');

    const byLabel = new Map(view!.trend.map((p) => [p.label, p.value]));
    expect(byLabel.get('Mar 2026')).toBe('£15,000.00');
    expect(byLabel.get('Feb 2026')).toBe('£9,000.00');

    // Only their invoices, and only sales invoices — the purchase bill is a different book.
    expect(view?.invoices.map((i) => i.number)).toEqual(['INV-014']);
  });

  it('answers with nothing for a counterparty id from another organisation', async () => {
    const scope = await scopeFor(ownerId);
    const foreign = '00000000-0000-0000-0000-0000000000ff';
    // The page turns this into the uniform 404 rather than confirming the id exists (§10).
    expect(await loadCustomerDetail(
      clientFor(ownerId), orgId, orgSlug, scope, foreign, '2026-03-31',
    )).toBeNull();
  });
});

// -----------------------------------------------------------------------------------------------
// The opening-balance form (CD-06)
// -----------------------------------------------------------------------------------------------

describe("the opening-balance form's action", () => {
  it('is not offered to a client, and is refused if one calls it anyway', async () => {
    const clientCtx = { effectiveRole: 'client' as const, permissions: permissionsFor('client') };

    // The action's own guard: the form is never rendered for this role (§7.4) …
    expect(can(clientCtx, 'financials.edit')).toBe(false);
    expect(() => assertCan(clientCtx, 'financials.edit')).toThrow(/permission/i);

    // … and the write is refused again in SQL, where a caller who skipped the page cannot get
    // round it (ADR-026).
    await expect(setOpeningBalance(clientFor(clientUserId), {
      bankAccountId, amount: '5000.00', date: '2026-03-01',
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    expect((await rowOf(orgId, 'bank_accounts', bankAccountId))?.opening_balance ?? null).toBeNull();
  });

  it('accepts an owner, and the Cash page stops asking once it is set', async () => {
    await markComplete(march, true);
    await writeMetric(march, 'closing_cash', '26000.00', { basis: 'bank' });

    const before = await loadCash(clientFor(ownerId), orgId, orgSlug, await scopeFor(ownerId));
    expect(before.openingBalanceMissing).toBe(true);
    expect(before.accounts[0]?.openingBalance).toBe('—');

    await setOpeningBalance(clientFor(ownerId), {
      bankAccountId, amount: '5000.00', date: '2026-03-01',
    });
    await parkQueuedJobs(orgId);

    const after = await loadCash(clientFor(ownerId), orgId, orgSlug, await scopeFor(ownerId));
    expect(after.openingBalanceMissing).toBe(false);
    expect(after.accounts[0]?.openingBalance).toBe('£5,000.00');

    await orgRow(fs(), orgId, 'bank_accounts', bankAccountId).update({ opening_balance: null, opening_balance_date: null });
  });

  it('refuses an amount without a date: an opening balance is both or neither', async () => {
    await expect(setOpeningBalance(clientFor(ownerId), {
      bankAccountId, amount: '5000.00', date: null,
    })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// -----------------------------------------------------------------------------------------------
// The re-map control (ADR-004)
// -----------------------------------------------------------------------------------------------

describe('the re-map control on the chart of accounts', () => {
  it('refuses a system account: a seeded account IS its category (ADR-004)', async () => {
    await expect(remapAccount(clientFor(ownerId), {
      accountId: systemRevenueAccount, standardCategory: 'marketing',
    })).rejects.toMatchObject({ code: 'VALIDATION' });

    expect((await rowOf(orgId, 'accounts', systemRevenueAccount))?.standard_category).toBe('revenue');
  });

  it('never even offers the control for one', async () => {
    const view = await loadAccountsPage(clientFor(ownerId), orgId);
    const system = view.rows.find((r) => r.account.id === systemRevenueAccount);
    expect(system?.remappable).toBe(false);
  });

  it('is refused for a client, who has no financials.edit', async () => {
    await expect(remapAccount(clientFor(clientUserId), {
      accountId: importedAccount, standardCategory: 'marketing',
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('re-maps an imported account for an owner and confirms the mapping', async () => {
    await remapAccount(clientFor(ownerId), {
      accountId: importedAccount, standardCategory: 'marketing',
    });

    const view = await loadAccountsPage(clientFor(ownerId), orgId);
    const row = view.rows.find((r) => r.account.id === importedAccount);
    expect(row?.account.standardCategory).toBe('marketing');
    expect(row?.account.mappingConfidence).toBe('confirmed');
    expect(row?.categoryLabel).toBe('Marketing');
    expect(row?.needsAttention).toBe(false);

    // A remap changes every metric that reads the account, so a recalculation is queued with it.
    const jobs = await fs().collection('jobs').where('organization_id', '==', orgId).where('job_type', '==', 'calculation.run').get();
    expect(jobs.size).toBeGreaterThan(0);

    await orgRow(fs(), orgId, 'accounts', importedAccount).update({
      standard_category: 'uncategorised', account_type: 'asset', mapping_confidence: 'unmapped',
    });
  });
});

describe('the chart of accounts puts the rows that need a decision first', () => {
  it('lists the unmapped account before the settled ones', async () => {
    const view = await loadAccountsPage(clientFor(ownerId), orgId);
    expect(view.unmappedCount).toBeGreaterThan(0);
    expect(view.rows[0]?.account.id).toBe(importedAccount);
    expect(view.rows[0]?.confidenceLabel).toBe('No category yet');
    expect(view.rows[0]?.needsAttention).toBe(true);
  });
});
