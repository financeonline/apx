import { describe, expect, it } from 'vitest';
import { computeVatReturn, estimateCorporationTax, vatQuarterFor, type VatInvoice } from '@/modules/tax';

/**
 * The indicative VAT return and Corporation Tax estimate (ADR-156). Every expected figure is worked
 * by hand in the comment beside it.
 */

describe('VAT quarters (UK stagger groups)', () => {
  it('finds the quarter containing a date for each group', () => {
    expect(vatQuarterFor('2026-08-15', 3)).toEqual({ start: '2026-07-01', end: '2026-09-30', label: 'Jul–Sep 2026' });
    expect(vatQuarterFor('2026-08-15', 1)).toEqual({ start: '2026-08-01', end: '2026-10-31', label: 'Aug–Oct 2026' });
    expect(vatQuarterFor('2026-08-15', 2)).toEqual({ start: '2026-06-01', end: '2026-08-31', label: 'Jun–Aug 2026' });
    // Across a year end: quarters ending Feb/May/Aug/Nov.
    expect(vatQuarterFor('2026-01-10', 2)).toEqual({ start: '2025-12-01', end: '2026-02-28', label: 'Dec 2025–Feb 2026' });
  });
});

const inv = (id: string, over: Partial<VatInvoice>): VatInvoice => ({
  id, invoiceType: 'sales', status: 'sent', issueDate: '2026-08-10', paidDate: null,
  subtotal: null, taxAmount: null, totalAmount: '0', amountPaid: '0', ...over,
});
const Q = vatQuarterFor('2026-08-15', 3);

/*
 * In the quarter: a sale 1,000 + VAT 200; its credit note 100 + VAT 20; a purchase 500 + VAT 100;
 * a purchase of 50 with no VAT stated (no tax, no subtotal). Outside: a void sale, a sale in October.
 *   Box 1 = 200 − 20 = 180.00 · Box 4 = 100.00 · Box 5 = 80.00 to pay
 *   Box 6 = 1,000 − 100 = 900 · Box 7 = 500 + 50 = 550
 */
const INVOICES: VatInvoice[] = [
  inv('s1', { subtotal: '1000.00', taxAmount: '200.00', totalAmount: '1200.00' }),
  inv('cn1', { invoiceType: 'sales_credit_note', subtotal: '100.00', taxAmount: '20.00', totalAmount: '120.00' }),
  inv('p1', { invoiceType: 'purchase', subtotal: '500.00', taxAmount: '100.00', totalAmount: '600.00' }),
  inv('p2', { invoiceType: 'purchase', totalAmount: '50.00' }),
  inv('void', { status: 'void', subtotal: '9999.00', taxAmount: '1999.80', totalAmount: '11998.80' }),
  inv('oct', { issueDate: '2026-10-02', subtotal: '700.00', taxAmount: '140.00', totalAmount: '840.00' }),
];

const box = (r: ReturnType<typeof computeVatReturn>, n: string) =>
  (r.kind === 'return' ? r.boxes.filter((b) => b.box === n).map((b) => b.value) : []);

describe('the UK nine-box VAT return', () => {
  it('builds boxes 1–7 from the quarter\'s invoices; credit notes subtract; void and other quarters are out', () => {
    const r = computeVatReturn({ invoices: INVOICES, quarter: Q, scheme: 'standard', country: 'GB', registered: true });
    expect(r.kind).toBe('return');
    expect(box(r, '1')).toEqual(['180.00']);
    expect(box(r, '2')).toEqual([null]);                       // not recorded in MOTION
    expect(box(r, '3')).toEqual(['180.00']);
    expect(box(r, '4')).toEqual(['100.00']);
    expect(box(r, '5')).toEqual(['80.00']);
    expect(box(r, '6')).toEqual(['900']);
    expect(box(r, '7')).toEqual(['550']);
    if (r.kind === 'return') {
      expect(r.netVat).toBe('80.00');
      expect(r.vatNotStated).toEqual(['p2']);                  // named, never assumed
      expect(r.invoicesCounted).toBe(4);
    }
  });

  it('a repayment quarter says so: Box 5 is the amount due back, net VAT negative', () => {
    const r = computeVatReturn({
      invoices: [inv('p', { invoiceType: 'purchase', subtotal: '1000.00', taxAmount: '200.00', totalAmount: '1200.00' }),
        inv('s', { subtotal: '250.00', taxAmount: '50.00', totalAmount: '300.00' })],
      quarter: Q, scheme: 'standard', country: 'GB', registered: true,
    });
    expect(box(r, '5')).toEqual(['150.00']);                     // 200 − 50 to reclaim
    if (r.kind === 'return') {
      expect(r.netVat).toBe('-150.00');
      expect(r.boxes.find((b) => b.box === '5')!.label).toBe('Net VAT to be reclaimed');
    }
  });

  it('derives VAT from total − subtotal when the tax column is empty', () => {
    const r = computeVatReturn({ invoices: [inv('s', { subtotal: '400.00', totalAmount: '480.00' })], quarter: Q, scheme: 'standard', country: 'GB', registered: true });
    expect(box(r, '1')).toEqual(['80.00']);
  });

  it('cash accounting counts what was paid in the quarter, in proportion', () => {
    // Issued in June (before the quarter), half paid on 5 July: half of 200 VAT = 100.00, half of 1,000 net = 500.
    const r = computeVatReturn({
      invoices: [inv('s', { issueDate: '2026-06-20', paidDate: '2026-07-05', subtotal: '1000.00', taxAmount: '200.00', totalAmount: '1200.00', amountPaid: '600.00' })],
      quarter: Q, scheme: 'cash_accounting', country: 'GB', registered: true,
    });
    expect(box(r, '1')).toEqual(['100.00']);
    expect(box(r, '6')).toEqual(['500']);
  });

  it('does not calculate a flat-rate return, an unregistered business, or a country it has no rules for', () => {
    expect(computeVatReturn({ invoices: INVOICES, quarter: Q, scheme: 'flat_rate', country: 'GB', registered: true }))
      .toMatchObject({ kind: 'not_calculated', reason: 'flat_rate' });
    expect(computeVatReturn({ invoices: INVOICES, quarter: Q, scheme: 'standard', country: 'GB', registered: false }))
      .toMatchObject({ kind: 'not_calculated', reason: 'not_registered' });
    expect(computeVatReturn({ invoices: INVOICES, quarter: Q, scheme: 'standard', country: 'IN', registered: true }))
      .toMatchObject({ kind: 'not_calculated', reason: 'country' });
  });
});

describe('the UAE VAT201 summary', () => {
  it('states supplies and output VAT, expenses and recoverable VAT, and the net', () => {
    const r = computeVatReturn({ invoices: INVOICES, quarter: Q, scheme: 'standard', country: 'AE', registered: true });
    if (r.kind !== 'return') throw new Error('expected a return');
    const by = (label: string) => r.boxes.find((b) => b.label.startsWith(label))!.value;
    expect(by('Standard-rated supplies')).toBe('900.00');          // 1,000 − 100
    expect(by('VAT on standard-rated supplies')).toBe('180.00');
    expect(by('Standard-rated expenses')).toBe('550.00');           // 500 + 50
    expect(by('Recoverable VAT')).toBe('100.00');
    expect(by('Payable tax')).toBe('80.00');
  });
});

describe('UK Corporation Tax (periods from 1 April 2023)', () => {
  const year = { country: 'GB', periodStart: '2025-04-01', periodEnd: '2026-03-31', associatedCompanies: 0 } as const;

  it('small profits rate up to £50,000', () => {
    expect(estimateCorporationTax({ ...year, profitBeforeTax: '40000.00' }))
      .toMatchObject({ estimatedTax: '7600.00', band: 'Small profits rate (19%)' });   // 40,000 × 19%
  });

  it('main rate with marginal relief in between', () => {
    // 25% × 100,000 = 25,000; relief 3/200 × (250,000 − 100,000) = 2,250; tax 22,750.
    expect(estimateCorporationTax({ ...year, profitBeforeTax: '100000.00' }))
      .toMatchObject({ estimatedTax: '22750.00', marginalRelief: '2250.00', effectiveRate: '0.2275' });
  });

  it('main rate at £250,000 and above', () => {
    expect(estimateCorporationTax({ ...year, profitBeforeTax: '300000.00' })).toMatchObject({ estimatedTax: '75000.00' });
  });

  it('divides the limits among associated companies', () => {
    // One associate: limits 25,000 and 125,000. 25% × 100,000 − 3/200 × 25,000 = 25,000 − 375 = 24,625.
    expect(estimateCorporationTax({ ...year, associatedCompanies: 1, profitBeforeTax: '100000.00' }))
      .toMatchObject({ estimatedTax: '24625.00', thresholds: { lower: '25000.00', upper: '125000.00' } });
  });

  it('reduces the limits for a shorter period', () => {
    // 1 Jan–30 Jun 2024 = 182 days. Upper 250,000 × 182/365 = 124,657.534…; relief 3/200 × 94,657.534… = 1,419.863…
    // 25% × 30,000 = 7,500 − 1,419.863… = 6,080.14.
    expect(estimateCorporationTax({ country: 'GB', periodStart: '2024-01-01', periodEnd: '2024-06-30', associatedCompanies: 0, profitBeforeTax: '30000.00' }))
      .toMatchObject({ estimatedTax: '6080.14', days: 182 });
  });

  it('a loss is no tax; the due date is 9 months and 1 day after the period', () => {
    expect(estimateCorporationTax({ ...year, profitBeforeTax: '-5000.00' }))
      .toMatchObject({ estimatedTax: '0.00', effectiveRate: null, dueDate: '2027-01-01' });   // 31 Mar 2026 → 1 Jan 2027
  });

  it('makes no estimate for a period before the current rules', () => {
    expect(estimateCorporationTax({ country: 'GB', periodStart: '2022-04-01', periodEnd: '2023-03-31', associatedCompanies: 0, profitBeforeTax: '1.00' }))
      .toEqual({ kind: 'not_estimated', reason: 'period_before_rules' });
  });
});

describe('UAE Corporate Tax (periods from 1 June 2023)', () => {
  const year = { country: 'AE', periodStart: '2025-01-01', periodEnd: '2025-12-31', associatedCompanies: 0 } as const;

  it('0% up to AED 375,000, 9% above; due 9 months after the period', () => {
    expect(estimateCorporationTax({ ...year, profitBeforeTax: '300000.00' })).toMatchObject({ estimatedTax: '0.00', dueDate: '2026-09-30' });
    // (500,000 − 375,000) × 9% = 11,250.
    expect(estimateCorporationTax({ ...year, profitBeforeTax: '500000.00' })).toMatchObject({ estimatedTax: '11250.00', band: '9% above AED 375,000' });
  });

  it('no estimate for other countries', () => {
    expect(estimateCorporationTax({ ...year, country: 'IN', profitBeforeTax: '1.00' })).toEqual({ kind: 'not_estimated', reason: 'country' });
  });
});
