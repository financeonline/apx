/**
 * Tax (ADR-156): the indicative VAT return and Corporation Tax estimate, from the business's own
 * invoices and calculated profit, under the rules of its country (UK or UAE).
 */
export {
  computeVatReturn, recentVatQuarters, vatQuarterFor, firstQuarterEnd,
  type VatBox, type VatCountry, type VatInvoice, type VatQuarter, type VatReturn, type VatScheme,
} from './domain/vat';
export {
  addMonthsToDate, daysInclusive, estimateCorporationTax, type CorporationTaxEstimate, type CtCountry,
} from './domain/corporation-tax';
export { loadCorporationTaxView, loadVatView, type CorporationTaxView, type VatView } from './services';
export type { OrganisationTaxFacts } from './data/repository';
