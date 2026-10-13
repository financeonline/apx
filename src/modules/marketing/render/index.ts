/**
 * The Marketing report's presentation and its two files (ADR-170): what the page, the Word file and
 * the PDF draw, so they say the same thing in the same order. Re-exported by the module's barrel.
 */
export {
  NOT_AVAILABLE, formatReportDate, formatReportDateTime, formatReportMoney, formatReportPercent, formatShare,
  marketingFilename, shareWidth, withoutLead,
} from './format';
export {
  MARKETING_AUTHORSHIP, MARKETING_AUTHORSHIP_OFFLINE, MARKETING_NOTICES, authorshipFor, presentMarketingReport,
  type MarketingPresentation, type NoticeTone, type PresentedConcept, type PresentedCover, type PresentedSection,
  type PresentedShare, type PresentedSubsection, type ReportBlock, type ReportCell, type ReportTable,
} from './present';
export { summariseMarketing, type MarketingSummary, type MarketingTone } from './summary';
export { renderMarketingDocx } from './docx';
export { renderMarketingPdf } from './pdf';
