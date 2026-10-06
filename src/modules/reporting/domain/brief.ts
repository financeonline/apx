import { interimChange, type InterimFigure, type InterimFigureKey, type InterimFigures } from '@/modules/financial-engine';

/**
 * The Daily Executive Brief and the Weekly Intelligence Report (Phase 17; Agreement §22; ADR-141).
 *
 * What a brief SAYS is assembled here, purely, from sources a service has already loaded. Nothing
 * in this file computes a financial figure: the interim figures come from the engine's interim
 * calculator, the month's figures from `metric_current` through the same card builder Home uses,
 * and every sentence about an alert is the alert's own. The brief chooses, orders and caps — that is
 * all — so it can never disagree with the screens its parts came from.
 *
 * The content is STORED (`public.reports.content`): the open alerts and overdue actions of a day are
 * a fact about that day, and recomposing the brief a week later would tell a different story. The
 * stored object is versioned (`BRIEF_CONTENT_VERSION`) so a later reader can tell the shapes apart.
 *
 * Links are stored with an `{org}` placeholder rather than the organisation's slug: a job has no
 * slug of its own, and a slug can change. `resolveHref` fills it when the report is shown.
 */

export const BRIEF_CONTENT_VERSION = 'brief.v1';

/** How many lines any one list shows. The total is always stated beside it. */
export const BRIEF_LIST_CAP = 10;

export const ORG_PLACEHOLDER = '{org}';

export function resolveHref(href: string, orgSlug: string): string {
  return href.split(ORG_PLACEHOLDER).join(encodeURIComponent(orgSlug));
}

export type BriefKind = 'daily_brief' | 'weekly_intelligence';

export interface Capped<T> {
  readonly items: readonly T[];
  /** How many there were in all; `items` holds at most `BRIEF_LIST_CAP`. */
  readonly total: number;
}

export interface BriefAlertLine {
  readonly id: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  readonly title: string;
  /** The alert's own sentence, never re-worded here. */
  readonly explanation: string;
  readonly nextStep: string | null;
  readonly periodLabel: string | null;
  /** When it was raised, reopened or resolved — whichever the list is about. */
  readonly at: string;
  readonly href: string;
}

export interface BriefActionLine {
  readonly id: string;
  readonly title: string;
  readonly priority: 'critical' | 'high' | 'medium' | 'low';
  readonly status: 'open' | 'in_progress' | 'completed' | 'dismissed';
  readonly dueDate: string | null;
  /**
   * Whether somebody owns it — never WHO. A stored brief is readable by everyone with
   * `reports.view`, clients included, and a client may not learn colleagues' names (`users.view`;
   * see `actions/data/repository.ts` ownerNames).
   */
  readonly assigned: boolean;
  readonly at: string | null;
  readonly href: string;
}

export interface BriefMovementLine {
  readonly label: string;
  readonly dimensionLabel: string | null;
  readonly change: string;
  readonly percent: string | null;
  readonly favourable: boolean;
  readonly current: string;
  readonly comparison: string;
  readonly statusLabel: string | null;
  readonly href: string;
}

export interface BriefCard {
  readonly metricKey: string;
  readonly label: string;
  readonly value: string;
  readonly change: string | null;
  readonly statusLabel: string | null;
  readonly href: string;
}

/** The latest complete month, as Home shows it. */
export interface BriefMonth {
  readonly periodId: string;
  readonly label: string;
  readonly comparisonLabel: string | null;
  readonly basisLine: string;
  readonly cards: readonly BriefCard[];
  readonly health: {
    readonly score: number;
    readonly band: string | null;
    readonly changeVsPrevious: number | null;
    readonly dimensionsUsed: number;
    readonly dimensionsTotal: number;
    readonly capped: boolean;
  } | null;
  /** Ranked by money, the month's adverse movements (Insights). */
  readonly adverse: readonly BriefMovementLine[];
  /** …and its favourable ones. */
  readonly favourable: readonly BriefMovementLine[];
}

/** One interim figure in this window beside the same figure in the window before. */
export interface BriefComparisonRow {
  readonly key: InterimFigureKey;
  readonly current: InterimFigure;
  readonly previous: InterimFigure | null;
  /** current − previous, when both exist. */
  readonly change: string | null;
}

export interface BriefDataNotice {
  readonly kind:
    | 'bank_account_short' | 'no_bank_accounts' | 'no_bank_data_in_window' | 'no_invoice_data'
    | 'other_currency_records' | 'no_month_yet';
  readonly text: string;
}

export interface BriefContent {
  readonly version: typeof BRIEF_CONTENT_VERSION;
  readonly kind: BriefKind;
  readonly organisationName: string;
  readonly timezone: string;
  readonly currency: string;
  readonly window: { readonly start: string; readonly end: string };
  readonly previousWindow: { readonly start: string; readonly end: string };
  /** When the brief was composed. Everything "still open" is as of this instant. */
  readonly composedAt: string;

  /** Key movements (daily) / financial changes (weekly): the interim figures, compared. */
  readonly interim: InterimFigures;
  readonly comparison: readonly BriefComparisonRow[];

  /** What happened in the window. */
  readonly events: {
    readonly alertsRaised: Capped<BriefAlertLine>;
    readonly alertsResolved: Capped<BriefAlertLine>;
    readonly actionsCreated: Capped<BriefActionLine>;
    readonly actionsCompleted: Capped<BriefActionLine>;
  };

  /**
   * When data was last added — the date Home already shows everyone. Import details are not stored:
   * imports are `imports.review` business, and a stored brief is readable with `reports.view`.
   */
  readonly dataRefreshedAt: string | null;

  /**
   * What needs attention (the Daily Challenges, R17-2) / unresolved issues (weekly): as of
   * composition, not as of the window's end.
   */
  readonly attention: {
    readonly standingAlerts: Capped<BriefAlertLine>;
    readonly standingBySeverity: Readonly<Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>>;
    readonly overdueActions: Capped<BriefActionLine>;
    readonly dueSoonActions: Capped<BriefActionLine>;
  };

  /** Context the window cannot give: the latest complete month (R17-1a). */
  readonly latestMonth: BriefMonth | null;

  readonly notices: readonly BriefDataNotice[];
}

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------

export interface BriefSources {
  readonly kind: BriefKind;
  readonly organisationName: string;
  readonly timezone: string;
  readonly window: { readonly start: string; readonly end: string };
  readonly previousWindow: { readonly start: string; readonly end: string };
  readonly composedAt: string;
  readonly interim: InterimFigures;
  readonly previousInterim: InterimFigures;
  readonly alertsRaised: readonly BriefAlertLine[];
  readonly alertsResolved: readonly BriefAlertLine[];
  readonly standingAlerts: readonly BriefAlertLine[];
  readonly actionsCreated: readonly BriefActionLine[];
  readonly actionsCompleted: readonly BriefActionLine[];
  readonly openActions: readonly BriefActionLine[];
  readonly dataRefreshedAt: string | null;
  readonly latestMonth: BriefMonth | null;
}

const SEVERITY_RANK: Readonly<Record<BriefAlertLine['severity'], number>> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};
const PRIORITY_RANK: Readonly<Record<BriefActionLine['priority'], number>> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

function capped<T>(items: readonly T[], order: (a: T, b: T) => number): Capped<T> {
  return { items: [...items].sort(order).slice(0, BRIEF_LIST_CAP), total: items.length };
}

const bySeverityThenTime = (a: BriefAlertLine, b: BriefAlertLine): number =>
  SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.at.localeCompare(a.at) || a.id.localeCompare(b.id);

const byTimeDesc = <T extends { readonly at: string | null; readonly id: string }>(a: T, b: T): number =>
  (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id);

const byDueThenPriority = (a: BriefActionLine, b: BriefActionLine): number =>
  (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31')
  || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id.localeCompare(b.id);

function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** How far after the window an action counts as "due soon". */
export const DUE_SOON_DAYS = 7;

function comparisonRows(current: InterimFigures, previous: InterimFigures): BriefComparisonRow[] {
  const prior = new Map<InterimFigureKey, InterimFigure>(
    [...(previous.cash ?? []), ...(previous.invoicing ?? [])].map((figure) => [figure.key, figure]));
  return [...(current.cash ?? []), ...(current.invoicing ?? [])].map((figure) => {
    const before = prior.get(figure.key) ?? null;
    return {
      key: figure.key,
      current: figure,
      previous: before,
      change: before === null ? null : interimChange(figure.value, before.value),
    };
  });
}

const UNAVAILABLE_TEXT: Readonly<Record<'no_bank_accounts' | 'no_bank_data_in_window' | 'no_invoice_data', string>> = {
  no_bank_accounts: 'No bank account has been added, so there are no cash figures for this period.',
  no_bank_data_in_window: 'No bank statement reaches into this period yet, so there are no cash figures for it.',
  no_invoice_data: 'No invoice list has been imported, so there are no invoicing figures.',
};

export function assembleBrief(sources: BriefSources): BriefContent {
  const { window } = sources;

  const standing = sources.standingAlerts;
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const alert of standing) bySeverity[alert.severity] += 1;

  // Open actions due on or before the window's last day are overdue; those due in the week after
  // it are due soon. Status is as of composition — a brief composed late says so (`composedAt`).
  const soonEnd = addDaysIso(window.end, DUE_SOON_DAYS);
  const open = sources.openActions.filter((action) => action.status === 'open' || action.status === 'in_progress');
  const overdue = open.filter((action) => action.dueDate !== null && action.dueDate <= window.end);
  const dueSoon = open.filter((action) => action.dueDate !== null && action.dueDate > window.end
    && action.dueDate <= soonEnd);

  const notices: BriefDataNotice[] = [];
  for (const reason of sources.interim.unavailable) {
    notices.push({ kind: reason, text: UNAVAILABLE_TEXT[reason] });
  }
  for (const account of sources.interim.coverage.accountsShort) {
    if (sources.interim.cash === null) break;
    notices.push({
      kind: 'bank_account_short',
      text: account.latestDate === null
        ? `${account.name} has no transactions imported yet, so cash figures leave it out.`
        : `${account.name}'s statements reach ${account.latestDate}; cash after that date is not counted yet.`,
    });
  }
  if (sources.interim.coverage.otherCurrencyRecords > 0) {
    const n = sources.interim.coverage.otherCurrencyRecords;
    notices.push({
      kind: 'other_currency_records',
      text: `${n} record${n === 1 ? '' : 's'} in another currency ${n === 1 ? 'is' : 'are'} not included; figures are in ${sources.interim.currency} only.`,
    });
  }
  if (sources.latestMonth === null) {
    notices.push({ kind: 'no_month_yet', text: 'There is no complete month with figures yet.' });
  }

  return {
    version: BRIEF_CONTENT_VERSION,
    kind: sources.kind,
    organisationName: sources.organisationName,
    timezone: sources.timezone,
    currency: sources.interim.currency,
    window,
    previousWindow: sources.previousWindow,
    composedAt: sources.composedAt,
    interim: sources.interim,
    comparison: comparisonRows(sources.interim, sources.previousInterim),
    events: {
      alertsRaised: capped(sources.alertsRaised, bySeverityThenTime),
      alertsResolved: capped(sources.alertsResolved, byTimeDesc),
      actionsCreated: capped(sources.actionsCreated, byTimeDesc),
      actionsCompleted: capped(sources.actionsCompleted, byTimeDesc),
    },
    dataRefreshedAt: sources.dataRefreshedAt,
    attention: {
      standingAlerts: capped(standing.filter((alert) => alert.severity === 'critical' || alert.severity === 'high'),
        bySeverityThenTime),
      standingBySeverity: bySeverity,
      overdueActions: capped(overdue, byDueThenPriority),
      dueSoonActions: capped(dueSoon, byDueThenPriority),
    },
    latestMonth: sources.latestMonth,
    notices,
  };
}

/** How many of a capped list are not shown (components do no arithmetic, SERVICE_ARCHITECTURE.md §8). */
export function notShown(list: Capped<unknown>): number {
  return Math.max(0, list.total - list.items.length);
}
