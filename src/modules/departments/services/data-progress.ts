import 'server-only';
import { NotFound } from '@/core/errors';
import { assertCan, can } from '@/core/permissions';
import { systemClock, todayInTimeZone } from '@/core/periods';
import { listBankAccounts, type BankAccount } from '@/modules/banking';
import {
  basisLine, buildHeadlineCards, isRecalculating, latestCompletePeriodByFlag, loadAccountsPage, loadPeriodSnapshots,
  loadPeriodSummary, loadPeriods, type PeriodLabel,
} from '@/modules/dashboard';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import { loadTaxDates, type TaxDates } from '@/modules/tax';
import { moduleOn, type AccessContext } from '@/modules/tenancy';
import * as repo from '../data/repository';
import * as progressRepo from '../data/progress-repository';
import type { BatchRow, RunFacts } from '../data/progress-repository';
import {
  PROGRESS_SOURCES, SOURCE_LABELS, batchPipeline, coverageByMonth, headlineStatus, markGaps, missingMonths, monthKeys, monthsBetween, monthLabel,
  monthList, orderBlockers, previousMonth, shortDate, sourceOf,
  type Blocker, type CoverageCell, type DateRange, type Headline, type PipelineView, type ProgressSource,
} from '../domain/data-progress';

/**
 * Data progress — `/app/<slug>/data/progress`, opened from the dashboard's Compliance View card
 * (owner, 2026-11-02): where each upload is in the pipeline, which months each source covers, and
 * what is stuck, from the company's own records. Asked of someone who keeps the data
 * (`imports.review`); each further line is asked only of someone who may read it (bank accounts,
 * the chart of accounts, bank categories, tax dates, calculation runs), and is left out otherwise.
 * It computes no figure: statuses, dates and counts the Imports, Banking, Accounts and Tax pages read.
 */

/** How many uploads each source lists; the rest are on the Imports page. */
const BATCHES_SHOWN = 3;
/** The month strip: twelve months ending with this one. */
const STRIP_MONTHS = 12;

export interface ProgressBatchView {
  readonly id: string;
  readonly href: string;
  readonly filename: string;
  readonly importType: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly rows: number;
  readonly addedAt: string | null;
  readonly pipeline: PipelineView;
  /** A failed upload's error, in the words it was recorded with. */
  readonly error: string | null;
}

export interface ProgressSourceView {
  readonly key: string;
  readonly source: ProgressSource;
  readonly label: string;
  /** The bank and masked number, or what the source is for. */
  readonly sublabel: string | null;
  /** "Covers to 31 Aug 2026" — the end of its latest upload in the books; null when none is. */
  readonly reach: string | null;
  readonly batches: readonly ProgressBatchView[];
  readonly more: number;
}

export interface CoverageMonthView {
  readonly key: string;            // "2026-08"
  readonly label: string;          // "Aug 2026"
  readonly short: string;          // "Aug"
  readonly current: boolean;       // this month, still running
  /** `fiscal_periods.is_complete` as the engine wrote it; null when APX has no such month yet. */
  readonly complete: boolean | null;
}

export interface CoverageRowView {
  readonly key: string;
  readonly label: string;
  readonly cells: readonly CoverageCell[];
}

export interface DataProgressView {
  readonly headline: Headline;
  readonly lastDataAdded: string | null;
  /** The latest calculation run; null when none ran or the reader may not see runs. */
  readonly lastRun: { readonly status: string; readonly at: string | null; readonly engineVersion: string | null } | null;
  /** When the figures on screen were calculated (the latest successful run). */
  readonly lastSuccessAt: string | null;
  readonly seesRuns: boolean;
  readonly sources: readonly ProgressSourceView[];
  readonly coverage: { readonly months: readonly CoverageMonthView[]; readonly rows: readonly CoverageRowView[] };
  readonly blockers: readonly Blocker[];
  readonly canAddData: boolean;
}

// ---------------------------------------------------------------------------------------------
// Shared with the dashboard's Compliance View card
// ---------------------------------------------------------------------------------------------

/**
 * "Updating your numbers" as Home decides it (ADR-124 D-6): a calculation is queued or running, or
 * the figures on screen were made by an earlier engine version and are about to be replaced.
 */
export async function figuresUpdating(ctx: AccessContext, succeeded: RunFacts | null): Promise<boolean> {
  return updating(await isRecalculating(ctx.db, ctx.orgId!, ctx.requestId), succeeded);
}

const updating = (running: boolean, succeeded: RunFacts | null) =>
  running || (succeeded?.engineVersion != null && succeeded.engineVersion !== ENGINE_VERSION);

export const isCommitted = (b: BatchRow) => b.status === 'committed' && b.rolledBackAt === null;

/**
 * Failed uploads that still matter: a failure stops counting once a later upload of the same source
 * (and bank account) was accepted in its place. The card and the Data progress page share this rule,
 * so their counts always agree.
 */
export function unresolvedFailures(batches: readonly BatchRow[]): BatchRow[] {
  const sameSource = (a: BatchRow, b: BatchRow) => sourceOf(a.importType) === sourceOf(b.importType) && a.bankAccountId === b.bankAccountId;
  return batches.filter((b) => b.status === 'failed' && !batches.some((later) => later !== b && sameSource(later, b)
    && (later.createdAt ?? '') > (b.createdAt ?? '') && ['awaiting_review', 'committing', 'committed'].includes(later.status)));
}

/** Uploads waiting for review, failed uploads (still unresolved) and the last committed date, from one read of the batches. */
export function importFacts(batches: readonly BatchRow[]): { awaitingReview: number; failed: number; lastDataAdded: string | null } {
  return {
    awaitingReview: batches.filter((b) => b.status === 'awaiting_review').length,
    failed: unresolvedFailures(batches).length,
    lastDataAdded: batches.filter(isCommitted).map((b) => b.committedAt).filter((d): d is string => d !== null).sort().at(-1) ?? null,
  };
}

/**
 * The basis line Home printed (§4 level 1): the sources of the latest complete month's figures, when
 * data was last added, and that month — "Based on your accounts, bank statements and invoices · Last
 * data added 29 Oct 2026 · Sep 2026 (latest complete month)". Of `candidates` (newest first, with
 * figures), the latest complete one, else the newest.
 */
export async function complianceBasisLine(
  ctx: AccessContext, candidates: readonly PeriodLabel[], lastDataAdded: string | null,
): Promise<string> {
  const period = latestCompletePeriodByFlag(candidates) ?? candidates[0] ?? null;
  if (period === null) return '';
  const snapshots = await loadPeriodSnapshots(ctx.db, ctx.orgId!, period.id, ctx.requestId);
  const { cards } = buildHeadlineCards({ snapshots, period, previousLabel: null, orgSlug: ctx.orgSlug ?? '' });
  return basisLine(cards, lastDataAdded, period);
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

const ym = (iso: string | null) => (iso === null ? null : iso.slice(0, 7));
const rangeOf = (b: BatchRow): DateRange | null => (b.periodStart && b.periodEnd ? { start: b.periodStart, end: b.periodEnd } : null);
const ranges = (batches: readonly BatchRow[]) => batches.map(rangeOf).filter((r): r is DateRange => r !== null);
const rowsOf = (b: BatchRow) => Object.values(b.rowCounts).reduce((n, v) => n + v, 0);
const accountName = (a: BankAccount | undefined) => a?.name ?? 'Bank account';

export async function loadDataProgress(ctx: AccessContext): Promise<DataProgressView> {
  assertCan(ctx, 'imports.review');
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const base = `/app/${ctx.orgSlug ?? ''}`;
  const seesFinancials = can(ctx, 'financials.view');
  const seesBankAccounts = seesFinancials || can(ctx, 'banking.view');
  const seesBanking = can(ctx, 'banking.view') && moduleOn(ctx, 'banking');
  const seesTax = seesFinancials && moduleOn(ctx, 'tax');
  const seesRuns = seesFinancials || can(ctx, 'reports.view');
  const canAddData = can(ctx, 'imports.create');

  const [batches, runs, periods, accounts, chart, tax, basics, running] = await Promise.all([
    progressRepo.allBatches(ctx.db, orgId),
    seesRuns ? progressRepo.latestRuns(ctx.db, orgId) : Promise.resolve({ latest: null, succeeded: null }),
    loadPeriods(ctx.db, orgId, ctx.requestId),
    seesBankAccounts ? listBankAccounts(ctx.db, orgId, ctx.requestId) : Promise.resolve([] as BankAccount[]),
    seesFinancials ? loadAccountsPage(ctx.db, orgId, ctx.requestId) : Promise.resolve(null),
    seesTax ? loadTaxDates(ctx) : Promise.resolve(null as TaxDates | null),
    repo.organisationBasics(ctx.db, orgId),
    isRecalculating(ctx.db, orgId, ctx.requestId),
  ]);
  const recalculating = updating(running, runs.succeeded);
  const today = todayInTimeZone(systemClock, basics.timezone);
  const thisMonth = today.slice(0, 7);
  const lastWholeMonth = previousMonth(thisMonth);

  const lastSuccessAt = runs.succeeded?.finishedAt ?? null;
  const lastRunFailed = runs.latest?.status === 'failed';
  const failedRunStart = lastRunFailed ? runs.latest?.startedAt ?? null : null;
  const pipelineOf = (b: BatchRow) => batchPipeline({
    status: b.status,
    committedAt: b.committedAt,
    errorStage: b.errorStage,
    recalculatedAt: lastSuccessAt,
    recalculating,
    runFailedSinceCommit: failedRunStart !== null && b.committedAt !== null && failedRunStart >= b.committedAt,
  });

  // ---- Sources: each bank account, then the other five ----
  const tracked = batches.filter((b) => sourceOf(b.importType) !== null);
  const accountById = new Map(accounts.map((a) => [a.id, a] as const));
  const bankBatches = tracked.filter((b) => sourceOf(b.importType) === 'bank');
  const bankKeys = [...new Set([
    ...accounts.filter((a) => a.isActive).map((a) => a.id),
    ...bankBatches.map((b) => b.bankAccountId ?? 'none'),
  ])];
  const groups: Array<{ key: string; source: ProgressSource; label: string; sublabel: string | null; batches: BatchRow[] }> = [];
  for (const key of bankKeys) {
    const account = accountById.get(key);
    groups.push({
      key: `bank:${key}`, source: 'bank',
      label: key === 'none' ? 'Bank statements' : `Bank · ${accountName(account)}`,
      sublabel: account ? [account.bankName, account.accountNumberMasked].filter(Boolean).join(' · ') || null : null,
      batches: bankBatches.filter((b) => (b.bankAccountId ?? 'none') === key),
    });
  }
  if (bankKeys.length === 0) groups.push({ key: 'bank:none', source: 'bank', label: 'Bank statements', sublabel: null, batches: [] });
  for (const source of PROGRESS_SOURCES.filter((s) => s !== 'bank')) {
    groups.push({ key: source, source, label: SOURCE_LABELS[source], sublabel: null, batches: tracked.filter((b) => sourceOf(b.importType) === source) });
  }

  const shown = groups.flatMap((g) => g.batches.slice(0, BATCHES_SHOWN));
  const failedShown = batches.filter((b) => b.status === 'failed' || b.status === 'awaiting_review');
  // Uncategorised bank transactions are asked of the latest month a statement in the books covers.
  const periodByMonth = new Map(periods.map((p) => [p.periodStart.slice(0, 7), p] as const));
  const bankCommitted = bankBatches.filter(isCommitted);
  const bankMonth = ym(bankCommitted.map((b) => b.periodEnd).filter((d): d is string => d !== null).sort().at(-1) ?? null);
  const bankPeriod = bankMonth === null ? null : periodByMonth.get(bankMonth > thisMonth ? thisMonth : bankMonth) ?? null;
  const [names, summary] = await Promise.all([
    progressRepo.documentNames(ctx.db, orgId,
      [...shown, ...failedShown].map((b) => b.sourceDocumentId).filter((id): id is string => id !== null)),
    seesBanking && bankPeriod !== null
      ? loadPeriodSummary(ctx.db, orgId, bankPeriod.id, ctx.requestId).catch(() => null) : Promise.resolve(null),
  ]);
  const fileOf = (b: BatchRow) => (b.sourceDocumentId === null ? 'Untitled file' : names.get(b.sourceDocumentId) ?? 'Untitled file');
  const batchView = (b: BatchRow): ProgressBatchView => ({
    id: b.id, href: `${base}/data/imports/${b.id}`, filename: fileOf(b), importType: b.importType,
    periodStart: b.periodStart, periodEnd: b.periodEnd, rows: rowsOf(b), addedAt: b.committedAt ?? b.createdAt,
    pipeline: pipelineOf(b), error: b.status === 'failed' ? b.errorMessage : null,
  });
  const sources: ProgressSourceView[] = groups.map((g) => {
    const reach = g.batches.filter(isCommitted).map((b) => b.periodEnd).filter((d): d is string => d !== null).sort().at(-1) ?? null;
    return {
      key: g.key, source: g.source, label: g.label, sublabel: g.sublabel,
      reach: reach === null ? null : `Covers to ${shortDate(reach)}`,
      batches: g.batches.slice(0, BATCHES_SHOWN).map(batchView),
      more: Math.max(0, g.batches.length - BATCHES_SHOWN),
    };
  });

  // ---- Month coverage ----
  const stripKeys = monthKeys(thisMonth, STRIP_MONTHS);
  const months: CoverageMonthView[] = stripKeys.map((key) => ({
    key, label: monthLabel(key), short: monthLabel(key).slice(0, 3), current: key === thisMonth,
    complete: periodByMonth.get(key)?.isComplete ?? null,
  }));
  const rows = groups
    .map((g) => ({ key: g.key, label: g.label, committed: g.batches.filter(isCommitted) }))
    .filter((g) => g.committed.length > 0)
    .map((g) => ({ key: g.key, label: g.label, committed: g.committed }));

  // ---- What we are stuck on ----
  const blockers: Blocker[] = [];
  const committed = tracked.filter(isCommitted);
  const actuals = committed.filter((b) => sourceOf(b.importType) !== 'budget');

  if (lastRunFailed && !recalculating) {
    blockers.push({
      kind: 'run_failed', needsYou: false, at: failedRunStart,
      sentence: `The last update of your figures${failedRunStart ? ` (started ${shortDate(failedRunStart)})` : ''} failed.`,
      detail: lastSuccessAt
        ? `The figures on screen are from the update that finished ${shortDate(lastSuccessAt)}. Adding or re-checking data starts a new update.`
        : 'No update has finished yet, so there are no figures to show. Adding or re-checking data starts a new update.',
      action: { label: 'Check your uploads', href: `${base}/data/imports` },
    });
  }

  // A failed upload matters until a later upload of the same source (and bank account) took its place.
  for (const b of unresolvedFailures(tracked)) {
    blockers.push({
      kind: 'upload_failed', needsYou: true, at: b.createdAt,
      sentence: `“${fileOf(b)}” could not be read, so it is not in your figures.`,
      detail: b.errorMessage,
      action: { label: 'Open the upload', href: `${base}/data/imports/${b.id}` },
    });
  }
  for (const b of tracked.filter((x) => x.status === 'awaiting_review')) {
    const isBank = sourceOf(b.importType) === 'bank';
    const noBalances = isBank && (b.statementOpening === null || b.statementClosing === null);
    blockers.push({
      kind: 'awaiting_review', needsYou: true, at: b.createdAt,
      sentence: `“${fileOf(b)}” is waiting for your review. Nothing in it counts until you press Import.`,
      detail: noBalances ? 'Enter the statement’s printed opening and closing balances while you review it.' : null,
      action: { label: 'Review it', href: `${base}/data/imports/${b.id}` },
    });
  }

  // Bank accounts: an opening balance, a statement at all, and the months their statements miss.
  const reachYm = [ym(actuals.map((b) => b.periodEnd).filter((d): d is string => d !== null).sort().at(-1) ?? null), lastWholeMonth]
    .filter((m): m is string => m !== null).sort()[0] ?? null;
  for (const account of accounts.filter((a) => a.isActive)) {
    const mine = committed.filter((b) => sourceOf(b.importType) === 'bank' && b.bankAccountId === account.id);
    const pending = tracked.some((b) => sourceOf(b.importType) === 'bank' && b.bankAccountId === account.id && b.status === 'awaiting_review');
    const knownOpening = account.openingBalance !== null && account.openingBalanceDate !== null;
    if (seesFinancials && !knownOpening && mine.length > 0 && !mine.some((b) => b.statementOpening !== null)) {
      blockers.push({
        kind: 'no_opening_balance', needsYou: true,
        sentence: `No opening balance is entered for ${account.name}, and its statements carry none, so its cash balance cannot be shown.`,
        detail: null,
        action: { label: 'Enter opening balance', href: `${base}/money/cash` },
      });
    }
    if (mine.length === 0) {
      if (!pending) {
        blockers.push({
          kind: 'no_statement', needsYou: true,
          sentence: `No bank statement has been added for ${account.name} yet.`,
          detail: null,
          action: canAddData ? { label: 'Add a statement', href: `${base}/data/imports/new` } : null,
        });
      }
      continue;
    }
    const first = ym(ranges(mine).map((r) => r.start).sort()[0] ?? null);
    const gaps = first !== null && reachYm !== null ? missingMonths(ranges(mine), first, reachYm) : [];
    if (gaps.length > 0) {
      blockers.push({
        kind: 'bank_gap', needsYou: true, at: gaps.at(-1),
        sentence: `No bank statement for ${monthList(gaps)} (${account.name}).`,
        detail: 'Cash and spending for those months are missing until a statement covering them is added.',
        action: canAddData ? { label: 'Add a statement', href: `${base}/data/imports/new` } : null,
      });
    }
  }

  // Months inside the trading range that no source covers at all.
  const tradingFrom = ym(ranges(actuals).map((r) => r.start).sort()[0] ?? null);
  const monthGaps = tradingFrom !== null && reachYm !== null ? missingMonths(ranges(actuals), tradingFrom, reachYm) : [];
  if (monthGaps.length > 0) {
    blockers.push({
      kind: 'month_gap', needsYou: true, at: monthGaps.at(-1),
      sentence: `No data at all for ${monthList(monthGaps)}.`,
      detail: `Your uploads run from ${monthLabel(tradingFrom!)} but none covers ${monthGaps.length === 1 ? 'that month' : 'those months'}, so ${monthGaps.length === 1 ? 'it has' : 'they have'} no figures.`,
      action: canAddData ? { label: 'Add data', href: `${base}/data/imports/new` } : null,
    });
  }

  // Finished months after the latest upload: one is the usual wait for a statement; two or more need you.
  const latestEnd = actuals.map((b) => b.periodEnd).filter((d): d is string => d !== null).sort().at(-1) ?? null;
  const behind = latestEnd === null || ym(latestEnd)! >= lastWholeMonth ? [] : monthsBetween(ym(latestEnd)!, lastWholeMonth).slice(1);
  if (behind.length > 0) {
    blockers.push({
      kind: 'behind', needsYou: behind.length >= 2, at: latestEnd,
      sentence: `Your data runs to ${shortDate(latestEnd)}: nothing covers ${monthList(behind)} yet.`,
      detail: 'Add the latest bank statement and accounts to bring your figures up to date.',
      action: canAddData ? { label: 'Add data', href: `${base}/data/imports/new` } : null,
    });
  }

  if (chart !== null && chart.unmappedCount > 0) {
    blockers.push({
      kind: 'unmapped_accounts', needsYou: true,
      sentence: chart.unmappedCount === 1
        ? 'One account has no category yet, so what went through it is left out of your profit figures.'
        : `${chart.unmappedCount} accounts have no category yet, so what went through them is left out of your profit figures.`,
      detail: null,
      action: { label: 'Choose categories', href: `${base}/data/accounts` },
    });
  }

  // Uncategorised bank transactions in the latest month a statement covers.
  if (summary !== null && bankPeriod !== null) {
    const total = summary?.accounts.reduce((n, a) => n + a.row_count, 0) ?? 0;
    const open = summary?.accounts.reduce((n, a) => n + a.uncategorised_count, 0) ?? 0;
    if (open > 0) {
      blockers.push({
        kind: 'uncategorised', needsYou: open * 20 >= total, // 5% or more: the bank figures' warning line
        sentence: `${open} of ${total} bank transactions in ${monthLabel(bankPeriod.periodStart)} have no category yet.`,
        detail: 'Until they have one, spending by category for that month is incomplete.',
        action: { label: 'Categorise them', href: `${base}/money/banking/transactions?period=${bankPeriod.id}&filter=uncategorised` },
      });
    }
  }

  const unbalanced = bankCommitted.filter((b) => b.statementOpening === null || b.statementClosing === null);
  if (unbalanced.length > 0) {
    blockers.push({
      kind: 'balances_missing', needsYou: false,
      sentence: unbalanced.length === 1
        ? 'One bank statement in your figures has no printed opening and closing balance, so it cannot be checked against the bank.'
        : `${unbalanced.length} bank statements in your figures have no printed opening and closing balance, so they cannot be checked against the bank.`,
      detail: 'A statement that prints its balances (most PDF statements do) can be checked line by line.',
      action: seesBanking ? { label: 'See bank reconciliation', href: `${base}/money/banking` } : null,
    });
  }

  const notCounted = recalculating || lastRunFailed ? [] : committed.filter((b) => b.committedAt !== null && (lastSuccessAt === null || b.committedAt > lastSuccessAt));
  if (seesRuns && notCounted.length > 0) {
    blockers.push({
      kind: 'waiting_recalc', needsYou: false,
      sentence: notCounted.length === 1
        ? 'One upload is in the books but not in your figures yet.'
        : `${notCounted.length} uploads are in the books but not in your figures yet.`,
      detail: 'They are counted at the next update of your figures; nothing is needed from you.',
      action: null,
    });
  }

  if (tax !== null) {
    const taxHref = can(ctx, 'settings.manage') ? `${base}/settings` : `${base}/money/tax`;
    const taxLabel = can(ctx, 'settings.manage') ? 'Open tax settings' : 'Open Tax';
    if (tax.vatRegistered === null) {
      blockers.push({
        kind: 'vat_setup', needsYou: true,
        sentence: 'VAT is not set up, so APX cannot give your VAT quarter dates or a VAT estimate.',
        detail: 'Say whether the company is VAT registered and which months its quarters end.',
        action: { label: taxLabel, href: taxHref },
      });
    } else if (tax.vatRegistered === true && tax.vatQuarter === null) {
      blockers.push({
        kind: 'vat_setup', needsYou: true,
        sentence: 'The company is VAT registered, but its quarter months are not set, so the quarter dates are unknown.',
        detail: null,
        action: { label: taxLabel, href: taxHref },
      });
    }
    if (tax.corporationTax === null) {
      blockers.push({
        kind: 'ct_unknown', needsYou: false,
        sentence: 'No Corporation Tax date yet: it is worked out once a complete month is in your figures.',
        detail: null,
        action: canAddData ? { label: 'Add data', href: `${base}/data/imports/new` } : null,
      });
    } else if (tax.corporationTax.dueDate < today) {
      blockers.push({
        kind: 'ct_overdue', needsYou: true,
        sentence: `Corporation Tax for the year to ${shortDate(tax.corporationTax.yearEnd)} was due on ${shortDate(tax.corporationTax.dueDate)}.`,
        detail: 'APX states the date only; it does not check whether the return was filed.',
        action: { label: 'Open Tax', href: `${base}/money/tax` },
      });
    }
  }

  // A budget is a plan and a balance sheet a statement at a date: a month between two of them is not missing.
  const coverageRows: CoverageRowView[] = rows.map((r) => ({
    key: r.key, label: r.label, cells: markGaps(coverageByMonth(ranges(r.committed), stripKeys), stripKeys, r.key === 'budget' || r.key === 'balance_sheet' ? null : reachYm),
  }));
  const ordered = orderBlockers(blockers);
  const facts = importFacts(batches);
  return {
    headline: headlineStatus({
      recalculating, lastRunFailed, needsYou: ordered.filter((b) => b.needsYou).length, waitingForUpdate: seesRuns ? notCounted.length : 0,
    }),
    lastDataAdded: facts.lastDataAdded,
    lastRun: runs.latest === null ? null : { status: runs.latest.status, at: runs.latest.finishedAt ?? runs.latest.startedAt, engineVersion: runs.latest.engineVersion },
    lastSuccessAt,
    seesRuns,
    sources,
    coverage: { months, rows: coverageRows },
    blockers: ordered,
    canAddData,
  };
}
