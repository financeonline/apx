import { describe, expect, it } from 'vitest';
import {
  CT_NOT_ESTIMATED_TEXT, CUSTOM_DIMENSIONS, FIXED_AREAS, NOT_CALCULATED_REASON, VAT_NOT_CALCULATED_TEXT,
  VAT_QUARTERS_NOT_SET_TEXT, buildCorporationTaxSection, buildSnapshotSection, buildVatSection,
  customQuestionMessage, isCustomDimension, isFixedArea, renderCustomPdf, unavailableSection,
  type CustomReportContent, type SectionFigure,
} from '@/modules/reporting';
import { missingReasonText } from '@/modules/dashboard';
import { computeVatReturn, vatQuarterFor, type CorporationTaxView } from '@/modules/tax';

/** ADR-156: the Custom report's fixed sections — MOTION's own figures, never the AI's. */

const figures = (entries: Record<string, string | null>, missing: readonly string[] = []) =>
  new Map<string, SectionFigure>(Object.entries(entries).map(([k, v]) => [k, { value: v, missing: v === null ? missing : [] }]));

describe('the new areas', () => {
  it('are custom dimensions and fixed areas', () => {
    for (const area of FIXED_AREAS) {
      expect(isCustomDimension(area)).toBe(true);
      expect(isFixedArea(area)).toBe(true);
    }
    expect(CUSTOM_DIMENSIONS.vat).toBe('VAT');
    expect(CUSTOM_DIMENSIONS.corporation_tax).toBe('Corporation Tax');
    expect(isFixedArea('cash')).toBe(false);
  });

  it('keep an abbreviation in capitals in the question', () => {
    expect(customQuestionMessage('August 2026', ['vat', 'corporation_tax', 'cash'], 'What is owed?'))
      .toBe('For August 2026, looking at VAT, corporation tax, cash: What is owed?');
  });
});

describe('Loans and Assets from the month-end snapshots', () => {
  it('formats each figure in the organisation currency', () => {
    const section = buildSnapshotSection({
      area: 'loans', currency: 'GBP', periodLabel: 'August 2026', missingReason: missingReasonText,
      figures: figures({
        loan_balance: '12000.00', long_term_borrowing: '30000.5', debt_balance: '42000.50',
        loans_secured: '30000.50', loans_unsecured: '12000.00', loans_unmarked: '0.00',
      }),
    });
    expect(section.title).toBe('Loans');
    expect(section.subtitle).toBe('At the end of August 2026');
    expect(section.rows.map((r) => r.label)).toEqual([
      'Loans', 'Long-term borrowing', 'Borrowing owed', 'Secured', 'Unsecured', 'Not yet marked',
    ]);
    expect(section.rows[0]).toEqual({ label: 'Loans', value: '£12,000.00', reason: null });
    expect(section.rows[5]!.value).toBe('£0.00');
    expect(section.notes.some((n) => n.includes('not marked'))).toBe(false);
  });

  it('shows NULL as not available with the reason, never as zero', () => {
    const section = buildSnapshotSection({
      area: 'assets', currency: 'GBP', periodLabel: 'August 2026', missingReason: missingReasonText,
      figures: figures({ fixed_assets: null, other_long_term_assets: null, current_assets: null }, ['no_balance_sheet']),
    });
    expect(section.rows.map((r) => r.label)).toEqual(['Fixed assets', 'Other long-term assets', 'Current assets', 'Total assets']);
    expect(section.rows[0]!.value).toBeNull();
    expect(section.rows[0]!.reason).toBe(missingReasonText(['no_balance_sheet']));
    expect(section.rows[0]!.reason).toMatch(/No trial balance or balance sheet/);
    // Absent altogether: the month was calculated before the figure existed.
    expect(section.rows[3]).toEqual({ label: 'Total assets', value: null, reason: NOT_CALCULATED_REASON });
  });

  it('says when some borrowing is not yet marked', () => {
    const section = buildSnapshotSection({
      area: 'loans', currency: 'GBP', periodLabel: 'August 2026', missingReason: missingReasonText,
      figures: figures({ loans_unmarked: '500.00' }),
    });
    expect(section.notes.some((n) => n.includes('not marked secured or unsecured'))).toBe(true);
  });
});

describe('VAT', () => {
  const quarter = vatQuarterFor('2026-08-31', 3);

  it('asks for the VAT quarters when they are not set', () => {
    const section = buildVatSection({ quartersSet: false, quarter: null, vatReturn: null, periodLabel: 'August 2026', currency: 'GBP' });
    expect(section.rows).toEqual([]);
    expect(section.notes).toEqual([VAT_QUARTERS_NOT_SET_TEXT]);
    expect(section.indicative).toBe(true);
  });

  it('lists the UK boxes, the EU boxes as not available, and the net line', () => {
    const vatReturn = computeVatReturn({
      quarter, scheme: 'standard', country: 'GB', registered: true,
      invoices: [
        { id: 's1', invoiceType: 'sales', status: 'paid', issueDate: '2026-08-10', paidDate: null, subtotal: '1000.00', taxAmount: '200.00', totalAmount: '1200.00', amountPaid: '0' },
        { id: 'p1', invoiceType: 'purchase', status: 'paid', issueDate: '2026-07-10', paidDate: null, subtotal: '500.00', taxAmount: '100.00', totalAmount: '600.00', amountPaid: '0' },
        { id: 'p2', invoiceType: 'purchase', status: 'paid', issueDate: '2026-07-11', paidDate: null, subtotal: null, taxAmount: null, totalAmount: '50.00', amountPaid: '0' },
      ],
    });
    const section = buildVatSection({ quartersSet: true, quarter, vatReturn, periodLabel: 'August 2026', currency: 'GBP' });
    expect(section.subtitle).toBe('Quarter Jul–Sep 2026');
    expect(section.rows[0]).toEqual({ label: 'VAT due on sales and other outputs', box: '1', value: '£200.00', reason: null });
    const box2 = section.rows.find((r) => r.box === '2')!;
    expect(box2.value).toBeNull();
    expect(box2.reason).toMatch(/Not recorded in MOTION/);
    expect(section.rows.find((r) => r.box === '6')!.value).toBe('£1,000');
    const net = section.rows[section.rows.length - 1]!;
    expect(net).toEqual({ label: 'Net VAT to pay', value: '£100.00', reason: null });
    expect(section.notes.some((n) => n.startsWith('1 invoice does not state its VAT'))).toBe(true);
  });

  it('calls a repayment due back', () => {
    const vatReturn = computeVatReturn({
      quarter, scheme: 'standard', country: 'GB', registered: true,
      invoices: [{ id: 'p1', invoiceType: 'purchase', status: 'paid', issueDate: '2026-07-10', paidDate: null, subtotal: '500.00', taxAmount: '100.00', totalAmount: '600.00', amountPaid: '0' }],
    });
    const section = buildVatSection({ quartersSet: true, quarter, vatReturn, periodLabel: 'August 2026', currency: 'GBP' });
    expect(section.rows[section.rows.length - 1]).toEqual({ label: 'Net VAT due back to you', value: '£100.00', reason: null });
  });

  it.each(['flat_rate', 'country', 'not_registered'] as const)('explains a return not calculated (%s)', (reason) => {
    const section = buildVatSection({
      quartersSet: true, quarter, vatReturn: { kind: 'not_calculated', reason, quarter }, periodLabel: 'August 2026', currency: 'GBP',
    });
    expect(section.rows).toEqual([]);
    expect(section.notes).toEqual([VAT_NOT_CALCULATED_TEXT[reason]]);
  });

  it('never shows another quarter\'s return as this one', () => {
    const other = vatQuarterFor('2026-05-31', 3);
    const section = buildVatSection({
      quartersSet: true, quarter, vatReturn: { kind: 'not_calculated', reason: 'flat_rate', quarter: other }, periodLabel: 'August 2026', currency: 'GBP',
    });
    expect(section.rows).toEqual([]);
    expect(section.notes[0]).toMatch(/too far back/);
  });
});

describe('Corporation Tax', () => {
  const view = (over: Partial<CorporationTaxView> = {}): Pick<CorporationTaxView,
    'year' | 'monthsCovered' | 'monthsInYear' | 'coveredTo' | 'profitBeforeTax' | 'bookedTax' | 'estimate'> => ({
    year: { start: '2026-04-01', end: '2027-03-31', label: '2026-04-01 to 2027-03-31' },
    monthsCovered: 5, monthsInYear: 12, coveredTo: '2026-08-31',
    profitBeforeTax: '40000.00', bookedTax: '1000.00',
    estimate: {
      kind: 'estimate', country: 'GB', profitBeforeTax: '40000.00', estimatedTax: '7600.00', band: 'Small profits rate (19%)',
      effectiveRate: '0.19', thresholds: { lower: '20890.41', upper: '104452.05' }, marginalRelief: null, dueDate: '2028-01-01', days: 153,
    },
    ...over,
  });

  it('lists period, months, profit, booked tax, estimate, band and due date', () => {
    const section = buildCorporationTaxSection({ view: view(), currency: 'GBP' });
    expect(section.indicative).toBe(true);
    expect(section.rows.map((r) => [r.label, r.value])).toEqual([
      ['Period', '1 April 2026 to 31 March 2027'],
      ['Months covered', '5 of 12'],
      ['Profit before tax', '£40,000.00'],
      ['Tax already booked', '£1,000.00'],
      ['Estimated tax', '£7,600.00'],
      ['Band', 'Small profits rate (19%)'],
      ['Due date', '1 January 2028'],
    ]);
    expect(section.notes[0]).toMatch(/reach 31 August 2026/);
  });

  it.each(['country', 'period_before_rules'] as const)('says why no estimate is made (%s)', (reason) => {
    const section = buildCorporationTaxSection({ view: view({ estimate: { kind: 'not_estimated', reason } }), currency: 'GBP' });
    const estimated = section.rows.find((r) => r.label === 'Estimated tax')!;
    expect(estimated.value).toBeNull();
    expect(estimated.reason).toBe(CT_NOT_ESTIMATED_TEXT[reason]);
    expect(section.rows.find((r) => r.label === 'Profit before tax')!.value).toBe('£40,000.00');
  });

  it('shows no profit as not available, not as zero', () => {
    const section = buildCorporationTaxSection({
      view: view({ monthsCovered: 0, coveredTo: null, profitBeforeTax: null, bookedTax: null, estimate: null }), currency: 'GBP',
    });
    for (const label of ['Profit before tax', 'Tax already booked', 'Estimated tax', 'Band', 'Due date']) {
      const row = section.rows.find((r) => r.label === label)!;
      expect(row.value).toBeNull();
      expect(row.reason).toMatch(/No month of this financial year/);
    }
  });

  it('has nothing to estimate before the first complete month', () => {
    const section = buildCorporationTaxSection({ view: view({ year: null }), currency: 'GBP' });
    expect(section.rows).toEqual([]);
    expect(section.notes).toHaveLength(1);
  });
});

describe('a report of fixed sections only', () => {
  it('renders as a PDF without any AI answer, and an old report without sections still renders', async () => {
    const base: CustomReportContent = {
      version: 'custom.v1', organisationName: 'Acme',
      period: { id: 'p', label: 'August 2026', start: '2026-08-01', end: '2026-08-31' },
      dimensions: ['loans', 'vat'], conversationId: null, entries: [], composedAt: '2026-09-02T10:00:00.000Z',
    };
    const sections = [
      buildSnapshotSection({ area: 'loans', currency: 'GBP', periodLabel: 'August 2026', missingReason: missingReasonText, figures: figures({}) }),
      unavailableSection('vat', VAT_QUARTERS_NOT_SET_TEXT),
    ];
    const withSections = await renderCustomPdf({ ...base, sections });
    const without = await renderCustomPdf(base);
    for (const bytes of [withSections, without]) {
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    }
  });
});
