import { Decimal, formatMoney } from '@/core/money';
import type { CorporationTaxView, VatQuarter, VatReturn } from '@/modules/tax';
import type { CustomDimension } from './custom';

/**
 * The Custom Report's fixed sections (ADR-156; owner, 2026-10-07). Pure.
 *
 * For each of these areas a person chooses, the report carries a table MOTION computed itself —
 * not the AI — so the section is there, and says the same thing, whether or not the analyst is
 * available. Every figure is one MOTION already holds: the engine's month-end snapshots for loans
 * and assets, and the Tax module's indicative VAT return and Corporation Tax estimate.
 *
 * A figure that is not known is shown as "Not available" with the plain reason, never as 0.
 * The rows are stored formatted, as the report said them that day.
 */

export const FIXED_AREAS = ['loans', 'assets', 'vat', 'corporation_tax'] as const satisfies readonly CustomDimension[];
export type FixedArea = (typeof FIXED_AREAS)[number];

export function isFixedArea(value: string): value is FixedArea {
  return (FIXED_AREAS as readonly string[]).includes(value);
}

export interface CustomSectionRow {
  readonly label: string;
  /** The box number, for a row of a VAT return. */
  readonly box?: string;
  /** Formatted for display; NULL when the figure is not available. */
  readonly value: string | null;
  /** Why the figure is not available, in plain words. NULL when there is a value. */
  readonly reason: string | null;
}

export interface CustomSection {
  readonly area: FixedArea;
  readonly title: string;
  /** What the figures are as at, or for, e.g. "At the end of August 2026". */
  readonly subtitle: string | null;
  /** The tax sections are indicative, and say so. */
  readonly indicative: boolean;
  readonly rows: readonly CustomSectionRow[];
  readonly notes: readonly string[];
}

export const NOT_AVAILABLE_TEXT = 'Not available';
export const INDICATIVE_TEXT = 'Indicative — check before filing';

export const SECTION_TITLES: Readonly<Record<FixedArea, string>> = {
  loans: 'Loans',
  assets: 'Assets',
  vat: 'VAT',
  corporation_tax: 'Corporation Tax',
};

/** The month-end snapshot figures each balance section shows, in order. */
export const SNAPSHOT_ROWS = {
  loans: [
    ['loan_balance', 'Loans'],
    ['long_term_borrowing', 'Long-term borrowing'],
    ['debt_balance', 'Borrowing owed'],
    ['loans_secured', 'Secured'],
    ['loans_unsecured', 'Unsecured'],
    ['loans_unmarked', 'Not yet marked'],
  ],
  assets: [
    ['fixed_assets', 'Fixed assets'],
    ['other_long_term_assets', 'Other long-term assets'],
    ['current_assets', 'Current assets'],
    ['total_assets', 'Total assets'],
  ],
} as const satisfies Record<'loans' | 'assets', ReadonlyArray<readonly [string, string]>>;

/** A figure the month was calculated without — computed by an engine before this figure existed. */
export const NOT_CALCULATED_REASON =
  'This month was calculated before APX worked this figure out. It appears when the month is next recalculated.';

export const NO_PERMISSION_REASON = 'Your role cannot see the tax figures, so this section is left out.';

export const VAT_NOT_CALCULATED_TEXT: Readonly<Record<'flat_rate' | 'country' | 'not_registered', string>> = {
  flat_rate: 'You use the Flat Rate Scheme, which needs your flat-rate percentage. APX does not hold it, so the return is not calculated.',
  country: 'APX prepares the VAT return for businesses in the UK and the UAE only. Set your country in Settings if it is one of these.',
  not_registered: 'Your business is recorded as not registered for VAT, so there is no VAT return.',
};

export const CT_NOT_ESTIMATED_TEXT: Readonly<Record<'country' | 'period_before_rules', string>> = {
  country: 'APX estimates Corporation Tax for businesses in the UK and the UAE only. Set your country in Settings if it is one of these.',
  period_before_rules: 'This financial year began before the current rules (UK: 1 April 2023; UAE: 1 June 2023), so no estimate is made.',
};

export const VAT_QUARTERS_NOT_SET_TEXT = 'Set your VAT quarters in Settings to include the VAT return.';

/** One snapshot as the sections need it: the value and, when it is NULL, the engine's reasons. */
export interface SectionFigure {
  readonly value: string | null;
  readonly missing: readonly string[];
}

const money = (value: string, currency: string) => formatMoney(value, { currency, showMinorUnits: true });
const wholeMoney = (value: string, currency: string) => formatMoney(value, { currency, showMinorUnits: false });
const isZero = (value: string) => new Decimal(value).isZero();

/** "30 September 2027" (en-GB, as the product writes dates). */
export function sectionDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
}

const notAvailable = (label: string, reason: string, box?: string): CustomSectionRow =>
  ({ label, ...(box === undefined ? {} : { box }), value: null, reason });

/** Loans or Assets: the engine's month-end figures, exactly as the Balance sheet page shows them. */
export function buildSnapshotSection(input: {
  readonly area: 'loans' | 'assets';
  /** Keyed by metric key (the undimensioned row). A key that is absent was not calculated. */
  readonly figures: ReadonlyMap<string, SectionFigure>;
  readonly currency: string;
  readonly periodLabel: string;
  readonly missingReason: (missing: readonly string[]) => string;
}): CustomSection {
  const rows = SNAPSHOT_ROWS[input.area].map(([key, label]): CustomSectionRow => {
    const figure = input.figures.get(key);
    if (figure === undefined) return notAvailable(label, NOT_CALCULATED_REASON);
    if (figure.value === null) return notAvailable(label, input.missingReason(figure.missing));
    return { label, value: money(figure.value, input.currency), reason: null };
  });

  const notes: string[] = ['From your trial balance or balance sheet for the month, as you categorised each account.'];
  if (input.area === 'loans') {
    notes.push('Secured, unsecured and not yet marked add up to the borrowing owed.');
    const unmarked = input.figures.get('loans_unmarked')?.value ?? null;
    if (unmarked !== null && !isZero(unmarked)) {
      notes.push('Some loans are not marked secured or unsecured yet. Mark each loan account on Accounts and the split updates.');
    }
  } else {
    notes.push('Current assets are cash, what customers owe, stock and other short-term assets.');
  }

  return {
    area: input.area, title: SECTION_TITLES[input.area], subtitle: `At the end of ${input.periodLabel}`,
    indicative: false, rows, notes,
  };
}

/** A section that could not be built at all, with the reason as its only note. */
export function unavailableSection(area: FixedArea, reason: string): CustomSection {
  return {
    area, title: SECTION_TITLES[area], subtitle: null,
    indicative: area === 'vat' || area === 'corporation_tax', rows: [], notes: [reason],
  };
}

/** The indicative VAT return for the quarter containing the report's month. */
export function buildVatSection(input: {
  /** False when the business has not said which months its VAT quarters end in. */
  readonly quartersSet: boolean;
  /** The quarter containing the report's month (NULL when the quarters are not set). */
  readonly quarter: VatQuarter | null;
  readonly vatReturn: VatReturn | null;
  readonly periodLabel: string;
  readonly currency: string;
}): CustomSection {
  if (!input.quartersSet || input.quarter === null) return unavailableSection('vat', VAT_QUARTERS_NOT_SET_TEXT);
  const quarter = input.quarter;
  const base = { area: 'vat' as const, title: SECTION_TITLES.vat, subtitle: `Quarter ${quarter.label}`, indicative: true };

  const ret = input.vatReturn;
  if (ret === null || ret.quarter.end !== quarter.end) {
    return { ...base, rows: [], notes: ['That quarter is too far back for APX to prepare its VAT return here.'] };
  }
  if (ret.kind === 'not_calculated') return { ...base, rows: [], notes: [VAT_NOT_CALCULATED_TEXT[ret.reason]] };

  const notes: string[] = [];
  const rows: CustomSectionRow[] = ret.boxes.map((box) => {
    if (box.value === null) return notAvailable(box.label, box.note ?? 'Not recorded in APX.', box.box);
    if (box.note !== undefined) notes.push(`Box ${box.box}: ${box.note}`);
    const shown = box.value.includes('.') ? money(box.value, input.currency) : wholeMoney(box.value, input.currency);
    return { label: box.label, box: box.box, value: shown, reason: null };
  });
  const net = new Decimal(ret.netVat);
  rows.push({
    label: net.isNegative() ? 'Net VAT due back to you' : 'Net VAT to pay',
    value: money(net.abs().toFixed(2), input.currency),
    reason: null,
  });

  notes.push(
    `The whole quarter containing ${input.periodLabel}, from the invoices imported so far `
    + `(${ret.scheme === 'cash_accounting' ? 'cash accounting: by the date each invoice was paid' : 'by invoice date'}).`,
  );
  notes.push(`${ret.invoicesCounted} invoice${ret.invoicesCounted === 1 ? '' : 's'} counted: ${ret.salesInvoices} sales, ${ret.purchaseInvoices} purchases.`);
  if (ret.vatNotStated.length > 0) {
    const n = ret.vatNotStated.length;
    notes.push(`${n} invoice${n === 1 ? ' does' : 's do'} not state ${n === 1 ? 'its' : 'their'} VAT, so ${n === 1 ? 'its' : 'their'} VAT is not counted. Correct ${n === 1 ? 'it' : 'them'} to complete the return.`);
  }
  notes.push('APX does not file your return; you file it with the tax authority.');
  return { ...base, rows, notes };
}

/** The indicative Corporation Tax estimate for the financial year containing the report's month. */
export function buildCorporationTaxSection(input: {
  readonly view: Pick<CorporationTaxView,
    'year' | 'monthsCovered' | 'monthsInYear' | 'coveredTo' | 'profitBeforeTax' | 'bookedTax' | 'estimate'>;
  readonly currency: string;
}): CustomSection {
  const { view, currency } = input;
  if (view.year === null) {
    return unavailableSection('corporation_tax', 'There is no complete month with figures yet, so there is nothing to estimate.');
  }
  const subtitle = `Financial year ${sectionDate(view.year.start)} to ${sectionDate(view.year.end)}`;
  const base = { area: 'corporation_tax' as const, title: SECTION_TITLES.corporation_tax, subtitle, indicative: true };
  const noProfit = 'No month of this financial year has a calculated profit yet.';

  const estimate = view.estimate;
  const notEstimated = estimate !== null && estimate.kind === 'not_estimated' ? CT_NOT_ESTIMATED_TEXT[estimate.reason] : null;
  const estimateReason = notEstimated ?? noProfit;
  const estimated = estimate !== null && estimate.kind === 'estimate' ? estimate : null;

  const rows: CustomSectionRow[] = [
    { label: 'Period', value: `${sectionDate(view.year.start)} to ${sectionDate(view.year.end)}`, reason: null },
    { label: 'Months covered', value: `${view.monthsCovered} of ${view.monthsInYear}`, reason: null },
    view.profitBeforeTax === null
      ? notAvailable('Profit before tax', noProfit)
      : { label: 'Profit before tax', value: money(view.profitBeforeTax, currency), reason: null },
    view.bookedTax === null
      ? notAvailable('Tax already booked', noProfit)
      : { label: 'Tax already booked', value: money(view.bookedTax, currency), reason: null },
    estimated === null
      ? notAvailable('Estimated tax', estimateReason)
      : { label: 'Estimated tax', value: money(estimated.estimatedTax, currency), reason: null },
    estimated === null
      ? notAvailable('Band', estimateReason)
      : { label: 'Band', value: estimated.band, reason: null },
    estimated === null
      ? notAvailable('Due date', estimateReason)
      : { label: 'Due date', value: sectionDate(estimated.dueDate), reason: null },
  ];

  const notes: string[] = [];
  if (view.coveredTo !== null) {
    notes.push(`The figures reach ${sectionDate(view.coveredTo)}; the estimate is for those months only, and the full year's tax will differ.`);
  }
  notes.push(
    'Estimated on the profit APX calculated before tax. Taxable profit can differ — capital allowances instead of '
    + 'depreciation, expenses that are not allowed, losses brought forward — so this is not a tax computation.',
  );
  if (estimated?.country === 'AE') {
    notes.push('Small Business Relief is an election you make, so it is not applied here.');
  }
  return { ...base, rows, notes };
}
