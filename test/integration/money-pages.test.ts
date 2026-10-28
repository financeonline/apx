import { randomUUID } from 'node:crypto';

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

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
import { adminSql, clientFor, createAuthUser, sqlstate } from './setup';

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
 * The assertions are made against the database, not the DOM: what matters is that the page's data
 * equals its evidence, and a rendering test cannot show that.
 *
 * The fixtures deliberately do NOT use `resetFixtures()`. That helper deletes every `itest-` row in
 * the database, which is correct when the suite owns the instance and destructive when a second
 * engineer is running their own file against the same local Supabase — each run then deletes the
 * other's organisation mid-test. This file owns a uniquely named organisation and a domain of its
 * own, creates it once and removes exactly that, so it neither depends on nor disturbs anything
 * else on the instance.
 */

/** Unique per run, so two runs of this file can never collide on the organisation slug. */
const SUITE = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = 'moneyfix.test';

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

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

/** Writes a snapshot and its pointer, exactly as a calculation run would. */
function writeMetric(periodId: string, key: string, value: string | null, over: {
  unit?: string;
  basis?: string;
  assurance?: string;
  quality?: Record<string, unknown>;
  components?: Record<string, unknown>;
  dimensionType?: string;
  dimensionId?: string | null;
  /** A standard category has no row to point at, so it travels here (ADR-053). */
  dimensionKey?: string | null;
} = {}): string {
  const runId = one(`
    insert into public.calculation_runs
           (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
    values ('${orgId}', 'recalc_manual', '1.0.0', '${periodId}', '${periodId}', '2026-06-15', 'succeeded')
    returning id`);

  const dimensionType = over.dimensionType ?? 'none';
  const dimensionId = over.dimensionId ?? null;
  const dimensionKey = over.dimensionKey ?? null;

  const snapshotId = one(`
    insert into public.metric_snapshots
           (organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id,
            dimension_key, value, unit, currency, basis, assurance_level, data_quality, components)
    values ('${orgId}', '${runId}', '${periodId}', '${key}', '${dimensionType}',
            ${dimensionId === null ? 'null' : `'${dimensionId}'`},
            ${dimensionKey === null ? 'null' : `'${dimensionKey}'`},
            ${value === null ? 'null' : value}, '${over.unit ?? 'money'}',
            ${over.unit === 'ratio' || over.unit === 'days' || over.unit === 'count' ? 'null' : "'GBP'"},
            '${over.basis ?? 'ledger'}', '${over.assurance ?? 'verified'}',
            '${JSON.stringify(over.quality ?? { completeness: 1, proxy: false, warnings: [], missing: [] })}'::jsonb,
            '${JSON.stringify(over.components ?? {})}'::jsonb)
    returning id`);

  adminSql(`
    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id, dimension_key,
            snapshot_id, calculation_run_id)
    values ('${orgId}', '${periodId}', '${key}', '${dimensionType}',
            ${dimensionId === null ? 'null' : `'${dimensionId}'`},
            ${dimensionKey === null ? 'null' : `'${dimensionKey}'`}, '${snapshotId}', '${runId}')
    on conflict do nothing`);

  return snapshotId;
}

function markComplete(periodId: string, complete: boolean): void {
  adminSql(`update public.fiscal_periods set is_complete = ${complete} where id = '${periodId}'`);
}

/** March, fully stated: the month every "equals its snapshot" assertion is made against. */
function seedMarch(): void {
  markComplete(february, true);
  markComplete(march, true);

  writeMetric(february, 'revenue', '18000.00');
  writeMetric(february, 'closing_cash', '21000.00');

  writeMetric(march, 'revenue', '20000.50');
  writeMetric(march, 'cost_of_sales', '6000.25');
  writeMetric(march, 'gross_profit', '14000.25');
  writeMetric(march, 'gross_margin', '0.7000', { unit: 'ratio' });
  writeMetric(march, 'operating_expenses', '6000.00');
  writeMetric(march, 'operating_profit', '8000.25');
  writeMetric(march, 'operating_margin', '0.4000', { unit: 'ratio' });
  writeMetric(march, 'interest_expense', '120.00');
  writeMetric(march, 'tax_expense', '1400.00');
  writeMetric(march, 'net_profit', '6480.25');
  writeMetric(march, 'net_margin', '0.3239', { unit: 'ratio' });
  writeMetric(march, 'revenue.variance.prev_period', '2000.50', {
    components: { pct_change: 0.1111 },
  });

  // The dimensioned spending breakdown. `dimension_id` is a uuid column, so the category travels in
  // the components — which is where the page reads it from.
  writeMetric(march, 'expense_by_category', '4000.00', {
    dimensionType: 'standard_category', dimensionKey: 'payroll',
  });
  writeMetric(march, 'expense_by_category', '1500.00', {
    dimensionType: 'standard_category', dimensionKey: 'marketing',
  });

  writeMetric(march, 'cash_inflows', '24000.00', { basis: 'bank' });
  writeMetric(march, 'cash_outflows', '19000.00', { basis: 'bank' });
  writeMetric(march, 'net_cash_movement', '5000.00', { basis: 'bank' });
  writeMetric(march, 'opening_cash', '21000.00', { basis: 'bank' });
  writeMetric(march, 'closing_cash', '26000.00', { basis: 'bank' });
  writeMetric(march, 'cash_runway_months', '9.5', { unit: 'count', basis: 'bank' });

  writeMetric(march, 'receivables', '12000.00', { basis: 'invoices' });
  writeMetric(march, 'receivables_overdue', '3000.00', { basis: 'invoices' });
  writeMetric(march, 'receivables_days', '42', { unit: 'days', basis: 'invoices' });
  writeMetric(march, 'payables', '4500.00', { basis: 'invoices' });
  writeMetric(march, 'payables_overdue', '0.00', { basis: 'invoices' });
  writeMetric(march, 'payables_days', '31', { unit: 'days', basis: 'invoices' });

  writeMetric(march, 'customer_revenue', '15000.00', {
    basis: 'invoices', dimensionType: 'counterparty', dimensionId: customerId,
  });
  writeMetric(march, 'customer_revenue', '5000.50', {
    basis: 'invoices', dimensionType: 'counterparty', dimensionId: otherCustomerId,
  });
  writeMetric(march, 'customer_revenue_share', '0.7498', {
    unit: 'ratio', basis: 'invoices', dimensionType: 'counterparty', dimensionId: customerId,
  });
  writeMetric(march, 'customer_concentration_top1', '0.7498', { unit: 'ratio', basis: 'invoices' });
  writeMetric(february, 'customer_revenue', '9000.00', {
    basis: 'invoices', dimensionType: 'counterparty', dimensionId: customerId,
  });
}

async function scopeFor(userId: string): Promise<PeriodScope> {
  const scope = await loadPeriodScope(clientFor(userId), orgId, null);
  if (!scope) throw new Error('expected a month with figures');
  return scope;
}

/**
 * Removes only what THIS run created.
 *
 * Scoped to the run's own suffix rather than to a shared prefix, so two runs of this file against
 * the same local Supabase — one engineer's and another's — cannot delete each other's fixtures
 * halfway through. Anything left behind by a run that crashed is swept once it is an hour old.
 */
function cleanup(): void {
  adminSql(`
    delete from public.organizations where name = 'Moneyfix ${SUITE}';
    delete from public.organizations
     where name like 'Moneyfix %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%-${SUITE}@${EMAIL_DOMAIN}';
    delete from auth.users
     where email like '%@${EMAIL_DOMAIN}' and created_at < now() - interval '1 hour';
  `);
}

beforeAll(async () => {
  cleanup();
  ownerId = createAuthUser(`money-owner-${SUITE}@${EMAIL_DOMAIN}`);
  clientUserId = createAuthUser(`money-client-${SUITE}@${EMAIL_DOMAIN}`);
  strangerId = createAuthUser(`money-stranger-${SUITE}@${EMAIL_DOMAIN}`);

  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: `Moneyfix ${SUITE}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  orgSlug = one(`select slug from public.organizations where id = '${orgId}'`);

  adminSql(`
    set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role)
    values ('${orgId}', '${clientUserId}', 'client');`);

  const periodId = (start: string) => one(`
    select id from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '${start}'`);
  february = periodId('2026-02-01');
  march = periodId('2026-03-01');
  april = periodId('2026-04-01');

  bankAccountId = one(`
    insert into public.bank_accounts
           (organization_id, name, bank_name, sort_code_masked, account_number_masked, account_type)
    values ('${orgId}', 'Business current account', 'Barclays', '20-**-**', '****1234', 'current')
    returning id`);

  customerId = one(`
    insert into public.counterparties (organization_id, name, normalized_name, kind)
    values ('${orgId}', 'Northwind Ltd', 'northwind ltd', 'customer') returning id`);
  otherCustomerId = one(`
    insert into public.counterparties (organization_id, name, normalized_name, kind)
    values ('${orgId}', 'Initech', 'initech', 'customer') returning id`);

  systemRevenueAccount = one(`
    select id from public.accounts
     where organization_id = '${orgId}' and standard_category = 'revenue' and is_system`);
  uncategorisedAccount = one(`
    select id from public.accounts
     where organization_id = '${orgId}' and standard_category = 'uncategorised' and is_system`);
  importedAccount = one(`
    insert into public.accounts
           (organization_id, code, name, account_type, standard_category, source, mapping_confidence)
    values ('${orgId}', '7200', 'Software subscriptions', 'asset', 'uncategorised',
            'imported', 'unmapped')
    returning id`);

  // Two unpaid sales invoices, one of them well overdue, and one purchase invoice.
  adminSql(`
    insert into public.invoices
           (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date,
            period_id, total_amount, amount_paid, record_status)
    values ('${orgId}', 'sales', '${customerId}', 'INV-014', '2026-02-10', '2026-03-12',
            '${march}', 9000.00, 0, 'accepted'),
           ('${orgId}', 'sales', '${otherCustomerId}', 'INV-015', '2026-03-20', '2026-04-20',
            '${march}', 3000.00, 0, 'accepted'),
           ('${orgId}', 'purchase', '${customerId}', 'BILL-7', '2026-03-02', '2026-04-02',
            '${march}', 4500.00, 0, 'accepted')`);

  // A month of statement lines: one categorised, one nobody has classified, one pointing at the
  // holding account — which is the same thing to a reader.
  adminSql(`
    insert into public.bank_transactions
           (organization_id, bank_account_id, transaction_date, amount, period_id,
            description_raw, description_normalized, category_account_id, category_source,
            record_status)
    values ('${orgId}', '${bankAccountId}', '2026-03-05', 9000.00, '${march}',
            'FPS CREDIT NORTHWIND 20-11-22 12345678', 'FPS CREDIT NORTHWIND',
            '${systemRevenueAccount}', 'rule', 'accepted'),
           ('${orgId}', '${bankAccountId}', '2026-03-14', -420.75, '${march}',
            'CARD PAYMENT TO ACME 12344321', 'CARD PAYMENT TO ACME ****4321', null, 'none', 'accepted'),
           ('${orgId}', '${bankAccountId}', '2026-03-18', -95.00, '${march}',
            'DD SOMETHING 9999', 'DD SOMETHING', '${uncategorisedAccount}', 'none', 'accepted')`);
});

afterAll(() => cleanup());

beforeEach(() => {
  adminSql(`
    begin;
    set local app.purge = 'on';
    delete from public.metric_current where organization_id = '${orgId}';
    delete from public.metric_snapshots where organization_id = '${orgId}';
    delete from public.calculation_runs where organization_id = '${orgId}';
    update public.fiscal_periods set is_complete = false where organization_id = '${orgId}';
    commit;`);
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
    markComplete(march, true);
    writeMetric(march, 'cash_inflows', '4000.00', { basis: 'bank' });
    writeMetric(march, 'closing_cash', null, {
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

describe('description_raw is not selectable, so the Bank activity page cannot leak it', () => {
  beforeEach(seedMarch);

  it('refuses the column to an owner, an admin and a client alike', async () => {
    for (const userId of [ownerId, clientUserId]) {
      const { error } = await clientFor(userId)
        .from('bank_transactions')
        .select('id, description_raw')
        .eq('organization_id', orgId);
      // 42501: the privilege is revoked from `authenticated` outright. This is not RLS and not a
      // role check — there is no role for which the column is selectable.
      expect(sqlstate(error), 'description_raw must not be selectable').toBe('42501');
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

    expect(one(`
      select coalesce(opening_balance::text, 'null') from public.bank_accounts
       where id = '${bankAccountId}'`)).toBe('null');
  });

  it('accepts an owner, and the Cash page stops asking once it is set', async () => {
    markComplete(march, true);
    writeMetric(march, 'closing_cash', '26000.00', { basis: 'bank' });

    const before = await loadCash(clientFor(ownerId), orgId, orgSlug, await scopeFor(ownerId));
    expect(before.openingBalanceMissing).toBe(true);
    expect(before.accounts[0]?.openingBalance).toBe('—');

    await setOpeningBalance(clientFor(ownerId), {
      bankAccountId, amount: '5000.00', date: '2026-03-01',
    });

    const after = await loadCash(clientFor(ownerId), orgId, orgSlug, await scopeFor(ownerId));
    expect(after.openingBalanceMissing).toBe(false);
    expect(after.accounts[0]?.openingBalance).toBe('£5,000.00');

    adminSql(`
      update public.bank_accounts set opening_balance = null, opening_balance_date = null
       where id = '${bankAccountId}'`);
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

    expect(one(`
      select standard_category::text from public.accounts
       where id = '${systemRevenueAccount}'`)).toBe('revenue');
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
    expect(Number(one(`
      select count(*) from public.jobs
       where organization_id = '${orgId}' and job_type = 'calculation.run'`))).toBeGreaterThan(0);

    adminSql(`
      update public.accounts
         set standard_category = 'uncategorised', account_type = 'asset',
             mapping_confidence = 'unmapped'
       where id = '${importedAccount}'`);
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
