import { describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
/*
 * Relative imports: `motion/no-deep-module-import` refuses `@/modules/<m>/domain/...`, and the
 * barrels import `server-only` services.
 */
import {
  alertQueue, alertQueueItems, buildMonthWindow, moneyChart, percentOf, revenueMix, spendingMix, windowCaption, yearOnYear,
  type AlertLike, type PeriodLike,
} from '../../src/modules/departments/domain/dashboard-money';
import {
  complianceChecks, financeLine, firstName, greeting, lastLoginLabel, workflowPanel,
} from '../../src/modules/departments/domain/dashboard-extras';
import { annualComparison, compactMoney, marketingWindow, type AnnualFacts } from '../../src/modules/marketing/domain/annual';
import type { FigureFact, MonthFacts } from '../../src/modules/marketing/domain/financials';

/** The department dashboard's money departments and shared panels (ADR-180). */

function periods(from: string, to: string, incomplete: readonly string[] = []): PeriodLike[] {
  const out: PeriodLike[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    out.push({ id: `p-${ym}`, periodStart: `${ym}-01`, isComplete: !incomplete.includes(ym) });
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}
const ids = (ps: readonly PeriodLike[]) => new Set(ps.map((p) => p.id));

describe('the month window', () => {
  const all = periods('2025-04', '2026-09', ['2026-09']);
  const withData = ids(all.filter((p) => p.periodStart >= '2025-09'));

  it('ends at the latest month with figures and reads like the prototype', () => {
    const w = buildMonthWindow(all, withData, 6, 'current', 'GBP')!;
    expect(w.months.map((m) => m.label)).toEqual(['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
    expect(w.periodCaption).toBe('Apr – Sep 2026');
    expect(w.snapshotLabel).toBe('Current · Sep 2026');
    expect(w.reportingCutoff).toBe('Reporting cutoff · September 2026');
    expect(w.months[0]!.yearEarlierPeriodId).toBe('p-2025-04');
    expect(w.months[0]!.longLabel).toBe('Apr 2026');
    expect(w.currency).toBe('GBP');
  });

  it('Last Completed ends at the latest complete month with figures', () => {
    const w = buildMonthWindow(all, withData, 3, 'last', 'GBP')!;
    expect(w.months.map((m) => m.periodId)).toEqual(['p-2026-06', 'p-2026-07', 'p-2026-08']);
    expect(w.snapshotLabel).toBe('Last Completed · Aug 2026');
    expect(w.recent!.map((m) => m.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']);
  });

  it('one month, and a window across two years', () => {
    expect(buildMonthWindow(all, withData, 1, 'current', 'GBP')!.periodCaption).toBe('Sep 2026');
    const toFeb = periods('2025-01', '2026-02');
    expect(buildMonthWindow(toFeb, ids(toFeb), 6, 'current', 'GBP')!.periodCaption).toBe('Sep 2025 – Feb 2026');
  });

  it('never opens on months before the first one with figures, and is null without figures', () => {
    const w = buildMonthWindow(all, new Set(['p-2026-08', 'p-2026-09']), 6, 'current', 'GBP')!;
    expect(w.months.map((m) => m.label)).toEqual(['Aug', 'Sep']);
    expect(w.periodCaption).toBe('Aug – Sep 2026');
    expect(buildMonthWindow(all, new Set(), 6, 'current', 'GBP')).toBeNull();
    expect(windowCaption([])).toBe('');
  });
});

describe('figures', () => {
  const d = (v: string) => new Decimal(v);
  it('states a like-for-like change only when every month has its year-earlier figure', () => {
    expect(yearOnYear([d('100'), d('110')], [d('80'), d('90')])).toBe('+23.5%');
    expect(yearOnYear([d('90')], [d('100')])).toBe('−10.0%');
    expect(yearOnYear([d('90'), d('10')], [d('100'), null])).toBeNull();
    expect(yearOnYear([d('90')], [d('0')])).toBeNull();
    expect(yearOnYear([d('-5')], [d('10')])).toBeNull();
  });
  it('a percentage of a positive whole', () => {
    expect(percentOf(d('296'), d('1000'))).toBe('29.6%');
    expect(percentOf(d('1'), d('0'))).toBeNull();
    expect(percentOf(null, d('10'))).toBeNull();
  });
});

describe('the money chart', () => {
  it('draws numbers, titles whole pounds and drops an empty baseline', () => {
    const all = periods('2026-07', '2026-09');
    const w = buildMonthWindow(all, ids(all), 3, 'current', 'GBP')!;
    const chart = moneyChart({
      dept: 'analysis', window: w, first: [new Decimal('170000'), null, new Decimal('184000.40')],
      second: [new Decimal('131000'), null, new Decimal('138000')], baseline: [null, null, null], baselineWhat: 'revenue',
      insight: 'Operating profit is 25.0% of revenue.', figure: '£85k',
    });
    expect(chart.first).toEqual([170000, null, 184000.4]);
    expect(chart.baseline).toBeNull();
    expect(chart.firstTitles[0]).toBe('Jul · Revenue: £170,000');
    expect(chart.firstTitles[1]).toBe('Aug · Revenue: —');
    expect(chart.rows[2]).toEqual({ period: 'Sep 2026', first: '£184,000', second: '£138,000', baseline: '—' });
    expect(chart.ticks[0]).toBe('£0');
    expect(chart.cap).toBeGreaterThanOrEqual(184000.4 * 1.17);
    expect(chart.description).toBe('Jul – Sep 2026. Revenue and operating costs. Use View chart data for exact values.');
  });
});

describe('the mix', () => {
  const d = (v: string) => new Decimal(v);
  it('largest customer, the rest of sales and other income', () => {
    const mix = revenueMix({ revenue: d('1000'), otherIncome: d('100'), customers: [{ name: 'A', value: d('400') }, { name: 'B', value: d('300') }], currency: 'GBP' });
    expect(mix.slices.map((s) => [s.label, s.share])).toEqual([['A', 36], ['Other sales', 55], ['Other income', 9]]);
    expect(mix.total).toBe('£1.1k');
    expect(mix.caption).toBe('total income');
  });
  it('two largest customers and the rest without other income; sales alone without customers', () => {
    const two = revenueMix({ revenue: d('1000'), otherIncome: d('0'), customers: [{ name: 'A', value: d('400') }, { name: 'B', value: d('300') }], currency: 'GBP' });
    expect(two.slices.map((s) => s.shareDisplay)).toEqual(['40%', '30%', '30%']);
    expect(two.caption).toBe('total revenue');
    const none = revenueMix({ revenue: d('500'), otherIncome: null, customers: [], currency: 'GBP' });
    expect(none.slices).toEqual([{ label: 'Sales', share: 100, shareDisplay: '100%' }]);
    expect(revenueMix({ revenue: null, otherIncome: null, customers: [], currency: 'GBP' }).slices).toEqual([]);
  });
  it('spending: the two largest categories and the rest', () => {
    const mix = spendingMix([
      { label: 'w', value: d('5') }, { label: 'x', value: d('50') }, { label: 'y', value: d('30') }, { label: 'z', value: d('15') },
    ], 'GBP');
    expect(mix.slices.map((s) => [s.label, s.share])).toEqual([['x', 50], ['y', 30], ['Other', 20]]);
    expect(mix.total).toBe('£100');
    expect(mix.caption).toBe('total spending');
  });
});

describe('the priorities queue', () => {
  const alert = (id: string, severity: AlertLike['severity'], status: AlertLike['status'], ruleKey = 'revenue.decline'): AlertLike => ({
    id, ruleKey, family: 'Sales fell', severity, status, title: `Alert ${id}`, whatHappened: 'What happened.',
    whyItMatters: 'Why.', whatYouCanDo: null, periodLabel: 'Sep 2026', detailHref: `/app/x/insights/alerts/${id}`,
  });
  it('open alerts worst first, then acknowledged ones as reviewed', () => {
    const items = alertQueueItems(
      [alert('1', 'low', 'open'), alert('2', 'critical', 'open', 'cash.decline'), alert('3', 'medium', 'acknowledged')],
      new Set(['Review requested: Alert 1']), (t) => `Review requested: ${t}`,
    );
    expect(items.map((i) => [i.id, i.tag, i.reviewed, i.requested])).toEqual([
      ['alert:2', 'Action', false, false], ['alert:1', 'Review', false, true], ['alert:3', 'Investigate', true, false],
    ]);
    expect(items[0]!.icon).toBe('bank');
    expect(items[1]!.nextStep).toBe('Why.');
    expect(items[1]!.subtitle).toBe('Sales fell · Low priority · Sep 2026');
  });
  it('the analyst sees the review workspace, everyone else the next moves', () => {
    expect(alertQueue([], true).title).toBe('Analyst review queue');
    expect(alertQueue([], false).footnote).toBe('Select an item to see the context and request a review from your analyst.');
  });
});

describe('the shared panels', () => {
  const facts = {
    batches: { awaitingReview: 2, recordsReceived: 10 },
    actions: { open: 3, total: 5, windowTotal: 4, windowCompleted: 1 },
    filings: null, reportReady: false,
  };
  it('compliance checks as the prototype words them', () => {
    expect(complianceChecks(facts).map((c) => [c.title, c.text, c.status, c.type])).toEqual([
      ['Accounting integration', 'Xero is not connected', 'Not connected', 'warning'],
      ['Data completion', '2 uploads await review', 'Incomplete', 'warning'],
      ['Workflow review', '3 of 5 open actions still to review', 'Pending', 'warning'],
      ['Statutory filings', 'No filing evidence or compliance source is connected', 'Not verified', 'unverified'],
    ]);
    expect(complianceChecks({ ...facts, batches: { awaitingReview: 0, recordsReceived: 0 } })[1]!.status).toBe('Complete');
  });
  it('the workflow infographic', () => {
    const panel = workflowPanel(facts);
    expect(panel.nodes.map((n) => [n.label, n.detail, n.status])).toEqual([
      ['Source data', '10 records received', 'ready'], ['Validate', '2 pending', 'warning'],
      ['Reconcile', 'Xero not connected', 'warning'], ['Approve', '1 of 4 reviewed', 'warning'],
      ['Report', 'Complete the readiness checks', 'pending'],
    ]);
    expect([panel.toProcess, panel.reviewsOpen]).toEqual([2, 3]);
  });
  it('greeting, last login and the finance line', () => {
    expect(greeting(firstName('Carl Jones', null), false)).toBe('Welcome back, Carl. Your business, in perspective.');
    expect(greeting(firstName(null, 'ana@apx.test'), true)).toBe('Welcome back, ana. Turn information into action.');
    expect(lastLoginLabel('2026-10-17T08:42:00Z', 'Europe/London')).toEqual({ time: '17 Oct 2026 · 09:42', zone: 'BST' });
    expect(lastLoginLabel(null, 'Europe/London')).toBeNull();
    expect(financeLine('Current · Sep 2026', 'Apr – Sep 2026', new Decimal('1000'), new Decimal('296'), 'GBP'))
      .toBe('Current · Sep 2026 · Apr – Sep 2026: revenue £1,000, operating costs £704, operating profit £296 (29.6% margin).');
  });
});

describe('the year figures (modules/marketing annual)', () => {
  const known = (value: string): FigureFact => ({ value, basis: 'ledger', warnings: [], missing: [] });
  const month = (ym: string, isComplete = true): MonthFacts => ({
    periodId: `p-${ym}`, periodStart: `${ym}-01`, periodEnd: `${ym}-28`, isComplete,
    figures: {
      revenue: known('1000.00'), cost_of_sales: known('400.00'), gross_profit: known('600.00'),
      operating_expenses: known('300.00'), net_profit: known('300.00'), other_income: known('0.00'), tax_expense: known('0.00'),
    },
  });
  const range = (year: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => month(`${year}-${String(from + i).padStart(2, '0')}`));

  it('a partial year compares the same months with the same marketing source', () => {
    const facts: AnnualFacts = {
      currency: 'GBP', fiscalYearStartMonth: 1,
      months: [...range(2024, 1, 12), ...range(2025, 1, 6)],
      categorySpend: range(2025, 1, 6).map((m) => ({ periodId: m.periodId, category: 'marketing', label: 'Marketing', value: '50.00' })),
      campaignSpend: range(2024, 1, 6).map((m) => ({ periodId: m.periodId, amount: '20.00' })),
    };
    const c = annualComparison(facts)!;
    expect(c.current.label).toBe('Jan – Jun 2025');
    expect(c.previous!.label).toBe('Jan – Jun 2024');
    expect(c.current.year.marketingSpend).toBe('300.00');
    // Accounts are the source over the three-year table, so the same months of 2024 had no Marketing
    // account spend (a known zero) — not their campaign spend.
    expect(c.previous!.year.marketingSpend).toBe('0.00');
  });

  it('marketing vs revenue over the window, month by month', () => {
    const may = month('2025-05'), jun = month('2025-06', false);
    const m = marketingWindow({
      currency: 'GBP', fiscalYearStartMonth: 1, months: [may, jun],
      categorySpend: [{ periodId: jun.periodId, category: 'marketing', label: 'Marketing', value: '100.00' }], campaignSpend: [],
    }, [{ periodId: may.periodId, label: 'May' }, { periodId: jun.periodId, label: 'Jun' }], 'May – Jun 2025');
    expect(m.source).toBe('accounts');
    expect(m.months.map((r) => r.spend)).toEqual(['0.00', '100.00']);
    expect(m.shareDisplay).toBe('5.0% of revenue');
    expect(m.share).toBe(0.05);
  });

  it('leaves a month without figures out of the totals rather than making them unknown', () => {
    const may = month('2025-05');
    const jun: MonthFacts = { ...month('2025-06', false), figures: {} };
    const m = marketingWindow({
      currency: 'GBP', fiscalYearStartMonth: 1, months: [may, jun],
      categorySpend: [{ periodId: may.periodId, category: 'marketing', label: 'Marketing', value: '50.000000' }], campaignSpend: [],
    }, [{ periodId: may.periodId, label: 'May' }, { periodId: jun.periodId, label: 'Jun' }], 'May – Jun 2025');
    expect(m.months.map((r) => [r.revenue, r.spend])).toEqual([['1000.00', '50.00'], [null, null]]);
    expect([m.revenue, m.spend, m.shareDisplay]).toEqual(['1000.00', '50.00', '5.0% of revenue']);
  });

  it('compact money never reads "1000k"', () => {
    expect(compactMoney('999950.00', 'GBP')).toBe('£1m');
    expect(compactMoney('1284000.00', 'GBP')).toBe('£1.28m');
    expect(compactMoney('-379000.00', 'GBP')).toBe('−£379k');
  });
});
