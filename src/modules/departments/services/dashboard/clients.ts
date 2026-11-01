import 'server-only';
import { NotFound } from '@/core/errors';
import { Decimal } from '@/core/money';
import { can } from '@/core/permissions';
import { fixedClock, todayInTimeZone } from '@/core/periods';
import { dimensionKeyOf, loadDimensioned } from '@/modules/dashboard';
import type { EngagementItemView } from '@/modules/engagement';
import { listCounterparties, listInvoices, type Invoice } from '@/modules/financials';
import type { AccessContext } from '@/modules/tenancy';
import * as repo from '../../data/repository';
import {
  compactMoney, countBaseline, countByMonth, countChart, countSpark, dayLabel, departmentHeading, formatCount,
  isOverdueInvoice, monthEndOf, monthKey, overdueCustomersAt, plural, rate, rateLabel, shareSlices,
} from '../../domain/dashboard-ops';
import {
  DEPARTMENT_META, type ClientRow, type DepartmentView, type MonthWindow, type PriorityItem,
} from '../../domain/dashboard';
import { clientReviewTitle, engagementItemsFor, reviewRequestTitle, titleSet } from './review-requests';

/**
 * Client Management (the prototype's `clients` department). For a company, its clients are its
 * CUSTOMERS: counterparties of kind customer (or both), with the engine's `customer_revenue` per
 * month (dimensioned by counterparty) and their sales invoices. Attention = an invoice past its due
 * date with a balance still owed. Requests and reviews are the engagement items (ADR-144).
 *
 * Reads: the counterparties, the sales invoices and the engagement items (one query each), and the
 * `customer_revenue` snapshots for the window and the same months a year earlier (one `in` query).
 */

const CLIENTS_SHOWN = 50;
const FOOTNOTE = 'Select an item to see the context and request a review from your analyst.';
const QUEUE = { kicker: 'YOUR NEXT MOVES', title: 'Priorities & observations', footnote: FOOTNOTE, reviewedWord: 'Reviewed' } as const;
const COMPLETED: ReadonlySet<string> = new Set(['delivered', 'closed']);

interface CustomerFacts {
  readonly id: string;
  readonly name: string;
  readonly revenue: Decimal;
  readonly revenueBefore: Decimal | null;
  readonly invoices: number;
  readonly overdue: readonly Invoice[];
  readonly overdueAmount: Decimal;
  readonly nextDue: string | null;
}

export async function loadClientsView(ctx: AccessContext, window: MonthWindow): Promise<DepartmentView> {
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const heading = departmentHeading('clients', window);
  const currency = window.currency;

  // Customers and their invoices are read under `customers.view` or `financials.view` (src/db/rls.ts).
  if (!can(ctx, 'customers.view') && !can(ctx, 'financials.view')) {
    return emptyClients(heading, window, 'Client management is shown to the people who can see your customers.');
  }

  const base = `/app/${ctx.orgSlug ?? ''}`;
  const windowIds = window.months.map((m) => m.periodId);
  const earlierIds = window.months.map((m) => m.yearEarlierPeriodId).filter((id): id is string => id !== null);
  const [counterparties, invoices, revenueRows, engagement, basics] = await Promise.all([
    listCounterparties(ctx.db, orgId, { limit: 10_000, offset: 0 }, ctx.requestId),
    listInvoices(ctx.db, orgId, { invoiceType: 'sales' }, { limit: 20_000, offset: 0 }, ctx.requestId),
    loadDimensioned(ctx.db, orgId, 'customer_revenue', [...windowIds, ...earlierIds], ctx.requestId),
    engagementItemsFor(ctx),
    repo.organisationBasics(ctx.db, orgId),
  ]);
  const today = todayInTimeZone(fixedClock(ctx.now()), basics.timezone);
  const titles = titleSet(engagement);

  // ---- Revenue per customer: the window, and the same months a year earlier ----
  const windowSet = new Set(windowIds), earlierSet = new Set(earlierIds);
  const revenue = new Map<string, Decimal>(), before = new Map<string, Decimal>();
  const activeByPeriod = new Map<string, Set<string>>();
  for (const row of revenueRows) {
    const id = dimensionKeyOf(row);
    // The engine's synthetic NULL-dimension row is unattributed revenue, not a customer (ADR-103).
    if (id === null || row.value === null) continue;
    const value = new Decimal(row.value);
    if (windowSet.has(row.periodId)) {
      revenue.set(id, (revenue.get(id) ?? new Decimal(0)).plus(value));
      if (value.greaterThan(0)) {
        if (!activeByPeriod.has(row.periodId)) activeByPeriod.set(row.periodId, new Set());
        activeByPeriod.get(row.periodId)!.add(id);
      }
    } else if (earlierSet.has(row.periodId)) {
      before.set(id, (before.get(id) ?? new Decimal(0)).plus(value));
    }
  }

  // ---- Invoices per customer ----
  const firstStart = window.months[0]?.periodStart ?? '';
  const lastEnd = window.months.length === 0 ? '' : monthEndOf(window.months.at(-1)!.periodStart);
  const invoicesBy = new Map<string, Invoice[]>();
  for (const inv of invoices) {
    if (!invoicesBy.has(inv.counterpartyId)) invoicesBy.set(inv.counterpartyId, []);
    invoicesBy.get(inv.counterpartyId)!.push(inv);
  }

  const names = new Map(counterparties.map((c) => [c.id, c.name]));
  const customerIds = new Set<string>([
    ...counterparties.filter((c) => c.kind === 'customer' || c.kind === 'both').map((c) => c.id),
    ...revenue.keys(),
  ]);
  const customers: CustomerFacts[] = [...customerIds].map((id) => {
    const own = invoicesBy.get(id) ?? [];
    const overdue = own.filter((inv) => isOverdueInvoice(inv, today));
    const open = own.filter((inv) => (inv.status === 'open' || inv.status === 'partially_paid') && inv.dueDate !== null)
      .map((inv) => inv.dueDate!).sort();
    return {
      id, name: names.get(id) ?? 'Unknown customer',
      revenue: revenue.get(id) ?? new Decimal(0),
      revenueBefore: before.get(id) ?? null,
      invoices: own.filter((inv) => inv.issueDate >= firstStart && inv.issueDate <= lastEnd).length,
      overdue,
      overdueAmount: overdue.reduce((sum, inv) => sum.plus(inv.balanceDue), new Decimal(0)),
      nextDue: open[0] ?? null,
    };
  });
  const byRevenue = [...customers].sort((a, b) => b.revenue.comparedTo(a.revenue) || a.name.localeCompare(b.name));
  const active = byRevenue.filter((c) => c.revenue.greaterThan(0));
  const attention = byRevenue.filter((c) => c.overdue.length > 0);
  const overdueInvoices = attention.flatMap((c) => c.overdue);
  const overdueTotal = attention.reduce((sum, c) => sum.plus(c.overdueAmount), new Decimal(0));

  // ---- Requests and reviews (engagement items) ----
  // Requests and reviews are activity: counted up to today (owner, 2026-11-02), not in the figures' months.
  const activityWindow = window.activity ?? window;
  const keys = activityWindow.months.map((m) => m.periodStart.slice(0, 7));
  const items: readonly EngagementItemView[] = engagement ?? [];
  const inWindow = (date: string) => { const key = monthKey(date); return key !== null && keys.includes(key); };
  const completedDates = items.filter((i) => COMPLETED.has(i.status)).map((i) => i.updatedAt);
  const requestsByMonth = countByMonth(items.map((i) => i.createdAt), keys);
  const completedByMonth = countByMonth(completedDates, keys);
  const requestsInWindow = items.filter((i) => inWindow(i.createdAt));
  const requests = requestsInWindow.length;
  // Of the requests made in the window, how many are delivered or closed.
  const completed = requestsInWindow.filter((i) => COMPLETED.has(i.status)).length;
  const reviewRate = rate(completed, requests);

  // ---- Priorities ----
  const queue: PriorityItem[] = [];
  const push = (recordId: string, href: string, fields: Pick<PriorityItem, 'title' | 'subtitle' | 'tag' | 'icon' | 'context' | 'nextStep'>) => {
    queue.push({ id: `customer:${recordId}`, kind: 'customer', recordId, href, reviewed: false,
      requested: titles.has(reviewRequestTitle(fields.title)), ...fields });
  };
  if (attention.length > 0) {
    const named = attention.slice(0, 3).map((c) => c.name);
    const more = attention.length - named.length;
    push('review-agenda', `${base}/customers`, {
      title: 'Prepare the client review agenda',
      subtitle: `Client success · ${plural(attention.length, 'customer')} need${attention.length === 1 ? 's' : ''} attention`,
      tag: 'Prepare', icon: 'client',
      context: `${listOf(named)}${more > 0 ? ` and ${plural(more, 'other')}` : ''} ${attention.length === 1 ? 'has' : 'have'} invoices past their due date.`,
      nextStep: 'Open the client portfolio, review each account and agree the next step before the review.',
    });
    push('overdue-invoices', `${base}/customers`, {
      title: 'Chase overdue invoices',
      subtitle: `Working capital · ${plural(overdueInvoices.length, 'invoice')} · ${compactMoney(overdueTotal, currency)}`,
      tag: 'Action', icon: 'bank',
      context: `${plural(overdueInvoices.length, 'sales invoice')} ${overdueInvoices.length === 1 ? 'is' : 'are'} past the due date, ${compactMoney(overdueTotal, currency)} still owed in total.`,
      nextStep: 'Agree who chases each invoice, confirm payment dates and update the cash outlook.',
    });
  }
  const growth = active
    .filter((c) => c.revenueBefore !== null && c.revenue.greaterThan(c.revenueBefore))
    .sort((a, b) => b.revenue.minus(b.revenueBefore!).comparedTo(a.revenue.minus(a.revenueBefore!)))[0];
  const leader = growth ?? active[0];
  if (leader !== undefined) {
    push(leader.id, `${base}/customers/${leader.id}`, {
      title: 'Identify a client growth conversation',
      subtitle: `Business development · ${leader.name}`,
      tag: 'Explore', icon: 'chart',
      context: growth !== undefined
        ? `${leader.name}’s sales rose from ${compactMoney(leader.revenueBefore, currency)} to ${compactMoney(leader.revenue, currency)} against the same months last year — the largest increase of any customer.`
        : `${leader.name} is your largest customer this period, with ${compactMoney(leader.revenue, currency)} of sales.`,
      nextStep: 'Use the How can I Grow panel to prepare a discussion with clear assumptions.',
    });
  }

  // ---- The client portfolio ----
  const portfolio = byRevenue.filter((c) => c.revenue.greaterThan(0) || c.overdue.length > 0).slice(0, CLIENTS_SHOWN);
  const clients: ClientRow[] = portfolio.map((c) => {
    const late = c.overdue.length > 0;
    const firstOverdue = c.overdue.map((inv) => inv.dueDate!).sort()[0] ?? null;
    return {
      id: c.id, name: c.name,
      sector: `Customer · ${plural(c.invoices, 'invoice')}`,
      owner: `${compactMoney(c.revenue, currency)} sales`,
      nextReview: dayLabel(late ? firstOverdue : c.nextDue),
      status: late ? 'attention' : 'on-track',
      service: `Sales ${compactMoney(c.revenue, currency)} · ${compactMoney(c.overdueAmount, currency)} overdue`,
      nextStep: late ? 'Confirm the overdue invoices and agree payment dates.' : 'Review the account at the next scheduled meeting.',
      href: `${base}/customers/${c.id}`,
      reviewRecorded: titles.has(clientReviewTitle(c.name)),
    };
  });

  // ---- Mix: the two largest customers and the rest ----
  const windowRevenue = active.reduce((sum, c) => sum.plus(c.revenue), new Decimal(0));
  const top = active.slice(0, 2);
  const rest = windowRevenue.minus(top.reduce((sum, c) => sum.plus(c.revenue), new Decimal(0)));
  const customerInvoices = invoices.filter((inv) => customerIds.has(inv.counterpartyId));

  const figure = rateLabel(reviewRate);
  return {
    ...heading,
    metrics: [
      {
        label: 'Active clients', value: formatCount(active.length), change: `${formatCount(attention.length)} overdue`, note: 'customers this period',
        spark: countSpark(window, window.months.map((m) => activeByPeriod.get(m.periodId)?.size ?? 0)),
      },
      { label: 'Reviews completed', value: formatCount(completed), change: figure, note: 'of requests', spark: countSpark(activityWindow, completedByMonth) },
      {
        label: 'Needs attention', value: formatCount(attention.length), change: 'Review due', note: 'overdue invoices',
        spark: countSpark(window, window.months.map((m) => overdueCustomersAt(customerInvoices, monthEndOf(m.periodStart)))),
      },
    ],
    chart: countChart({
      dept: 'clients', window: activityWindow, first: requestsByMonth, second: completedByMonth,
      baseline: countBaseline(items.map((i) => i.createdAt), activityWindow),
      insight: `${formatCount(completed)} ${completed === 1 ? 'review' : 'reviews'} completed across ${plural(requests, 'request')}.`,
      figure,
    }),
    mix: {
      title: DEPARTMENT_META.clients.mix,
      total: formatCount(active.length),
      caption: 'active clients',
      slices: shareSlices([...top.map((c) => ({ label: c.name, value: c.revenue })), { label: 'Other customers', value: rest }]),
    },
    queue: { ...QUEUE, items: queue },
    clients,
    empty: customers.length === 0 ? 'No customers yet. Import sales invoices or a ledger with customer names to see your clients here.' : null,
  };
}

/** "A, B and C". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function emptyClients(heading: ReturnType<typeof departmentHeading>, window: MonthWindow, empty: string): DepartmentView {
  const zeros = window.months.map(() => 0);
  return {
    ...heading,
    metrics: [
      { label: 'Active clients', value: '0', change: '0 overdue', note: 'customers this period', spark: countSpark(window, zeros) },
      { label: 'Reviews completed', value: '0', change: '—', note: 'of requests', spark: countSpark(window, zeros) },
      { label: 'Needs attention', value: '0', change: 'Review due', note: 'overdue invoices', spark: countSpark(window, zeros) },
    ],
    chart: countChart({ dept: 'clients', window, first: zeros, second: zeros, baseline: null, insight: '0 reviews completed across 0 requests.', figure: '—' }),
    mix: { title: DEPARTMENT_META.clients.mix, total: '0', caption: 'active clients', slices: [] },
    queue: { ...QUEUE, items: [] },
    clients: [],
    empty,
  };
}
