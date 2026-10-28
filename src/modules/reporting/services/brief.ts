import 'server-only';
import type { Db } from '@/db/types';
import { ValidationError } from '@/core/errors';
import { addDays, isoWeekday } from '@/core/periods';
import { computeInterimFigures } from '@/modules/financial-engine';
import {
  basisLine, buildHeadlineCards, loadInsights, loadLastDataDate, loadPeriodSnapshots, loadPeriods,
  loadPeriodsWithData, type MovementView,
} from '@/modules/dashboard';
import { loadHealthCard } from '@/modules/health';
import {
  assembleBrief, ORG_PLACEHOLDER, type BriefContent, type BriefKind, type BriefMonth, type BriefMovementLine,
} from '../domain/brief';
import * as sources from '../data/brief-sources';

/**
 * Composing a Daily Executive Brief or a Weekly Intelligence Report (Phase 17).
 *
 * Reads, assembles, returns. It never writes: the `report.compose` job stores what this returns,
 * and the on-screen preview of a day still in progress shows it without storing it. Both callers
 * get the same content for the same data, because both call this.
 */

/** How many of the month's movements a brief carries, each way. */
const MOVEMENT_CAP = 5;

export interface BriefWindow {
  readonly start: string;
  readonly end: string;
}

/** The window a brief covers, from its first day; and the window before it, for comparison. */
export function briefWindows(kind: BriefKind, start: string): { window: BriefWindow; previous: BriefWindow } {
  if (kind === 'daily_brief') {
    return { window: { start, end: start }, previous: { start: addDays(start, -1), end: addDays(start, -1) } };
  }
  if (isoWeekday(start) !== 1) {
    throw new ValidationError('A week starts on a Monday.', [{ path: 'windowStart', message: start }]);
  }
  return {
    window: { start, end: addDays(start, 6) },
    previous: { start: addDays(start, -7), end: addDays(start, -1) },
  };
}

function movementLine(movement: MovementView): BriefMovementLine {
  return {
    label: movement.label,
    dimensionLabel: movement.dimensionLabel,
    change: movement.change,
    percent: movement.percent,
    favourable: movement.favourable,
    current: movement.current,
    comparison: movement.comparison,
    statusLabel: movement.status.label,
    href: movement.whyHref,
  };
}

/** The latest complete month with figures, as Home and the monthly report show it (R17-1a). */
export async function latestMonth(db: Db, orgId: string, requestId?: string): Promise<BriefMonth | null> {
  const [periods, withData, lastData] = await Promise.all([
    loadPeriods(db, orgId, requestId),
    loadPeriodsWithData(db, orgId, requestId),
    loadLastDataDate(db, orgId, requestId),
  ]);
  const period = periods.find((candidate) => candidate.isComplete && withData.has(candidate.id)) ?? null;
  if (period === null) return null;
  const previous = periods.find((candidate) => candidate.periodStart < period.periodStart
    && withData.has(candidate.id)) ?? null;

  const [snapshots, health, insights] = await Promise.all([
    loadPeriodSnapshots(db, orgId, period.id, requestId),
    loadHealthCard(db, orgId, period.id, previous?.id ?? null, requestId),
    loadInsights(db, orgId, ORG_PLACEHOLDER, requestId),
  ]);
  if (snapshots.length === 0) return null;

  const { cards } = buildHeadlineCards({
    snapshots, period, previousLabel: previous?.label ?? null, orgSlug: ORG_PLACEHOLDER,
  });
  // Insights ranks the latest complete month; it is only this month's story if it is this month.
  const movements = insights.kind === 'ready' && insights.view.period.id === period.id ? insights.view : null;

  return {
    periodId: period.id,
    label: period.label,
    comparisonLabel: previous?.label ?? null,
    basisLine: basisLine(cards, lastData, period),
    cards: cards.map((card) => ({
      metricKey: card.metricKey,
      label: card.label,
      value: card.value,
      change: card.change?.text ?? null,
      statusLabel: card.status.label,
      href: card.whyHref,
    })),
    health: health === null || health.score === null ? null : {
      score: health.score,
      band: health.band,
      changeVsPrevious: health.changeVsPrevious,
      dimensionsUsed: health.dimensionsUsed,
      dimensionsTotal: health.dimensionsTotal,
      capped: health.capped,
    },
    adverse: (movements?.unfavourable ?? []).slice(0, MOVEMENT_CAP).map(movementLine),
    favourable: (movements?.favourable ?? []).slice(0, MOVEMENT_CAP).map(movementLine),
  };
}

export async function composeBrief(input: {
  readonly db: Db;
  readonly orgId: string;
  readonly kind: BriefKind;
  readonly windowStart: string;
  readonly now: Date;
  readonly requestId?: string;
}): Promise<BriefContent> {
  const { db, orgId, kind, requestId } = input;
  const { window, previous } = briefWindows(kind, input.windowStart);

  const org = await sources.loadOrganisationBasics(db, orgId);
  const instants = sources.windowInstants(window.start, window.end, org.timezone);

  const [bank, invoices, accounts, invoicesExist, periods, actions, dataRefreshedAt, month] = await Promise.all([
    sources.loadBankRows(db, orgId, previous.start, window.end),
    sources.loadInvoiceRows(db, orgId, previous.start, window.end),
    sources.loadAccountCoverage(db, orgId),
    sources.hasInvoiceData(db, orgId),
    loadPeriods(db, orgId, requestId),
    sources.loadActionEvents(db, orgId, instants.from, instants.to),
    loadLastDataDate(db, orgId, requestId),
    latestMonth(db, orgId, requestId),
  ]);
  const periodLabels = new Map(periods.map((period) => [period.id, period.label]));
  const alerts = await sources.loadAlertEvents(db, orgId, instants.from, instants.to, periodLabels);

  const interimFor = (w: BriefWindow) => computeInterimFigures({
    window: w,
    baseCurrency: org.baseCurrency,
    bank,
    invoices,
    accounts,
    hasInvoiceData: invoicesExist,
  });

  return assembleBrief({
    kind,
    organisationName: org.name,
    timezone: org.timezone,
    window,
    previousWindow: previous,
    composedAt: input.now.toISOString(),
    interim: interimFor(window),
    previousInterim: interimFor(previous),
    alertsRaised: alerts.raised,
    alertsResolved: alerts.resolved,
    standingAlerts: alerts.standing,
    actionsCreated: actions.created,
    actionsCompleted: actions.completed,
    openActions: actions.open,
    dataRefreshedAt,
    latestMonth: month,
  });
}
