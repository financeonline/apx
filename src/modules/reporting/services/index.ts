import 'server-only';
import { NotFound, toMotionError, ValidationError } from '@/core/errors';
import { assertCan, can } from '@/core/permissions';
import { callApi } from '@/core/db';
import {
  buildHeadlineCards, loadPeriods, loadPeriodSnapshots, loadPeriodsWithData, loadLastDataDate,
  loadAlertsPage, basisLine,
} from '@/modules/dashboard';
import { loadHealthCard } from '@/modules/health';
import { listActions, type Action } from '@/modules/actions';
import type { AccessContext } from '@/modules/tenancy';
import type { AvailableReport, ReportViewModel } from '../domain/types';
import { composeSummaryEdition, type SummaryEditionView } from '../domain/summary';
import * as repo from '../data/repository';

/**
 * The Monthly Management Report (SERVICE_ARCHITECTURE.md §4.14; ADR-024).
 *
 * Reads. Never computes. Every figure comes from the same `metric_current` snapshots Home reads,
 * through the same `buildHeadlineCards` Home calls — so the report and the screen cannot disagree
 * about what March was, which is the one thing a document somebody takes to a meeting has to get
 * right (`ARCHITECTURE.md` risk 7).
 */

function orgOf(ctx: AccessContext): string {
  if (!ctx.orgId) throw new ValidationError('No organisation is in context.');
  return ctx.orgId;
}

/**
 * §4.14: complete periods only.
 *
 * A management report for a month that has not finished is a set of figures that will change after
 * somebody has acted on them. The list simply does not offer one (ADR-030.4).
 */
export async function listAvailable(ctx: AccessContext): Promise<AvailableReport[]> {
  assertCan(ctx, 'reports.view');
  const orgId = orgOf(ctx);

  const [periods, withData, files] = await Promise.all([
    loadPeriods(ctx.db, orgId, ctx.requestId),
    loadPeriodsWithData(ctx.db, orgId, ctx.requestId),
    repo.listReportFiles(ctx.db, orgId),
  ]);

  const byPeriod = new Map(files.map((file) => [file.periodId, file]));
  return periods
    .filter((period) => period.isComplete && withData.has(period.id))
    .map((period) => ({
      periodId: period.id,
      periodLabel: period.label,
      file: byPeriod.get(period.id) ?? null,
    }));
}

/**
 * Who reads the FULL Monthly Management Report — on screen and as the stored PDF — rather than its
 * summary edition (ADR-172 addendum, the owner's decision of 2026-10-14). The full report carries the
 * month's alerts, whose sentences name customers and suppliers, and the titles of open actions; it is
 * detail, and detail is `financials.view` (RBAC_MATRIX.md §8). The database draws the same line on
 * the stored file (`report_files_select`) and on the download's access event
 * (`api_server.record_access_event`, migration 20261018000036), so a page or route that forgot to
 * ask would still be refused.
 */
export const FULL_MONTHLY_REPORT_PERMISSION = 'financials.view' as const;

export function readsFullMonthlyReport(ctx: AccessContext): boolean {
  return can(ctx, 'reports.view') && can(ctx, FULL_MONTHLY_REPORT_PERMISSION);
}

/**
 * The full report on screen, for a reader with `reports.view` AND `financials.view`.
 *
 * Without `financials.view` — a 3rd party by default, or anyone whose switch is off — this refuses:
 * that reader gets the summary edition (`getMonthlySummary`), which is built from the overview and
 * never from this. (Before the addendum a 3rd party read this report with its alerts emptied by RLS;
 * an empty section built from a full document is exactly the "filtering" the owner ruled out.)
 *
 * Its open actions come from the Action Centre, which is `actions.view` reading (ADR-172): a reader
 * without it gets the report without that section rather than a refusal. The section is drawn only
 * when it has rows, so it never says "nothing outstanding" about something the reader cannot see.
 * The PDF job is not affected: it builds the report with its own scoped client
 * (`buildMonthlyReport`), and a reader holding `actions.view` sees exactly what the PDF prints.
 */
export async function getMonthlyReport(
  ctx: AccessContext, periodId: string,
): Promise<ReportViewModel | null> {
  assertCan(ctx, 'reports.view');
  assertCan(ctx, FULL_MONTHLY_REPORT_PERMISSION);
  const readsActions = can(ctx, 'actions.view');
  return buildMonthlyReport({
    db: ctx.db,
    orgId: orgOf(ctx),
    orgSlug: ctx.orgSlug ?? '',
    periodId,
    requestId: ctx.requestId,
    now: ctx.now(),
    openActions: readsActions
      ? () => listActions(ctx, { status: ['open', 'in_progress'] })
      : () => Promise.resolve([]),
  });
}

/**
 * The report itself, without a permission check.
 *
 * Two callers with two different kinds of authority: the service above, which checks
 * `reports.view` on a user's context, and the `report.render` job, which holds a scoped client and
 * runs work `api.enqueue_job` already authorised with `reports.generate`. Building it once is what
 * guarantees the PDF and the page say the same thing — which is the whole point of the phase.
 */
export async function buildMonthlyReport(input: {
  readonly db: AccessContext['db'];
  readonly orgId: string;
  readonly orgSlug: string;
  readonly periodId: string;
  readonly requestId?: string;
  readonly now: Date;
  readonly openActions: () => Promise<readonly Action[]>;
}): Promise<ReportViewModel | null> {
  const { db, orgId, orgSlug, periodId } = input;
  const ctx = { db, requestId: input.requestId } as { db: AccessContext['db']; requestId?: string };

  const [periods, withData] = await Promise.all([
    loadPeriods(ctx.db, orgId, ctx.requestId),
    loadPeriodsWithData(ctx.db, orgId, ctx.requestId),
  ]);
  const period = periods.find((candidate) => candidate.id === periodId) ?? null;
  // Cross-organisation or invented: NOT FOUND, never FORBIDDEN (SECURITY_MODEL.md §14).
  if (period === null) return null;
  if (!period.isComplete) return null;

  /*
   * The comparison month is the previous month WITH DATA, which is Home's rule (§4: a month with
   * no figure is a gap, not a zero). Comparing with the previous calendar month whatever it holds
   * agreed with Home only while every month carried a value — which, until ADR-104, an empty cash
   * family guaranteed by writing zeros nobody knew.
   */
  const previous = periods
    .filter((candidate) => candidate.periodStart < period.periodStart && withData.has(candidate.id))[0] ?? null;

  const [snapshots, health, alertsPage, actions, lastData, run] = await Promise.all([
    loadPeriodSnapshots(ctx.db, orgId, period.id, ctx.requestId),
    loadHealthCard(ctx.db, orgId, period.id, previous?.id ?? null, ctx.requestId),
    loadAlertsPage(ctx.db, orgId, orgSlug, { periodId: period.id, statuses: ['open'] }, ctx.requestId),
    input.openActions(),
    loadLastDataDate(ctx.db, orgId, ctx.requestId),
    repo.loadRunFor(ctx.db, orgId, period.id),
  ]);

  if (snapshots.length === 0) return null;

  const { cards } = buildHeadlineCards({
    snapshots, period, previousLabel: previous?.label ?? null, orgSlug,
  });

  return {
    organisationName: await repo.organisationName(ctx.db, orgId),
    period,
    comparisonLabel: previous?.label ?? null,
    cards,
    health,
    summary: repo.summaryFor(health, period.label),
    basisLine: basisLine(cards, lastData, period),
    alerts: alertsPage.alerts.map((alert) => ({
      id: alert.id,
      severity: alert.severity,
      title: alert.title,
      explanation: alert.whatHappened,
      recommendedNextStep: alert.whatYouCanDo,
    })),
    openActions: [...actions],
    asOf: run,
    generatedAt: input.now.toISOString(),
  };
}

/**
 * The summary edition (ADR-172 addendum): the headline figures, the Business Health Score area by
 * area and the report's own sentence — for any reader with `reports.view`. It is what a reader
 * without `financials.view` gets, and a full reader may take it too (to send to their bank).
 *
 * Built ONLY from the overview, with the READER'S client, and never from `buildMonthlyReport`:
 *   - no alert, action, counterparty, account, bank account, document or import is read at all;
 *   - only UNDIMENSIONED snapshots become figures (per customer, per account and per bank account
 *     figures are dropped before the cards are built, whatever the reader's RLS would allow), and
 *     their payloads are reduced to the one number a change line needs (`pct_change`);
 *   - the basis line is written without "last data added", which comes from the import log — so the
 *     edition says the same for every reader, and depends on nothing a 3rd party cannot read;
 *   - the composition is an allow-list (`composeSummaryEdition`).
 * For a 3rd party the database withholds the detail as well (RLS, `health_score_breakdowns`
 * redaction): even a mistake here could not read what the reader may not.
 *
 * NULL for a month that has not finished, has no figures, or is not this organisation's — NOT
 * FOUND, as the full report (SECURITY_MODEL.md §14).
 */
export async function getMonthlySummary(
  ctx: AccessContext, periodId: string,
): Promise<SummaryEditionView | null> {
  assertCan(ctx, 'reports.view');
  const orgId = orgOf(ctx);
  const { db, requestId } = ctx;

  const [periods, withData] = await Promise.all([
    loadPeriods(db, orgId, requestId),
    loadPeriodsWithData(db, orgId, requestId),
  ]);
  const period = periods.find((candidate) => candidate.id === periodId) ?? null;
  if (period === null || !period.isComplete) return null;
  // The comparison month is the previous month WITH DATA — Home's rule, and the full report's.
  const previous = periods
    .filter((candidate) => candidate.periodStart < period.periodStart && withData.has(candidate.id))[0] ?? null;

  const [snapshots, health, run, organisationName] = await Promise.all([
    loadPeriodSnapshots(db, orgId, period.id, requestId),
    loadHealthCard(db, orgId, period.id, previous?.id ?? null, requestId),
    repo.loadRunFor(db, orgId, period.id),
    repo.organisationName(db, orgId),
  ]);

  const overview = snapshots
    .filter((snapshot) => snapshot.dimensionType === 'none')
    .map((snapshot) => ({
      ...snapshot,
      components: snapshot.components.pct_change === undefined ? {} : { pct_change: snapshot.components.pct_change },
    }));
  if (overview.length === 0) return null;

  const { cards } = buildHeadlineCards({
    snapshots: overview, period, previousLabel: previous?.label ?? null, orgSlug: ctx.orgSlug ?? '',
  });

  return composeSummaryEdition({
    organisationName,
    period,
    comparisonLabel: previous?.label ?? null,
    cards,
    health,
    summary: repo.summaryFor(health, period.label),
    basisLine: basisLine(cards, null, period),
    asOf: run,
    generatedAt: ctx.now().toISOString(),
  });
}

/**
 * §4.14: asks the queue for a PDF. The job renders it; nothing here writes a file.
 *
 * `api.enqueue_job` merges onto a queued job for the same organisation and period, so pressing the
 * button twice does not render twice — a report is expensive and identical either way.
 */
export async function requestPdf(ctx: AccessContext, periodId: string): Promise<string> {
  assertCan(ctx, 'reports.generate');
  return callApi<string>(ctx.db, 'enqueue_job', {
    p_org: orgOf(ctx),
    p_job_type: 'report.render',
    p_payload: { periodId },
  }, ctx.requestId);
}

/**
 * §4.14 / ROUTE_ARCHITECTURE.md §166: the stored file, resolved by `(organization_id, id)`.
 *
 * Returns the row, not a URL. The URL is minted by the download route, audit-first, for the reason
 * `getDocumentReference` gives (ADR-043.5): a 60-second URL created while a page rendered would be
 * dead before anybody pressed anything, and every mint writes a `report.downloaded` row that would
 * then record a download nobody performed.
 */
export async function getReportFile(
  ctx: AccessContext, reportFileId: string,
): Promise<repo.ReportFileRow | null> {
  assertCan(ctx, 'reports.view');
  return repo.getReportFile(ctx.db, orgOf(ctx), reportFileId);
}

export { toMotionError, NotFound };
