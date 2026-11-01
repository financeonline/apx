import { describe, expect, it } from 'vitest';
import {
  captureSource, compactMoney, countBaseline, countByMonth, countChart, countScale, dayLabel, departmentHeading,
  groupCounts, isOverdueInvoice, monthEndOf, monthKey, openAt, overdueCustomersAt, plural, rate, rateLabel,
  shareSlices, workstream, yearEarlierKey, type InvoiceFacts,
} from '../../src/modules/departments/domain/dashboard-ops';
import type { MonthWindow } from '../../src/modules/departments/domain/dashboard';

/**
 * The pure helpers behind the count departments of the department dashboard (Data Capture, Manage
 * Workflow, Client Management): monthly tallies, the year-earlier baseline, whole-number chart
 * ticks, donut shares that add up to 100, and the "as at a past month end" reconstructions.
 */

const months = (starts: string[]): MonthWindow => ({
  months: starts.map((s, i) => ({
    periodId: `p${i}`, periodStart: s,
    label: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(s.slice(5, 7)) - 1]!,
    longLabel: `${s.slice(0, 7)}`, isComplete: true, yearEarlierPeriodId: null,
  })),
  periodCaption: 'Jul – Sep 2026', snapshotLabel: 'Current · Sep 2026', reportingCutoff: 'Reporting cutoff · September 2026', currency: 'GBP',
});
const window = months(['2026-07-01', '2026-08-01', '2026-09-01']);

describe('dates and months', () => {
  it('reads month keys from dates and timestamps', () => {
    expect(monthKey('2026-04-17')).toBe('2026-04');
    expect(monthKey('2026-04-17T09:30:00.000Z')).toBe('2026-04');
    expect(monthKey(null)).toBeNull();
    expect(monthKey('soon')).toBeNull();
  });

  it('finds the same month a year earlier and the last day of a month', () => {
    expect(yearEarlierKey('2026-04-01')).toBe('2025-04');
    expect(monthEndOf('2026-09-01')).toBe('2026-09-30');
    expect(monthEndOf('2024-02-01')).toBe('2024-02-29');
    expect(monthEndOf('2026-12-01')).toBe('2026-12-31');
  });

  it('writes the prototype date', () => {
    expect(dayLabel('2026-11-05')).toBe('05 Nov 2026');
    expect(dayLabel('2026-09-30T23:00:00Z')).toBe('30 Sep 2026');
    expect(dayLabel(null)).toBe('—');
  });

  it('counts records per month', () => {
    expect(countByMonth(['2026-07-02', '2026-07-30T10:00:00Z', '2026-09-01', null, '2025-07-01'], ['2026-07', '2026-08', '2026-09']))
      .toEqual([2, 0, 1]);
  });

  it('uses the year earlier as a baseline, with gaps before the first record', () => {
    // First record Aug 2025: Jul 2025 is before the company had any data — a gap, not a zero.
    expect(countBaseline(['2025-08-03', '2025-08-20', '2026-07-01'], window)).toEqual([null, 2, 0]);
    // Nothing a year earlier at all: no baseline line.
    expect(countBaseline(['2026-07-01'], window)).toBeNull();
    expect(countBaseline([], window)).toBeNull();
  });
});

describe('numbers', () => {
  it('formats counts, plurals and rates', () => {
    expect(plural(1, 'document')).toBe('1 document');
    expect(plural(1240, 'document')).toBe('1,240 documents');
    expect(rate(19, 20)).toBe(95);
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(1, 0)).toBeNull();
    expect(rateLabel(95)).toBe('95.0%');
    expect(rateLabel(null)).toBe('—');
  });

  it('shortens money as the prototype does', () => {
    expect(compactMoney('1690000', 'GBP')).toBe('£1.69m');
    expect(compactMoney('234700', 'GBP')).toBe('£234.7k');
    expect(compactMoney('234000', 'GBP')).toBe('£234k');
    expect(compactMoney('950', 'GBP')).toBe('£950');
    expect(compactMoney('-1500', 'GBP')).toBe('−£1.5k');
    expect(compactMoney(null, 'GBP')).toBe('—');
  });

  it('draws count charts on whole-number gridlines', () => {
    for (const values of [[1], [3, 2], [7], [52, 58, 82], [0]]) {
      const { cap, ticks } = countScale(values);
      expect(ticks).toHaveLength(5);
      expect(ticks.every((t) => Number.isInteger(t))).toBe(true);
      expect(cap).toBeGreaterThanOrEqual(Math.max(...values));
    }
  });
});

describe('the contract pieces', () => {
  it('numbers the department kicker', () => {
    expect(departmentHeading('capture', window).kicker).toBe('03 / BUILD RELIABLE FOUNDATIONS');
    expect(departmentHeading('clients', window).name).toBe('Client Management');
  });

  it('builds a count chart with titles, rows and the workflow kicker', () => {
    const chart = countChart({ dept: 'workflow', window, first: [5, 6, 7], second: [4, 5, 6], baseline: null, insight: '15 of 18 tasks completed in the selected period.', figure: '83.3% complete' });
    expect(chart.kicker).toBe('WORKFLOW PROGRESS');
    expect(chart.unit).toBe('count');
    expect(chart.firstTitles[0]).toBe('Jul · Tasks created: 5');
    expect(chart.rows[2]).toEqual({ period: '2026-09', first: '7', second: '6', baseline: '—' });
    expect(chart.ticks.at(-1)).toBe(String(chart.cap));
    expect(countChart({ dept: 'capture', window, first: [0, 0, 0], second: [0, 0, 0], baseline: null, insight: '', figure: '' }).kicker)
      .toBe('PERFORMANCE OVER TIME');
  });

  it('gives donut shares that add up to exactly 100', () => {
    const slices = shareSlices([{ label: 'A', value: 1 }, { label: 'B', value: 1 }, { label: 'C', value: 1 }]);
    expect(slices.map((s) => s.share).reduce((a, b) => a + b, 0)).toBe(100);
    expect(slices.map((s) => s.shareDisplay)).toEqual(['34%', '33%', '33%']);
    expect(shareSlices([{ label: 'A', value: 0 }, { label: 'B', value: 5 }])).toEqual([{ label: 'B', share: 100, shareDisplay: '100%' }]);
    expect(shareSlices([])).toEqual([]);
  });
});

describe('department groupings', () => {
  it('groups import types and action sources into three', () => {
    expect(captureSource('bank_statement')).toBe('Bank statements');
    expect(captureSource('trial_balance')).toBe('Accounts');
    expect(captureSource('sales_invoices')).toBe('Invoices & other');
    expect(workstream('health_score')).toBe('From alerts');
    expect(workstream('report')).toBe('From the AI analyst & reports');
    expect(workstream('user')).toBe('Added by your team');
    expect(groupCounts(['a', 'b', 'a'], ['a', 'b', 'c'], (x) => x)).toEqual([
      { label: 'a', value: 2 }, { label: 'b', value: 1 }, { label: 'c', value: 0 },
    ]);
  });
});

describe('as at a past month end', () => {
  it('counts tasks open at a month end', () => {
    const tasks = [
      { createdAt: '2026-07-10T09:00:00Z', completedAt: null, status: 'open' },
      { createdAt: '2026-07-10T09:00:00Z', completedAt: '2026-08-02T09:00:00Z', status: 'completed' },
      { createdAt: '2026-09-10T09:00:00Z', completedAt: null, status: 'in_progress' },
      { createdAt: '2026-07-01T09:00:00Z', completedAt: null, status: 'dismissed' },
    ];
    expect(openAt(tasks, '2026-07-31')).toBe(2);
    expect(openAt(tasks, '2026-08-31')).toBe(1);
    expect(openAt(tasks, '2026-09-30')).toBe(2);
  });

  it('knows which invoices are overdue, now and at a past month end', () => {
    const inv = (over: Partial<InvoiceFacts>): InvoiceFacts => ({
      counterpartyId: 'c1', issueDate: '2026-06-01', dueDate: '2026-07-01', status: 'open', balanceDue: '100.00', paidDate: null, ...over,
    });
    expect(isOverdueInvoice(inv({}), '2026-07-02')).toBe(true);
    expect(isOverdueInvoice(inv({}), '2026-07-01')).toBe(false);
    expect(isOverdueInvoice(inv({ balanceDue: '0.00' }), '2026-08-01')).toBe(false);
    expect(isOverdueInvoice(inv({ status: 'paid' }), '2026-08-01')).toBe(false);

    const invoices = [
      inv({}),
      inv({ counterpartyId: 'c2', status: 'paid', paidDate: '2026-08-15', balanceDue: '0.00' }),
      inv({ counterpartyId: 'c3', status: 'paid', paidDate: '2026-06-20', balanceDue: '0.00' }),
      inv({ counterpartyId: 'c4', issueDate: '2026-08-05', dueDate: '2026-08-20' }),
    ];
    expect(overdueCustomersAt(invoices, '2026-07-31')).toBe(2); // c1 open, c2 paid later
    expect(overdueCustomersAt(invoices, '2026-08-31')).toBe(2); // c1, c4
  });
});
