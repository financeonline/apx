import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callApi } from '@/core/db';
import type { AssuranceLevel } from '@/core/assurance';
import { Decimal, formatMoney, formatPercent } from '@/core/money';
import { varianceKey } from '@/modules/financial-engine';
import {
  countBankTransactions, listBankAccounts, listBankTransactions, listRecurringGroups,
  loadBankTransaction, loadLatestGroupMembers, looksLikeTransfer,
  type BankAccount, type BankTransaction, type BankTransactionFilter, type RecurringGroupRow,
} from '@/modules/banking';
import { listAccounts, type StandardCategory } from '@/modules/financials';
import { statusFor, type StatusBadge } from '../domain/status';
import type { MetricCardView, PeriodLabel, SnapshotRow } from '../domain/view-models';
import { formatValue } from '../domain/view-models';
import * as repo from '../data/repository';
import { loadAlertsPage, type AlertView } from './alerts';
import {
  CATEGORY_LABELS, TRANSACTION_PAGE_SIZE, accountReference, isUncategorised, toCashAccount,
  toFigure, toTransactionView, type PeriodScope, type TransactionView,
} from './money';

/**
 * Banking Intelligence view models (Phase 13, ADR-101; REQ-BK-01…11; UX_ARCHITECTURE.md §4).
 *
 * Every figure here is either read from `metric_current` (the engine's own cash family) or from
 * `api.bank_period_summary` (an aggregation of the same accepted rows under the same transfer rule,
 * asserted equal to the engine in `test/integration/banking.test.ts`). Nothing is worked out twice.
 * Nothing here claims a bank connection: `source` is stated by the summary function and rendered
 * as a sentence on every banking page (CD-21, REQ-BK-10).
 */

// ---------------------------------------------------------------------------------------------
// Summary shape (api.bank_period_summary)
// ---------------------------------------------------------------------------------------------

interface SummaryAccount {
  readonly bank_account_id: string;
  readonly inflow: string;
  readonly outflow: string;
  readonly transfers_in: string;
  readonly transfers_out: string;
  readonly row_count: number;
  readonly uncategorised_count: number;
  readonly transfer_count: number;
  readonly first_date: string | null;
  readonly last_date: string | null;
  readonly last_balance_after: string | null;
  readonly last_balance_date: string | null;
}

interface SummaryCategory {
  readonly standard_category: string;
  readonly inflow: string;
  readonly outflow: string;
  readonly row_count: number;
}

export interface SummaryStatement {
  readonly batch_id: string;
  readonly bank_account_id: string | null;
  readonly period_start: string;
  readonly period_end: string;
  readonly committed_at: string;
  readonly statement_opening_balance: string | null;
  readonly statement_closing_balance: string | null;
  readonly extraction_method: string;
  readonly unreconciled: boolean;
}

interface PeriodSummary {
  readonly accounts: readonly SummaryAccount[];
  readonly categories: readonly SummaryCategory[];
  readonly statements: readonly SummaryStatement[];
  readonly latest_statement: { committed_at: string; period_end: string; bank_account_id: string | null } | null;
  readonly source: 'imported_statements';
}

export async function loadPeriodSummary(
  db: SupabaseClient, orgId: string, periodId: string, requestId?: string,
): Promise<PeriodSummary> {
  return callApi<PeriodSummary>(db, 'bank_period_summary', { p_org: orgId, p_period: periodId }, requestId);
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

export const ACCOUNT_TYPE_LABELS: Readonly<Record<BankAccount['accountType'], string>> = {
  current: 'Current account',
  savings: 'Savings account',
  credit_card: 'Credit card',
  loan: 'Loan',
  other: 'Account',
};

export const CADENCE_LABELS: Readonly<Record<string, string>> = {
  weekly: 'every week',
  fortnightly: 'every two weeks',
  monthly: 'every month',
  quarterly: 'every quarter',
  annual: 'every year',
  irregular: 'now and then',
};

export const RECURRING_STATUS_LABELS: Readonly<Record<RecurringGroupRow['status'], string>> = {
  active: 'Regular',
  changed: 'Amount changed',
  stopped: 'Stopped',
};

/**
 * The one sentence every banking page carries about where the data comes from (CD-21). There is
 * no live provider; saying so plainly is part of the product, not a caveat.
 */
export const BANK_SOURCE_SENTENCE =
  'Bank figures come from the statements you have uploaded. APX is not connected to your bank.';

export type ReconciliationStatus = 'reconciled' | 'unreconciled' | 'balances_missing' | 'no_statement';

export const RECONCILIATION_LABELS: Readonly<Record<ReconciliationStatus, string>> = {
  reconciled: 'Reconciled',
  unreconciled: 'Does not reconcile',
  balances_missing: 'Not checked',
  no_statement: 'No statement',
};

const RECONCILIATION_TEXT: Readonly<Record<ReconciliationStatus, string>> = {
  reconciled: 'The rows on the statement add up to the opening and closing balances printed on it.',
  unreconciled: 'The rows on the statement did not add up to its printed balances when it was imported, so the figures from it are marked as needing a check.',
  balances_missing: 'The balances printed on the statement were not captured, so APX could not check the rows against them. They can be typed in on the import page.',
  no_statement: 'No uploaded statement covers this month for this account.',
};

// ---------------------------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------------------------

export interface BankingSourceView {
  readonly sentence: string;
  /** "Last statement imported 21 September 2026, covering to 31 August 2026" — or null before any. */
  readonly lastStatement: { readonly committedAt: string; readonly coveringTo: string; readonly accountName: string | null } | null;
}

export interface ReconciliationView {
  readonly status: ReconciliationStatus;
  readonly label: string;
  readonly sentence: string;
}

export interface BankAccountCardView {
  readonly id: string;
  readonly name: string;
  readonly bankName: string;
  readonly reference: string;
  readonly typeLabel: string;
  readonly accountType: BankAccount['accountType'];
  readonly currency: string;
  readonly isCashLike: boolean;
  /** The balance printed on the statement at its last line in the month — a fact, not a figure. */
  readonly statementBalance: { readonly value: string; readonly asAt: string } | null;
  readonly moneyIn: string;
  readonly moneyOut: string;
  readonly net: string;
  readonly netRaw: string;
  readonly transfersBetweenOwnAccounts: string | null;
  readonly rowCount: number;
  readonly uncategorisedCount: number;
  readonly freshness: { readonly coveringTo: string; readonly committedAt: string } | null;
  readonly reconciliation: ReconciliationView;
  readonly needsOpeningBalance: boolean;
  readonly href: string;
}

export interface NoticeView {
  readonly kind: 'alert' | 'lookalike' | 'uncategorised' | 'reconciliation';
  readonly tone: 'neutral' | 'warn' | 'danger';
  readonly text: string;
  readonly href: string | null;
}

export interface RecurringPaymentView {
  readonly id: string;
  readonly description: string;
  readonly direction: 'in' | 'out';
  readonly accountName: string;
  readonly cadenceLabel: string;
  readonly expected: string;
  readonly expectedRaw: string;
  readonly last: string;
  readonly lastRaw: string;
  readonly changed: boolean;
  readonly lastSeen: string;
  readonly nextExpected: string | null;
  readonly status: RecurringGroupRow['status'];
  readonly statusLabel: string;
  readonly occurrences: number;
  readonly href: string;
}

export interface CategoryShareView {
  readonly category: string;
  readonly label: string;
  readonly outflow: string;
  readonly outflowRaw: string;
  readonly inflow: string;
  readonly share: string | null;
  readonly rowCount: number;
}

export interface LiquidityView {
  readonly cashAvailable: MetricCardView | null;
  readonly runway: MetricCardView | null;
  readonly netMovement: MetricCardView | null;
  readonly trend: { readonly direction: 'rising' | 'falling' | 'mixed' | 'insufficient'; readonly sentence: string };
  readonly concentration: { readonly share: string | null; readonly accountName: string | null; readonly sentence: string };
}

export interface OrgReconciliationView {
  readonly statementClosing: string | null;
  readonly motionClosing: string | null;
  readonly delta: string | null;
  readonly status: 'matches' | 'differs' | 'unchecked';
  readonly sentence: string;
}

export interface BankingOverview {
  readonly scope: PeriodScope;
  readonly currency: string;
  readonly source: BankingSourceView;
  /** Cash available, money in, money out, net movement — the engine's rows, in that order. */
  readonly headline: readonly MetricCardView[];
  readonly notices: readonly NoticeView[];
  readonly accounts: readonly BankAccountCardView[];
  readonly recurring: readonly RecurringPaymentView[];
  readonly categories: readonly CategoryShareView[];
  readonly liquidity: LiquidityView;
  readonly reconciliation: OrgReconciliationView;
  /** Data-quality codes on the month's cash figures, for the page to render with the shared copy. */
  readonly dataQualityCodes: readonly string[];
  readonly counts: { readonly transactions: number; readonly uncategorised: number; readonly lookalikes: number };
}

const CASH_LIKE = new Set<BankAccount['accountType']>(['current', 'savings']);
const BANKING_ALERT_KEYS = new Set([
  'bank.unusual_transaction', 'duplicate.transaction', 'recurring.amount_changed',
  'recurring.missed', 'recurring.inflow_missed', 'recurring.new', 'cash.decline', 'cash.runway_low',
]);

function money(value: string, currency: string, signed = false): string {
  return formatMoney(value, { currency, showMinorUnits: true, ...(signed ? { signDisplay: 'always' as const } : {}) });
}

function index(rows: readonly SnapshotRow[]): Map<string, SnapshotRow> {
  const map = new Map<string, SnapshotRow>();
  for (const row of rows) if (row.dimensionType === 'none') map.set(row.metricKey, row);
  return map;
}

/** Exported unchanged for Funding Readiness F3.4 (PHASE_16 §5.3: "reused unchanged"). */
export function reconciliationFor(
  accountId: string, statements: readonly SummaryStatement[],
): ReconciliationView {
  const mine = statements.filter((s) => s.bank_account_id === accountId);
  const status: ReconciliationStatus =
    mine.length === 0 ? 'no_statement'
      : mine.some((s) => s.unreconciled) ? 'unreconciled'
        : mine.some((s) => s.statement_closing_balance === null || s.statement_opening_balance === null) ? 'balances_missing'
          : 'reconciled';
  return { status, label: RECONCILIATION_LABELS[status], sentence: RECONCILIATION_TEXT[status] };
}

function freshnessFor(
  accountId: string, statements: readonly SummaryStatement[],
): BankAccountCardView['freshness'] {
  const mine = statements.filter((s) => s.bank_account_id === accountId)
    .sort((a, b) => (a.committed_at < b.committed_at ? 1 : -1));
  const latest = mine[0];
  return latest ? { coveringTo: latest.period_end, committedAt: latest.committed_at } : null;
}

/** Account cards for one month, from the summary and the accounts table. */
export function bankAccountCards(
  orgSlug: string,
  accounts: readonly BankAccount[],
  summary: PeriodSummary,
  periodId: string,
): BankAccountCardView[] {
  const bySummary = new Map(summary.accounts.map((a) => [a.bank_account_id, a] as const));
  return accounts
    .filter((a) => a.isActive)
    .map((account) => {
      const s = bySummary.get(account.id);
      const inflow = s?.inflow ?? '0';
      const outflow = s?.outflow ?? '0';
      const net = new Decimal(inflow).minus(outflow);
      const transfers = s ? new Decimal(s.transfers_in).plus(s.transfers_out) : new Decimal(0);
      return {
        id: account.id,
        name: account.name,
        bankName: account.bankName,
        reference: accountReference(account),
        typeLabel: ACCOUNT_TYPE_LABELS[account.accountType],
        accountType: account.accountType,
        currency: account.currency,
        isCashLike: CASH_LIKE.has(account.accountType),
        statementBalance: s?.last_balance_after && s.last_balance_date
          ? { value: money(s.last_balance_after, account.currency), asAt: s.last_balance_date }
          : null,
        moneyIn: money(inflow, account.currency),
        moneyOut: money(outflow, account.currency),
        net: money(net.toFixed(2), account.currency, true),
        netRaw: net.toFixed(2),
        transfersBetweenOwnAccounts: transfers.isZero() ? null : money(transfers.toFixed(2), account.currency),
        rowCount: s?.row_count ?? 0,
        uncategorisedCount: s?.uncategorised_count ?? 0,
        freshness: freshnessFor(account.id, summary.statements),
        reconciliation: reconciliationFor(account.id, summary.statements),
        needsOpeningBalance: toCashAccount(account).needsOpeningBalance,
        href: `/app/${orgSlug}/money/banking/transactions?period=${periodId}&account=${account.id}`,
      };
    });
}

/** Where money went, by standard category — bank movement, not the P&L (Phase 13 brief §5). */
export function categoryShares(summary: PeriodSummary, currency: string): CategoryShareView[] {
  const total = summary.categories.reduce((acc, c) => acc.plus(c.outflow), new Decimal(0));
  return [...summary.categories]
    .sort((a, b) => new Decimal(b.outflow).comparedTo(new Decimal(a.outflow)))
    .map((c) => {
      const out = new Decimal(c.outflow);
      const label = c.standard_category === 'uncategorised'
        ? 'Not yet categorised'
        : CATEGORY_LABELS[c.standard_category as StandardCategory] ?? c.standard_category;
      return {
        category: c.standard_category,
        label,
        outflow: money(c.outflow, currency),
        outflowRaw: out.toFixed(2),
        inflow: money(c.inflow, currency),
        share: total.isZero() || out.isZero() ? null : formatPercent(out.dividedBy(total).toFixed(6)),
        rowCount: c.row_count,
      };
    });
}

function describeGroup(
  group: RecurringGroupRow,
  member: { description: string | null; amount: string } | undefined,
  accountNames: ReadonlyMap<string, string>,
  currency: string,
  orgSlug: string,
): RecurringPaymentView {
  const lastRaw = member ? new Decimal(member.amount).abs().toFixed(2) : group.expectedAmount;
  const tolerance = new Decimal(group.expectedAmount).times(group.amountToleranceRatio);
  const changed = new Decimal(lastRaw).minus(group.expectedAmount).abs().greaterThan(tolerance);
  return {
    id: group.id,
    description: member?.description ?? group.counterpartyKey,
    direction: group.direction === 'inflow' ? 'in' : 'out',
    accountName: (group.bankAccountId && accountNames.get(group.bankAccountId)) || 'Unknown account',
    cadenceLabel: CADENCE_LABELS[group.cadence] ?? group.cadence,
    expected: money(group.expectedAmount, currency),
    expectedRaw: new Decimal(group.expectedAmount).toFixed(2),
    last: money(lastRaw, currency),
    lastRaw,
    changed,
    lastSeen: group.lastSeen,
    nextExpected: group.nextExpected,
    status: group.status,
    statusLabel: RECURRING_STATUS_LABELS[group.status],
    occurrences: group.occurrenceCount,
    href: `/app/${orgSlug}/money/banking/transactions?recurring=${group.id}`,
  };
}

/** The groups as read, and their views; the Banking page also needs each group's key and direction. */
async function recurringGroupsAndViews(
  db: SupabaseClient, orgId: string, orgSlug: string, currency: string, requestId?: string,
): Promise<{ groups: RecurringGroupRow[]; views: RecurringPaymentView[] }> {
  const [groups, accounts] = await Promise.all([
    listRecurringGroups(db, orgId, requestId),
    listBankAccounts(db, orgId, requestId),
  ]);
  const members = await loadLatestGroupMembers(db, orgId, groups.map((g) => g.id), requestId);
  const names = new Map(accounts.map((a) => [a.id, a.name] as const));
  const rank = { changed: 0, active: 1, stopped: 2 } as const;
  const views = groups
    .map((g) => describeGroup(g, members.get(g.id), names, currency, orgSlug))
    .sort((a, b) => rank[a.status] - rank[b.status] || new Decimal(b.expectedRaw).comparedTo(new Decimal(a.expectedRaw)));
  return { groups, views };
}

/** The detected recurring payments, largest first; stopped ones last. */
export async function loadRecurringPayments(
  db: SupabaseClient, orgId: string, orgSlug: string, currency: string, requestId?: string,
): Promise<RecurringPaymentView[]> {
  return (await recurringGroupsAndViews(db, orgId, orgSlug, currency, requestId)).views;
}

/**
 * The recurring-payment alerts whose stored sentence opens with the group's bank description, and
 * the direction the rule itself implies (`recurring.amount_changed` fires either way, so its
 * direction comes from the group).
 */
const SIGNATURE_LED_ALERTS: ReadonlyMap<string, RecurringGroupRow['direction'] | null> = new Map([
  ['recurring.amount_changed', null], ['recurring.missed', 'outflow'], ['recurring.inflow_missed', 'inflow'],
]);

/**
 * "fps credit gamma catering inv was £9,217, …" reads as a raw bank line, lower-cased because the
 * signature is the normalised description (the original wording is not readable here, ADR-038.4).
 * Where the sentence opens with a known group's signature, it is said as a payment from or to that
 * payee, capitalised; anything else is only given a capital letter. Display only: the stored alert
 * text, and the Alerts page, are unchanged.
 */
function noticeText(alert: AlertView, directions: ReadonlyMap<string, Direction>): string {
  const text = alert.whatHappened || alert.title;
  if (SIGNATURE_LED_ALERTS.has(alert.ruleKey)) {
    const key = [...directions.keys()]
      .filter((k) => k !== '' && text.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const direction = key === undefined ? undefined : SIGNATURE_LED_ALERTS.get(alert.ruleKey) ?? directions.get(key);
    // The same description both ways cannot say which this was, so it keeps its own words.
    if (key !== undefined && (direction === 'inflow' || direction === 'outflow')) {
      // A key can carry the confirmed counterparty (`signature|cp:<id>`); only the words are shown.
      const payee = capitalise(key.split('|cp:')[0]!.trim());
      return `${direction === 'inflow' ? `A payment from ${payee}` : `A payment to ${payee}`}${text.slice(key.length)}`;
    }
  }
  return capitalise(text);
}

type Direction = RecurringGroupRow['direction'] | 'both';

/** Each group key's direction; a key seen both ways (two accounts, say) is `both`. */
function directionsOf(groups: readonly RecurringGroupRow[]): Map<string, Direction> {
  const out = new Map<string, Direction>();
  for (const g of groups) {
    const seen = out.get(g.counterpartyKey);
    out.set(g.counterpartyKey, seen === undefined || seen === g.direction ? g.direction : 'both');
  }
  return out;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function noticesFrom(
  alerts: readonly AlertView[],
  directions: ReadonlyMap<string, Direction>,
  lookalikes: number,
  uncategorised: number,
  accounts: readonly BankAccountCardView[],
  orgSlug: string,
  periodId: string,
): NoticeView[] {
  const out: NoticeView[] = [];
  for (const alert of alerts) {
    if (!BANKING_ALERT_KEYS.has(alert.ruleKey)) continue;
    out.push({
      kind: 'alert',
      tone: alert.severity === 'critical' || alert.severity === 'high' ? 'danger' : alert.severity === 'info' ? 'neutral' : 'warn',
      text: noticeText(alert, directions),
      href: alert.detailHref,
    });
  }
  if (lookalikes > 0) {
    out.push({
      kind: 'lookalike', tone: 'warn',
      text: lookalikes === 1
        ? 'One transaction looks like a transfer between your own accounts but has no matching leg, so it is still counted as money in or out.'
        : `${lookalikes} transactions look like transfers between your own accounts but have no matching leg, so they are still counted as money in or out.`,
      href: `/app/${orgSlug}/money/banking/transactions?period=${periodId}&filter=lookalike`,
    });
  }
  if (uncategorised > 0) {
    out.push({
      kind: 'uncategorised', tone: 'neutral',
      text: uncategorised === 1
        ? 'One transaction has no category yet.'
        : `${uncategorised} transactions have no category yet.`,
      href: `/app/${orgSlug}/money/banking/transactions?period=${periodId}&filter=uncategorised`,
    });
  }
  for (const account of accounts) {
    if (account.reconciliation.status === 'unreconciled') {
      out.push({ kind: 'reconciliation', tone: 'warn', text: `${account.name}: the statement for this month does not reconcile to its printed balances.`, href: null });
    }
  }
  return out;
}

function trendOf(closings: readonly (string | null)[]): LiquidityView['trend'] {
  const known = closings.filter((v): v is string => v !== null).map((v) => new Decimal(v));
  if (known.length < 3) {
    return { direction: 'insufficient', sentence: 'APX needs three months of cash balances to describe a trend.' };
  }
  const [a, b, c] = known.slice(-3) as [Decimal, Decimal, Decimal];
  if (a.lessThan(b) && b.lessThan(c)) return { direction: 'rising', sentence: 'Cash has risen for three months in a row.' };
  if (a.greaterThan(b) && b.greaterThan(c)) return { direction: 'falling', sentence: 'Cash has fallen for three months in a row.' };
  return { direction: 'mixed', sentence: 'Cash has gone up and down over the last three months.' };
}

function concentrationOf(accounts: readonly BankAccountCardView[], summary: PeriodSummary, currency: string): LiquidityView['concentration'] {
  const cashLike = accounts.filter((a) => a.isCashLike);
  if (cashLike.length < 2) {
    return { share: null, accountName: null, sentence: cashLike.length === 1 ? 'All your cash is in one account.' : 'No cash accounts yet.' };
  }
  const balances = cashLike.map((a) => {
    const s = summary.accounts.find((x) => x.bank_account_id === a.id);
    return { account: a, value: s?.last_balance_after ?? null };
  });
  if (balances.some((b) => b.value === null)) {
    return { share: null, accountName: null, sentence: 'Not every account has a statement balance for this month, so APX cannot say how your cash is spread.' };
  }
  const total = balances.reduce((acc, b) => acc.plus(b.value!), new Decimal(0));
  if (!total.greaterThan(0)) {
    return { share: null, accountName: null, sentence: 'The statement balances do not add up to a positive total, so a spread is not meaningful.' };
  }
  const largest = [...balances].sort((x, y) => new Decimal(y.value!).comparedTo(new Decimal(x.value!)))[0]!;
  const share = new Decimal(largest.value!).dividedBy(total);
  return {
    share: formatPercent(share.toFixed(6)),
    accountName: largest.account.name,
    sentence: `${formatPercent(share.toFixed(6))} of your cash (${money(largest.value!, currency)}) sits in ${largest.account.name}.`,
  };
}

function orgReconciliation(closing: SnapshotRow | undefined, currency: string): OrgReconciliationView {
  if (!closing || closing.value === null) {
    return { statementClosing: null, motionClosing: null, delta: null, status: 'unchecked', sentence: 'APX has no cash balance for this month to check against the statements.' };
  }
  const stated = closing.components.statement_closing_cash;
  const delta = closing.components.statement_delta;
  if (typeof stated !== 'string' || typeof delta !== 'string') {
    return {
      statementClosing: null, motionClosing: money(closing.value, currency), delta: null, status: 'unchecked',
      sentence: 'Not every account’s statement carries a running balance for this month, so the total could not be checked against the statements.',
    };
  }
  const differs = new Decimal(delta).abs().greaterThan('0.01');
  return {
    statementClosing: money(stated, currency),
    motionClosing: money(closing.value, currency),
    delta: money(delta, currency, true),
    status: differs ? 'differs' : 'matches',
    sentence: differs
      ? `The statements say ${money(stated, currency)} and APX works out ${money(closing.value, currency)} — a difference of ${money(delta, currency, true)}. The difference usually means an opening balance or a missing statement.`
      : `The statements and APX agree: ${money(closing.value, currency)} at the end of the month.`,
  };
}

async function baseCurrency(db: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await db.from('organizations').select('base_currency').eq('id', orgId).maybeSingle();
  return ((data as { base_currency?: string } | null)?.base_currency) ?? 'GBP';
}

/** The Banking page, one month. */
export async function loadBankingOverview(
  db: SupabaseClient,
  orgId: string,
  orgSlug: string,
  scope: PeriodScope,
  requestId?: string,
): Promise<BankingOverview> {
  const periodId = scope.period.id;
  const trailing = scope.periods.filter((p) => p.periodStart <= scope.period.periodStart).slice(0, 3).map((p) => p.id);
  const [snapshots, accounts, summary, currency, alerts, series, sample] = await Promise.all([
    repo.loadPeriodSnapshots(db, orgId, periodId, requestId),
    listBankAccounts(db, orgId, requestId),
    loadPeriodSummary(db, orgId, periodId, requestId),
    baseCurrency(db, orgId),
    loadAlertsPage(db, orgId, orgSlug, { statuses: ['open', 'acknowledged'], periodId, limit: 50 }, requestId),
    repo.loadMetricSeries(db, orgId, ['closing_cash'], trailing, requestId),
    // A bounded sample of the month, for the transfer look-alike count only.
    listBankTransactions(db, orgId, { periodId }, { limit: 500, offset: 0 }, requestId),
  ]);
  const byKey = index(snapshots);
  const options = { orgSlug, comparisonLabel: scope.previous?.label ?? 'the previous month' };
  const figure = (key: string): MetricCardView | null => {
    const row = byKey.get(key);
    return row ? toFigure(row, scope.period, byKey.get(varianceKey(key, 'prev_period')) ?? null, options) : null;
  };
  const headline = ['closing_cash', 'cash_inflows', 'cash_outflows', 'net_cash_movement']
    .map(figure).filter((f): f is MetricCardView => f !== null);
  const cards = bankAccountCards(orgSlug, accounts, summary, periodId);
  const lookalikes = sample.filter((t) => !t.isTransfer && looksLikeTransfer(t.descriptionNormalized)).length;
  const uncategorised = summary.accounts.reduce((acc, a) => acc + a.uncategorised_count, 0);
  const transactions = summary.accounts.reduce((acc, a) => acc + a.row_count, 0);
  const { groups: recurringGroups, views: recurring } = await recurringGroupsAndViews(db, orgId, orgSlug, currency, requestId);
  const directions = directionsOf(recurringGroups);
  const closings = [...trailing].reverse().map((id) =>
    series.find((s) => s.periodId === id && s.metricKey === 'closing_cash' && s.dimensionType === 'none')?.value ?? null);
  const names = new Map(accounts.map((a) => [a.id, a.name] as const));
  const codes = new Set<string>();
  for (const key of ['closing_cash', 'cash_inflows', 'cash_outflows', 'net_cash_movement']) {
    const row = byKey.get(key);
    for (const w of row?.dataQuality.warnings ?? []) codes.add(w);
    for (const m of row?.dataQuality.missing ?? []) codes.add(m);
  }
  return {
    scope,
    currency,
    source: {
      sentence: BANK_SOURCE_SENTENCE,
      lastStatement: summary.latest_statement
        ? {
          committedAt: summary.latest_statement.committed_at,
          coveringTo: summary.latest_statement.period_end,
          accountName: summary.latest_statement.bank_account_id ? names.get(summary.latest_statement.bank_account_id) ?? null : null,
        }
        : null,
    },
    headline,
    notices: noticesFrom(alerts.alerts, directions, lookalikes, uncategorised, cards, orgSlug, periodId),
    accounts: cards,
    recurring,
    categories: categoryShares(summary, currency),
    liquidity: {
      cashAvailable: figure('closing_cash'),
      runway: figure('cash_runway_months'),
      netMovement: figure('net_cash_movement'),
      trend: trendOf(closings),
      concentration: concentrationOf(cards, summary, currency),
    },
    reconciliation: orgReconciliation(byKey.get('closing_cash'), currency),
    dataQualityCodes: [...codes],
    counts: { transactions, uncategorised, lookalikes },
  };
}

// ---------------------------------------------------------------------------------------------
// Transactions, paged
// ---------------------------------------------------------------------------------------------

export type BankingListFilter = 'all' | 'uncategorised' | 'in' | 'out' | 'transfers' | 'lookalike';

export interface BankTransactionRowView extends TransactionView {
  readonly href: string;
  readonly direction: 'in' | 'out';
  readonly status: StatusBadge;
  readonly recurring: boolean;
}

export interface BankTransactionsPage {
  readonly period: PeriodLabel;
  readonly periods: readonly PeriodLabel[];
  readonly account: { id: string; name: string } | null;
  readonly accounts: readonly { id: string; name: string }[];
  readonly filter: BankingListFilter;
  readonly recurringGroupId: string | null;
  readonly rows: readonly BankTransactionRowView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  /** How many pages `total` spans at `pageSize` — worked out here, not in the component (§8). */
  readonly pages: number;
  readonly source: BankingSourceView['sentence'];
}

export function parseListFilter(value: string | undefined): BankingListFilter {
  return value === 'uncategorised' || value === 'in' || value === 'out' || value === 'transfers' || value === 'lookalike'
    ? value : 'all';
}

function toRow(
  t: BankTransaction, names: ReadonlyMap<string, string>, categoryOf: ReadonlyMap<string, StandardCategory>, orgSlug: string,
): BankTransactionRowView {
  const base = toTransactionView(t, names, categoryOf);
  return {
    ...base,
    href: `/app/${orgSlug}/money/banking/transactions/${t.id}`,
    direction: new Decimal(t.amount).isNegative() ? 'out' : 'in',
    status: statusFor({ value: t.amount, assurance: t.assuranceLevel as AssuranceLevel, dataQuality: { completeness: 1, proxy: false, warnings: [], missing: [] } }),
    recurring: t.recurringGroupId !== null,
  };
}

export async function loadBankTransactionsPage(
  db: SupabaseClient,
  orgId: string,
  orgSlug: string,
  scope: PeriodScope,
  query: { readonly accountId?: string; readonly filter: BankingListFilter; readonly page: number; readonly recurringGroupId?: string },
  requestId?: string,
): Promise<BankTransactionsPage> {
  const [bankAccounts, chart] = await Promise.all([
    listBankAccounts(db, orgId, requestId),
    listAccounts(db, orgId, requestId),
  ]);
  const names = new Map(bankAccounts.map((a) => [a.id, a.name] as const));
  const categoryOf = new Map<string, StandardCategory>(chart.map((a) => [a.id, a.standardCategory]));
  const uncategorisedAccount = chart.find((a) => a.standardCategory === 'uncategorised')?.id;
  const account = query.accountId && names.has(query.accountId)
    ? { id: query.accountId, name: names.get(query.accountId)! } : null;

  const filter: BankTransactionFilter = {
    ...(query.recurringGroupId ? { recurringGroupId: query.recurringGroupId } : { periodId: scope.period.id }),
    ...(account ? { bankAccountId: account.id } : {}),
    ...(query.filter === 'in' ? { direction: 'inflow' as const } : {}),
    ...(query.filter === 'out' ? { direction: 'outflow' as const } : {}),
    ...(query.filter === 'transfers' ? { transfersOnly: true } : {}),
    ...(query.filter === 'uncategorised' && uncategorisedAccount ? { uncategorisedAccountId: uncategorisedAccount } : {}),
  };
  const pageSize = TRANSACTION_PAGE_SIZE;
  const page = Math.max(1, query.page);

  if (query.filter === 'lookalike') {
    // A description test, so it is applied in code over a bounded month rather than in SQL.
    const sample = await listBankTransactions(db, orgId, filter, { limit: 500, offset: 0 }, requestId);
    const matches = sample.filter((t) => !t.isTransfer && looksLikeTransfer(t.descriptionNormalized));
    return {
      period: scope.period, periods: scope.periods, account, accounts: [...names].map(([id, name]) => ({ id, name })),
      filter: query.filter, recurringGroupId: query.recurringGroupId ?? null,
      rows: matches.slice((page - 1) * pageSize, page * pageSize).map((t) => toRow(t, names, categoryOf, orgSlug)),
      page, pageSize, total: matches.length, pages: Math.max(1, Math.ceil(matches.length / pageSize)), source: BANK_SOURCE_SENTENCE,
    };
  }

  const [rows, total] = await Promise.all([
    listBankTransactions(db, orgId, filter, { limit: pageSize, offset: (page - 1) * pageSize }, requestId),
    countBankTransactions(db, orgId, filter, requestId),
  ]);
  return {
    period: scope.period, periods: scope.periods, account, accounts: [...names].map(([id, name]) => ({ id, name })),
    filter: query.filter, recurringGroupId: query.recurringGroupId ?? null,
    rows: rows.map((t) => toRow(t, names, categoryOf, orgSlug)),
    page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), source: BANK_SOURCE_SENTENCE,
  };
}

// ---------------------------------------------------------------------------------------------
// One transaction
// ---------------------------------------------------------------------------------------------

export interface TransferCandidateView {
  readonly id: string;
  readonly date: string;
  readonly description: string;
  readonly amount: string;
  readonly accountName: string;
  /** What pairing would mean, in words — derived from the two account types (ADR-028). */
  readonly meaning: string;
}

export interface BankTransactionDetail {
  readonly id: string;
  readonly date: string;
  readonly postedDate: string | null;
  readonly description: string;
  readonly reference: string | null;
  readonly amount: string;
  readonly direction: 'in' | 'out';
  readonly currency: string;
  readonly account: { id: string; name: string; reference: string; typeLabel: string };
  readonly category: { accountId: string | null; label: string; source: BankTransaction['categorySource']; sourceLabel: string; uncategorised: boolean };
  readonly categoryOptions: readonly { id: string; label: string }[];
  readonly transfer: { kind: BankTransaction['transferKind']; label: string; pairId: string | null; pairHref: string | null } | null;
  readonly transferCandidates: readonly TransferCandidateView[];
  readonly recurring: { groupId: string; href: string } | null;
  readonly statementBalance: string | null;
  readonly standing: { recordStatus: string; assurance: string; counted: boolean; label: string };
  readonly reconciliation: ReconciliationView;
  readonly periodId: string;
  readonly periodLabel: string | null;
  readonly source: string;
}

const SOURCE_LABELS: Readonly<Record<BankTransaction['categorySource'], string>> = {
  user: 'Chosen by you',
  rule: 'Set by APX’s rules',
  ai_suggested: 'Suggested',
  none: 'Not set',
};

const TRANSFER_LABELS: Readonly<Record<string, string>> = {
  cash_transfer: 'Transfer between your own accounts',
  card_repayment: 'Credit card repayment',
  loan_repayment: 'Loan repayment',
  loan_drawdown: 'Loan drawn down',
  other_transfer: 'Transfer',
};

const STANDING_LABELS: Readonly<Record<string, string>> = {
  accepted: 'Counted in your figures',
  needs_review: 'Needs a review before it counts',
  incomplete: 'Incomplete — not counted',
  duplicate: 'Marked as a duplicate — not counted',
  rejected: 'Rejected — not counted',
  pending: 'Not yet imported',
};

function pairMeaning(a: BankAccount['accountType'], b: BankAccount['accountType']): string {
  if (CASH_LIKE.has(a) && CASH_LIKE.has(b)) return 'a transfer between your own accounts, so it leaves your cash figures';
  if (a === 'credit_card' || b === 'credit_card') return 'a credit card repayment — still money out of the bank';
  if (a === 'loan' || b === 'loan') return 'a loan repayment or drawdown — still a cash movement';
  return 'a transfer, kept out of profit but not out of cash';
}

export async function loadBankTransactionDetail(
  db: SupabaseClient,
  orgId: string,
  orgSlug: string,
  transactionId: string,
  requestId?: string,
): Promise<BankTransactionDetail | null> {
  const row = await loadBankTransaction(db, orgId, transactionId, requestId);
  if (!row) return null;
  const [bankAccounts, chart, periods] = await Promise.all([
    listBankAccounts(db, orgId, requestId),
    listAccounts(db, orgId, requestId),
    repo.loadPeriods(db, orgId, requestId),
  ]);
  const account = bankAccounts.find((a) => a.id === row.bankAccountId);
  if (!account) return null;
  const categoryOf = new Map<string, StandardCategory>(chart.map((a) => [a.id, a.standardCategory]));
  const names = new Map(bankAccounts.map((a) => [a.id, a.name] as const));
  const uncategorised = isUncategorised(row, categoryOf);
  const category = row.categoryAccountId ? categoryOf.get(row.categoryAccountId) ?? null : null;
  const period = periods.find((p) => p.id === row.periodId) ?? null;

  const summary = period ? await loadPeriodSummary(db, orgId, period.id, requestId) : null;

  // Legs this row could be the other half of: opposite sign, same size, another account, ≤ 3 days
  // apart, not already a transfer, not decided by a person. The kind is only described here; SQL
  // derives it when the pair is confirmed (ADR-028).
  let candidates: TransferCandidateView[] = [];
  if (!row.isTransfer && row.recordStatus === 'accepted') {
    const magnitude = new Decimal(row.amount).abs().toFixed(2);
    const from = new Date(`${row.transactionDate}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 3);
    const to = new Date(`${row.transactionDate}T00:00:00Z`); to.setUTCDate(to.getUTCDate() + 3);
    const { data } = await db
      .from('bank_transactions')
      .select('id, bank_account_id, transaction_date, amount, description_normalized, is_transfer, category_source')
      .eq('organization_id', orgId)
      .eq('record_status', 'accepted')
      .is('superseded_by', null)
      .eq('is_transfer', false)
      .neq('bank_account_id', row.bankAccountId)
      .eq('amount', new Decimal(row.amount).isNegative() ? magnitude : `-${magnitude}`)
      .gte('transaction_date', from.toISOString().slice(0, 10))
      .lte('transaction_date', to.toISOString().slice(0, 10))
      .limit(10);
    candidates = ((data ?? []) as Array<{ id: string; bank_account_id: string; transaction_date: string; amount: string; description_normalized: string | null; category_source: string }>)
      .filter((c) => c.category_source !== 'user')
      .map((c) => {
        const other = bankAccounts.find((a) => a.id === c.bank_account_id);
        return {
          id: c.id,
          date: c.transaction_date,
          description: c.description_normalized ?? '—',
          amount: money(String(c.amount), account.currency, true),
          accountName: names.get(c.bank_account_id) ?? 'Unknown account',
          meaning: pairMeaning(account.accountType, other?.accountType ?? 'other'),
        };
      });
  }

  return {
    id: row.id,
    date: row.transactionDate,
    postedDate: row.postedDate,
    description: row.descriptionNormalized ?? '—',
    reference: row.reference,
    amount: money(row.amount, account.currency, true),
    direction: new Decimal(row.amount).isNegative() ? 'out' : 'in',
    currency: account.currency,
    account: { id: account.id, name: account.name, reference: accountReference(account), typeLabel: ACCOUNT_TYPE_LABELS[account.accountType] },
    category: {
      accountId: row.categoryAccountId,
      label: uncategorised ? 'Not yet categorised' : (category ? CATEGORY_LABELS[category] : 'Not yet categorised'),
      source: row.categorySource,
      sourceLabel: SOURCE_LABELS[row.categorySource],
      uncategorised,
    },
    categoryOptions: [...chart]
      .filter((a) => a.standardCategory !== 'uncategorised')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({ id: a.id, label: `${a.name} — ${CATEGORY_LABELS[a.standardCategory]}` })),
    transfer: row.isTransfer
      ? {
        kind: row.transferKind,
        label: TRANSFER_LABELS[row.transferKind] ?? 'Transfer',
        pairId: row.transferPairId,
        pairHref: row.transferPairId ? `/app/${orgSlug}/money/banking/transactions/${row.transferPairId}` : null,
      }
      : null,
    transferCandidates: candidates,
    recurring: row.recurringGroupId
      ? { groupId: row.recurringGroupId, href: `/app/${orgSlug}/money/banking/transactions?recurring=${row.recurringGroupId}` }
      : null,
    statementBalance: row.balanceAfter === null ? null : money(row.balanceAfter, account.currency),
    standing: {
      recordStatus: row.recordStatus,
      assurance: row.assuranceLevel,
      counted: row.recordStatus === 'accepted' && row.supersededBy === null,
      label: row.supersededBy !== null ? 'Replaced by a later import — not counted' : STANDING_LABELS[row.recordStatus] ?? row.recordStatus,
    },
    reconciliation: summary ? reconciliationFor(account.id, summary.statements) : { status: 'no_statement', label: RECONCILIATION_LABELS.no_statement, sentence: RECONCILIATION_TEXT.no_statement },
    periodId: row.periodId,
    periodLabel: period?.label ?? null,
    source: BANK_SOURCE_SENTENCE,
  };
}

/** Every banking view carries the same value formatter so a "36+" runway reads the same everywhere. */
export { formatValue };
