/**
 * `modules/marketing` — the Marketing department (ADR-170): the company profile and the marketing
 * strategy report, shaped on the client's own example document. Sections 01–02 and the Section 03
 * commentary are written by the AI from the profile and the figures; Section 03's tables are the
 * product's own figures. The report is written by the `marketing.generate` job, stored, and shown
 * until somebody refreshes it; it downloads as Word and PDF.
 *
 * Server-side, like every module barrel: the services and renderers import `server-only`. A client
 * component takes its types with `import type` and its data as props.
 */

export {
  MARKETING_REPORT_VERSION, profileIsReady,
  type BudgetLine, type CampaignConcept, type CompanyProfile, type Competitor, type CompetitorSection, type CostLine,
  type CustomerSector, type FinancialCommentary, type FinancialYear, type MarketingFinancials, type MarketingNarrative,
  type MarketingReport, type MarketingReportStatus, type MarketingView, type PlanPeriod, type Priority, type ProductCampaign,
  type ProductSales, type SectorShare, type SocialLink, type StrategySection,
} from './domain/types';
export {
  EMPTY_PROFILE, PROFILE_LIMITS, labelForUrl, normaliseUrl, parseCompanyProfile,
  type CompanyProfileForm, type ProfileIssue, type ProfileParse,
} from './domain/profile';
export { assembleMarketingReport, buildSources, reportDateLabel, type AssembleInput } from './domain/assemble';

// Reading, for the page and the downloads.
export { getCompanyProfile, getLatestMarketingReport, getMarketingView, marketingEnabled } from './services/read';
// Writing: the profile form, and asking for the report.
export { setCompanyProfile } from './services/profile';
export { requestMarketingReport, type MarketingRequest } from './services/request';
// The `marketing.generate` job.
export {
  runMarketingReport, MARKETING_FAILURES, MARKETING_TIMEOUT_MS,
  type MarketingReportDeps, type MarketingRunOutcome,
} from './services/generate-report';

// Section 03's figures, and the writer of Sections 01–02 and the commentary.
export { loadMarketingFinancials } from './services/financials';
export { generateMarketingNarrative } from './services/generate-narrative';

// The presentation the page, the Word file and the PDF share, and the two files.
export * from './render';
