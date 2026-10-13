import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadMarketingFinancials } from '@/modules/marketing';
import { baseFromYears, investmentSourceNote } from '../domain/figures';
import type { InvestmentBase } from '../domain/types';

/**
 * The Investment Pack's starting point (ADR-171): the company's latest financial year, from the very
 * figures Marketing's Section 03 shows (ADR-170) — the engine's monthly snapshots added into financial
 * years under the registry's own roll-up rules, complete months only, never zero-filled. Reading them
 * through `loadMarketingFinancials` rather than again here means the Investment Pack and the Marketing
 * report cannot start from different turnover or net profit for the same year.
 *
 * Two callers, two clients, one reader:
 *
 *   - the `investment.generate` job, on its scoped service client (`withOrgScope`; ADR-013, ADR-090):
 *     every read names the organisation;
 *   - the Investment page, on the member's own client under RLS: every table the reader touches —
 *     `organizations`, `fiscal_periods`, `metric_current` with its `metric_snapshots`, `accounts`,
 *     `campaign_spend`, `invoice_lines` with their `invoices`, and `products` — is readable by the
 *     owner, admin, employee, client and super-admin roles of the organisation, which are exactly the
 *     holders of `reports.view` (`role_permissions`), and the columns read are granted to
 *     `authenticated`. Proven by `test/integration/investment-figures.test.ts`.
 *
 * Null when APX holds no year with both turnover and net profit, or the base year's turnover is not
 * positive (`baseFromYears`).
 */
export async function loadInvestmentBase(db: SupabaseClient, orgId: string): Promise<InvestmentBase | null> {
  const financials = await loadMarketingFinancials(db, orgId);
  if (financials === null) return null;
  const note = investmentSourceNote(financials.years, financials.currency, financials.sourceNote);
  if (note === null) return null;
  return baseFromYears(financials.years, financials.currency, note);
}
