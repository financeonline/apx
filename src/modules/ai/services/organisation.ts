import 'server-only';
import { readableOrganization } from '@/db/app/ai-reads';
import type { AccessContext } from '@/modules/tenancy';

/**
 * The organisation facts the analyst needs — its name for the prompt, its base currency for the
 * money a tool shows, and the month its fiscal year starts for period resolution — read under the
 * `organizations` SELECT policy, which admits every member: no wider read is needed.
 *
 * A service, so the domain tools (which do no I/O of their own, ADR-022) can ask for the currency
 * without reaching the database layer.
 */
export interface OrganisationFacts {
  readonly name: string;
  readonly baseCurrency: string;
  readonly fiscalYearStartMonth: number;
}

export async function organisationOf(ctx: AccessContext, orgId: string | null): Promise<OrganisationFacts> {
  const row = await readableOrganization(ctx.db, orgId) as { name?: string; base_currency?: string; fiscal_year_start_month?: number } | null;
  return {
    name: row?.name ?? 'this organisation',
    baseCurrency: row?.base_currency ?? 'GBP',
    fiscalYearStartMonth: Number(row?.fiscal_year_start_month ?? 1),
  };
}
