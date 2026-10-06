import { isNegative } from '@/core/money';
import type { StandardCategory } from '@/modules/financials';
import { balanceReportCompleteness, type CoverageBatch } from './coverage';
import { leafEvidence } from './cash';
import { balanceStatement, statementTotal } from './receivables-input';
import type { AggregateCell, EngineContext, MetricResult, PeriodRef } from './types';

/**
 * `debt_balance` (Phase 16 §5.4.1, D-19; ADR-145): what the business owes on borrowing at the end of
 * P, from the balance family's statement for P — a cumulative trial balance, else a cumulative
 * balance sheet (the precedence `balanceStatement` already applies for receivables and payables).
 *
 *   - Population: accounts categorised `loan` or `long_term_liability` when the run executed.
 *     `credit_card` and other liabilities are not debt here; a card facility is debt only when its
 *     account is categorised `loan`.
 *   - Reporting sign: owed is positive.
 *   - A statement for P with no such line is a KNOWN zero only when the statement is complete for P
 *     (Step 0F/NF-2: a trial balance answered complete and balancing, a balance sheet answered
 *     complete). On an unconfirmed, partial or unbalanced statement it is unknown — NULL with the
 *     completeness reason, never a zero nobody stated.
 *   - No cumulative statement for P (ledger-, invoice-, bank-only, a P&L report, a movement-basis
 *     trial balance): NULL `no_balance_sheet`.
 *   - A loan-type BANK ACCOUNT never establishes debt (U-3), whatever it is called.
 *
 * A MINOR engine change (§6): a new metric; every existing value is unchanged. Nothing reads it but
 * Funding Readiness — not Health, alerts, the analyst or the portfolio.
 */

export const DEBT_CATEGORIES: readonly StandardCategory[] = ['loan', 'long_term_liability'];

export function computeDebtBalance(
  ctx: EngineContext,
  period: PeriodRef,
  cells: readonly AggregateCell[],
  batches: readonly CoverageBatch[],
): MetricResult {
  const currency = ctx.settings.baseCurrency;
  const unavailable = (missing: MetricResult['dataQuality']['missing']): MetricResult => ({
    key: 'debt_balance', value: null, unit: 'money', basis: 'none', assurance: 'calculated',
    dimensionType: 'none', dimensionId: null, currency,
    components: {}, dataQuality: { completeness: 0, proxy: false, warnings: [], missing }, evidenceQuery: null,
  });

  const statement = balanceStatement(cells, batches, period);
  if (statement === null) return unavailable(['no_balance_sheet']);

  const total = statementTotal(statement.cells, ctx, DEBT_CATEGORIES);
  if (total.accountIds.length === 0) {
    const completeness = balanceReportCompleteness(batches, cells, period, statement.kind);
    if (completeness !== 'complete') {
      return unavailable([completeness === 'unconfirmed' ? 'report_completeness_unconfirmed'
        : completeness === 'unbalanced' ? 'trial_balance_not_balanced' : 'category_not_in_report']);
    }
  }

  return {
    key: 'debt_balance',
    value: total.value,
    unit: 'money',
    basis: 'period_balances',
    assurance: 'calculated',
    dimensionType: 'none',
    dimensionId: null,
    currency,
    components: {
      source: 'period_balances', balance_kind: statement.kind, categories: [...DEBT_CATEGORIES],
      account_ids: total.accountIds,
    },
    dataQuality: {
      completeness: 1,
      proxy: false,
      // A debit balance on debt accounts is reported, never hidden (§5.4.2).
      warnings: isNegative(total.value) ? ['debit_balance_on_debt_accounts'] : [],
      missing: [],
    },
    evidenceQuery: leafEvidence(ctx, 'period_balances', total.accountIds.length > 0
      ? { period_ids: [period.id], account_ids: [...total.accountIds], balance_kind: statement.kind }
      : { period_ids: [period.id], balance_kind: statement.kind }),
  };
}
