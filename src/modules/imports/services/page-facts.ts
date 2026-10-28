import 'server-only';
import { orgRowById, orgRows } from '@/db/rls';
import { globalRow } from '@/db/schema';
import type { Db } from '@/db/types';

/**
 * The few reads the import pages and actions make beside the review itself (ADR-013: a page reaches
 * data only through a module service). Each runs under the caller's read policy (`src/db/rls.ts`),
 * except the organisation's own name and feature flags — the organisation the caller was just
 * resolved into by `getAccessContext`, which has no row policy of its own.
 */

/** Active bank accounts for the upload form, by name. Sorted here: a handful, no index to keep. */
export async function listActiveBankAccounts(
  db: Db, orgId: string,
): Promise<Array<{ id: string; name: string; account_number_masked: string | null }>> {
  const rows = await orgRows<{ id: string; name: string; account_number_masked: string | null }>(
    db, orgId, 'bank_accounts', (q) => q.where('is_active', '==', true),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** The organisation's name and feature flags (the caller is already a member: see above). */
export async function organizationFacts(
  db: Db, orgId: string,
): Promise<{ name: string | null; features: Record<string, unknown> }> {
  const snap = await globalRow(db.fs, 'organizations', orgId).get();
  return {
    name: (snap.get('name') as string | undefined) ?? null,
    features: (snap.get('features') as Record<string, unknown> | undefined) ?? {},
  };
}

/** Whether a source document has a text layer (§5.4: AI reading is offered only for one). */
export async function documentHasTextLayer(db: Db, orgId: string, documentId: string): Promise<boolean | null> {
  const row = await orgRowById<{ has_text_layer: boolean | null }>(db, orgId, 'source_documents', documentId);
  return row?.has_text_layer ?? null;
}

/** Active expense accounts, by name — where a receipts batch may post (ADR-150). */
export async function listExpenseAccounts(
  db: Db, orgId: string,
): Promise<Array<{ id: string; code: string | null; name: string }>> {
  const rows = await orgRows<{ id: string; code: string | null; name: string }>(db, orgId, 'accounts', (q) => q
    .where('account_type', '==', 'expense').where('is_active', '==', true));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PageConfirmationFacts {
  readonly extractionStats: { confidence?: Record<string, string>; balances_read?: { opening?: string; closing?: string } };
  readonly statementOpeningBalance: number | string | null;
  readonly statementClosingBalance: number | string | null;
  readonly pageRows: ReadonlyArray<{ status: string; issues: Array<{ code: string }>; reviewer_decision: string }>;
}

/** What deciding "confirm page N" needs (§5.4): the batch's reading stats and that page's rows. */
export async function loadPageConfirmationFacts(
  db: Db, orgId: string, batchId: string, page: number,
): Promise<PageConfirmationFacts> {
  const [batch, pageRows] = await Promise.all([
    orgRowById<{
      extraction_stats?: PageConfirmationFacts['extractionStats'];
      statement_opening_balance: number | string | null; statement_closing_balance: number | string | null;
    }>(db, orgId, 'import_batches', batchId),
    orgRows<PageConfirmationFacts['pageRows'][number]>(db, orgId, 'import_rows', (q) => q
      .where('batch_id', '==', batchId).where('source_page', '==', page)
      .select('status', 'issues', 'reviewer_decision')),
  ]);
  return {
    extractionStats: batch?.extraction_stats ?? {},
    statementOpeningBalance: batch?.statement_opening_balance ?? null,
    statementClosingBalance: batch?.statement_closing_balance ?? null,
    pageRows,
  };
}
