import 'server-only';
import { Decimal } from '@/core/money';
import { assertCan } from '@/core/permissions';
import {
  addMonths, fiscalYearStart, monthEnd, monthStart, todayInTimeZone, yearMonthOf, systemClock, type IsoDate,
} from '@/core/periods';
import { loadPeriodSnapshots, loadPeriods } from '@/modules/dashboard';
import type { AccessContext } from '@/modules/tenancy';
import { corporationTaxDueDate, estimateCorporationTax, type CorporationTaxEstimate } from '../domain/corporation-tax';
import { computeVatReturn, recentVatQuarters, vatQuarterFor, type VatQuarter, type VatReturn } from '../domain/vat';
import { loadOrganisationTaxFacts, loadVatInvoices, type OrganisationTaxFacts } from '../data/repository';

/**
 * The Tax page and the custom report's tax sections (ADR-156). Everything here is read from the
 * business's own records — invoices for VAT, the engine's monthly profit and tax snapshots for
 * Corporation Tax — and computed by the pure rules in `../domain`. Nothing is stored.
 */

export interface VatView {
  readonly facts: OrganisationTaxFacts;
  /** Null until the business has said which months its VAT quarters end in (never assumed). */
  readonly quarters: readonly VatQuarter[] | null;
  readonly selected: VatQuarter | null;
  readonly vatReturn: VatReturn | null;
}

export async function loadVatView(ctx: AccessContext, quarterEnd?: string): Promise<VatView> {
  assertCan(ctx, 'financials.view');
  const orgId = ctx.orgId!;
  const facts = await loadOrganisationTaxFacts(ctx.db, orgId, ctx.requestId);
  if (facts.vatQuarterEndMonth === null) return { facts, quarters: null, selected: null, vatReturn: null };

  const today = todayInTimeZone(systemClock, facts.timezone);
  const quarters = recentVatQuarters(today, facts.vatQuarterEndMonth, 8);
  // Default: the last quarter that has ended (the one a return is due for); else the one asked for.
  const selected = quarters.find((q) => q.end === quarterEnd) ?? quarters[1] ?? quarters[0]!;
  const invoices = await loadVatInvoices(
    ctx.db, orgId, selected.start, selected.end,
    facts.vatScheme === 'cash_accounting' ? 'paid_date' : 'issue_date', ctx.requestId,
  );
  const vatReturn = computeVatReturn({
    invoices, quarter: selected, scheme: facts.vatScheme, country: facts.countryCode, registered: facts.vatRegistered,
  });
  return { facts, quarters, selected, vatReturn };
}

export interface CorporationTaxView {
  readonly facts: OrganisationTaxFacts;
  readonly year: { readonly start: IsoDate; readonly end: IsoDate; readonly label: string } | null;
  /** Months of the year with a calculated profit, and the months in the year. */
  readonly monthsCovered: number;
  readonly monthsInYear: number;
  /** The last month the figures reach, when the year is not complete. */
  readonly coveredTo: IsoDate | null;
  readonly profitBeforeTax: string | null;
  readonly bookedTax: string | null;
  readonly estimate: CorporationTaxEstimate | null;
}

export async function loadCorporationTaxView(ctx: AccessContext, yearStart?: string): Promise<CorporationTaxView> {
  assertCan(ctx, 'financials.view');
  const orgId = ctx.orgId!;
  const facts = await loadOrganisationTaxFacts(ctx.db, orgId, ctx.requestId);
  const periods = await loadPeriods(ctx.db, orgId, ctx.requestId);
  const latest = periods.find((p) => p.isComplete) ?? null;
  const empty = { facts, year: null, monthsCovered: 0, monthsInYear: 12, coveredTo: null, profitBeforeTax: null, bookedTax: null, estimate: null };
  if (latest === null && yearStart === undefined) return empty;

  // The financial year containing the latest complete month, or the one asked for.
  const anchor = yearStart ?? latest!.periodStart;
  const startYm = fiscalYearStart(yearMonthOf(anchor), facts.fiscalYearStartMonth);
  const start = monthStart(startYm);
  const end = monthEnd(addMonths(startYm, 11));
  const label = `${start} to ${end}`;

  const inYear = periods
    .filter((p) => p.periodStart >= start && p.periodEnd <= end && p.isComplete)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));

  let profit = new Decimal(0);
  let booked = new Decimal(0);
  let covered = 0;
  let coveredTo: IsoDate | null = null;
  for (const p of inYear) {
    const rows = await loadPeriodSnapshots(ctx.db, orgId, p.id, ctx.requestId);
    const value = (key: string) => rows.find((r) => r.metricKey === key && r.dimensionType === 'none')?.value ?? null;
    const net = value('net_profit');
    if (net === null) break; // a gap ends the run: a year-to-date figure has no holes in it
    const tax = value('tax_expense');
    profit = profit.plus(net).plus(tax ?? '0');
    booked = booked.plus(tax ?? '0');
    covered += 1;
    coveredTo = p.periodEnd;
  }

  if (covered === 0) return { ...empty, year: { start, end, label } };

  const estimate = estimateCorporationTax({
    country: facts.countryCode, periodStart: start, periodEnd: coveredTo!,
    profitBeforeTax: profit.toFixed(2), associatedCompanies: facts.ctAssociatedCompanies,
  });
  // The due date belongs to the accounting period, not to the months the figures reach.
  const dated = estimate.kind === 'estimate'
    ? { ...estimate, dueDate: corporationTaxDueDate(facts.countryCode, end) ?? estimate.dueDate }
    : estimate;

  return {
    facts, year: { start, end, label }, monthsCovered: covered, monthsInYear: 12,
    coveredTo: covered === 12 ? null : coveredTo,
    profitBeforeTax: profit.toFixed(2), bookedTax: booked.toFixed(2), estimate: dated,
  };
}

/**
 * The compliance dates the tax module can state, for Home's "Data & compliance" strip (ADR-172
 * follow-up; SOW "Accountant: … including compliance"). Dates only — no figure is computed, so it
 * needs no invoice or snapshot read:
 *   - VAT: the quarter now running and the last one that ended (the one a return is due for), when
 *     the business is VAT registered and has said which months its quarters end in — never assumed.
 *     APX states no VAT filing deadline, so none is given here.
 *   - Corporation Tax: the financial year holding the latest complete month, and when its tax is due
 *     under the country's rule (`corporationTaxDueDate`); null outside the UK and UAE.
 */
export interface TaxDates {
  readonly vatRegistered: boolean | null;
  readonly vatQuarter: VatQuarter | null;
  readonly lastVatQuarter: VatQuarter | null;
  readonly corporationTax: { readonly yearStart: IsoDate; readonly yearEnd: IsoDate; readonly dueDate: IsoDate } | null;
}

export async function loadTaxDates(ctx: AccessContext): Promise<TaxDates> {
  assertCan(ctx, 'financials.view');
  const orgId = ctx.orgId!;
  const [facts, periods] = await Promise.all([
    loadOrganisationTaxFacts(ctx.db, orgId, ctx.requestId),
    loadPeriods(ctx.db, orgId, ctx.requestId),
  ]);

  let vatQuarter: VatQuarter | null = null;
  let lastVatQuarter: VatQuarter | null = null;
  if (facts.vatRegistered === true && facts.vatQuarterEndMonth !== null) {
    const today = todayInTimeZone(systemClock, facts.timezone);
    const quarters = recentVatQuarters(today, facts.vatQuarterEndMonth, 2);
    vatQuarter = quarters[0] ?? null;
    lastVatQuarter = quarters[1] ?? null;
  }

  const latest = periods.find((p) => p.isComplete) ?? null;
  let corporationTax: TaxDates['corporationTax'] = null;
  if (latest !== null) {
    const startYm = fiscalYearStart(yearMonthOf(latest.periodStart), facts.fiscalYearStartMonth);
    const yearStart = monthStart(startYm);
    const yearEnd = monthEnd(addMonths(startYm, 11));
    const dueDate = corporationTaxDueDate(facts.countryCode, yearEnd);
    corporationTax = dueDate === null ? null : { yearStart, yearEnd, dueDate };
  }

  return { vatRegistered: facts.vatRegistered, vatQuarter, lastVatQuarter, corporationTax };
}

export { vatQuarterFor };
