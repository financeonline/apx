import { describe, expect, it } from 'vitest';

import {
  composePeriod, computeCoverage, ENGINE_VERSION, invoiceRevenueCoverage, invoiceSideCoverage,
  type AgingInvoice, type CoverageBatch, type EngineContext, type MetricResult, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * FU-15 (ADR-128): what an invoice list can say about a month-END position.
 *
 * Four dates, kept apart:
 *   - the DECLARED range — which invoices the list is about (an aged-debtors list: its as-at date is
 *     the range's end);
 *   - the COMMIT date — the last day the list can know anything: an invoice raised, or a payment made,
 *     after it is not on it;
 *   - the month-end P is asked about;
 *   - the engine's as-of — which month is current.
 *
 * A full list knows through min(declared end, commit date); it states P's end position only when that
 * effective range reaches P's last day (and, for P's whole month, starts by P's first). Before this, a
 * list committed on 10 August with the form's default range of 1–31 August stated 31 August's
 * receivables as VERIFIED — missing every invoice raised after the 10th and showing as open
 * everything paid after it.
 */

const month = (id: string, start: string, end: string): PeriodRef =>
  ({ id, periodStart: start, periodEnd: end, fiscalYear: 2026, fiscalQuarter: 3, label: id, isComplete: true });
const jul = month('p-jul', '2026-07-01', '2026-07-31');
const aug = month('p-aug', '2026-08-01', '2026-08-31');
const sep = { ...month('p-sep', '2026-09-01', '2026-09-30'), isComplete: false };

let n = 0;
const list = (over: Partial<CoverageBatch>): CoverageBatch => ({
  id: `b-${(n += 1)}`, targetTable: 'invoices', balanceKind: null, balanceBasis: null, bankAccountId: null,
  invoiceListKind: 'full', importType: 'sales_invoices', periodStart: '2026-08-01', periodEnd: '2026-08-31',
  // R-2: these lists stand for complete exports — confirmed to hold every invoice open at their start.
  openingConfirmed: true,
  committedAt: '2026-09-10T10:00:00Z', ...over,
});
const side = (batches: CoverageBatch[], p: PeriodRef, current = false, s: 'sales' | 'purchase' = 'sales') =>
  invoiceSideCoverage(batches, p, s, current);

describe('a mid-month list states nothing about the month end', () => {
  it('declared 1–31 August, committed 10 August: August\'s end is not covered (the FU-15 defect)', () => {
    const midMonth = list({ committedAt: '2026-08-10T09:00:00Z' });
    expect(side([midMonth], aug).covers).toBe(false);
    // The same rule revenue already used: the two answers now agree.
    expect(invoiceRevenueCoverage([midMonth], aug, '2026-10-04').covers).toBe(false);
    // Nor does it supply a month of sales history to the days-outstanding denominator.
    expect(side([midMonth], aug).fullListSpans).toBe(false);
    // It is still a batch of this side: the figure says "stale", it does not pretend nothing exists.
    expect(side([midMonth], aug).anyBatch).toBe(true);
  });

  it('a purchase list committed mid-month leaves payables uncovered the same way', () => {
    const midMonth = list({ importType: 'purchase_invoices', committedAt: '2026-08-10T09:00:00Z' });
    expect(side([midMonth], aug, false, 'purchase').covers).toBe(false);
  });

  it('a list committed on the month\'s last day knows that day: it covers', () => {
    expect(side([list({ committedAt: '2026-08-31T18:00:00Z' })], aug).covers).toBe(true);
  });

  it('an aged-debtors list dated 31 August but committed on the 20th is not an August position', () => {
    const future = list({ invoiceListKind: 'open_items', periodStart: '2026-08-31', periodEnd: '2026-08-31', committedAt: '2026-08-20T00:00:00Z' });
    expect(side([future], aug).covers).toBe(false);
  });
});

describe('a late upload of a valid month-end snapshot stays valid', () => {
  it('a full list spanning August, committed in October, covers August — however late', () => {
    expect(side([list({ committedAt: '2026-10-04T09:00:00Z' })], aug).covers).toBe(true);
    expect(side([list({ committedAt: '2027-02-01T09:00:00Z' })], aug).covers).toBe(true);
    expect(side([list({ committedAt: '2026-10-04T09:00:00Z' })], aug).fullListSpans).toBe(true);
  });

  it('an aged-debtors list as at 31 August, committed 3 September, covers August', () => {
    expect(side([list({ invoiceListKind: 'open_items', periodStart: '2026-08-31', periodEnd: '2026-08-31', committedAt: '2026-09-03T00:00:00Z' })], aug).covers).toBe(true);
  });
});

describe('incomplete coverage', () => {
  it('a list that stops short of the month end, uploaded later, does not state it', () => {
    expect(side([list({ periodEnd: '2026-08-20', committedAt: '2026-09-02T00:00:00Z' })], aug).covers).toBe(false);
  });

  it('a list starting partway through the month is not a full month of sales history', () => {
    const fromTheFifteenth = list({ periodStart: '2026-08-15', committedAt: '2026-09-02T00:00:00Z' });
    // It does state the month-end position (fresh, reaching the end: ADR-124 D-3, unchanged) …
    expect(side([fromTheFifteenth], aug).covers).toBe(true);
    // … but not August's sales, so it does not anchor the denominator.
    expect(side([fromTheFifteenth], aug).fullListSpans).toBe(false);
  });
});

describe('superseded lists', () => {
  it('a mid-month list followed by a later full list: the later one covers the month', () => {
    const early = list({ committedAt: '2026-08-10T09:00:00Z' });
    const later = list({ committedAt: '2026-09-05T09:00:00Z' });
    expect(side([early], aug).covers).toBe(false);
    expect(side([early, later], aug).covers).toBe(true);
  });

  it('a list committed mid-month still covers the earlier months it spans completely', () => {
    const midAug = list({ periodStart: '2026-07-01', periodEnd: '2026-08-31', committedAt: '2026-08-10T09:00:00Z' });
    expect(side([midAug], jul).covers).toBe(true);
    expect(side([midAug], aug).covers).toBe(false);
  });
});

describe('the current month keeps its rule (ADR-123 F-9)', () => {
  it('a list committed during the current month ages it as at the run date', () => {
    expect(side([list({ periodStart: '2026-09-01', periodEnd: '2026-09-30', committedAt: '2026-09-10T00:00:00Z' })], sep, true).covers).toBe(true);
  });

  it('a list committed before the current month began knows nothing about it, whatever range was typed', () => {
    expect(side([list({ periodStart: '2026-09-01', periodEnd: '2026-09-30', committedAt: '2026-08-28T00:00:00Z' })], sep, true).covers).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The figures themselves
// ---------------------------------------------------------------------------------------------

const ctx: EngineContext = {
  organizationId: 'org', calculationRunId: 'run', aggregatedAt: '2026-10-04T00:00:00Z', asOf: '2026-10-04', engineVersion: ENGINE_VERSION,
  settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null, taxableCategories: [] },
  costOfSalesEverUsed: true, costOfSalesInInvoices: false, accounts: [], counterparties: [], bankAccounts: [], periods: [jul, aug],
};

const invoice = (over: Partial<AgingInvoice> & { id: string }): AgingInvoice => ({
  invoiceType: 'sales', counterpartyId: null, issueDate: '2026-08-05', dueDate: '2026-09-04',
  totalAmount: '1000.00', amountPaid: '0.00', balanceDue: '1000.00', paidDate: null, status: 'open', ...over,
});

function receivablesFor(batches: CoverageBatch[], invoices: AgingInvoice[]): MetricResult {
  const coverage = computeCoverage({ period: aug, batches, bankAccounts: [], rowCounts: {}, asOf: ctx.asOf });
  return composePeriod({
    period: aug, coverage, cells: [], transferLegs: [], context: ctx,
    receivables: { invoices, batches, asOfIsPeriodEnd: true, priorDenominators: [], ledger: null },
  }).find((r) => r.key === 'receivables' && r.dimensionType === 'none')!;
}

describe('the receivables figure at 31 August', () => {
  const invoices = [
    // Raised 5 August, paid 20 September: open at 31 August.
    invoice({ id: 'i-1', issueDate: '2026-08-05', amountPaid: '1000.00', balanceDue: '0.00', paidDate: '2026-09-20', status: 'paid' }),
    // Raised 25 August, unpaid: a mid-month list could not have contained it.
    invoice({ id: 'i-2', issueDate: '2026-08-25', totalAmount: '600.00', balanceDue: '600.00' }),
  ];

  it('from a mid-month list: unavailable, stale — never a verified month-end figure', () => {
    const ar = receivablesFor([list({ committedAt: '2026-08-10T09:00:00Z' })], invoices);
    expect(ar.value).toBeNull();
    expect(ar.dataQuality.missing).toContain('stale_invoice_data');
    expect(ar.assurance).not.toBe('verified');
  });

  it('from a late list with payment dates: the month-end position, rebuilt from when each was paid', () => {
    const ar = receivablesFor([list({ committedAt: '2026-10-01T09:00:00Z' })], invoices);
    // 1,000 still open on 31 August (paid 20 September) + 600 = 1,600.
    expect([ar.value, ar.basis, ar.assurance]).toEqual(['1600.00', 'invoices', 'verified']);
  });

  it('a later payment with no payment date is counted as paid, and the figure says the date is unknown', () => {
    const noDate = [invoice({ id: 'i-3', amountPaid: '1000.00', balanceDue: '0.00', paidDate: null, status: 'paid' })];
    const ar = receivablesFor([list({ committedAt: '2026-10-01T09:00:00Z' })], noDate);
    expect(ar.dataQuality.warnings).toContain('payment_date_unknown');
  });
});
