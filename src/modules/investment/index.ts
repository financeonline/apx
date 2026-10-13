/**
 * `modules/investment` — the Investment department (ADR-171): the Investment Pack, shaped on the
 * client's own example ("Investment Strategy & Financial Growth Plan"). Every number is APX's own
 * arithmetic on the company's figures (the base year, the surplus split, growth and return scenarios,
 * the portfolio's amounts); ChatGPT writes only the words and chooses the options and the portfolio's
 * shares. The pack is written by the `investment.generate` job, stored, and shown until somebody
 * refreshes it; it downloads as Word and PDF. Built on Marketing's pattern (ADR-170), whose company
 * profile it reads.
 *
 * Server-side, like every module barrel: the services and renderers import `server-only`. A client
 * component takes its types with `import type` and its data as props.
 */

export {
  INVESTMENT_DISCLAIMER, INVESTMENT_REPORT_VERSION,
  type Amount, type CommitteePriority, type GrowthScenario, type InvestmentAssumptions, type InvestmentBase,
  type InvestmentFigures, type InvestmentLever, type InvestmentNarrative, type InvestmentOption, type InvestmentReport,
  type InvestmentReportStatus, type InvestmentView, type PortfolioShare, type ProcessStage, type ProjectionYear,
  type ReinvestComparison, type ReturnScenario, type RiskLevel, type SurplusSource,
} from './domain/types';
export { assembleInvestmentReport, buildInvestmentSources, type AssembleInvestmentInput } from './domain/assemble';
export { SURPLUS_MAX, SURPLUS_MIN, parseSurplusInput, type SurplusParse } from './domain/surplus';

// APX's arithmetic: the base year, the default surplus, the figures and the portfolio's amounts.
export { allocatePortfolio, buildInvestmentFigures, defaultSurplus } from './domain/figures';
export { loadInvestmentBase } from './services/figures';

// Reading, for the page and the downloads.
export { getInvestmentView, getLatestInvestmentReport, investmentEnabled } from './services/read';
// Asking for the pack.
export { requestInvestmentReport, type InvestmentRequest } from './services/request';
// The `investment.generate` job, and the writer of its words.
export {
  runInvestmentReport, noProfitFailure, INVESTMENT_FAILURES, INVESTMENT_TIMEOUT_MS,
  type InvestmentReportDeps, type InvestmentRunOutcome,
} from './services/generate-report';
export { generateInvestmentNarrative } from './services/generate-narrative';

// The Word file and the PDF.
export * from './render';
