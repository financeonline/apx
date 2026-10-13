import { Decimal } from '@/core/money';
import { addMonths, monthEnd, monthStart, yearMonth, yearMonthOf, type IsoDate } from '@/core/periods';

/**
 * The indicative VAT return (ADR-156; owner, 2026-10-07). Pure.
 *
 * Built from the business's own sales and purchase invoices — never the bank, never an estimate:
 *
 *   UK (country GB), the nine-box return:
 *     Box 1  VAT due on sales                         Σ sales tax − sales credit-note tax
 *     Box 2  VAT due on acquisitions from the EU      not recorded in MOTION → stated as not covered
 *     Box 3  Box 1 + Box 2
 *     Box 4  VAT reclaimed on purchases               Σ purchase tax − purchase credit-note tax
 *     Box 5  Box 3 − Box 4 (payable, or repayable when negative)
 *     Box 6  sales excluding VAT                      Σ net of tax, whole pounds
 *     Box 7  purchases excluding VAT                  Σ net of tax, whole pounds
 *     Box 8/9 EU supplies / acquisitions              not covered
 *
 *   UAE (country AE), the VAT201 summary: standard-rated supplies and output VAT (the emirate split of
 *   Box 1 is not recorded), standard-rated expenses and recoverable VAT, and the net VAT due.
 *
 * Which invoices: accepted, current, not void, issued in the quarter (standard scheme). Under cash
 * accounting, by the date paid instead, and in proportion to what was paid. The flat-rate scheme
 * needs a percentage MOTION does not hold, so it is reported as not calculated. An invoice whose VAT
 * is not stated (no tax amount, no subtotal to derive it from) is counted and named, never assumed.
 *
 * It is indicative — the business files its return with the tax authority; MOTION does not.
 */

export type VatScheme = 'standard' | 'cash_accounting' | 'flat_rate';
export type VatCountry = 'GB' | 'AE';

export interface VatInvoice {
  readonly id: string;
  readonly invoiceType: 'sales' | 'purchase' | 'sales_credit_note' | 'purchase_credit_note';
  readonly status: string;
  readonly issueDate: IsoDate;
  readonly paidDate: IsoDate | null;
  readonly subtotal: string | null;
  readonly taxAmount: string | null;
  readonly totalAmount: string;
  readonly amountPaid: string;
}

export interface VatQuarter {
  readonly start: IsoDate;
  readonly end: IsoDate;
  /** e.g. "Jul–Sep 2026". */
  readonly label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The VAT quarter containing `date`. `quarterEndMonth` is the month (1, 2 or 3) the first quarter
 * of the calendar year ends in — the UK stagger groups (3 = quarters ending Mar/Jun/Sep/Dec).
 */
export function vatQuarterFor(date: IsoDate, quarterEndMonth: 1 | 2 | 3): VatQuarter {
  const ym = yearMonthOf(date);
  // Months to the end of this quarter: the quarter ends in a month m with m ≡ quarterEndMonth (mod 3).
  const offset = (((quarterEndMonth - ym.month) % 3) + 3) % 3;
  const endYm = addMonths(ym, offset);
  const startYm = addMonths(endYm, -2);
  const label = startYm.year === endYm.year
    ? `${MONTHS[startYm.month - 1]}–${MONTHS[endYm.month - 1]} ${endYm.year}`
    : `${MONTHS[startYm.month - 1]} ${startYm.year}–${MONTHS[endYm.month - 1]} ${endYm.year}`;
  return { start: monthStart(startYm), end: monthEnd(endYm), label };
}

/** The `count` most recent quarters that have ENDED by `today`, newest first, plus the current one first. */
export function recentVatQuarters(today: IsoDate, quarterEndMonth: 1 | 2 | 3, count: number): VatQuarter[] {
  const out: VatQuarter[] = [];
  let q = vatQuarterFor(today, quarterEndMonth);
  for (let i = 0; i < count; i++) {
    out.push(q);
    const prior = yearMonthOf(q.start);
    q = vatQuarterFor(monthStart(addMonths(prior, -1)), quarterEndMonth);
  }
  return out;
}

/** The quarter a date in "YYYY-MM-DD" belongs to, from a quarter-end ISO date chosen in the UI. */
export function vatQuarterEnding(endDate: IsoDate, quarterEndMonth: 1 | 2 | 3): VatQuarter {
  return vatQuarterFor(endDate, quarterEndMonth);
}

const sign = (t: VatInvoice['invoiceType']): 1 | -1 => (t === 'sales_credit_note' || t === 'purchase_credit_note' ? -1 : 1);
const isSales = (t: VatInvoice['invoiceType']) => t === 'sales' || t === 'sales_credit_note';

/** The invoice's VAT and net, or null VAT when the row does not state it. */
function vatOf(inv: VatInvoice): { vat: Decimal | null; net: Decimal } {
  const total = new Decimal(inv.totalAmount);
  const subtotal = inv.subtotal === null ? null : new Decimal(inv.subtotal);
  const tax = inv.taxAmount === null ? null : new Decimal(inv.taxAmount);
  // A subtotal of 0 against a positive total is an exporter's placeholder, not a zero-value invoice.
  const usableSubtotal = subtotal !== null && !(subtotal.isZero() && total.greaterThan(0)) ? subtotal : null;
  if (tax !== null) return { vat: tax, net: usableSubtotal ?? total.minus(tax) };
  if (usableSubtotal !== null) return { vat: total.minus(usableSubtotal), net: usableSubtotal };
  return { vat: null, net: total };
}

export interface VatBox {
  readonly box: string;
  readonly label: string;
  /** Exact decimal string; null when MOTION does not record what the box needs. */
  readonly value: string | null;
  readonly note?: string;
}

export type VatReturn =
  | {
      readonly kind: 'return';
      readonly country: VatCountry;
      readonly scheme: Exclude<VatScheme, 'flat_rate'>;
      readonly quarter: VatQuarter;
      readonly boxes: readonly VatBox[];
      /** Positive: owed to the tax authority; negative: due back. */
      readonly netVat: string;
      readonly invoicesCounted: number;
      /** Invoices in the quarter whose VAT is not stated — named so they can be fixed. */
      readonly vatNotStated: readonly string[];
      readonly salesInvoices: number;
      readonly purchaseInvoices: number;
    }
  | { readonly kind: 'not_calculated'; readonly reason: 'flat_rate' | 'country' | 'not_registered'; readonly quarter: VatQuarter };

const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const wholePounds = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0);

export function computeVatReturn(input: {
  readonly invoices: readonly VatInvoice[];
  readonly quarter: VatQuarter;
  readonly scheme: VatScheme;
  readonly country: string | null;
  readonly registered: boolean | null;
}): VatReturn {
  const { quarter } = input;
  if (input.registered === false) return { kind: 'not_calculated', reason: 'not_registered', quarter };
  if (input.country !== 'GB' && input.country !== 'AE') return { kind: 'not_calculated', reason: 'country', quarter };
  if (input.scheme === 'flat_rate') return { kind: 'not_calculated', reason: 'flat_rate', quarter };
  const scheme = input.scheme;

  let outputVat = new Decimal(0);
  let inputVat = new Decimal(0);
  let salesNet = new Decimal(0);
  let purchasesNet = new Decimal(0);
  let counted = 0;
  let sales = 0;
  let purchases = 0;
  const notStated: string[] = [];

  for (const inv of input.invoices) {
    if (inv.status === 'void') continue;
    // Which quarter the invoice falls in, and how much of it: all of it on issue (standard), the
    // paid share when paid (cash accounting).
    let share = new Decimal(1);
    if (scheme === 'standard') {
      if (inv.issueDate < quarter.start || inv.issueDate > quarter.end) continue;
    } else {
      if (inv.paidDate === null || inv.paidDate < quarter.start || inv.paidDate > quarter.end) continue;
      const total = new Decimal(inv.totalAmount);
      if (total.isZero()) continue;
      share = Decimal.min(new Decimal(inv.amountPaid).dividedBy(total), new Decimal(1));
    }
    const { vat, net } = vatOf(inv);
    counted += 1;
    const s = sign(inv.invoiceType);
    if (isSales(inv.invoiceType)) {
      sales += 1;
      salesNet = salesNet.plus(net.times(share).times(s));
      if (vat === null) notStated.push(inv.id); else outputVat = outputVat.plus(vat.times(share).times(s));
    } else {
      purchases += 1;
      purchasesNet = purchasesNet.plus(net.times(share).times(s));
      if (vat === null) notStated.push(inv.id); else inputVat = inputVat.plus(vat.times(share).times(s));
    }
  }

  const net = outputVat.minus(inputVat);
  const notCovered = 'Not recorded in APX — add it yourself if it applies.';
  const boxes: VatBox[] = input.country === 'GB'
    ? [
        { box: '1', label: 'VAT due on sales and other outputs', value: money(outputVat) },
        { box: '2', label: 'VAT due on acquisitions from the EU (Northern Ireland goods)', value: null, note: notCovered },
        { box: '3', label: 'Total VAT due (Box 1 + Box 2)', value: money(outputVat) },
        { box: '4', label: 'VAT reclaimed on purchases and other inputs', value: money(inputVat) },
        { box: '5', label: net.isNegative() ? 'Net VAT to be reclaimed' : 'Net VAT to pay', value: money(net.abs()) },
        { box: '6', label: 'Total sales excluding VAT (whole pounds)', value: wholePounds(salesNet) },
        { box: '7', label: 'Total purchases excluding VAT (whole pounds)', value: wholePounds(purchasesNet) },
        { box: '8', label: 'Supplies of goods to the EU excluding VAT', value: null, note: notCovered },
        { box: '9', label: 'Acquisitions of goods from the EU excluding VAT', value: null, note: notCovered },
      ]
    : [
        { box: '1', label: 'Standard-rated supplies (all emirates)', value: money(salesNet), note: 'The split by emirate is not recorded in APX.' },
        { box: '1', label: 'VAT on standard-rated supplies (output VAT)', value: money(outputVat) },
        { box: '9', label: 'Standard-rated expenses', value: money(purchasesNet) },
        { box: '9', label: 'Recoverable VAT on expenses (input VAT)', value: money(inputVat) },
        { box: '12', label: 'Total value of due tax for the period', value: money(outputVat) },
        { box: '13', label: 'Total value of recoverable tax for the period', value: money(inputVat) },
        { box: '14', label: net.isNegative() ? 'Net VAT recoverable for the period' : 'Payable tax for the period', value: money(net.abs()) },
      ];

  return {
    kind: 'return', country: input.country, scheme, quarter, boxes, netVat: money(net),
    invoicesCounted: counted, vatNotStated: notStated, salesInvoices: sales, purchaseInvoices: purchases,
  };
}

/** For the settings form and tests: the first quarter end of `year` in a stagger group. */
export function firstQuarterEnd(year: number, quarterEndMonth: 1 | 2 | 3): IsoDate {
  return monthEnd(yearMonth(year, quarterEndMonth));
}
