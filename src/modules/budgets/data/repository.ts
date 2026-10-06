import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';

/** Reads for budgets (ADR-142). Nothing here writes: a budget arrives only through the import wizard. */

export interface BudgetLineRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountCode: string | null;
  readonly category: string;
  readonly amount: string;
  readonly importBatchId: string | null;
  readonly sourceRef: string | null;
}

/** The month's current budget lines (accepted, not superseded), with their accounts. */
export async function loadBudgetLines(db: SupabaseClient, orgId: string, periodId: string): Promise<BudgetLineRow[]> {
  const { data, error } = await db.from('budget_lines')
    .select('id, account_id, amount, import_batch_id, source_ref')
    .eq('organization_id', orgId).eq('period_id', periodId)
    .eq('record_status', 'accepted').is('superseded_by', null)
    .order('id').limit(5000);
  if (error) throw toMotionError(error);
  const rows = (data ?? []) as Array<{ id: string; account_id: string; amount: string | number; import_batch_id: string | null; source_ref: string | null }>;
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.account_id))];
  const accounts = new Map<string, { name: string; code: string | null; category: string }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: acc, error: accError } = await db.from('accounts')
      .select('id, name, code, standard_category').eq('organization_id', orgId).in('id', ids.slice(i, i + 200));
    if (accError) throw toMotionError(accError);
    for (const a of (acc ?? []) as Array<{ id: string; name: string; code: string | null; standard_category: string }>) {
      accounts.set(a.id, { name: a.name, code: a.code, category: a.standard_category });
    }
  }
  return rows.map((r) => {
    const account = accounts.get(r.account_id);
    return {
      id: r.id,
      accountId: r.account_id,
      accountName: account?.name ?? 'Unknown account',
      accountCode: account?.code ?? null,
      category: account?.category ?? 'uncategorised',
      amount: String(r.amount),
      importBatchId: r.import_batch_id,
      sourceRef: r.source_ref,
    };
  });
}

/** The months that have a current budget, newest first. */
export async function loadBudgetPeriodIds(db: SupabaseClient, orgId: string): Promise<Set<string>> {
  const { data, error } = await db.from('budget_lines').select('period_id')
    .eq('organization_id', orgId).eq('record_status', 'accepted').is('superseded_by', null).limit(20000);
  if (error) throw toMotionError(error);
  return new Set(((data ?? []) as Array<{ period_id: string }>).map((r) => r.period_id));
}
