import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callApi } from '@/core/db';

/**
 * Banking edits. Each queues a recalculation in the same transaction, because re-categorising a
 * transaction or marking a transfer changes cash and P&L figures that are already on screen.
 */

/** Set the standard-category account a transaction belongs to. Appends `category_history`. */
export async function overrideBankCategory(
  db: SupabaseClient, transactionId: string, accountId: string | null, requestId?: string,
): Promise<string> {
  return callApi<string>(db, 'override_bank_category', {
    p_txn: transactionId,
    p_account: accountId,
  }, requestId);
}

/**
 * Pair two legs of a transfer, or unmark one by passing `null`.
 *
 * The KIND is derived in SQL from the two account types and is deliberately not a parameter
 * (ADR-028). Use `transferKindFor` to show the user what will happen; do not send it.
 */
export async function markTransfer(
  db: SupabaseClient, transactionId: string, pairId: string | null, requestId?: string,
): Promise<string> {
  return callApi<string>(db, 'mark_transfer', {
    p_txn: transactionId,
    p_pair: pairId,
  }, requestId);
}
