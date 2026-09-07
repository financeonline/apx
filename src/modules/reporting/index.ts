/**
 * `modules/reporting` — the Monthly Management Report (ADR-024, SOW §20).
 *
 * One report in the MVP, and it adds no calculation: every figure is the `metric_current` snapshot
 * Home reads, built through the same `buildHeadlineCards`. That is the whole reason it could be in
 * scope — `ARCHITECTURE.md` names metric drift, "the same metric computed differently in two places
 * (UI, report, AI)", as a top risk, and a report is exactly where it lands. It is the artefact
 * somebody prints and takes to a meeting, and it must not disagree with the screen it came from.
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
