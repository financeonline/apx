import 'server-only';
import type { Db } from '@/db/types';
import { readRows, readRowsByIds } from '@/db/app/financials-reads';

/**
 * Reads for budgets (ADR-142), made as the caller (`readRows`). Nothing here writes: a budget arrives
 * only through the import wizard.
 */

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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
export async function loadBudgetLines(db: Db, orgId: string, periodId: string): Promise<BudgetLineRow[]> {
  // Composite index: budget_lines (period_id, record_status, superseded_by, id).
  const rows = await readRows<Row>(db, orgId, 'budget_lines', (q) => q
    .where('period_id', '==', periodId).where('record_status', '==', 'accepted').where('superseded_by', '==', null)
    .orderBy('id').limit(5000));
  if (rows.length === 0) return [];

  const accounts = new Map<string, { name: string; code: string | null; category: string }>();
  for (const a of await readRowsByIds<Row>(db, orgId, 'accounts', rows.map((r) => String(r.account_id)))) {
    accounts.set(a.id, { name: a.name, code: a.code ?? null, category: a.standard_category });
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
      importBatchId: r.import_batch_id ?? null,
      sourceRef: r.source_ref ?? null,
    };
  });
}

/** The months that have a current budget, newest first. */
export async function loadBudgetPeriodIds(db: Db, orgId: string): Promise<Set<string>> {
  const rows = await readRows<Row>(db, orgId, 'budget_lines', (q) => q
    .where('record_status', '==', 'accepted').where('superseded_by', '==', null).select('period_id').limit(20000));
  return new Set(rows.map((r) => String(r.period_id)));
}
