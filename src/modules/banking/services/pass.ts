import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { log } from '@/core/logging';
import { planBankingPass, type PassBankAccount, type PassTransaction } from '../domain/pass';
import type { CategoryAccountRef } from '../domain/categorisation';
import type { CategorySource, TransferKind } from '../domain/types';

/**
 * The banking step of a calculation run (FINANCIAL_ENGINE.md §2.4 step 5; Phase 13, ADR-101).
 *
 * Loads the organisation's accepted, current bank rows — every period, because recurring detection
 * looks back eighteen months and the keyword rules are retroactive (§4.1) — plans the pass with the
 * pure function, and hands the plan to `api_server.apply_banking_pass`, which writes only what
 * differs. Injected into the run loop like the health step, so the engine stays unaware of the
 * banking rules and the banking module can depend on the engine without the engine depending back.
 *
 * `description_raw` is never selected: the pass reads the masked text like every other consumer
 * (ADR-038.4), and the keyword rules were written against it.
 */
export interface BankingStepDeps {
  readonly scoped: SupabaseClient;
  readonly applyBankingPass: (
    organizationId: string, runId: string | null, plan: Record<string, unknown>,
  ) => Promise<Record<string, number>>;
}

const PAGE = 1000;

async function loadRows(db: SupabaseClient, orgId: string): Promise<PassTransaction[]> {
  const out: PassTransaction[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('bank_transactions')
      .select(`id, bank_account_id, transaction_date, amount, description_normalized, counterparty_id,
               category_account_id, category_source, is_transfer, transfer_kind, transfer_pair_id`)
      .eq('organization_id', orgId)
      .eq('record_status', 'accepted')
      .is('superseded_by', null)
      .order('id')
      .range(offset, offset + PAGE - 1);
    if (error) throw toMotionError(error);
    const rows = (data ?? []) as Array<{
      id: string; bank_account_id: string; transaction_date: string; amount: string;
      description_normalized: string | null; counterparty_id: string | null;
      category_account_id: string | null; category_source: CategorySource;
      is_transfer: boolean; transfer_kind: TransferKind; transfer_pair_id: string | null;
    }>;
    for (const r of rows) {
      out.push({
        id: r.id,
        bankAccountId: r.bank_account_id,
        transactionDate: r.transaction_date,
        amount: String(r.amount),
        descriptionNormalized: r.description_normalized,
        counterpartyId: r.counterparty_id,
        categoryAccountId: r.category_account_id,
        categorySource: r.category_source,
        isTransfer: r.is_transfer,
        transferKind: r.transfer_kind,
        transferPairId: r.transfer_pair_id,
      });
    }
    if (rows.length < PAGE) return out;
  }
}

async function loadAccounts(db: SupabaseClient, orgId: string): Promise<PassBankAccount[]> {
  const { data, error } = await db
    .from('bank_accounts')
    .select('id, name, account_type, is_active')
    .eq('organization_id', orgId);
  if (error) throw toMotionError(error);
  return ((data ?? []) as Array<{ id: string; name: string; account_type: PassBankAccount['accountType']; is_active: boolean }>)
    .map((a) => ({ id: a.id, name: a.name, accountType: a.account_type, isActive: a.is_active }));
}

async function loadCategoryAccounts(db: SupabaseClient, orgId: string): Promise<CategoryAccountRef[]> {
  const { data, error } = await db
    .from('accounts')
    .select('id, standard_category')
    .eq('organization_id', orgId);
  if (error) throw toMotionError(error);
  return ((data ?? []) as Array<{ id: string; standard_category: CategoryAccountRef['standardCategory'] }>)
    .map((a) => ({ id: a.id, standardCategory: a.standard_category }));
}

/** Runs the pass for one organisation. Returns the counts `api_server` wrote, for the run's stats. */
export async function runBankingPass(
  deps: BankingStepDeps,
  input: { organizationId: string; asOf: string; runId?: string | null },
): Promise<Record<string, number>> {
  const orgId = input.organizationId;
  const [transactions, bankAccounts, categoryAccounts] = await Promise.all([
    loadRows(deps.scoped, orgId),
    loadAccounts(deps.scoped, orgId),
    loadCategoryAccounts(deps.scoped, orgId),
  ]);
  if (transactions.length === 0) return {};
  const plan = planBankingPass({ organizationId: orgId, asOf: input.asOf, transactions, bankAccounts, categoryAccounts });
  const nothing = plan.categorisations.length === 0 && plan.pairs.length === 0 && plan.groups.length === 0;
  // A plan with nothing in it still runs: the writer is what marks vanished groups `stopped`, and
  // it is idempotent, so the cost of an empty call is one audit row.
  const counts = await deps.applyBankingPass(orgId, input.runId ?? null, {
    categorisations: plan.categorisations,
    pairs: plan.pairs,
    groups: plan.groups,
    versions: plan.versions,
  });
  log.info('banking pass applied', {
    organizationId: orgId, service: 'banking.pass', ...counts,
    planned: { categorisations: plan.categorisations.length, pairs: plan.pairs.length, groups: plan.groups.length, unpaired: plan.unpairedCandidates.length, empty: nothing },
  });
  return counts;
}

/** The step in the shape `RunDeps.bankingPass` expects. */
export function bankingStep(deps: BankingStepDeps) {
  return (input: { organizationId: string; asOf: string }) => runBankingPass(deps, input);
}
