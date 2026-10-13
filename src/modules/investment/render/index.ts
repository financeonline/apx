/**
 * The Investment Pack's presentation and its two files (ADR-171): what the page, the Word file and
 * the PDF draw, so they say the same thing in the same order — Marketing's pattern (ADR-170).
 * Re-exported by the module's barrel.
 */
export {
  RISK_LEVELS, approximateMoney, investmentFilename, moneyAxis, percentText, rangeText, riskIndex, riskLabel,
  type AxisTick,
} from './format';
export {
  INVESTMENT_AUTHORSHIP, INVESTMENT_AUTHORSHIP_OFFLINE, INVESTMENT_NOTICES, investmentAuthorshipFor,
  presentInvestmentReport, presentInvestmentStart,
  type ChartSeries, type InvestmentPresentation, type InvestmentStart, type LineChart, type PackBlock, type PackCell,
  type PackTable, type PresentedChart, type PresentedHeadline, type PresentedLink, type PresentedOption,
  type PresentedPackCover, type PresentedPackSection, type PresentedPackSubsection, type PresentedPriority,
  type RiskChart, type RiskPoint, type SplitChart, type SplitSlice,
} from './present';
export { summariseInvestment, type InvestmentSummary, type InvestmentTone } from './summary';
export { renderInvestmentDocx } from './docx';
export { renderInvestmentPdf } from './pdf';
