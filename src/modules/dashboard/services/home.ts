import 'server-only';
import type { Db } from '@/db/types';
import { ENGINE_VERSION, varianceKey } from '@/modules/financial-engine';
import { metricAvailability, type AvailabilityInput } from '@/modules/financials';
import {
  loadHealthCard, loadHealthHistory, summarySentence,
  type HealthCardView, type HealthHistoryPoint, type SummarySentence,
} from '@/modules/health';
import { formatMoney, tryParseDecimal } from '@/core/money';
import * as repo from '../data/repository';
import {
  changeFrom, formatValue, labelFor, toMetricCard,
  type MetricCardView, type PeriodLabel, type SnapshotRow,
} from '../domain/view-models';
import { BASIS_TEXT, missingReasonText } from '../domain/status';

/**
 * Home (UX_ARCHITECTURE.md §4).
 *
 * Assembles the view models the page renders. It reads snapshots and formats them; it never
 * computes a financial figure — every number on Home is a figure the engine already wrote, read
 * through the `metric_current` pointer. That is what makes the integration assertion possible:
 * every figure on the page must equal its snapshot.
 */

/**
 * §4: Home opens on the LATEST COMPLETE month, the same rule the analyst uses.
 *
 * This is a SELECTION, not a second predicate (ADR-093). `isComplete` is `fiscal_periods.is_complete`
 * as the engine wrote it, and the engine wrote it through `core/periods.completenessHolds` — so the
 * dashboard and the engine agree because the dashboard is reading the engine's answer rather than
 * working one out. The name says so, because a `latestCompletePeriod` that looked like a rule is
 * how this came to be read as a third implementation of one.
 */
export function latestCompletePeriodByFlag(periods: readonly PeriodLabel[]): PeriodLabel | null {
  return periods.find((p) => p.isComplete) ?? null;
}

/**
 * The partial current month, shown as one slim line under the heading (§4).
 *
 * A month that is not finished gets no health score, no comparisons and no alerts, because a
 * part-month compared with a whole one is a misleading comparison rather than a useful one.
 */
export function partialPeriod(
  periods: readonly PeriodLabel[], withData: ReadonlySet<string>,
): PeriodLabel | null {
  const complete = latestCompletePeriodByFlag(periods);
  const candidate = periods.find((p) => !p.isComplete && withData.has(p.id));
  if (!candidate) return null;
  if (complete && candidate.periodStart <= complete.periodStart) return null;
  return candidate;
}

export type HomeState =
  /** No committed data at all (§6 "Home, first run"). */
  | { readonly kind: 'first_run' }
  /** Data uploaded but still awaiting review (§6). */
  | { readonly kind: 'awaiting_review'; readonly batchId: string; readonly filename: string; readonly rowCount: number; readonly issueCount: number }
  /** Bank data only: three cards plus the opening-balance prompt (§4, ADR-035). */
  | { readonly kind: 'bank_only'; readonly view: HomeView }
  | { readonly kind: 'ready'; readonly view: HomeView };

export interface PartialMonthLine {
  readonly label: string;
  /** "money in £6,000 · money out £4,100" — already formatted. */
  readonly summary: string;
  readonly href: string;
}

export interface HomeView {
  readonly period: PeriodLabel;
  readonly periods: readonly PeriodLabel[];
  readonly cards: readonly MetricCardView[];
  /** "Based on your bank statements · Last data added 12 Mar 2026 · March 2026". */
  readonly basisLine: string;
  readonly partialMonth: PartialMonthLine | null;
  readonly recalculating: boolean;
  /** True when cost of sales cannot be established, so the gross-profit card is omitted (CD-05, ADR-105). */
  readonly hidesGrossProfit: boolean;
  /** The engine's reason for omitting it, in the shared reason words; null when the card is shown. */
  readonly grossProfitNote: string | null;
  /**
   * The health score for this period, or NULL when none was written — which happens for exactly one
   * reason: the period is not complete (ADR-030.4). The card is omitted rather than showing a zero.
   */
  readonly health: HealthCardView | null;
  /** The one plain sentence at level 1, from `modules/health` templates — never from the AI. */
  readonly summary: SummarySentence;
  /** The label of the month the change is measured against, for the card's change line. */
  readonly comparisonLabel: string | null;
}

/** The Level 2 cards, in the order §4 fixes. Order is part of the contract, not a preference. */
const HEADLINE_ORDER = [
  'revenue', 'gross_profit', 'operating_profit', 'closing_cash', 'receivables', 'payables',
] as const;

/** The bank-only variant's three cards plus cash (§4, ADR-035). */
const BANK_ONLY_ORDER = ['cash_inflows', 'cash_outflows', 'net_cash_movement', 'closing_cash'] as const;

/** A snapshot row as the shared availability rule reads it (ADR-106). */
function qualityOf(row: SnapshotRow): AvailabilityInput {
  return { value: row.value, warnings: row.dataQuality.warnings, missing: row.dataQuality.missing };
}

function index(rows: readonly SnapshotRow[]): Map<string, SnapshotRow> {
  const map = new Map<string, SnapshotRow>();
  for (const row of rows) {
    if (row.dimensionType === 'none') map.set(row.metricKey, row);
  }
  return map;
}

/**
 * The organisation's currency, taken from the figures themselves.
 *
 * Every money snapshot carries the currency it was computed in, so the sentence is rendered with the
 * same symbol as the cards. Falling back to a hard-coded 'GBP' would be a silent assumption about
 * somebody's business; falling back to the first money row's currency is a statement of fact.
 */
function currencyOf(rows: readonly SnapshotRow[]): string {
  return rows.find((r) => r.unit === 'money' && r.currency !== null)?.currency ?? 'GBP';
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The headline cards §4 fixes, for one month.
 *
 * Extracted so Home and the Monthly Management Report build them from the SAME code rather than
 * from two readings of the same rule. `ARCHITECTURE.md` names metric drift — "the same metric
 * computed differently in two places (UI, report, AI)" — as a top risk, and a report that decided
 * for itself whether to show gross profit, or which month to compare against, would be that risk
 * arriving by the back door. Neither caller computes anything; both read `metric_current`.
 */
export function buildHeadlineCards(input: {
  readonly snapshots: readonly SnapshotRow[];
  readonly period: PeriodLabel;
  readonly previousLabel: string | null;
  readonly orgSlug: string;
}): {
  cards: MetricCardView[];
  hidesGrossProfit: boolean;
  /** Why the gross-profit card is omitted, in the reader's words; null when it is shown. */
  grossProfitNote: string | null;
  bankOnly: boolean;
  /** Distinct from `bankOnly`: an organisation can lack a P&L source and have no cash data either. */
  noPnlSource: boolean;
} {
  const byKey = index(input.snapshots);
  const period = input.period;
  const previous = input.previousLabel === null ? null : { label: input.previousLabel };
  const orgSlug = input.orgSlug;

  /*
   * CD-05: an organisation whose cost of sales cannot be established never sees a gross-profit
   * card, because "profit after direct costs" equal to sales reads as a 100% margin.
   *
   * The engine says so in two places and this reads both (ADR-105): `cost_of_sales` is NULL with
   * `no_cost_of_sales_accounts` or `cost_of_sales_in_other_source`, and `gross_profit` — which the
   * engine still writes as revenue so the statement adds up — carries the warning
   * `no_cost_of_sales` with that reason deliberately REMOVED from its own `missing`. Testing
   * `gross_profit.missing` alone, as this did until ADR-105, tested a field the engine empties.
   *
   * ADR-106 moved the decision itself into `financials` so that Home, the monthly report and the
   * analyst answer one question once. This reads the shared rule; it no longer states it.
   */
  const grossProfit = byKey.get('gross_profit');
  const costOfSales = byKey.get('cost_of_sales');
  const availability = grossProfit === undefined
    ? null
    : metricAvailability('gross_profit', qualityOf(grossProfit), costOfSales ? qualityOf(costOfSales) : null);
  const hidesGrossProfit = availability === null || availability.state === 'not_applicable';
  // The reason the reader is given instead of the card — the engine's own, in the shared words.
  const grossProfitNote = availability !== null && availability.state === 'not_applicable'
    ? missingReasonText([availability.reason])
    : null;

  // The bank-only variant (ADR-035): the organisation has bank data and NO P&L source at all.
  //
  // The test is deliberately about the organisation rather than the month: a business whose March
  // ledger simply has not been uploaded yet should still see its ordinary Home with the missing
  // figures dashed, not be told it is a bank-only business. So the variant needs cash figures
  // present AND revenue either absent or explicitly uncovered.
  const revenue = byKey.get('revenue');
  const hasCash = byKey.has('cash_inflows') || byKey.has('cash_outflows');
  const noPnlSource = !revenue || (revenue.value === null && revenue.basis === 'none');
  const bankOnly = hasCash && noPnlSource;

  const order = bankOnly
    ? BANK_ONLY_ORDER
    : HEADLINE_ORDER.filter((key) => key !== 'gross_profit' || !hidesGrossProfit);

  const cards: MetricCardView[] = [];
  for (const key of order) {
    const row = byKey.get(key);
    if (!row) continue;

    const variance = byKey.get(varianceKey(key, 'prev_period')) ?? null;

    cards.push(toMetricCard(row, period, variance, {
      orgSlug,
      comparisonLabel: previous?.label ?? 'the previous month',
      // §4: operating profit carries net profit on a visible second line, never a tooltip.
      secondary: key === 'operating_profit'
        ? { label: labelFor('net_profit').plain, row: byKey.get('net_profit') ?? null }
        : undefined,
    }));
  }

  return { cards, hidesGrossProfit, grossProfitNote, bankOnly, noPnlSource };
}

/** The basis and freshness line (§4 level 1). Shared with the report, which prints it too. */
export function basisLine(cards: readonly MetricCardView[], lastData: string | null, period: PeriodLabel): string {
  const sources = [...new Set(cards.map((c) => c.basisText).filter(Boolean))];
  const parts: string[] = [];
  if (sources.length > 0) {
    // Each basis reads "From bank statements"; joined, the "From" goes once: "Based on your accounts,
    // bank statements and invoices" — not "Based on from … and from …" (found with the sample data).
    const named = sources.map((s) => s.replace(/^from\s+/i, '').toLowerCase());
    const list = named.length === 1 ? named[0]! : `${named.slice(0, -1).join(', ')} and ${named.at(-1)!}`;
    parts.push(`Based on ${list}`);
  }
  const added = formatDate(lastData);
  if (added) parts.push(`Last data added ${added}`);
  parts.push(`${period.label} (latest complete month)`);
  return parts.join(' · ');
}

export interface LoadHomeOptions {
  /**
   * The organisation is suspended (ADR-044.4). Its member resolves to `suspended_member`, who reads
   * the frozen figures and periods but no records — so the record-level first-run test below cannot
   * be asked, and is not.
   */
  readonly suspended?: boolean;
}

export async function loadHome(
  db: Db,
  orgId: string,
  orgSlug: string,
  requestId?: string,
  options: LoadHomeOptions = {},
): Promise<HomeState> {
  const suspended = options.suspended === true;
  const [periods, withData, jobRunning, figuresEngine, lastData, hasRecords] = await Promise.all([
    repo.loadPeriods(db, orgId, requestId),
    repo.loadPeriodsWithData(db, orgId, requestId),
    repo.isRecalculating(db, orgId, requestId),
    repo.loadFiguresEngineVersion(db, orgId, requestId),
    repo.loadLastDataDate(db, orgId, requestId),
    /*
     * The frozen Home (ADR-068): a suspended member cannot read a single record, so the question
     * "does any accepted record exist?" would always answer no and Home would ask a suspended
     * organisation for its first file. The figures it CAN read are the ones that were on Home when
     * it was suspended, and whether they exist is the whole test.
     */
    suspended ? Promise.resolve(true) : repo.hasAcceptedRecords(db, orgId, requestId),
  ]);

  /*
   * ADR-124 D-6: figures an earlier engine version computed are not current. Until the engine-upgrade
   * recalculation replaces them they stay on screen — a stale number with a warning serves a reader
   * better than a blank page (§7.1) — but under the same "Updating your numbers" banner a running
   * recalculation gets, never as if they were today's.
   */
  const recalculating = jobRunning || (figuresEngine !== null && figuresEngine !== ENGINE_VERSION);

  /*
   * The first-run test is about RECORDS, not snapshots (ADR-058.8).
   *
   * An organisation whose only import was rolled back still has a full set of snapshots — every cash
   * figure a known zero. Asking `metric_current` would call that "ready" and build a dashboard on
   * nothing; asking whether any record survives gives the true answer, and Home goes back to asking
   * for a file.
   */
  if (!hasRecords || withData.size === 0) {
    // Nothing computed yet — but "you have not added anything" and "you added something and it is
    // waiting for you" need completely different sentences (§6). A suspended member cannot read
    // batches, and the frozen Home has no "waiting for you" — nothing can be committed.
    const pending = suspended ? null : await repo.loadPendingBatch(db, orgId, requestId);
    if (pending) {
      return {
        kind: 'awaiting_review',
        batchId: pending.id,
        filename: pending.filename,
        rowCount: pending.rowCount,
        issueCount: pending.issueCount,
      };
    }
    return { kind: 'first_run' };
  }

  const period = latestCompletePeriodByFlag(periods.filter((p) => withData.has(p.id)))
    // No complete month yet: fall back to the latest month that has data, and let the partial line
    // carry the caveat (§4, core/periods.latestCompletePeriod).
    ?? periods.find((p) => withData.has(p.id))
    ?? null;

  if (!period) return { kind: 'first_run' };

  const previous = periods
    .filter((p) => p.periodStart < period.periodStart && withData.has(p.id))[0] ?? null;

  const snapshots = await repo.loadPeriodSnapshots(db, orgId, period.id, requestId);
  const byKey = index(snapshots);

  const { cards, hidesGrossProfit, grossProfitNote, bankOnly, noPnlSource } = buildHeadlineCards({
    snapshots, period, previousLabel: previous?.label ?? null, orgSlug,
  });

  const partial = partialPeriod(periods, withData);
  let partialLine: PartialMonthLine | null = null;
  if (partial) {
    const partialSnapshots = await repo.loadPeriodSnapshots(db, orgId, partial.id, requestId);
    const partialByKey = index(partialSnapshots);
    // A side with no value (a NULL snapshot) is left out rather than printed as "—"; with neither
    // side known there is nothing to say about the month so far, so there is no line.
    const known = (row: SnapshotRow | undefined) => (row !== undefined && row.value !== null ? row : undefined);
    const inflow = known(partialByKey.get('cash_inflows'));
    const outflow = known(partialByKey.get('cash_outflows'));
    if (inflow || outflow) {
      partialLine = {
        label: `${partial.label} so far`,
        summary: [
          inflow ? `money in ${formatValue(inflow)}` : null,
          outflow ? `money out ${formatValue(outflow)}` : null,
        ].filter(Boolean).join(' · '),
        href: `/app/${orgSlug}/money/cash?period=${partial.id}`,
      };
    }
  }

  const health = await loadHealthCard(db, orgId, period.id, previous?.id ?? null, requestId);

  /*
   * The summary sentence reads the same snapshots the cards do, so it can never describe a month
   * differently from the numbers beside it. `hasPnlSource` is the inverse of the bank-only test
   * above, which is why it is derived from it rather than asked again.
   */
  const summary = summarySentence({
    periodLabel: period.label,
    currency: currencyOf(snapshots),
    netProfit: byKey.get('net_profit')?.value ?? null,
    netCashMovement: byKey.get('net_cash_movement')?.value ?? null,
    cashInflows: byKey.get('cash_inflows')?.value ?? null,
    cashOutflows: byKey.get('cash_outflows')?.value ?? null,
    hasPnlSource: !noPnlSource,
    score: health,
  });

  const view: HomeView = {
    period,
    periods: periods.filter((p) => withData.has(p.id)),
    cards,
    basisLine: basisLine(cards, lastData, period),
    partialMonth: partialLine,
    recalculating,
    hidesGrossProfit,
    grossProfitNote,
    health,
    summary,
    comparisonLabel: previous?.label ?? null,
  };

  return bankOnly ? { kind: 'bank_only', view } : { kind: 'ready', view };
}

/**
 * The twelve months ENDING at the period on screen, oldest first.
 *
 * Not simply the twelve newest periods the organisation has: a fiscal calendar runs ahead of the
 * data, and the engine writes a known zero for cash in every period — so "the newest twelve" was a
 * year of empty future months, and the chart showed 2027 to a business whose figures stop in May
 * 2026 (ADR-058.9).
 */
function trailingWindow(
  periods: readonly PeriodLabel[], endingAt: string | undefined, count: number,
): PeriodLabel[] {
  const ordered = [...periods].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const endIndex = endingAt === undefined
    ? ordered.length - 1
    : ordered.findIndex((p) => p.id === endingAt);
  const end = endIndex < 0 ? ordered.length - 1 : endIndex;
  return ordered.slice(Math.max(0, end - count + 1), end + 1);
}

/** The trend chart's three series (§4 level 3). */
export interface TrendSeries {
  readonly key: string;
  readonly label: string;
  readonly points: ReadonlyArray<{
    period: string; label: string; value: string | null; display: string;
    /** The figure as a plain number for a chart's axis only (ADR-176); null is a gap. */
    plotted: number | null;
  }>;
}

export async function loadTrend(
  db: Db,
  orgId: string,
  periods: readonly PeriodLabel[],
  requestId?: string,
  endingAt?: string,
): Promise<TrendSeries[]> {
  const window = trailingWindow(periods, endingAt, 12);
  const keys = ['revenue', 'operating_profit', 'closing_cash'];
  const rows = await repo.loadMetricSeries(db, orgId, keys, window.map((p) => p.id), requestId);

  const byKeyPeriod = new Map(rows.map((r) => [`${r.metricKey}|${r.periodId}`, r]));
  const currency = currencyOf(rows);

  return keys.map((key) => ({
    key,
    label: labelFor(key).plain,
    points: window.map((p) => ({
      period: p.id,
      label: p.label,
      // A month with no figure is a gap in the line, not a zero (§4).
      value: byKeyPeriod.get(`${key}|${p.id}`)?.value ?? null,
      // The table shows money as the cards do ("£42,351"), never the raw "42351.35" (found with sample data).
      display: (() => {
        const v = byKeyPeriod.get(`${key}|${p.id}`)?.value ?? null;
        return v === null ? '—' : formatMoney(v, { currency });
      })(),
      plotted: tryParseDecimal(byKeyPeriod.get(`${key}|${p.id}`)?.value ?? null)?.toNumber() ?? null,
    })),
  }));
}

export { BASIS_TEXT, changeFrom };

/**
 * The health score history for the chart (§Level 1).
 *
 * Read separately from `loadHome` because it is a level-1 detail on the explain page rather than
 * something Home needs before its first paint, and because a twelve-month read should not sit in
 * front of the six cards a reader came for.
 */
export async function loadHealthTrend(
  db: Db,
  orgId: string,
  periods: readonly PeriodLabel[],
  requestId?: string,
  endingAt?: string,
): Promise<{ points: readonly HealthHistoryPoint[]; labels: Map<string, string> }> {
  const window = trailingWindow(periods, endingAt, 12);
  const points = await loadHealthHistory(db, orgId, window.map((p) => p.id), requestId);
  return { points, labels: new Map(window.map((p) => [p.id, p.label])) };
}
