import { describe, expect, it } from 'vitest';
import { evaluateExpenseSpikeAccount, evaluateExpenseSpikeCategory } from '@/modules/alerts';
import { CURRENT, emptyRuleContext, snapshot, variance } from '../fixtures/health';

/**
 * N-5 (re-review of 39711f5): an expense-spike alert on a trial-balance basis pinned "the five largest
 * entries" from `ledger_entries` — a source the figure never read, so its evidence was empty or
 * unrelated. It must cite the winning source: the report lines the figure was read from, both
 * year-to-date sides for a cumulative month. The ledger basis is unchanged.
 *
 * Marketing rose 6,000 → 9,000 (+50%, 3% of revenue 100,000): both thresholds hold.
 */

const RUN = '00000000-0000-4000-8000-0000000000ff';
const leaf = (periodIds: string[]) => ({ v: 1, table: 'period_balances', filters: { period_ids: periodIds, account_ids: ['acct-1'], balance_kind: 'trial_balance' },
  as_of: { calculation_run_id: RUN, aggregated_at: '2026-04-01T00:00:00.000Z' } });

function ctx(basis: 'ledger' | 'period_balances', evidenceQuery: unknown, metric: 'account' | 'category') {
  const dimension = metric === 'account' ? { dimensionId: 'acct-1' } : { dimensionKey: 'marketing' };
  const key = metric === 'account' ? 'expense_by_account' : 'expense_by_category';
  return emptyRuleContext({
    snapshots: [
      snapshot({ key: 'revenue', value: '100000', unit: 'money', basis }),
      { ...snapshot({ key, value: '9000', unit: 'money', basis, ...dimension }), evidenceQuery },
      variance({ key: `${key}.variance.prev_period`, value: '3000', unit: 'money', basis, pctChange: '0.50',
        components: { current: '9000', comparison: '6000' }, ...dimension }),
    ],
  });
}

const queries = (outcome: { evidence?: ReadonlyArray<{ itemType: string; queryDescriptor: unknown; label: string }> }) =>
  (outcome.evidence ?? []).filter((e) => e.itemType === 'query').map((e) => ({ table: (e.queryDescriptor as { table: string }).table,
    filters: (e.queryDescriptor as { filters: unknown }).filters, label: e.label }));

describe('N-5 · an expense spike cites the source that stated the figure', () => {
  it('account, movement trial balance: the report lines of the account, never ledger entries', () => {
    const [outcome] = evaluateExpenseSpikeAccount(ctx('period_balances', { kind: 'leaf', descriptor: leaf([CURRENT]) }, 'account'));
    expect(queries(outcome!)).toEqual([
      { table: 'period_balances', filters: { period_ids: [CURRENT], account_ids: ['acct-1'], balance_kind: 'trial_balance' }, label: 'Marketing — the report lines' },
    ]);
  });

  it('account, cumulative trial balance: both year-to-date selections', () => {
    const q = { kind: 'difference', formula: 'year_to_date - prior_year_to_date', terms: [
      { name: 'year_to_date', sign: 1, period_id: CURRENT, descriptor: leaf([CURRENT]), unavailable: null, expected: '9000.00' },
      { name: 'prior_year_to_date', sign: -1, period_id: 'p-2026-02', descriptor: leaf(['p-2026-02']), unavailable: null, expected: '0.00' },
    ] };
    const [outcome] = evaluateExpenseSpikeAccount(ctx('period_balances', q, 'account'));
    expect(queries(outcome!).map((x) => [x.table, (x.filters as { period_ids: string[] }).period_ids[0], x.label])).toEqual([
      ['period_balances', CURRENT, 'Marketing — year to date'],
      ['period_balances', 'p-2026-02', 'Marketing — less: prior year to date'],
    ]);
  });

  it('category, trial balance: the report lines, never ledger entries', () => {
    const [outcome] = evaluateExpenseSpikeCategory(ctx('period_balances', { kind: 'leaf', descriptor: leaf([CURRENT]) }, 'category'));
    expect(queries(outcome!).map((x) => x.table)).toEqual(['period_balances']);
  });

  it('no usable evidence query on a report basis: no records pin rather than a wrong one', () => {
    const [outcome] = evaluateExpenseSpikeAccount(ctx('period_balances', null, 'account'));
    expect(queries(outcome!)).toEqual([]);
  });

  it('ledger basis: unchanged — the five largest entries', () => {
    const [outcome] = evaluateExpenseSpikeAccount(ctx('ledger', null, 'account'));
    expect(queries(outcome!).map((x) => [x.table, x.label])).toEqual([['ledger_entries', 'The five largest entries on Marketing']]);
  });
});
