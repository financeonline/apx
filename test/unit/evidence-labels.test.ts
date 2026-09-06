import { describe, expect, it } from 'vitest';
import {
  accountLabel, calculationRunLabel, counterpartyLabel, invoiceLabel, metricSnapshotLabel,
  parseSourceRef, queryLabel,
} from '@/modules/evidence';

/**
 * Evidence item labels (EVIDENCE_MODEL.md §2.2, R2-C-08) and the source reference behind a row (§6
 * level 4).
 *
 * The property under test throughout: a label is derived from the referenced OBJECT and from
 * nothing else. §2.2 makes that a security property rather than a style one — "the AI contract
 * carries no `label` field" — because a label is the sentence a reader uses to decide whether a
 * number means what they think it means.
 */

describe('a metric snapshot is named by its metric, its month and its source (§2.2)', () => {
  it('reads the way the example in the document does', () => {
    expect(metricSnapshotLabel({
      metricKey: 'revenue', periodLabel: 'Mar 2026', basis: 'period_balances',
    })).toBe('Revenue, Mar 2026 — from your reports');

    expect(metricSnapshotLabel({
      metricKey: 'revenue', periodLabel: 'Mar 2026', basis: 'ledger',
    })).toBe('Revenue, Mar 2026 — from your accounts');
  });

  it('uses the accountant’s register, not the headline one (§304)', () => {
    // The card says "Sales"; evidence says "Revenue", because an accountant may be reconciling.
    expect(metricSnapshotLabel({ metricKey: 'revenue', periodLabel: null, basis: 'ledger' }))
      .toContain('Revenue');
    expect(metricSnapshotLabel({ metricKey: 'receivables', periodLabel: null, basis: 'invoices' }))
      .toContain('Receivables');
  });

  it('names the subject of a dimensioned figure', () => {
    expect(metricSnapshotLabel({
      metricKey: 'revenue', periodLabel: 'Mar 2026', basis: 'ledger', dimensionLabel: 'Acme Ltd',
    })).toBe('Revenue — Acme Ltd, Mar 2026 — from your accounts');
  });

  /*
   * A basis the label table has not been taught is DROPPED, not printed. "Revenue, Mar 2026" is
   * incomplete; "Revenue, Mar 2026 — undefined" is wrong, and this is the sentence a reader uses to
   * decide whether to trust a figure.
   */
  it('says less rather than something untrue when the basis is unknown', () => {
    expect(metricSnapshotLabel({ metricKey: 'revenue', periodLabel: 'Mar 2026', basis: 'quantum' }))
      .toBe('Revenue, Mar 2026');
  });

  it('falls back to the key for a metric with no declared label', () => {
    expect(metricSnapshotLabel({
      metricKey: 'revenue.variance.prev_period', periodLabel: null, basis: 'ledger',
    })).toContain('revenue.variance.prev_period');
  });
});

describe('the other item types', () => {
  it('names a run by when it ran and what version ran it', () => {
    expect(calculationRunLabel({ engineVersion: '1.4.0', finishedAt: '2026-04-03T09:15:00Z' }))
      .toBe('Calculated 3 Apr 2026, engine 1.4.0');
    // A run that has not finished still has a version, and saying so beats saying nothing.
    expect(calculationRunLabel({ engineVersion: '1.4.0', finishedAt: null }))
      .toBe('Calculation, engine 1.4.0');
  });

  it('names a selection by what it selects and what it is evidence for', () => {
    expect(queryLabel({ table: 'ledger_entries', ofMetricLabel: 'Revenue, Mar 2026' }))
      .toBe('The ledger entries behind Revenue, Mar 2026');
    expect(queryLabel({ table: 'period_balances', ofMetricLabel: 'Revenue, Mar 2026' }))
      .toBe('The report balances behind Revenue, Mar 2026');
  });

  it('names an account by its code where the chart has one', () => {
    expect(accountLabel({ code: '4000', name: 'Sales' })).toBe('4000 Sales');
    expect(accountLabel({ code: null, name: 'Sales' })).toBe('Sales');
    expect(counterpartyLabel({ name: 'Acme Ltd' })).toBe('Acme Ltd');
  });

  it('names an invoice the way §2.2 does', () => {
    expect(invoiceLabel({
      invoiceNumber: 'INV-1042', counterpartyName: 'Acme Ltd', formattedAmount: '£4,200',
    })).toBe('Invoice INV-1042, Acme Ltd, £4,200');

    // A list with no numbers on it is still nameable.
    expect(invoiceLabel({ invoiceNumber: null, counterpartyName: 'Acme Ltd', formattedAmount: null }))
      .toBe('Invoice, Acme Ltd');
  });
});

describe('the line of the file a row came from (§6 level 4)', () => {
  it('reads each of the three shapes the parsers write', () => {
    expect(parseSourceRef('csv:row:7')).toEqual({ page: null, sheet: null, row: 7 });
    expect(parseSourceRef('pdf:page:3:line:12')).toEqual({ page: 3, sheet: null, row: 12 });
    expect(parseSourceRef('xlsx:Sheet1:14')).toEqual({ page: null, sheet: 'Sheet1', row: 14 });
  });

  it('handles a sheet whose own name contains a colon', () => {
    expect(parseSourceRef('xlsx:Q1:2026:14')).toEqual({ page: null, sheet: 'Q1:2026', row: 14 });
  });

  it('returns nothing rather than guessing at a reference it does not recognise', () => {
    for (const input of [null, '', 'nonsense', 'csv:row:x', 'pdf:page:']) {
      expect(parseSourceRef(input), input ?? 'null')
        .toEqual({ page: null, sheet: null, row: null });
    }
  });
});
