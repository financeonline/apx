import 'server-only';
import type { Db } from '@/db/types';
import {
  displayCopyFor, familyOf, loadAlertHistory, loadAlerts, thresholdNoteFor, whyItMattersFor,
  type AlertListRow, type AlertQuery, type AlertSeverity,
} from '@/modules/alerts';
import type { PeriodLabel } from '../domain/view-models';
import * as repo from '../data/repository';

/**
 * The alert list for the interface (UX_ARCHITECTURE.md §4 level 3, §8.3).
 *
 * The stored row holds the FIRST and THIRD parts of §8.3's pattern — `explanation` and
 * `recommended_next_step` — because those are the two §8.2 gives per rule and the two an export or
 * an AI answer quotes. The second part, "why it matters", is re-rendered here from the same stored
 * `threshold_summary`, so it cannot say anything the alert did not record.
 *
 * Nothing here recomputes a condition or a severity. The engine decided both.
 */

export interface AlertView {
  readonly id: string;
  readonly ruleKey: string;
  readonly family: string;
  readonly severity: AlertSeverity;
  readonly status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  readonly statusReasonCode: string;
  readonly title: string;
  readonly whatHappened: string;
  readonly whyItMatters: string | null;
  readonly whatYouCanDo: string | null;
  readonly thresholdNote: string | null;
  readonly periodLabel: string;
  readonly firstSeenLabel: string;
  /** True when the alert has been standing since before this period — a state rule (ADR-036). */
  readonly recurring: boolean;
  readonly evidenceHref: string | null;
  /** The action somebody already created from this alert, if any (§8 convert row). */
  readonly actionId: string | null;
  readonly detailHref: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function toView(
  row: AlertListRow,
  periods: ReadonlyMap<string, PeriodLabel>,
  orgSlug: string,
  currency: string,
): AlertView {
  const period = periods.get(row.periodId);
  const firstSeen = formatDate(row.firstSeenAt);
  // The current wording, from the stored figures; the stored words only for a rule with no template.
  const copy = displayCopyFor(row.ruleKey, row.thresholdSummary, currency);
  return {
    id: row.id,
    ruleKey: row.ruleKey,
    family: familyOf(row.ruleKey),
    severity: row.severity,
    status: row.status,
    statusReasonCode: row.statusReasonCode,
    title: copy?.title ?? row.title,
    whatHappened: copy?.whatHappened ?? row.explanation,
    whyItMatters: whyItMattersFor(row.ruleKey, row.thresholdSummary, currency),
    whatYouCanDo: copy?.whatYouCanDo ?? row.recommendedNextStep,
    thresholdNote: thresholdNoteFor(row.ruleKey, row.thresholdSummary, currency),
    periodLabel: period?.label ?? '',
    firstSeenLabel: firstSeen,
    // A state alert that has outlived the period it is reported against has been standing a while,
    // and saying so is the difference between "new problem" and "still the same problem".
    recurring: period !== undefined && row.firstSeenAt < period.periodStart,
    evidenceHref: row.evidenceBundleId === null
      ? null : `/app/${orgSlug}/evidence/${row.evidenceBundleId}`,
    actionId: row.actionId ?? null,
    detailHref: `/app/${orgSlug}/insights/alerts/${row.id}`,
  };
}

export interface AlertsPageView {
  readonly alerts: readonly AlertView[];
  readonly openCount: number;
  readonly filtered: boolean;
}

export async function loadAlertsPage(
  db: Db,
  orgId: string,
  orgSlug: string,
  query: AlertQuery,
  requestId?: string,
): Promise<AlertsPageView> {
  const [rows, periods, currency] = await Promise.all([
    loadAlerts(db, orgId, query, requestId),
    repo.loadPeriods(db, orgId, requestId),
    loadCurrency(db, orgId, requestId),
  ]);

  const periodById = new Map(periods.map((p) => [p.id, p]));
  const filtered = (query.statuses?.length ?? 0) > 0 || (query.severities?.length ?? 0) > 0
    || query.periodId !== undefined;

  return {
    alerts: rows.map((row) => toView(row, periodById, orgSlug, currency)),
    openCount: rows.filter((r) => r.status === 'open').length,
    filtered,
  };
}

/**
 * Home's top risks (§4 level 3): up to three OPEN alerts, worst first.
 *
 * Acknowledged ones are excluded deliberately. Somebody has already said they have seen it; putting
 * it back at the top of Home every morning is how a product trains people to stop reading Home.
 */
export async function loadTopRisks(
  db: Db,
  orgId: string,
  orgSlug: string,
  limit = 3,
  requestId?: string,
): Promise<readonly AlertView[]> {
  const view = await loadAlertsPage(db, orgId, orgSlug, { statuses: ['open'], limit }, requestId);
  return view.alerts.slice(0, limit);
}

export interface AlertHistoryView {
  readonly alert: AlertView;
  readonly revisions: ReadonlyArray<{
    readonly revisionNo: number;
    readonly severity: AlertSeverity;
    readonly explanation: string;
    readonly at: string;
    readonly evidenceHref: string | null;
  }>;
}

/** What an alert said at each evaluation (ADR-034, F-C-16). */
export async function loadAlertDetail(
  db: Db,
  orgId: string,
  orgSlug: string,
  alertId: string,
  requestId?: string,
): Promise<AlertHistoryView | null> {
  const [rows, periods, currency] = await Promise.all([
    loadAlerts(db, orgId, {}, requestId),
    repo.loadPeriods(db, orgId, requestId),
    loadCurrency(db, orgId, requestId),
  ]);

  const row = rows.find((r) => r.id === alertId);
  if (row === undefined) return null;

  const revisions = await loadAlertHistory(db, orgId, alertId, requestId);
  const periodById = new Map(periods.map((p) => [p.id, p]));

  return {
    alert: toView(row, periodById, orgSlug, currency),
    revisions: revisions.map((revision) => ({
      revisionNo: revision.revisionNo,
      severity: revision.severity,
      explanation: revision.explanation,
      at: formatDate(revision.createdAt),
      evidenceHref: revision.evidenceBundleId === null
        ? null : `/app/${orgSlug}/evidence/${revision.evidenceBundleId}`,
    })),
  };
}

/**
 * The organisation's currency, from its own figures.
 *
 * Alert copy renders money, and §8.2 says the symbol follows `organizations.base_currency`. Taking
 * it from a money snapshot rather than hard-coding 'GBP' keeps that true for every organisation.
 */
async function loadCurrency(
  db: Db, orgId: string, requestId?: string,
): Promise<string> {
  const periods = await repo.loadPeriods(db, orgId, requestId);
  const latest = periods.find((p) => p.isComplete) ?? periods[0];
  if (latest === undefined) return 'GBP';
  const snapshots = await repo.loadPeriodSnapshots(db, orgId, latest.id, requestId);
  return snapshots.find((s) => s.unit === 'money' && s.currency !== null)?.currency ?? 'GBP';
}
