/**
 * `modules/reporting` — Intelligent Reporting (ADR-024; Phase 17, ADR-141; SOW §20).
 *
 * The Monthly Management Report adds no calculation: every figure is the `metric_current` snapshot
 * Home reads, built through the same `buildHeadlineCards`. That is the whole reason it could be in
 * scope — `ARCHITECTURE.md` names metric drift, "the same metric computed differently in two places
 * (UI, report, AI)", as a top risk, and a report is exactly where it lands. It is the artefact
 * somebody prints and takes to a meeting, and it must not disagree with the screen it came from.
 *
 * Phase 17 adds the composed reports — the Daily Executive Brief, the Weekly Intelligence Report,
 * the Accountant/CFO Report and the Custom AI Report — under the same rule, and STORES what each
 * said (`public.reports`), because "what was open that day" is a fact about that day.
 */

export {
  type AvailableReport,
  type ReportAlertLine,
  type ReportFileRef,
  type ReportViewModel,
} from './domain/types';

export {
  buildMonthlyReport,
  getMonthlyReport,
  getReportFile,
  listAvailable,
  requestPdf,
} from './services';

export { renderReportPdf } from './domain/pdf';

export {
  BRIEF_CONTENT_VERSION,
  BRIEF_LIST_CAP,
  DUE_SOON_DAYS,
  ORG_PLACEHOLDER,
  assembleBrief,
  notShown,
  resolveHref,
  type BriefActionLine,
  type BriefAlertLine,
  type BriefCard,
  type BriefComparisonRow,
  type BriefContent,
  type BriefKind,
  type BriefMonth,
  type BriefMovementLine,
  type BriefSources,
  type Capped,
} from './domain/brief';

export { briefWindows, composeBrief } from './services/brief';
export { ADVISER_CONTENT_VERSION, composeAdviserReport, type AdviserContent } from './services/adviser';
export {
  KIND_LABELS,
  composeStoredReport,
  getStoredReport,
  latestCompletedWindows,
  listStoredReports,
  loadStoredReportForJob,
  previewBrief,
  requestCompose,
  requestStoredPdf,
  type ComposableKind,
  type Composed,
  type StoredKind,
  type StoredReport,
  type StoredReportSummary,
} from './services/stored';
export {
  CUSTOM_CONTENT_VERSION,
  CUSTOM_DIMENSIONS,
  MAX_CUSTOM_QUESTIONS,
  MAX_CUSTOM_QUESTION_CHARS,
  SUPPORTED_QUESTIONS,
  customQuestionMessage,
  entriesFromConversation,
  focusWord,
  isCustomDimension,
  type CustomAnswerEntry,
  type CustomDimension,
  type CustomReportContent,
} from './domain/custom';
export {
  CT_NOT_ESTIMATED_TEXT,
  FIXED_AREAS,
  INDICATIVE_TEXT,
  NOT_AVAILABLE_TEXT,
  NOT_CALCULATED_REASON,
  SECTION_TITLES,
  VAT_NOT_CALCULATED_TEXT,
  VAT_QUARTERS_NOT_SET_TEXT,
  buildCorporationTaxSection,
  buildSnapshotSection,
  buildVatSection,
  isFixedArea,
  unavailableSection,
  type CustomSection,
  type CustomSectionRow,
  type FixedArea,
  type SectionFigure,
} from './domain/custom-sections';
export { customReportPeriods, finishCustomReport } from './services/custom';
export {
  ANSWER_SECTION_TITLES,
  DEGRADED_TEXT,
  NOTE_TEXT,
  STATEMENT_KIND_LABELS,
  UNANSWERED_TEXT,
  UNSUPPORTED_TEXT,
  INTERIM_DISCLAIMER,
  INTERIM_LABELS,
  INTERIM_NOTES,
  INTERIM_STATUS_LABELS,
  PRIORITY_LABELS as REPORT_PRIORITY_LABELS,
  REPORT_DIMENSION_LABELS,
  REPORT_EXCLUSION_TEXT,
  SEVERITY_LABELS as REPORT_SEVERITY_LABELS,
  windowLabel,
} from './domain/labels';
export { renderAdviserPdf, renderBriefPdf } from './domain/pdf-composed';
export { renderCustomPdf } from './domain/pdf-custom';
export type { AdviserCompletedAction, AdviserDimensionLine } from './domain/adviser';
export { FUNDING_REPORT_VERSION, type FundingReportContent } from './domain/funding-report';
export { renderFundingPdf } from './domain/pdf-funding';
export { renderPortfolioPdf } from './domain/pdf-portfolio';
