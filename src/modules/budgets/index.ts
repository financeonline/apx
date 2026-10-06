/**
 * `modules/budgets` — budget against actual (Agreement §9; REQ-FC-03/04; ADR-142).
 *
 * A budget is imported through the ordinary import wizard into `budget_lines`. It is a plan, not a
 * record: the engine never reads it. The variance is a deterministic read beside the engine.
 */
export {
  BUDGET_LINES,
  BUDGET_VARIANCE_VERSION,
  budgetByCategory,
  computeBudgetVariance,
  type ActualFigure,
  type BudgetInput,
  type BudgetLineKey,
  type BudgetVariance,
  type VarianceRow,
} from './domain/variance';
export { budgetVarianceFor, getBudgetView, type BudgetView } from './services';
export type { BudgetLineRow } from './data/repository';
