import { describe, expect, it } from 'vitest';
import { buildHeadlineCards, type PeriodLabel, type SnapshotRow } from '@/modules/dashboard';

/**
 * The gross-profit card and the engine's contract (CD-05, ADR-105).
 *
 * When cost of sales cannot be established the engine writes `cost_of_sales` as NULL with a reason,
 * and STILL writes `gross_profit` as revenue — flagged with the warning `no_cost_of_sales` and with
 * the reason deliberately removed from its own `missing` so the statement adds up. Home's rule used
 * to test `gross_profit.missing`, which that contract empties, so the card was always shown. These
 * cases are the engine's real output shapes, not hand-shaped ones.
 */
const period: PeriodLabel = { id: 'p-may', label: 'May 2026', periodStart: '2026-05-01', periodEnd: '2026-05-31', isComplete: true };
const row = (key: string, value: string | null, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  snapshotId: `snap-${key}`, metricKey: key, periodId: period.id, dimensionType: 'none', dimensionId: null,
  value, unit: 'money', currency: 'GBP', basis: 'invoices', assurance: 'calculated',
  dataQuality: { completeness: 1, proxy: false, warnings: [], missing: [] }, components: {}, ...over,
});
const keys = (cards: ReadonlyArray<{ metricKey: string }>) => cards.map((c) => c.metricKey);

describe('the gross-profit card follows the engine (CD-05, ADR-105)', () => {
  it('is shown, with its value, when cost of sales exists', () => {
    const out = buildHeadlineCards({
      period, previousLabel: null, orgSlug: 'o',
      snapshots: [row('revenue', '8550.00'), row('cost_of_sales', '900.00'), row('gross_profit', '7650.00'), row('operating_profit', '7650.00')],
    });
    expect(out.hidesGrossProfit).toBe(false);
    expect(out.grossProfitNote).toBeNull();
    expect(keys(out.cards)).toContain('gross_profit');
    expect(out.cards.find((c) => c.metricKey === 'gross_profit')?.value).toContain('7,650');
  });

  it('is omitted, with the reason, when no cost-of-sales account has ever carried a figure', () => {
    const out = buildHeadlineCards({
      period, previousLabel: null, orgSlug: 'o',
      snapshots: [
        row('revenue', '5000.00'),
        row('cost_of_sales', null, { dataQuality: { completeness: 1, proxy: false, warnings: [], missing: ['no_cost_of_sales_accounts'] } }),
        // What the engine really writes: revenue, warned, with the reason stripped from `missing`.
        row('gross_profit', '5000.00', { dataQuality: { completeness: 1, proxy: false, warnings: ['no_cost_of_sales'], missing: [] } }),
        row('operating_profit', '5000.00'),
      ],
    });
    expect(out.hidesGrossProfit).toBe(true);
    expect(keys(out.cards)).not.toContain('gross_profit');
    expect(out.grossProfitNote).toMatch(/direct-cost accounts/);
  });

  it('is omitted when cost of sales lives only in a source the month is not built from', () => {
    const out = buildHeadlineCards({
      period, previousLabel: null, orgSlug: 'o',
      snapshots: [
        row('revenue', '9000.00', { basis: 'ledger' }),
        row('cost_of_sales', null, { basis: 'ledger', dataQuality: { completeness: 1, proxy: false, warnings: [], missing: ['cost_of_sales_in_other_source'] } }),
        row('gross_profit', '9000.00', { basis: 'ledger', dataQuality: { completeness: 1, proxy: false, warnings: ['no_cost_of_sales'], missing: [] } }),
        row('operating_profit', '9000.00', { basis: 'ledger' }),
      ],
    });
    expect(out.hidesGrossProfit).toBe(true);
    expect(keys(out.cards)).not.toContain('gross_profit');
    expect(out.grossProfitNote).toMatch(/purchase invoices show direct costs/);
  });

  it('never manufactures a figure: a NULL gross profit stays absent, not zero', () => {
    const out = buildHeadlineCards({
      period, previousLabel: null, orgSlug: 'o',
      snapshots: [row('revenue', null, { basis: 'none', dataQuality: { completeness: 0, proxy: false, warnings: [], missing: ['no_source_covers_period'] } })],
    });
    expect(out.hidesGrossProfit).toBe(true);
    expect(keys(out.cards)).not.toContain('gross_profit');
    expect(out.cards.every((c) => c.value !== '£0')).toBe(true);
  });
});
