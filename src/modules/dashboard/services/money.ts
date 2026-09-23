import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { compare, formatMoney } from '@/core/money';
import { varianceKey } from '@/modules/financial-engine';
import {
  listAccounts, listCounterparties, listInvoices, metricAvailability,
  STANDARD_CATEGORIES,
  type Account, type Counterparty, type Invoice, type StandardCategory,
} from '@/modules/financials';
import {
  listBankAccounts, listBankTransactions, type BankAccount, type BankTransaction,
} from '@/modules/banking';
import * as repo from '../data/repository';
import {
  changeFrom, formatValue, toMetricCard,
  type MetricCardView, type PeriodLabel, type SnapshotRow,
} from '../domain/view-models';

/**
 * The Money section, Customers and the chart of accounts (UX_ARCHITECTURE.md §3.2, §4;
 * ROUTE_ARCHITECTURE.md §4).
 *
 * The rule this file exists to obey is §4's: **every figure comes from `metric_current` through the
 * dashboard repository, and nothing here computes a financial number.** Records — invoices, bank
 * transactions, accounts — are read too, but only as the evidence *behind* a figure: they are
 * listed, filtered and sorted, never summed. If a page needs a total that no metric provides, the
 * honest answer is "—" with a reason (§4), not an addition done here.
 *
 * The one thing these loaders do that Home's does not is show pence: §8.2 puts pence on Money
 * sub-pages, evidence and reports, and nowhere else.
 */

// ---------------------------------------------------------------------------------------------
// Period selection
// ---------------------------------------------------------------------------------------------

/** The months a page can be scoped to, and the one it is showing. */
export interface PeriodScope {
  readonly period: PeriodLabel;
  /** The month the change column compares with: the nearest earlier month that has figures. */
  readonly previous: PeriodLabel | null;
  /** Only months with computed figures, newest first — what the period picker may offer (§5). */
  readonly periods: readonly PeriodLabel[];
}

/**
 * Which month a period-scoped page opens on (§4, ADR-030).
 *
 * A `?period=` in the URL wins, but only if that month actually has figures — a stale or foreign id
 * must not produce an empty page pretending to be a month. Otherwise the latest COMPLETE month, the
 * same rule Home and the analyst use; and if no month is complete yet, the latest month with data,
 * so a first-time user sees their figures rather than an empty state that is not true.
 */
export function resolvePeriod(
  periods: readonly PeriodLabel[],
  withData: ReadonlySet<string>,
  requested?: string | null,
): PeriodLabel | null {
  const available = periods.filter((p) => withData.has(p.id));
  if (available.length === 0) return null;
  if (requested) {
    const asked = available.find((p) => p.id === requested);
    if (asked) return asked;
  }
  return available.find((p) => p.isComplete) ?? available[0] ?? null;
}

/** The nearest earlier month that carries figures. Never a month the engine has not computed. */
export function previousPeriodOf(
  periods: readonly PeriodLabel[],
  withData: ReadonlySet<string>,
  period: PeriodLabel,
): PeriodLabel | null {
  return periods
    .filter((p) => withData.has(p.id) && p.periodStart < period.periodStart)[0] ?? null;
}

export async function loadPeriodScope(
  db: SupabaseClient, orgId: string, requested?: string | null, requestId?: string,
): Promise<PeriodScope | null> {
  const [periods, withData] = await Promise.all([
    repo.loadPeriods(db, orgId, requestId),
    repo.loadPeriodsWithData(db, orgId, requestId),
  ]);
  const period = resolvePeriod(periods, withData, requested);
  if (!period) return null;
  return {
    period,
    previous: previousPeriodOf(periods, withData, period),
    periods: periods.filter((p) => withData.has(p.id)),
  };
}

// ---------------------------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------------------------

/**
 * A money figure with pence (§8.2).
 *
 * `formatValue` is the Home formatting — whole units — and Home is right to round: a headline card
 * is read at a glance. A Money sub-page is read by somebody checking it against a statement, so the
 * pence have to be there. Everything else (ratios, days, counts) formats identically, through the
 * same `core/money` functions; this never formats a number itself.
 */
export function formatFigure(row: Pick<SnapshotRow, 'value' | 'unit' | 'currency'>): string {
  if (row.value === null) return '—';
  if (row.unit === 'money') {
    return formatMoney(row.value, { currency: row.currency ?? 'GBP', showMinorUnits: true });
  }
  return formatValue(row);
}

export interface FigureOptions {
  readonly orgSlug: string;
  readonly comparisonLabel: string;
  readonly secondary?: { readonly label: string; readonly row: SnapshotRow | null };
}

/** The Home card view model, re-formatted for a Money sub-page. Same badge, same "Why?", same change. */
export function toFigure(
  row: SnapshotRow,
  period: PeriodLabel,
  variance: VarianceLike | null,
  options: FigureOptions,
): MetricCardView {
  // §8.2: a Money sub-page shows pence, because an accountant may be reconciling to the penny. The
  // option goes to `toMetricCard` so the CHANGE line is formatted the same way as the value —
  // formatting the two differently is how a page comes to show "£12,400.50" beside "+£2,001".
  return toMetricCard(row, period, variance, { ...options, showMinorUnits: true });
}

type VarianceLike = Parameters<typeof changeFrom>[1];

function index(rows: readonly SnapshotRow[]): Map<string, SnapshotRow> {
  const map = new Map<string, SnapshotRow>();
  for (const row of rows) {
    if (row.dimensionType === 'none') map.set(row.metricKey, row);
  }
  return map;
}

/**
 * Builds the figures a page lists, in the order the statement is read.
 *
 * A key with no snapshot is skipped rather than shown as zero: the engine writes a row for every
 * metric it could even attempt, so a missing row means the metric does not apply to this
 * organisation at all (§4).
 */
function figuresFor(
  keys: readonly string[],
  byKey: Map<string, SnapshotRow>,
  period: PeriodLabel,
  options: FigureOptions,
): MetricCardView[] {
  const out: MetricCardView[] = [];
  const costOfSales = byKey.get('cost_of_sales');
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row) continue;
    /*
     * ADR-106: the ONE availability rule Home and the analyst read. The engine writes gross profit as
     * revenue when there is no cost of sales to subtract, so the statement adds up; on this page that
     * line sat between a cost of sales reading "—" and a margin reading "—" as "£12,500 · Partial
     * data", which is the same figure Home omits and the analyst is not given. It is presented here
     * exactly as an unavailable figure is — "—" with the engine's reason — by handing the renderer
     * the row with no value and that reason, so no second rendering rule exists. A real gross
     * profit is untouched.
     */
    const availability = metricAvailability(
      key,
      { value: row.value, warnings: row.dataQuality.warnings, missing: row.dataQuality.missing },
      costOfSales
        ? { value: costOfSales.value, warnings: costOfSales.dataQuality.warnings, missing: costOfSales.dataQuality.missing }
        : null,
    );
    if (availability.state === 'not_applicable') {
      out.push(toFigure(
        { ...row, value: null, dataQuality: { ...row.dataQuality, missing: [availability.reason as SnapshotRow['dataQuality']['missing'][number]] } },
        period, null, options,
      ));
      continue;
    }
    out.push(toFigure(row, period, byKey.get(varianceKey(key, 'prev_period')) ?? null, options));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Labels for the dimensioned breakdowns
// ---------------------------------------------------------------------------------------------

/**
 * The 26 standard categories in the words a Money sub-page may use (§8.1: the accountant's term is
 * allowed here, where an accountant may be reading). Typed as a total map so a 27th category is a
 * compile error rather than a row rendered with a raw enum value.
 */
export const CATEGORY_LABELS: Readonly<Record<StandardCategory, string>> = {
  revenue: 'Revenue',
  other_income: 'Other income',
  cost_of_sales: 'Cost of sales',
  operating_expense: 'Other running costs',
  payroll: 'Payroll',
  marketing: 'Marketing',
  interest_expense: 'Interest paid',
  tax_expense: 'Tax',
  depreciation: 'Depreciation',
  other_expense: 'Other costs',
  cash: 'Cash',
  receivables: 'Owed to you',
  inventory: 'Stock',
  other_current_asset: 'Other short-term assets',
  fixed_asset: 'Fixed assets',
  other_asset: 'Other assets',
  payables: 'You owe',
  credit_card: 'Credit cards',
  loan: 'Loans',
  tax_liability: 'Tax owed',
  other_current_liability: 'Other short-term liabilities',
  long_term_liability: 'Long-term liabilities',
  equity: 'Equity',
  drawings: 'Drawings',
  transfer: 'Transfers between accounts',
  uncategorised: 'Not yet categorised',
};

export function categoryLabel(category: string | null): string {
  if (!category) return 'Unattributed';
  return CATEGORY_LABELS[category as StandardCategory] ?? category;
}

/**
 * What a dimensioned snapshot is a breakdown OF.
 *
 * A dimension that is a row — an account, a counterparty, a bank account — is identified by
 * `dimension_id`. A standard category is not a row and has no uuid to point at, so it travels in
 * `dimension_key` (ADR-053). The components fallback is kept for snapshots written before that
 * column existed: an old snapshot must stay readable, because a report generated last month has to
 * resolve to the numbers it saw (FINANCIAL_ENGINE.md §6).
 */
export function dimensionKeyOf(row: SnapshotRow): string | null {
  if (typeof row.dimensionKey === 'string') return row.dimensionKey;
  const fromComponents = row.components.category;
  if (typeof fromComponents === 'string') return fromComponents;
  return row.dimensionId;
}

export interface BreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly figure: MetricCardView;
}

// ---------------------------------------------------------------------------------------------
// Money index
// ---------------------------------------------------------------------------------------------

export interface MoneyLink {
  readonly href: string;
  readonly title: string;
  readonly description: string;
  /** The month's headline figure for that page, or null when the page has no figure yet. */
  readonly figure: MetricCardView | null;
  readonly permission: 'financials.view' | 'banking.view';
}

export interface MoneyIndexView {
  readonly scope: PeriodScope;
  readonly links: readonly MoneyLink[];
}

/** The one figure that says what each sub-page is about, for the section index. */
const INDEX_PAGES = [
  {
    slug: 'profit-and-loss', title: 'Profit & loss', metric: 'revenue',
    description: 'Sales, costs and what is left, line by line.',
    permission: 'financials.view',
  },
  {
    slug: 'cash', title: 'Cash', metric: 'closing_cash',
    description: 'Money in, money out, and what is in the bank.',
    permission: 'financials.view',
  },
  {
    slug: 'banking', title: 'Banking', metric: 'net_cash_movement',
    description: 'Your accounts and every transaction in the month.',
    permission: 'banking.view',
  },
  {
    slug: 'receivables', title: 'Owed to you', metric: 'receivables',
    description: 'Unpaid sales invoices and what is overdue.',
    permission: 'financials.view',
  },
  {
    slug: 'payables', title: 'You owe', metric: 'payables',
    description: 'Unpaid supplier invoices and what is overdue.',
    permission: 'financials.view',
  },
] as const;

export async function loadMoneyIndex(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, requestId?: string,
): Promise<MoneyIndexView> {
  const snapshots = await repo.loadPeriodSnapshots(db, orgId, scope.period.id, requestId);
  const byKey = index(snapshots);
  const options: FigureOptions = {
    orgSlug,
    comparisonLabel: scope.previous?.label ?? 'the previous month',
  };

  return {
    scope,
    links: INDEX_PAGES.map((page) => {
      const row = byKey.get(page.metric);
      return {
        href: `/app/${orgSlug}/money/${page.slug}`,
        title: page.title,
        description: page.description,
        figure: row
          ? toFigure(row, scope.period, byKey.get(varianceKey(page.metric, 'prev_period')) ?? null, options)
          : null,
        permission: page.permission,
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Profit and loss
// ---------------------------------------------------------------------------------------------

/** Above the spending breakdown: what was earned and what it cost to earn it. */
const PNL_ABOVE = ['revenue', 'cost_of_sales', 'gross_profit', 'gross_margin'] as const;
/** Below it: the running costs, and what survives interest and tax. */
const PNL_BELOW = [
  'operating_expenses', 'operating_profit', 'operating_margin',
  'interest_expense', 'tax_expense', 'net_profit', 'net_margin',
] as const;

export interface ProfitAndLossView {
  readonly scope: PeriodScope;
  readonly above: readonly MetricCardView[];
  readonly spending: readonly BreakdownRow[];
  readonly below: readonly MetricCardView[];
}

export async function loadProfitAndLoss(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, requestId?: string,
): Promise<ProfitAndLossView> {
  const [snapshots, categories] = await Promise.all([
    repo.loadPeriodSnapshots(db, orgId, scope.period.id, requestId),
    repo.loadDimensioned(db, orgId, 'expense_by_category', [scope.period.id], requestId),
  ]);
  const byKey = index(snapshots);
  const byDimension = new Map(
    snapshots
      .filter((s) => s.metricKey === varianceKey('expense_by_category', 'prev_period'))
      .map((s) => [dimensionKeyOf(s) ?? s.snapshotId, s]),
  );
  const options: FigureOptions = {
    orgSlug,
    comparisonLabel: scope.previous?.label ?? 'the previous month',
  };

  return {
    scope,
    above: figuresFor(PNL_ABOVE, byKey, scope.period, options),
    spending: [...categories]
      .sort((a, b) => {
        if (a.value === null) return b.value === null ? 0 : 1;
        if (b.value === null) return -1;
        return compare(b.value, a.value);
      })
      .map((row) => {
        const key = dimensionKeyOf(row);
        return {
          key: key ?? row.snapshotId,
          label: categoryLabel(key),
          figure: toFigure(row, scope.period, byDimension.get(key ?? row.snapshotId) ?? null, options),
        };
      }),
    below: figuresFor(PNL_BELOW, byKey, scope.period, options),
  };
}

// ---------------------------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------------------------

const CASH_KEYS = [
  'cash_inflows', 'cash_outflows', 'net_cash_movement',
  'opening_cash', 'closing_cash', 'cash_runway_months',
] as const;

export interface CashAccountView {
  readonly id: string;
  readonly name: string;
  readonly bankName: string;
  readonly reference: string;
  /** The opening balance as stored, formatted — or "—" when nobody has told us what it was. */
  readonly openingBalance: string;
  readonly openingBalanceDate: string | null;
  readonly needsOpeningBalance: boolean;
}

export interface CashView {
  readonly scope: PeriodScope;
  readonly figures: readonly MetricCardView[];
  readonly accounts: readonly CashAccountView[];
  /** True when at least one account has no opening balance, so cash cannot be stated (CD-06). */
  readonly openingBalanceMissing: boolean;
}

/** The masked reference a person recognises their account by. Never an unmasked number. */
export function accountReference(account: BankAccount): string {
  const parts = [account.sortCodeMasked, account.accountNumberMasked].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : account.bankName;
}

export function toCashAccount(account: BankAccount): CashAccountView {
  const known = account.openingBalance !== null && account.openingBalanceDate !== null;
  return {
    id: account.id,
    name: account.name,
    bankName: account.bankName,
    reference: accountReference(account),
    openingBalance: known
      ? formatMoney(account.openingBalance!, { currency: account.currency, showMinorUnits: true })
      : '—',
    openingBalanceDate: account.openingBalanceDate,
    needsOpeningBalance: !known,
  };
}

export async function loadCash(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, requestId?: string,
): Promise<CashView> {
  const [snapshots, bankAccounts] = await Promise.all([
    repo.loadPeriodSnapshots(db, orgId, scope.period.id, requestId),
    listBankAccounts(db, orgId, requestId),
  ]);
  const byKey = index(snapshots);
  const accounts = bankAccounts.filter((a) => a.isActive).map(toCashAccount);

  return {
    scope,
    figures: figuresFor(CASH_KEYS, byKey, scope.period, {
      orgSlug,
      comparisonLabel: scope.previous?.label ?? 'the previous month',
    }),
    accounts,
    openingBalanceMissing: accounts.some((a) => a.needsOpeningBalance),
  };
}

/** The bank accounts the opening-balance form offers, whether or not a period has figures yet. */
export async function loadBankAccountsForBalances(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<CashAccountView[]> {
  const accounts = await listBankAccounts(db, orgId, requestId);
  return accounts.filter((a) => a.isActive).map(toCashAccount);
}

// ---------------------------------------------------------------------------------------------
// Bank activity
// ---------------------------------------------------------------------------------------------

export type BankingFilter = 'all' | 'uncategorised';

export interface TransactionView {
  readonly id: string;
  readonly date: string;
  /** The MASKED description. `description_raw` is not selectable by anyone (ADR-044.2). */
  readonly description: string;
  readonly amount: string;
  readonly accountName: string;
  readonly categoryLabel: string;
  readonly uncategorised: boolean;
  readonly transferKind: string | null;
}

export interface BankingView {
  readonly scope: PeriodScope;
  readonly figures: readonly MetricCardView[];
  readonly accounts: readonly CashAccountView[];
  readonly transactions: readonly TransactionView[];
  readonly filter: BankingFilter;
  /** How many of the month's transactions are still uncategorised, for the filter link. */
  readonly uncategorisedCount: number;
  readonly truncated: boolean;
}

/** The page size for a month of statement lines. Bounded: an unbounded select is a DoS. */
export const TRANSACTION_PAGE_SIZE = 200;

/**
 * A transaction nobody has classified yet — either no category at all, or one pointing at the
 * organisation's `uncategorised` holding account. Both are the same thing to a reader, and both are
 * what the Data quality card counts.
 */
export function isUncategorised(
  transaction: Pick<BankTransaction, 'categoryAccountId'>,
  categoryOf: ReadonlyMap<string, StandardCategory>,
): boolean {
  if (!transaction.categoryAccountId) return true;
  return categoryOf.get(transaction.categoryAccountId) === 'uncategorised';
}

const TRANSFER_LABELS: Readonly<Record<string, string>> = {
  cash_transfer: 'Transfer between your accounts',
  card_repayment: 'Credit card repayment',
  loan_repayment: 'Loan repayment',
  loan_drawdown: 'Loan drawn down',
  other_transfer: 'Transfer',
};

export function toTransactionView(
  transaction: BankTransaction,
  accountNames: ReadonlyMap<string, string>,
  categoryOf: ReadonlyMap<string, StandardCategory>,
): TransactionView {
  const uncategorised = isUncategorised(transaction, categoryOf);
  const category = transaction.categoryAccountId
    ? categoryOf.get(transaction.categoryAccountId) ?? null
    : null;
  return {
    id: transaction.id,
    date: transaction.transactionDate,
    description: transaction.descriptionNormalized ?? '—',
    amount: formatMoney(transaction.amount, {
      currency: transaction.currency, showMinorUnits: true,
    }),
    accountName: accountNames.get(transaction.bankAccountId) ?? 'Unknown account',
    categoryLabel: uncategorised ? 'Not yet categorised' : categoryLabel(category),
    uncategorised,
    transferKind: transaction.isTransfer
      ? TRANSFER_LABELS[transaction.transferKind] ?? 'Transfer'
      : null,
  };
}

export async function loadBanking(
  db: SupabaseClient,
  orgId: string,
  orgSlug: string,
  scope: PeriodScope,
  filter: BankingFilter,
  requestId?: string,
): Promise<BankingView> {
  const [snapshots, bankAccounts, accounts, transactions] = await Promise.all([
    repo.loadPeriodSnapshots(db, orgId, scope.period.id, requestId),
    listBankAccounts(db, orgId, requestId),
    listAccounts(db, orgId, requestId),
    listBankTransactions(
      db, orgId, { periodId: scope.period.id },
      { limit: TRANSACTION_PAGE_SIZE, offset: 0 }, requestId,
    ),
  ]);

  const accountNames = new Map(bankAccounts.map((a) => [a.id, a.name]));
  const categoryOf = new Map<string, StandardCategory>(
    accounts.map((a) => [a.id, a.standardCategory]),
  );
  const views = transactions.map((t) => toTransactionView(t, accountNames, categoryOf));

  return {
    scope,
    figures: figuresFor(
      ['cash_inflows', 'cash_outflows', 'net_cash_movement'], index(snapshots), scope.period,
      { orgSlug, comparisonLabel: scope.previous?.label ?? 'the previous month' },
    ),
    accounts: bankAccounts.filter((a) => a.isActive).map(toCashAccount),
    transactions: filter === 'uncategorised' ? views.filter((v) => v.uncategorised) : views,
    filter,
    uncategorisedCount: views.filter((v) => v.uncategorised).length,
    truncated: transactions.length === TRANSACTION_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------------------------
// Owed to you / You owe
// ---------------------------------------------------------------------------------------------

export const AGING_BUCKETS = ['not_due', 'days_1_30', 'days_31_60', 'days_61_90', 'days_90_plus', 'unknown'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_LABELS: Readonly<Record<AgingBucket, string>> = {
  not_due: 'Not due yet',
  days_1_30: '1–30 days late',
  days_31_60: '31–60 days late',
  days_61_90: '61–90 days late',
  days_90_plus: 'Over 90 days late',
  unknown: 'No due date',
};

const MS_PER_DAY = 86_400_000;

/**
 * How late an invoice is, as a bucket.
 *
 * Dates, not money: this decides which row an invoice is listed under, and the aging TOTALS still
 * come from `receivables_overdue` and its siblings. An invoice with no due date is `unknown` rather
 * than "not due" — the engine reports `no_due_dates` for exactly this reason, and guessing here
 * would contradict it.
 */
export function agingBucket(dueDate: string | null, asOf: string): AgingBucket {
  if (!dueDate) return 'unknown';
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const today = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(today)) return 'unknown';
  const daysLate = Math.floor((today - due) / MS_PER_DAY);
  if (daysLate <= 0) return 'not_due';
  if (daysLate <= 30) return 'days_1_30';
  if (daysLate <= 60) return 'days_31_60';
  if (daysLate <= 90) return 'days_61_90';
  return 'days_90_plus';
}

export interface InvoiceView {
  readonly id: string;
  readonly number: string;
  readonly counterpartyName: string;
  readonly counterpartyId: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly balanceDue: string;
  readonly bucket: AgingBucket;
  readonly bucketLabel: string;
}

export interface LedgerBookView {
  readonly scope: PeriodScope;
  readonly figures: readonly MetricCardView[];
  readonly invoices: readonly InvoiceView[];
  readonly truncated: boolean;
}

export const INVOICE_PAGE_SIZE = 200;

export function toInvoiceView(
  invoice: Invoice, names: ReadonlyMap<string, string>, asOf: string,
): InvoiceView {
  const bucket = agingBucket(invoice.dueDate, asOf);
  return {
    id: invoice.id,
    number: invoice.invoiceNumber,
    counterpartyId: invoice.counterpartyId,
    counterpartyName: names.get(invoice.counterpartyId) ?? 'Unknown',
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    balanceDue: formatMoney(invoice.balanceDue, {
      currency: invoice.currency, showMinorUnits: true,
    }),
    bucket,
    bucketLabel: AGING_LABELS[bucket],
  };
}

const BOOKS = {
  receivables: {
    keys: ['receivables', 'receivables_overdue', 'receivables_days'],
    invoiceType: 'sales',
  },
  payables: {
    keys: ['payables', 'payables_overdue', 'payables_days'],
    invoiceType: 'purchase',
  },
} as const;

export async function loadLedgerBook(
  db: SupabaseClient,
  orgId: string,
  orgSlug: string,
  scope: PeriodScope,
  book: 'receivables' | 'payables',
  asOf: string,
  requestId?: string,
): Promise<LedgerBookView> {
  const spec = BOOKS[book];
  const [snapshots, invoices, counterparties] = await Promise.all([
    repo.loadPeriodSnapshots(db, orgId, scope.period.id, requestId),
    listInvoices(
      db, orgId, { invoiceType: spec.invoiceType, openOnly: true },
      { limit: INVOICE_PAGE_SIZE, offset: 0 }, requestId,
    ),
    listCounterparties(db, orgId, { limit: 200, offset: 0 }, requestId),
  ]);

  const names = new Map(counterparties.map((c) => [c.id, c.name]));
  return {
    scope,
    figures: figuresFor(spec.keys, index(snapshots), scope.period, {
      orgSlug, comparisonLabel: scope.previous?.label ?? 'the previous month',
    }),
    invoices: invoices.map((i) => toInvoiceView(i, names, asOf)),
    truncated: invoices.length === INVOICE_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

export interface CustomerRow {
  /** Null for the engine's "Unattributed" row: revenue we cannot tie to a named customer. */
  readonly counterpartyId: string | null;
  readonly name: string;
  readonly href: string | null;
  readonly revenue: MetricCardView;
  /** That customer's share of the month's revenue, or "—" when it is not computable. */
  readonly share: string;
}

export interface CustomersView {
  readonly scope: PeriodScope;
  readonly concentration: readonly MetricCardView[];
  readonly customers: readonly CustomerRow[];
}

const CONCENTRATION_KEYS = [
  'customer_concentration_top1', 'customer_concentration_top5', 'revenue_concentration_hhi',
] as const;

export async function loadCustomers(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, requestId?: string,
): Promise<CustomersView> {
  const [snapshots, revenue, shares, counterparties] = await Promise.all([
    repo.loadPeriodSnapshots(db, orgId, scope.period.id, requestId),
    repo.loadDimensioned(db, orgId, 'customer_revenue', [scope.period.id], requestId),
    repo.loadDimensioned(db, orgId, 'customer_revenue_share', [scope.period.id], requestId),
    listCounterparties(db, orgId, { limit: 200, offset: 0 }, requestId),
  ]);

  const byKey = index(snapshots);
  const options: FigureOptions = {
    orgSlug, comparisonLabel: scope.previous?.label ?? 'the previous month',
  };
  const names = new Map(counterparties.map((c) => [c.id, c.name]));
  const shareOf = new Map(shares.map((s) => [dimensionKeyOf(s) ?? '', s]));

  /*
   * Sorting compares two stored values; it never adds them. A NULL sorts last, because "we could
   * not work this out" is not a small number (§4). The synthetic unattributed row sorts last of all
   * whatever its size: it is the revenue nobody could attribute, and ranking it among the customers
   * would present a gap in the data as the business's biggest client (ADR-103).
   */
  const ranked = [...revenue].sort((a, b) => {
    const aUnattributed = dimensionKeyOf(a) === null;
    const bUnattributed = dimensionKeyOf(b) === null;
    if (aUnattributed !== bUnattributed) return aUnattributed ? 1 : -1;
    if (a.value === null) return b.value === null ? 0 : 1;
    if (b.value === null) return -1;
    return compare(b.value, a.value);
  });

  return {
    scope,
    concentration: figuresFor(CONCENTRATION_KEYS, byKey, scope.period, options),
    customers: ranked.map((row) => {
      const id = dimensionKeyOf(row);
      const share = id ? shareOf.get(id) ?? null : null;
      return {
        counterpartyId: id,
        name: id ? names.get(id) ?? 'Unknown customer' : 'Not attributed to a customer',
        href: id ? `/app/${orgSlug}/customers/${id}` : null,
        revenue: toFigure(row, scope.period, null, options),
        share: share ? formatFigure(share) : '—',
      };
    }),
  };
}

export interface CustomerTrendPoint {
  readonly periodId: string;
  readonly label: string;
  readonly value: string;
  readonly rawValue: string | null;
}

export interface CustomerDetailView {
  readonly scope: PeriodScope;
  readonly counterparty: Counterparty;
  readonly revenue: MetricCardView | null;
  readonly share: MetricCardView | null;
  readonly trend: readonly CustomerTrendPoint[];
  readonly invoices: readonly InvoiceView[];
}

/** How many months of a customer's revenue the detail page shows. */
export const CUSTOMER_TREND_MONTHS = 12;

export async function loadCustomerDetail(
  db: SupabaseClient,
  orgId: string,
  orgSlug: string,
  scope: PeriodScope,
  counterpartyId: string,
  asOf: string,
  requestId?: string,
): Promise<CustomerDetailView | null> {
  const counterparties = await listCounterparties(db, orgId, { limit: 200, offset: 0 }, requestId);
  const counterparty = counterparties.find((c) => c.id === counterpartyId) ?? null;
  // A counterparty id from another organisation resolves to nothing here because RLS never returned
  // it; the page turns that into the uniform 404 (ROUTE_ARCHITECTURE.md §10).
  if (!counterparty) return null;

  const window = scope.periods.slice(0, CUSTOMER_TREND_MONTHS);
  const [revenueRows, shareRows, invoices] = await Promise.all([
    repo.loadDimensioned(db, orgId, 'customer_revenue', window.map((p) => p.id), requestId),
    repo.loadDimensioned(db, orgId, 'customer_revenue_share', [scope.period.id], requestId),
    listInvoices(
      db, orgId, { invoiceType: 'sales' },
      { limit: INVOICE_PAGE_SIZE, offset: 0 }, requestId,
    ),
  ]);

  const mine = revenueRows.filter((r) => dimensionKeyOf(r) === counterpartyId);
  const byPeriod = new Map(mine.map((r) => [r.periodId, r]));
  const current = byPeriod.get(scope.period.id) ?? null;
  const share = shareRows.find((r) => dimensionKeyOf(r) === counterpartyId) ?? null;
  const options: FigureOptions = {
    orgSlug, comparisonLabel: scope.previous?.label ?? 'the previous month',
  };
  const names = new Map([[counterparty.id, counterparty.name]]);

  return {
    scope,
    counterparty,
    revenue: current ? toFigure(current, scope.period, null, options) : null,
    share: share ? toFigure(share, scope.period, null, options) : null,
    trend: [...window].reverse().map((period) => {
      const row = byPeriod.get(period.id) ?? null;
      return {
        periodId: period.id,
        label: period.label,
        // A month with no figure is a gap, not a zero (§4).
        value: row ? formatFigure(row) : '—',
        rawValue: row?.value ?? null,
      };
    }),
    invoices: invoices
      .filter((i) => i.counterpartyId === counterpartyId)
      .map((i) => toInvoiceView(i, names, asOf)),
  };
}

// ---------------------------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------------------------

export interface AccountRow {
  readonly account: Account;
  readonly categoryLabel: string;
  readonly confidenceLabel: string;
  readonly needsAttention: boolean;
  /** A seeded account IS its category (ADR-004); re-mapping one is refused in SQL, so we never offer it. */
  readonly remappable: boolean;
}

export interface AccountsView {
  readonly rows: readonly AccountRow[];
  readonly unmappedCount: number;
  readonly categories: readonly StandardCategory[];
}

export const CONFIDENCE_LABELS: Readonly<Record<string, string>> = {
  unmapped: 'Not mapped',
  suggested: 'Suggested — please check',
  confirmed: 'Confirmed',
};

const CONFIDENCE_ORDER: Readonly<Record<string, number>> = {
  unmapped: 0,
  suggested: 1,
  confirmed: 2,
};

/**
 * Unmapped accounts first, then merely suggested ones, then the settled rest.
 *
 * This page exists to fix unmapped accounts: every one of them is money the engine has had to park
 * in a holding category, so leaving them to alphabetical order would bury the only rows that need a
 * decision. Within a band the order is by name, so the list is stable between visits.
 */
export function sortAccountsForMapping(accounts: readonly Account[]): Account[] {
  return [...accounts].sort((a, b) => {
    const rank = (CONFIDENCE_ORDER[a.mappingConfidence] ?? 3) - (CONFIDENCE_ORDER[b.mappingConfidence] ?? 3);
    if (rank !== 0) return rank;
    if (a.standardCategory !== b.standardCategory) {
      return a.standardCategory.localeCompare(b.standardCategory);
    }
    return a.name.localeCompare(b.name);
  });
}

export function toAccountRow(account: Account): AccountRow {
  return {
    account,
    categoryLabel: categoryLabel(account.standardCategory),
    confidenceLabel: CONFIDENCE_LABELS[account.mappingConfidence] ?? account.mappingConfidence,
    needsAttention: account.mappingConfidence !== 'confirmed'
      || account.standardCategory === 'uncategorised',
    remappable: !account.isSystem,
  };
}

export async function loadAccountsPage(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<AccountsView> {
  const accounts = await listAccounts(db, orgId, requestId);
  const rows = sortAccountsForMapping(accounts.filter((a) => a.isActive)).map(toAccountRow);
  return {
    rows,
    unmappedCount: rows.filter((r) => r.account.mappingConfidence === 'unmapped').length,
    categories: STANDARD_CATEGORIES,
  };
}

