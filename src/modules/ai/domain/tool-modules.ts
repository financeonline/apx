import type { ModuleKey } from '@/modules/tenancy';

/**
 * ADR-158: the system each AI tool belongs to. A tool of a system the super admin switched off for
 * the organisation is neither offered to the model nor run. Tools not listed (figures, cash, alerts,
 * health, evidence, coverage) belong to MOTION itself and are always available.
 */
export const TOOL_MODULES: Readonly<Record<string, ModuleKey>> = {
  get_bank_accounts: 'banking',
  get_bank_categories: 'banking',
  get_recurring_payments: 'banking',
  get_unusual_transactions: 'banking',
  get_customer_profitability: 'customers',
  get_campaign_performance: 'customers',
  get_product_contribution: 'customers',
  get_sales_pipeline: 'customers',
  get_actions: 'actions',
  get_forecast: 'planning',
  get_scenario: 'planning',
  check_affordability: 'planning',
  get_budget_variance: 'planning',
};

export function toolModule(name: string): ModuleKey | null {
  return TOOL_MODULES[name] ?? null;
}
