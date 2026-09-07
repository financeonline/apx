import type { MetricCardView, PeriodLabel } from '@/modules/dashboard';
import type { HealthCardView } from '@/modules/health';
import type { Action } from '@/modules/actions';

/**
 * The Monthly Management Report (ADR-024; SOW §20; MVP_SCOPE.md §2.13).
 *
 * One report in the MVP, and it renders from what the product already knows: the same
 * `metric_current` snapshots Home reads, the same alerts Insights lists, the same actions the
 * Action Centre holds. It adds no calculation, which is the whole reason it could be in scope at
 * all — `ARCHITECTURE.md` names metric drift, "the same metric computed differently in two places
 * (UI, report, AI)", as a top risk, and a report is exactly where that risk lands: it is the
 * artefact somebody prints and takes to a meeting, and it must not disagree with the screen it came
 * from.
 */

export interface ReportAlertLine {
  readonly id: string;
  readonly severity: string;
  readonly title: string;
  /** The alert's own sentence, as Insights shows it — never re-worded here. */
  readonly explanation: string;
  readonly recommendedNextStep: string | null;
}

export interface ReportViewModel {
  readonly organisationName: string;
  readonly period: PeriodLabel;
  /** The month the change lines compare against, or NULL when there is none. */
  readonly comparisonLabel: string | null;
  /** The same cards, in the same order, as Home (§4). */
  readonly cards: readonly MetricCardView[];
  readonly health: HealthCardView | null;
  /** The plain sentence from `modules/health` templates — never from the AI. */
  readonly summary: string;
  readonly basisLine: string;
  readonly alerts: readonly ReportAlertLine[];
  readonly openActions: readonly Action[];
  /** When the figures were computed, and by which engine. */
  readonly asOf: { readonly engineVersion: string | null; readonly finishedAt: string | null };
  readonly generatedAt: string;
}

/** A report a customer can download, or the fact that none has been rendered yet. */
export interface ReportFileRef {
  readonly id: string;
  readonly periodId: string;
  readonly periodLabel: string;
  readonly byteSize: number | null;
  readonly createdAt: string;
}

export interface AvailableReport {
  readonly periodId: string;
  readonly periodLabel: string;
  /** The rendered PDF, when one exists. The on-screen report is always available. */
  readonly file: ReportFileRef | null;
}
