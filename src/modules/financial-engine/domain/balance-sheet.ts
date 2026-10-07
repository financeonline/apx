import type { StandardCategory } from '@/modules/financials';
import { balanceReportCompleteness, type CoverageBatch } from './coverage';
import { leafEvidence } from './cash';
import { DEBT_CATEGORIES } from './debt';
import { balanceStatement, statementTotal } from './receivables-input';
import type { AggregateCell, EngineContext, MetricResult, PeriodRef } from './types';

/**
 * Assets and loans at the end of P (ADR-156; owner, 2026-10-07): "how much are our fixed assets,
 * how much are current assets", and loans split secured / unsecured.
 *
 * Every figure is a category total from the balance family's cumulative statement for P — the
 * trial balance, else the balance sheet (`balanceStatement`, ADR-047.4) — in reporting sign, under
 * `debt_balance`'s rules exactly:
 *
 *   - no cumulative statement for P: NULL `no_balance_sheet`;
 *   - a statement with no line in the figure's population is a KNOWN zero only when the statement
 *     is complete for P (NF-2); otherwise NULL with the completeness reason, never a zero nobody
 *     stated.
 *
 * Populations (categories as the business mapped its accounts when the run executed):
 *
 *   fixed_assets            fixed_asset
 *   other_long_term_assets  other_asset
 *   current_assets          cash, receivables, inventory, other_current_asset
 *   total_assets            all four asset groups above
 *   loan_balance            loan                    (as categorised — the category says nothing
 *   long_term_borrowing     long_term_liability      about when it falls due, so neither is called
 *                                                    "short-term" here)
 *   loans_secured           loan + long_term_liability accounts marked secured
 *   loans_unsecured         … marked unsecured
 *   loans_unmarked          … not yet marked (never inferred from a name)
 *
 * The three security figures partition `debt_balance`: secured + unsecured + unmarked = borrowing.
 *
 * A MINOR engine change (§6): new metrics; every existing value is unchanged.
 */

export const ASSET_GROUPS = {
  fixed_assets: ['fixed_asset'],
  other_long_term_assets: ['other_asset'],
  current_assets: ['cash', 'receivables', 'inventory', 'other_current_asset'],
  total_assets: ['fixed_asset', 'other_asset', 'cash', 'receivables', 'inventory', 'other_current_asset'],
  loan_balance: ['loan'],
  long_term_borrowing: ['long_term_liability'],
} as const satisfies Record<string, readonly StandardCategory[]>;

export type LoanSecurity = 'secured' | 'unsecured' | null;

const SECURITY_METRICS: ReadonlyArray<readonly [string, LoanSecurity]> = [
  ['loans_secured', 'secured'],
  ['loans_unsecured', 'unsecured'],
  ['loans_unmarked', null],
];

function categoryFigure(
  key: string,
  categories: readonly StandardCategory[],
  ctx: EngineContext,
  period: PeriodRef,
  cells: readonly AggregateCell[],
  batches: readonly CoverageBatch[],
  security?: { readonly value: LoanSecurity },
): MetricResult {
  const currency = ctx.settings.baseCurrency;
  const unavailable = (missing: MetricResult['dataQuality']['missing']): MetricResult => ({
    key, value: null, unit: 'money', basis: 'none', assurance: 'calculated',
    dimensionType: 'none', dimensionId: null, currency,
    components: {}, dataQuality: { completeness: 0, proxy: false, warnings: [], missing }, evidenceQuery: null,
  });

  const statement = balanceStatement(cells, batches, period);
  if (statement === null) return unavailable(['no_balance_sheet']);

  // Loans by security: only the accounts carrying that marking (NULL = not yet marked).
  const scope = security === undefined
    ? ctx
    : { ...ctx, accounts: ctx.accounts.filter((a) => (a.loanSecurity ?? null) === security.value) };
  const total = statementTotal(statement.cells, scope, categories);

  if (total.accountIds.length === 0) {
    const completeness = balanceReportCompleteness(batches, cells, period, statement.kind);
    if (completeness !== 'complete') {
      return unavailable([completeness === 'unconfirmed' ? 'report_completeness_unconfirmed'
        : completeness === 'unbalanced' ? 'trial_balance_not_balanced' : 'category_not_in_report']);
    }
  }

  return {
    key,
    value: total.value,
    unit: 'money',
    basis: 'period_balances',
    assurance: 'calculated',
    dimensionType: 'none',
    dimensionId: null,
    currency,
    components: {
      source: 'period_balances', balance_kind: statement.kind, categories: [...categories],
      account_ids: total.accountIds,
      ...(security === undefined ? {} : { loan_security: security.value ?? 'unmarked' }),
    },
    dataQuality: { completeness: 1, proxy: false, warnings: [], missing: [] },
    evidenceQuery: leafEvidence(ctx, 'period_balances', total.accountIds.length > 0
      ? { period_ids: [period.id], account_ids: [...total.accountIds], balance_kind: statement.kind }
      : { period_ids: [period.id], balance_kind: statement.kind }),
  };
}

/** Every assets and loans figure for P, in a fixed order. */
export function computeBalanceSheetFigures(
  ctx: EngineContext,
  period: PeriodRef,
  cells: readonly AggregateCell[],
  batches: readonly CoverageBatch[],
): MetricResult[] {
  const out: MetricResult[] = [];
  for (const [key, categories] of Object.entries(ASSET_GROUPS) as Array<[string, readonly StandardCategory[]]>) {
    out.push(categoryFigure(key, categories, ctx, period, cells, batches));
  }
  for (const [key, value] of SECURITY_METRICS) {
    out.push(categoryFigure(key, DEBT_CATEGORIES, ctx, period, cells, batches, { value }));
  }
  return out;
}
