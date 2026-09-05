import { describe, expect, it } from 'vitest';

import {
  BASIS_TEXT, PARTIAL_DATA_THRESHOLD, changeFrom, formatValue, labelFor, missingReasonText,
  statusFor, toMetricCard, type PeriodLabel, type SnapshotRow,
} from '@/modules/dashboard';
import { PERFECT_QUALITY, type DataQuality } from '@/modules/financial-engine';

/**
 * The status badge and the view models (UX_ARCHITECTURE.md §4, §8.1, ADR-037).
 *
 * §4's rule is the one these tests defend: **a number carries exactly one badge — the worst of its
 * assurance and its data quality.** Two badges would make a reader weigh them against each other,
 * which is the judgement the product is meant to have already made. And a figure that cannot be
 * computed shows "—" with a reason, never "0": those two mean completely different things to
 * somebody deciding whether they can pay a supplier.
 */

const quality = (over: Partial<DataQuality> = {}): DataQuality => ({ ...PERFECT_QUALITY, ...over });

const may: PeriodLabel = {
  id: 'p-may', label: 'May 2026', periodStart: '2026-05-01', periodEnd: '2026-05-31',
  isComplete: true,
};

const row = (over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  snapshotId: 's1', metricKey: 'revenue', periodId: may.id, dimensionType: 'none',
  dimensionId: null, value: '20000.00', unit: 'money', currency: 'GBP',
  basis: 'ledger', assurance: 'verified', dataQuality: quality(), components: {}, ...over,
});

describe('exactly one status badge, the worst of assurance and data quality (§8.1)', () => {
  it('gives a fully verified, complete figure no badge at all', () => {
    // The ordinary case is not decorated: a badge on everything is a badge on nothing.
    const badge = statusFor({ value: '1', assurance: 'verified', dataQuality: quality() });
    expect(badge.kind).toBe('none');
    expect(badge.label).toBeNull();
    expect(badge.tooltip).toBe('From your records');
  });

  it('labels a calculated figure "Calculated"', () => {
    const badge = statusFor({ value: '1', assurance: 'calculated', dataQuality: quality() });
    expect(badge.label).toBe('Calculated');
  });

  it('labels an incomplete figure "Partial data" whatever its assurance', () => {
    const badge = statusFor({
      value: '1', assurance: 'verified', dataQuality: quality({ completeness: 0.5 }),
    });
    expect(badge.label).toBe('Partial data');
  });

  it('treats any warning as partial data, even at full completeness', () => {
    const badge = statusFor({
      value: '1', assurance: 'verified',
      dataQuality: quality({ warnings: ['bank_coverage_partial'] }),
    });
    expect(badge.label).toBe('Partial data');
  });

  it('labels an estimate "Estimate", outranking incompleteness', () => {
    // An estimate that is also incomplete is still, first, an estimate: that is the more important
    // thing for a reader to know.
    const badge = statusFor({
      value: '1', assurance: 'estimated', dataQuality: quality({ completeness: 0.3 }),
    });
    expect(badge.label).toBe('Estimate');
  });

  it('treats a cash-basis proxy as an estimate even when its assurance says otherwise', () => {
    const badge = statusFor({
      value: '1', assurance: 'calculated', dataQuality: quality({ proxy: true }),
    });
    expect(badge.label).toBe('Estimate');
  });

  it('labels an AI-read figure "Please check", outranking everything below it', () => {
    const badge = statusFor({
      value: '1', assurance: 'inferred',
      dataQuality: quality({ completeness: 0.2, proxy: true, warnings: ['vat_inclusive'] }),
    });
    // The reader needs to know a human has not confirmed this yet, before anything else.
    expect(badge.label).toBe('Please check');
  });

  it('shows a dash with a reason for a figure that cannot be computed, never a zero', () => {
    const badge = statusFor({
      value: null, assurance: 'calculated',
      dataQuality: quality({ missing: ['no_opening_cash'] }),
    });
    expect(badge.kind).toBe('not_available');
    expect(badge.label).toBe('—');
    expect(badge.tooltip).toContain('opening bank balance');
  });

  it('outranks every other state with a NULL, because there is no figure to qualify', () => {
    const badge = statusFor({
      value: null, assurance: 'inferred', dataQuality: quality({ missing: ['insufficient_history'] }),
    });
    expect(badge.kind).toBe('not_available');
  });

  it('draws the partial-data line at nine tenths', () => {
    const above = statusFor({
      value: '1', assurance: 'verified', dataQuality: quality({ completeness: PARTIAL_DATA_THRESHOLD }),
    });
    const below = statusFor({
      value: '1', assurance: 'verified',
      dataQuality: quality({ completeness: PARTIAL_DATA_THRESHOLD - 0.01 }),
    });
    expect(above.kind).toBe('none');
    expect(below.label).toBe('Partial data');
  });

  it('always has a reason to give for a missing figure', () => {
    expect(missingReasonText([])).toContain('enough data');
    expect(missingReasonText(['no_source_covers_period'])).toContain('covering this month');
    expect(missingReasonText(['made_up_code'])).toContain('enough data');
  });
});

describe('formatting comes from core/money, never from a component (§4)', () => {
  it('renders money with the organisation currency and no pence on a headline figure', () => {
    // §8.2: pence appear only on Money sub-pages, evidence and reports. A headline card rounds,
    // because 50p is noise next to twelve thousand pounds.
    const shown = formatValue({ value: '12400.50', unit: 'money', currency: 'GBP' });
    expect(shown).toContain('£');
    expect(shown).toContain('12,401');
    expect(shown).not.toContain('.50');
  });

  it('shows pence when a Money sub-page asks for them (§8.2)', () => {
    // The same figure reads differently by context: an accountant reconciling on a Money sub-page
    // needs the 50p; a headline card does not.
    const headline = formatValue({ value: '12400.50', unit: 'money', currency: 'GBP' });
    const detailed = formatValue(
      { value: '12400.50', unit: 'money', currency: 'GBP' }, { showMinorUnits: true },
    );
    expect(headline).not.toContain('.50');
    expect(detailed).toContain('12,400.50');
  });

  it('renders a negative with a true minus sign, never parentheses (§8.2)', () => {
    const shown = formatValue({ value: '-1200.00', unit: 'money', currency: 'GBP' });
    expect(shown).toContain('\u2212');
    expect(shown).not.toContain('(');
  });

  it('renders a ratio as a percentage, never as a decimal (§8.2)', () => {
    const shown = formatValue({ value: '0.083', unit: 'ratio', currency: null });
    expect(shown).toContain('%');
    expect(shown).not.toBe('0.083');
  });

  it('renders days as whole days', () => {
    expect(formatValue({ value: '42.6', unit: 'days', currency: null })).toBe('43 days');
  });

  it('caps the runway rather than implying precision it does not have (§3.3)', () => {
    expect(formatValue({ value: '41.7', unit: 'count', currency: null })).toBe('36+');
    expect(formatValue({ value: '2.4', unit: 'count', currency: null })).toBe('2.4');
  });

  it('shows a dash for an absent figure in every unit', () => {
    for (const unit of ['money', 'ratio', 'days', 'count'] as const) {
      expect(formatValue({ value: null, unit, currency: 'GBP' }), unit).toBe('—');
    }
  });
});

describe('the change line (§3.2, §8.2)', () => {
  const base = row();

  it('says nothing when there is no comparison', () => {
    expect(changeFrom(base, null, 'April 2026')).toBeNull();
  });

  it('shows the amount and the percentage against the named month', () => {
    const change = changeFrom(base, {
      value: '2100.00', components: { pct_change: '0.083' }, dataQuality: quality(),
    }, 'April 2026');
    expect(change?.text).toContain('2,100');
    expect(change?.text).toContain('%');
    expect(change?.text).toContain('vs April 2026');
  });

  it('withholds the percentage when the comparison was zero', () => {
    // A percentage across zero is meaningless; the absolute change is still true and still shown.
    const change = changeFrom(base, {
      value: '2100.00', components: { pct_change: null },
      dataQuality: quality({ missing: ['comparison_is_zero'] }),
    }, 'April 2026');
    expect(change?.percent).toBeNull();
    expect(change?.amount).toContain('2,100');
  });

  it('withholds the percentage when the two months are on different bases (ADR-030)', () => {
    const change = changeFrom(base, {
      value: '2100.00', components: { pct_change: '0.083' },
      dataQuality: quality({ warnings: ['basis_differs'] }),
    }, 'April 2026');
    expect(change?.basisDiffers).toBe(true);
    // The card shows "compared on a different basis" instead — comparing two bases as a percentage
    // would compare two different things.
    expect(change?.percent).toBeNull();
  });

  it('knows a rise in sales is good news and a rise in costs is not (§4)', () => {
    const up = { value: '2100.00', components: { pct_change: '0.08' }, dataQuality: quality() };

    expect(changeFrom(row({ metricKey: 'revenue' }), up, 'April')?.favourable).toBe(true);
    expect(changeFrom(row({ metricKey: 'operating_expenses' }), up, 'April')?.favourable).toBe(false);
    expect(changeFrom(row({ metricKey: 'closing_cash' }), up, 'April')?.favourable).toBe(true);
    // A rise in what you are owed ties up cash.
    expect(changeFrom(row({ metricKey: 'receivables' }), up, 'April')?.favourable).toBe(false);
  });

  it('knows a fall in costs is good news', () => {
    const down = { value: '-500.00', components: { pct_change: '-0.05' }, dataQuality: quality() };
    expect(changeFrom(row({ metricKey: 'operating_expenses' }), down, 'April')?.favourable).toBe(true);
    expect(changeFrom(row({ metricKey: 'revenue' }), down, 'April')?.favourable).toBe(false);
  });

  it('gives no direction where a direction carries no meaning', () => {
    const up = { value: '100.00', components: { pct_change: '0.1' }, dataQuality: quality() };
    // Working capital can move either way for good reasons; colouring it would be a false signal.
    expect(changeFrom(row({ metricKey: 'working_capital' }), up, 'April')?.favourable).toBeNull();
  });
});

describe('plain language (§8.1)', () => {
  it('renders the plain phrase and keeps the accountant term for the tooltip', () => {
    expect(labelFor('revenue')).toEqual({ plain: 'Sales', technical: 'Revenue' });
    expect(labelFor('receivables').plain).toBe('Owed to you');
    expect(labelFor('payables').plain).toBe('You owe');
    expect(labelFor('net_cash_movement').plain).toBe('Change in cash');
    expect(labelFor('operating_profit').plain).toBe('Profit');
    expect(labelFor('operating_profit').technical).toContain('before interest and tax');
  });

  it('never renders a raw metric key for anything Home shows', () => {
    for (const key of ['revenue', 'gross_profit', 'operating_profit', 'closing_cash',
                       'receivables', 'payables', 'cash_inflows', 'cash_outflows']) {
      expect(labelFor(key).plain, key).not.toBe(key);
    }
  });

  it('describes the source in plain words, for the tooltip and never as a badge', () => {
    expect(BASIS_TEXT.bank).toBe('From bank statements');
    expect(BASIS_TEXT.ledger).toBe('From your accounts');
    expect(BASIS_TEXT.invoices).toBe('From invoices');
    expect(BASIS_TEXT.period_balances).toBe('From your reports');
  });
});

describe('the metric card view model (§5)', () => {
  it('carries a formatted value, one badge and a Why link', () => {
    const card = toMetricCard(row(), may, null, { orgSlug: 'acme', comparisonLabel: 'April 2026' });

    expect(card.label).toBe('Sales');
    expect(card.value).toContain('20,000');
    expect(card.status.kind).toBe('none');
    expect(card.whyHref).toContain('metric=revenue');
    expect(card.whyHref).toContain(`period=${may.id}`);
  });

  it('shows net profit on a visible second line under operating profit (§4)', () => {
    // "never tooltip-only": the figure a reader most wants after operating profit must be on screen.
    const card = toMetricCard(
      row({ metricKey: 'operating_profit', value: '8000.00' }), may, null,
      {
        orgSlug: 'acme', comparisonLabel: 'April 2026',
        secondary: { label: 'Profit after interest and tax', row: row({ metricKey: 'net_profit', value: '6400.00' }) },
      },
    );
    expect(card.secondaryLine?.label).toBe('Profit after interest and tax');
    expect(card.secondaryLine?.value).toContain('6,400');
  });

  it('shows a dash rather than a zero when the figure is absent', () => {
    const card = toMetricCard(
      row({ value: null, dataQuality: quality({ missing: ['no_source_covers_period'] }) }),
      may, null, { orgSlug: 'acme', comparisonLabel: 'April 2026' },
    );
    expect(card.value).toBe('—');
    expect(card.status.tooltip).toContain('covering this month');
  });
});
