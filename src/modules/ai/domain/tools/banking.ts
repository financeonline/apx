import { z } from 'zod';
import { loadAlerts, type AlertListRow } from '@/modules/alerts';
import { listBankAccounts, listBankTransactions, looksLikeTransfer } from '@/modules/banking';
import {
  bankAccountCards, categoryShares, loadPeriodSummary, loadRecurringPayments,
} from '@/modules/dashboard';
import { Decimal } from '@/core/money';
import type { PeriodRef } from '../periods';
import { untrusted } from '../untrusted';
import { count, fail, money, noData, ok, ratio, resolvePeriodArg, subject } from './envelope';
import type { ToolCallContext, ToolDefinition } from './types';

/**
 * Tools 20–23 (AI_ARCHITECTURE.md §3; Phase 13, ADR-101): banking, read through the same services
 * the Banking page renders. The model never reads a bank row it was not handed, never adds two
 * balances together, and never learns anything about a bank connection — because there is none.
 * Every result carries `source: 'imported_statements'` and `connected: false`, so an answer that
 * called the bank "live" would contradict its own evidence and fail grounding (§7).
 *
 * The organisation is `call.ctx.orgId`, resolved from the session; no tool takes one. A
 * `bank_account_id` that is not the organisation's is NOT_FOUND, never another organisation's row.
 */

const SOURCE = { source: 'imported_statements', connected: false } as const;

async function baseCurrency(call: ToolCallContext): Promise<string> {
  const { data } = await call.ctx.db.from('organizations').select('base_currency').eq('id', call.ctx.orgId!).maybeSingle();
  return ((data as { base_currency?: string } | null)?.base_currency) ?? 'GBP';
}

const ref = (p: { id: string; label: string }): PeriodRef => ({ id: p.id, label: p.label });

const BANKING_RULE_KEYS = [
  'bank.unusual_transaction', 'duplicate.transaction', 'recurring.amount_changed',
  'recurring.missed', 'recurring.inflow_missed', 'recurring.new',
] as const;

// -----------------------------------------------------------------------------------------------
// 20. get_bank_accounts
// -----------------------------------------------------------------------------------------------
export const getBankAccounts: ToolDefinition<{ period?: string }, unknown> = {
  name: 'get_bank_accounts',
  description: 'The organisation’s bank accounts for one month: the balance printed on each statement, money in and out with transfers between own accounts left out, whether the statement reconciled, and when the last statement was imported. Bank data comes from uploaded statements; MOTION is not connected to any bank.',
  permission: 'banking.view',
  input: z.object({ period: z.string().optional() }),
  async run(input, call) {
    const r = resolvePeriodArg(input.period, call); if (!r.ok) return fail(r.error);
    const { ctx } = call;
    const accounts = await listBankAccounts(ctx.db, ctx.orgId!, ctx.requestId);
    if (accounts.filter((a) => a.isActive).length === 0) return noData('bank account');
    const summary = await loadPeriodSummary(ctx.db, ctx.orgId!, r.period.id, ctx.requestId);
    const cards = bankAccountCards(ctx.orgSlug ?? '', accounts, summary, r.period.id);
    const currencyOf = new Map(accounts.map((a) => [a.id, a.currency] as const));
    const raw = new Map(summary.accounts.map((a) => [a.bank_account_id, a] as const));
    return ok({
      ...SOURCE,
      period: ref(r.period),
      last_statement: summary.latest_statement
        ? { imported_at: summary.latest_statement.committed_at, covering_to: summary.latest_statement.period_end }
        : null,
      accounts: cards.map((card) => {
        const s = raw.get(card.id);
        const currency = currencyOf.get(card.id) ?? null;
        return {
          account: subject('bank_account', card.id, card.name),
          type: card.accountType,
          counts_as_cash: card.isCashLike,
          currency,
          statement_balance: money(s?.last_balance_after ?? null, currency),
          statement_balance_date: s?.last_balance_date ?? null,
          money_in: money(s?.inflow ?? '0', currency),
          money_out: money(s?.outflow ?? '0', currency),
          net_movement: money(new Decimal(s?.inflow ?? '0').minus(s?.outflow ?? '0').toFixed(2), currency),
          transfers_between_own_accounts: money(new Decimal(s?.transfers_in ?? '0').plus(s?.transfers_out ?? '0').toFixed(2), currency),
          transactions: count(card.rowCount),
          uncategorised: count(card.uncategorisedCount),
          statement_covering_to: card.freshness?.coveringTo ?? null,
          statement_imported_at: card.freshness?.committedAt ?? null,
          reconciliation: card.reconciliation.status,
          needs_opening_balance: card.needsOpeningBalance,
        };
      }),
    }, { periods: [ref(r.period)], basis: 'bank', calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 21. get_recurring_payments
// -----------------------------------------------------------------------------------------------
export const getRecurringPayments: ToolDefinition<{ status?: 'active' | 'changed' | 'stopped'; limit?: number }, unknown> = {
  name: 'get_recurring_payments',
  description: 'Payments and receipts MOTION has seen at least three times on a regular cadence, from bank statements: what they usually are, what the last one was, whether the amount changed, and whether they have stopped. Use it for "which regular payments went up" or "what subscriptions do we pay".',
  permission: 'banking.view',
  input: z.object({
    status: z.enum(['active', 'changed', 'stopped']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async run(input, call) {
    const { ctx } = call;
    const currency = await baseCurrency(call);
    const all = await loadRecurringPayments(ctx.db, ctx.orgId!, ctx.orgSlug ?? '', currency, ctx.requestId);
    const rows = (input.status ? all.filter((r) => r.status === input.status) : all).slice(0, input.limit ?? 20);
    if (rows.length === 0) return noData('regular payment');
    return ok({
      ...SOURCE,
      recurring: rows.map((r) => ({
        id: r.id,
        type: 'recurring_group',
        description: untrusted('description', r.description),
        direction: r.direction === 'in' ? 'inflow' : 'outflow',
        account_name: untrusted('account', r.accountName),
        cadence: r.cadenceLabel,
        usually: money(r.expectedRaw, currency),
        last: money(r.lastRaw, currency),
        amount_changed: r.changed,
        last_seen: r.lastSeen,
        next_expected: r.nextExpected,
        status: r.status,
        times_seen: count(r.occurrences),
      })),
    }, { periods: [], basis: 'bank', calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 22. get_unusual_transactions
// -----------------------------------------------------------------------------------------------
export const getUnusualTransactions: ToolDefinition<{ period?: string; limit?: number }, unknown> = {
  name: 'get_unusual_transactions',
  description: 'Bank transactions MOTION’s deterministic rules flagged for a month: unusually large payments, possible duplicates, regular payments that changed or stopped — each as an alert with its evidence — plus how many transactions look like transfers between own accounts without a matching leg. MOTION decides what is unusual; you report it.',
  permission: 'banking.view',
  input: z.object({ period: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }),
  async run(input, call) {
    const r = resolvePeriodArg(input.period, call); if (!r.ok) return fail(r.error);
    const { ctx } = call;
    const [rows, sample] = await Promise.all([
      loadAlerts(ctx.db, ctx.orgId!, { periodId: r.period.id, statuses: ['open', 'acknowledged'] as AlertListRow['status'][], limit: 50 }, ctx.requestId),
      listBankTransactions(ctx.db, ctx.orgId!, { periodId: r.period.id }, { limit: 500, offset: 0 }, ctx.requestId),
    ]);
    const banking = rows.filter((a) => (BANKING_RULE_KEYS as readonly string[]).includes(a.ruleKey)).slice(0, input.limit ?? 10);
    const lookalikes = sample.filter((t) => !t.isTransfer && looksLikeTransfer(t.descriptionNormalized)).length;
    if (banking.length === 0 && lookalikes === 0) {
      return sample.length === 0 ? noData('bank transaction') : ok({
        ...SOURCE, period: ref(r.period), unusual: [], transfer_lookalikes: count(0),
        note: 'Nothing in this month tripped MOTION’s banking rules.',
      }, { periods: [ref(r.period)], basis: 'bank', calculation_run_id: null }, call);
    }
    return ok({
      ...SOURCE,
      period: ref(r.period),
      unusual: banking.map((a) => ({
        id: a.id,
        type: 'alert',
        rule_key: a.ruleKey,
        severity: a.severity,
        status: a.status,
        title: untrusted('title', a.title),
        explanation: untrusted('explanation', a.explanation),
        recommended_next_step: untrusted('next_step', a.recommendedNextStep),
        evidence_bundle_id: a.evidenceBundleId,
        transaction_id: a.subjectType === 'bank_transaction' ? a.subjectId : null,
        recurring_group_id: a.subjectType === 'recurring_group' ? a.subjectId : null,
      })),
      transfer_lookalikes: count(lookalikes),
    }, { periods: [ref(r.period)], basis: 'bank', calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 23. get_bank_categories
// -----------------------------------------------------------------------------------------------
export const getBankCategories: ToolDefinition<{ period?: string }, unknown> = {
  name: 'get_bank_categories',
  description: 'Where money went in a month, by category, from bank statements: money out and money in per standard category with each category’s share of the month’s outflows. This is bank movement, not a profit and loss — transfers between own accounts and card repayments are left out, and an uncategorised share is reported as such, never guessed.',
  permission: 'banking.view',
  input: z.object({ period: z.string().optional() }),
  async run(input, call) {
    const r = resolvePeriodArg(input.period, call); if (!r.ok) return fail(r.error);
    const { ctx } = call;
    const [summary, currency] = await Promise.all([
      loadPeriodSummary(ctx.db, ctx.orgId!, r.period.id, ctx.requestId),
      baseCurrency(call),
    ]);
    const shares = categoryShares(summary, currency);
    if (shares.length === 0) return noData('bank movement');
    return ok({
      ...SOURCE,
      period: ref(r.period),
      note: 'Bank movement by category, third parties only. Not a profit and loss.',
      categories: shares.map((c) => ({
        category: c.category,
        label: c.label,
        money_out: money(c.outflowRaw, currency),
        money_in: money(new Decimal(summary.categories.find((x) => x.standard_category === c.category)?.inflow ?? '0').toFixed(2), currency),
        share_of_money_out: c.share === null ? null : ratio(new Decimal(c.outflowRaw).dividedBy(
          summary.categories.reduce((acc, x) => acc.plus(x.outflow), new Decimal(0)),
        ).toFixed(6)),
        transactions: count(c.rowCount),
      })),
    }, { periods: [ref(r.period)], basis: 'bank', calculation_run_id: null }, call);
  },
};
