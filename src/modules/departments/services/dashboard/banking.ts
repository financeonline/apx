import 'server-only';
import { reviewsAsAnalyst } from './reviewer';
import { NotFound } from '@/core/errors';
import { Decimal } from '@/core/money';
import { can } from '@/core/permissions';
import { fixedClock, todayInTimeZone } from '@/core/periods';
import { categoryLabel, dimensionKeyOf, loadDimensioned, loadMetricSeries } from '@/modules/dashboard';
import { listInvoices } from '@/modules/financials';
import type { AccessContext } from '@/modules/tenancy';
import * as basicsRepo from '../../data/repository';
import * as repo from '../../data/dashboard-repository';
import { compactMoney, departmentHeading, isOverdueInvoice, plural } from '../../domain/dashboard-ops';
import {
  alertQueue, alertQueueItems, isBankingAlert, minusEach, moneyChart, moneySpark, spendingMix, sumKnown, valuesFor,
} from '../../domain/dashboard-money';
import type { DepartmentView, Metric, MonthWindow } from '../../domain/dashboard';
import { queueAlerts, seriesMap, seriesPeriodIds } from './analysis';
import { engagementItemsFor, reviewRequestTitle, titleSet } from './review-requests';

/**
 * Banking (the prototype's `banking` department) with the company's own figures: the engine's cash
 * figures (`closing_cash`, `net_cash_movement`, `cash_inflows`, `cash_outflows`) and
 * `receivables_overdue`, spending by category (`expense_by_category`), the active bank accounts, the
 * open sales invoices past their due date, and the cash, collection and payment alerts.
 */

const SERIES_KEYS = ['closing_cash', 'net_cash_movement', 'cash_inflows', 'cash_outflows', 'receivables_overdue'] as const;
/** Income and the tax charge are not spending (Section 03's NOT_A_COST_LINE). */
const NOT_SPENDING: ReadonlySet<string> = new Set(['other_income', 'revenue', 'tax_expense']);

export async function loadBankingView(ctx: AccessContext, window: MonthWindow): Promise<DepartmentView> {
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const currency = window.currency;
  const months = window.months;
  const ids = months.map((m) => m.periodId);
  const money = (v: Decimal | null) => compactMoney(v, currency);
  const readsInvoices = can(ctx, 'financials.view') || can(ctx, 'customers.view');

  const [series, categoryRows, accounts, invoices, basics, alerts, engagement] = await Promise.all([
    loadMetricSeries(ctx.db, orgId, SERIES_KEYS, seriesPeriodIds(window), ctx.requestId),
    loadDimensioned(ctx.db, orgId, 'expense_by_category', ids, ctx.requestId),
    repo.activeBankAccounts(ctx.db, orgId),
    readsInvoices
      ? listInvoices(ctx.db, orgId, { invoiceType: 'sales', openOnly: true }, { limit: 5000, offset: 0 }, ctx.requestId)
      : Promise.resolve(null),
    basicsRepo.organisationBasics(ctx.db, orgId),
    queueAlerts(ctx, orgId),
    engagementItemsFor(ctx),
  ]);
  const today = todayInTimeZone(fixedClock(ctx.now()), basics.timezone);

  const byKey = seriesMap(series);
  const of = (key: string, periodIds: readonly (string | null)[]) => valuesFor(byKey.get(key) ?? new Map(), periodIds);
  const closing = of('closing_cash', ids);
  const net = of('net_cash_movement', ids);
  const inflows = of('cash_inflows', ids);
  const outflows = of('cash_outflows', ids);
  const overdue = of('receivables_overdue', ids);
  // The balance at the end of the window: the last month that states it (the current month may not
  // have its statement yet, and a gap is never read as a zero balance).
  const latest = (values: readonly (Decimal | null)[]) => [...values].reverse().find((v) => v !== null) ?? null;
  const lastClosing = latest(closing);
  const totalNet = sumKnown(net);
  const overdueInvoices = invoices === null ? null : invoices.filter((inv) => isOverdueInvoice({
    counterpartyId: inv.counterpartyId ?? '', issueDate: inv.issueDate, dueDate: inv.dueDate,
    status: inv.status, balanceDue: String(inv.balanceDue), paidDate: inv.paidDate ?? null,
  }, today)).length;

  const metrics: Metric[] = [
    {
      label: 'Closing cash balance', value: money(lastClosing),
      change: plural(accounts, 'account'), note: 'combined balance',
      spark: moneySpark(months, closing, currency, false),
    },
    {
      label: 'Net cash movement', value: money(totalNet),
      change: totalNet === null ? '—' : totalNet.isNegative() ? 'Negative' : 'Positive', note: 'selected period',
      spark: moneySpark(months, net, currency, false),
    },
    {
      label: 'Overdue receivables', value: money(latest(overdue)),
      change: overdueInvoices === null ? '—' : plural(overdueInvoices, 'invoice'), note: 'from your invoices',
      spark: moneySpark(months, overdue, currency, false),
    },
  ];

  const netForInsight = totalNet ?? sumKnown(minusEach(inflows, outflows));
  const chart = moneyChart({
    dept: 'banking', window, first: inflows, second: outflows,
    baseline: of('cash_inflows', months.map((m) => m.yearEarlierPeriodId)), baselineWhat: 'cash received',
    insight: netForInsight === null ? 'No bank movements for these months yet.'
      : netForInsight.isNegative() ? 'Payments exceed receipts over this period.' : 'Receipts exceed payments over this period.',
    figure: money(netForInsight),
  });

  const byCategory = new Map<string, Decimal>();
  for (const row of categoryRows) {
    const key = dimensionKeyOf(row);
    if (key === null || row.value === null || NOT_SPENDING.has(key)) continue;
    byCategory.set(key, (byCategory.get(key) ?? new Decimal(0)).plus(new Decimal(row.value)));
  }
  const mix = spendingMix([...byCategory.entries()].map(([key, value]) => ({ label: categoryLabel(key), value })), currency);

  const banking = alerts.filter(isBankingAlert);
  const items = alertQueueItems(banking.length > 0 ? banking : alerts, titleSet(engagement), reviewRequestTitle);
  const nothing = [closing, net, inflows, outflows].every((s) => s.every((v) => v === null));
  return {
    ...departmentHeading('banking', window),
    metrics,
    chart,
    mix,
    queue: alertQueue(items, reviewsAsAnalyst(ctx)),
    clients: null,
    empty: nothing ? 'No cash figures for these months yet. Import a bank statement to see them.' : null,
  };
}
