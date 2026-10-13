import { z } from 'zod';
import { loadDimensioned, loadPeriodSnapshots, loadPeriods } from '@/modules/dashboard';
import { listCounterparties, listInvoices } from '@/modules/financials';
import { listBankAccounts, listBankTransactions } from '@/modules/banking';
import { listActions, type ActionStatus } from '@/modules/actions';
import { Decimal } from '@/core/money';
import type { PeriodRef } from '../periods';
import { untrusted } from '../untrusted';
import type { NumericValue } from '../values';
import {
  count, days, fail, money, noData, ok, ratio, resolvePeriodArg, snapshotNumber, subject,
} from './envelope';
import type { ToolCallContext, ToolDefinition } from './types';

/**
 * Tools 5–8 and 15 (AI_ARCHITECTURE.md §3): customers, cash, what is owed, and open actions.
 *
 * Same discipline as the metric family: a figure is a snapshot or a committed record, given in the
 * envelope with the id §7.6 derives its evidence from beside it. Where a tool lists records (the
 * largest movements, the top debtors) each row carries `id` and `type` so it is pinnable, and every
 * imported string — a description, a name, an invoice number — is wrapped.
 */

const PeriodOrRange = z.union([
  z.string(),
  z.object({ from: z.string(), to: z.string() }),
]);

async function periodsOf(arg: string | { from: string; to: string }, call: ToolCallContext) {
  const { ctx } = call;
  const all = await loadPeriods(ctx.db, ctx.orgId!, ctx.requestId);
  if (typeof arg === 'string') {
    const r = resolvePeriodArg(arg, call);
    if (!r.ok) return r;
    const p = all.find((x) => x.id === r.period.id)!;
    return { ok: true as const, periods: [p] };
  }
  const from = resolvePeriodArg(arg.from, call); if (!from.ok) return from;
  const to = resolvePeriodArg(arg.to, call); if (!to.ok) return to;
  const a = all.find((x) => x.id === from.period.id)!, b = all.find((x) => x.id === to.period.id)!;
  const [start, end] = a.periodStart <= b.periodStart ? [a.periodStart, b.periodStart] : [b.periodStart, a.periodStart];
  return { ok: true as const, periods: all.filter((p) => p.periodStart >= start && p.periodStart <= end).sort((x, y) => x.periodStart.localeCompare(y.periodStart)).slice(0, 24) };
}

const ref = (p: { id: string; label: string }): PeriodRef => ({ id: p.id, label: p.label });

// -----------------------------------------------------------------------------------------------
// 5. get_customer_profitability (MVP = revenue contribution, CD-08)
// -----------------------------------------------------------------------------------------------

export const getCustomerProfitability: ToolDefinition<{ period: string | { from: string; to: string }; limit?: number; order?: string }, unknown> = {
  name: 'get_customer_profitability',
  description: 'Customers ranked by revenue and share of revenue for a month or a range, with how concentrated revenue is in the top customers. In APX today contribution means revenue contribution.',
  permission: 'customers.view',
  input: z.object({
    period: PeriodOrRange, limit: z.number().int().min(1).max(20).optional(),
    order: z.enum(['revenue', 'share', 'change']).optional(),
  }),
  async run(input, call) {
    const scope = await periodsOf(input.period, call); if (!scope.ok) return fail(scope.error);
    const { ctx } = call;
    const ids = scope.periods.map((p) => p.id);
    const [revenue, shares, headline, counterparties] = await Promise.all([
      loadDimensioned(ctx.db, ctx.orgId!, 'customer_revenue', ids, ctx.requestId),
      loadDimensioned(ctx.db, ctx.orgId!, 'customer_revenue_share', ids, ctx.requestId),
      loadPeriodSnapshots(ctx.db, ctx.orgId!, ids[ids.length - 1]!, ctx.requestId),
      listCounterparties(ctx.db, ctx.orgId!, { limit: 500, offset: 0 }, ctx.requestId),
    ]);
    if (revenue.length === 0) return noData('customer revenue');
    const names = new Map(counterparties.map((c) => [c.id, c.name]));

    /*
     * Rows are per customer per period; a range sums nothing here — the model gets each period's
     * own snapshot and cites the one it quotes.
     *
     * The engine's synthetic `dimension_id = NULL` row is the revenue it could not attribute to
     * anybody (§3.5). It is a data-quality state, not a customer, so it leaves the ranked rows and
     * is reported on its own: a model handed it as row one would answer "your biggest customer is
     * Unattributed" (ADR-103).
     */
    const rowFor = (r: (typeof revenue)[number], id: string) => {
      const share = shares.find((s) => s.dimensionId === r.dimensionId && s.periodId === r.periodId);
      const period = scope.periods.find((p) => p.id === r.periodId)!;
      return {
        subject: subject('counterparty', id, names.get(id) ?? null),
        period: ref(period),
        revenue: money(r.value, r.currency),
        share: share ? ratio(share.value) : null,
        snapshot_id: r.snapshotId,
        share_snapshot_id: share?.snapshotId ?? null,
      };
    };
    const rows = revenue
      .filter((r) => r.dimensionId !== null)
      .map((r) => rowFor(r, r.dimensionId!));
    const unattributed = revenue
      .filter((r) => r.dimensionId === null && r.value !== null && !new Decimal(r.value).isZero())
      .map((r) => {
        const share = shares.find((s) => s.dimensionId === null && s.periodId === r.periodId);
        const period = scope.periods.find((p) => p.id === r.periodId)!;
        return {
          period: ref(period),
          revenue: money(r.value, r.currency),
          share: share ? ratio(share.value) : null,
          snapshot_id: r.snapshotId,
        };
      });
    const key = input.order === 'share' ? 'share' : 'revenue';
    rows.sort((a, b) => new Decimal(b[key]?.value ?? 0).comparedTo(new Decimal(a[key]?.value ?? 0)));

    const conc = (k: string) => { const s = headline.find((x) => x.metricKey === k && x.dimensionType === 'none'); return s ? { value: snapshotNumber(s), snapshot_id: s.snapshotId } : null; };
    return ok({
      rows: rows.slice(0, input.limit ?? 10),
      not_attributed_to_a_customer: unattributed,
      concentration: { top1: conc('customer_concentration_top1'), top5: conc('customer_concentration_top5'), hhi: conc('revenue_concentration_hhi') },
      note: 'Contribution is revenue contribution in APX today; cost allocation per customer is not available yet.'
        + (unattributed.length > 0
          ? ' Revenue under `not_attributed_to_a_customer` belongs to no customer APX could identify; it is a gap in the data, never a customer, and must not be named or ranked as one.'
          : ''),
    }, { periods: scope.periods.map(ref), calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 6. get_cash_analysis
// -----------------------------------------------------------------------------------------------

const CASH_KEYS = ['opening_cash', 'cash_inflows', 'cash_outflows', 'net_cash_movement', 'closing_cash', 'cash_runway_months'] as const;

export const getCashAnalysis: ToolDefinition<{ period: string | { from: string; to: string }; bank_account_id?: string }, unknown> = {
  name: 'get_cash_analysis',
  description: 'Cash for a month or a range: opening and closing balance, money in and out, the change, how many months the cash would last, the largest movements, and which bank accounts are covered.',
  permission: 'banking.view',
  input: z.object({ period: PeriodOrRange, bank_account_id: z.string().uuid().optional() }),
  async run(input, call) {
    const scope = await periodsOf(input.period, call); if (!scope.ok) return fail(scope.error);
    const { ctx } = call;
    const accounts = await listBankAccounts(ctx.db, ctx.orgId!, ctx.requestId);
    if (input.bank_account_id && !accounts.some((a) => a.id === input.bank_account_id)) {
      return fail({ code: 'NOT_FOUND', message: 'That bank account is not one of this organisation’s.' });
    }
    const periods = [];
    for (const p of scope.periods) {
      const snaps = await loadPeriodSnapshots(ctx.db, ctx.orgId!, p.id, ctx.requestId);
      const figures: Record<string, unknown> = { period: ref(p) };
      for (const key of CASH_KEYS) {
        const s = snaps.find((x) => x.metricKey === key && x.dimensionType === 'none');
        if (s) figures[key] = { metric_key: key, value: snapshotNumber(s), basis: s.basis, assurance_level: s.assurance, snapshot_id: s.snapshotId };
      }
      periods.push(figures);
    }
    if (periods.every((p) => Object.keys(p).length === 1)) return noData('cash figures');

    const last = scope.periods[scope.periods.length - 1]!;
    const txns = await listBankTransactions(ctx.db, ctx.orgId!,
      { periodId: last.id, ...(input.bank_account_id ? { bankAccountId: input.bank_account_id } : {}) },
      { limit: 500, offset: 0 }, ctx.requestId);
    const movements = txns.filter((t) => !t.isTransfer);
    const toRef = (t: (typeof txns)[number]) => ({
      id: t.id, type: 'bank_transaction', date: t.transactionDate,
      description: untrusted('description', t.descriptionNormalized),
      amount: money(t.amount, t.currency), direction: new Decimal(t.amount).isNegative() ? 'outflow' : 'inflow',
      subject: subject('bank_account', t.bankAccountId, accounts.find((a) => a.id === t.bankAccountId)?.name ?? null),
      period: ref(last),
    });
    const byAbs = [...movements].sort((a, b) => new Decimal(b.amount).abs().comparedTo(new Decimal(a.amount).abs()));
    const needsOpening = accounts.filter((a) => a.openingBalance === null).length;
    return ok({
      periods,
      largest_inflows: byAbs.filter((t) => !new Decimal(t.amount).isNegative()).slice(0, 5).map(toRef),
      largest_outflows: byAbs.filter((t) => new Decimal(t.amount).isNegative()).slice(0, 5).map(toRef),
      coverage: {
        bank_accounts: count(accounts.length)!,
        months_with_bank_data: count(periods.filter((p) => 'cash_inflows' in p).length)!,
        missing_opening_balance: needsOpening > 0,
      },
    }, { periods: scope.periods.map(ref), calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 7 & 8. get_receivables / get_payables
// -----------------------------------------------------------------------------------------------

function agingTool(side: 'receivables' | 'payables'): ToolDefinition<{ period?: string; limit?: number }, unknown> {
  const invoiceType = side === 'receivables' ? 'sales' : 'purchase';
  const who = side === 'receivables' ? 'customers who owe you' : 'suppliers you owe';
  return {
    name: `get_${side}`,
    description: `What is ${side === 'receivables' ? 'owed to you' : 'owed by you'} at the end of a month: the total, how many days it typically takes, how much is overdue, and the ${who} with the largest balances. \`period\` must be a label from period_context.`,
    permission: 'financials.view',
    input: z.object({ period: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }),
    async run(input, call) {
      const r = resolvePeriodArg(input.period, call); if (!r.ok) return fail(r.error);
      const { ctx } = call;
      const all = await loadPeriods(ctx.db, ctx.orgId!, ctx.requestId);
      const period = all.find((p) => p.id === r.period.id)!;
      const [snaps, invoices, counterparties] = await Promise.all([
        loadPeriodSnapshots(ctx.db, ctx.orgId!, period.id, ctx.requestId),
        listInvoices(ctx.db, ctx.orgId!, { invoiceType, openOnly: true }, { limit: 500, offset: 0 }, ctx.requestId),
        listCounterparties(ctx.db, ctx.orgId!, { limit: 500, offset: 0 }, ctx.requestId),
      ]);
      const pick = (k: string) => snaps.find((s) => s.metricKey === k && s.dimensionType === 'none');
      const total = pick(side), overdue = pick(`${side}_overdue`), dso = pick(`${side}_days`);
      if (!total) return noData(`${side} figure`);
      const names = new Map(counterparties.map((c) => [c.id, c.name]));

      // Top balances: the open invoices as at the period end, grouped by counterparty. The total
      // is the engine's snapshot; the rows are the records behind it, each pinnable.
      const asOf = period.periodEnd;
      const open = invoices.filter((i) => i.issueDate <= asOf && (i.paidDate === null || i.paidDate > asOf));
      const byCp = new Map<string, { balance: Decimal; oldest: string | null; ids: string[]; currency: string }>();
      for (const i of open) {
        const cur = byCp.get(i.counterpartyId) ?? { balance: new Decimal(0), oldest: null, ids: [], currency: i.currency };
        cur.balance = cur.balance.plus(i.balanceDue);
        cur.ids.push(i.id);
        if (i.dueDate && (cur.oldest === null || i.dueDate < cur.oldest)) cur.oldest = i.dueDate;
        byCp.set(i.counterpartyId, cur);
      }
      const top = [...byCp.entries()]
        .sort((a, b) => b[1].balance.comparedTo(a[1].balance))
        .slice(0, input.limit ?? 10)
        .map(([id, v]) => ({
          subject: subject('counterparty', id, names.get(id) ?? null),
          balance_due: money(v.balance.toString(), v.currency),
          oldest_due_date: v.oldest,
          invoices: v.ids.map((iid) => ({ id: iid, type: 'invoice' })),
          period: ref(period),
        }));

      return ok({
        period: ref(period),
        total: { metric_key: side, value: snapshotNumber(total), basis: total.basis, assurance_level: total.assurance, snapshot_id: total.snapshotId },
        days: dso ? { metric_key: `${side}_days`, value: snapshotNumber(dso), snapshot_id: dso.snapshotId } : null,
        overdue: overdue ? { metric_key: `${side}_overdue`, value: snapshotNumber(overdue), snapshot_id: overdue.snapshotId } : null,
        top,
        basis: total.basis,
      }, { periods: [ref(period)], basis: total.basis, assurance_level: total.assurance, calculation_run_id: null }, call);
    },
  };
}

export const getReceivables = agingTool('receivables');
export const getPayables = agingTool('payables');

// -----------------------------------------------------------------------------------------------
// 15. get_actions
// -----------------------------------------------------------------------------------------------

export const getActions: ToolDefinition<{ status?: readonly string[]; limit?: number }, unknown> = {
  name: 'get_actions',
  description: 'Actions already open or in progress, so you do not recommend something somebody is already doing.',
  permission: 'actions.view',
  input: z.object({
    status: z.array(z.enum(['open', 'in_progress', 'completed', 'dismissed'])).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async run(input, call) {
    const actions = await listActions(call.ctx, { status: (input.status ?? ['open', 'in_progress']) as ActionStatus[] });
    return ok({
      actions: actions.slice(0, input.limit ?? 10).map((a) => ({
        id: a.id, title: untrusted('title', a.title), priority: a.priority, status: a.status,
        owner_name: untrusted('name', a.ownerName), due_date: a.dueDate, source_type: a.sourceType,
      })),
      total: count(actions.length)!,
    }, { periods: [], calculation_run_id: null }, call);
  },
};

export type { NumericValue };
export { days };
