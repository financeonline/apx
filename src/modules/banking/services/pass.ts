import 'server-only';
import type { Db } from '@/db/types';
import { readRows } from '@/db/app/financials-reads';
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
 * `description_raw` is never read: the pass reads the masked text like every other consumer
 * (ADR-038.4), and the keyword rules were written against it.
 */
export interface BankingStepDeps {
  readonly scoped: Db;
  readonly applyBankingPass: (
    organizationId: string, runId: string | null, plan: Record<string, unknown>,
  ) => Promise<Record<string, number>>;
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function loadRows(db: Db, orgId: string): Promise<PassTransaction[]> {
  const rows = await readRows<Row>(db, orgId, 'bank_transactions', (q) => q
    .where('record_status', '==', 'accepted')
    .where('superseded_by', '==', null));
  rows.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return rows.map((r) => ({
    id: r.id,
    bankAccountId: r.bank_account_id,
    transactionDate: r.transaction_date,
    amount: String(r.amount),
    descriptionNormalized: (r.description_normalized as string | null | undefined) ?? null,
    counterpartyId: (r.counterparty_id as string | null | undefined) ?? null,
    categoryAccountId: (r.category_account_id as string | null | undefined) ?? null,
    categorySource: r.category_source as CategorySource,
    isTransfer: r.is_transfer === true,
    transferKind: r.transfer_kind as TransferKind,
    transferPairId: (r.transfer_pair_id as string | null | undefined) ?? null,
  }));
}

async function loadAccounts(db: Db, orgId: string): Promise<PassBankAccount[]> {
  const rows = await readRows<Row>(db, orgId, 'bank_accounts');
  return rows.map((a) => ({ id: a.id, name: a.name, accountType: a.account_type as PassBankAccount['accountType'], isActive: a.is_active === true }));
}

async function loadCategoryAccounts(db: Db, orgId: string): Promise<CategoryAccountRef[]> {
  const rows = await readRows<Row>(db, orgId, 'accounts');
  return rows.map((a) => ({ id: a.id, standardCategory: a.standard_category as CategoryAccountRef['standardCategory'] }));
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
