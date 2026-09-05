import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callApi } from '@/core/db';
import { ValidationError } from '@/core/errors';
import {
  DecideImportRowsInput, SaveImportMappingInput, SetStatementBalancesInput, StartImportBatchInput,
} from '../domain/validation';

/**
 * The import write surface, as far as Phase 2 (plan Phase 4) takes it: a batch can be started,
 * mapped, reviewed, have its statement balances entered, and be rejected.
 *
 * COMMIT AND ROLLBACK ARE NOT HERE. `api.commit_import_batch`, `api.rollback_import_batch` and
 * `api.replace_import_batch` belong to Phase 5 (IMPLEMENTATION_PLAN.md Phase 5 slice 7): their
 * invariants — commit-time cross-batch duplicate re-check, batch-scoped supersession, promotion of
 * dependants (ADR-047.9), supersession-chain re-linking — are import-engine logic that cannot be
 * written correctly before the dedupe machinery exists. The SQL primitives they will be built from
 * (`app.supersede_row`, `app.record_status_event`, `app.enqueue_recalculation`) do exist and are
 * tested. This is a stated boundary, not an oversight.
 */

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'Some details need fixing.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export async function startImportBatch(
  db: SupabaseClient, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(StartImportBatchInput, input);
  return callApi<string>(db, 'start_import_batch', {
    p_document: parsed.documentId,
    p_import_type: parsed.importType,
    p_opts: {
      bank_account_id: parsed.bankAccountId ?? null,
      period_start: parsed.periodStart ?? null,
      period_end: parsed.periodEnd ?? null,
      balance_basis: parsed.balanceBasis ?? null,
    },
  }, requestId);
}

export async function saveImportMapping(
  db: SupabaseClient, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(SaveImportMappingInput, input);
  return callApi<string>(db, 'save_import_mapping', {
    p_batch: parsed.batchId,
    p_mapping: {
      name: parsed.name,
      header_signature: parsed.headerSignature,
      column_map: parsed.columnMap,
      transforms: parsed.transforms,
      account_map: parsed.accountMap,
      balance_basis: parsed.balanceBasis ?? null,
      balance_sign: parsed.balanceSign ?? null,
    },
  }, requestId);
}

export async function decideImportRows(
  db: SupabaseClient, input: unknown, requestId?: string,
): Promise<number> {
  const parsed = parse(DecideImportRowsInput, input);
  return callApi<number>(db, 'decide_import_rows', {
    p_batch: parsed.batchId,
    p_decisions: parsed.decisions.map((d) => ({
      row_id: d.rowId,
      decision: d.decision,
      reason: d.reason,
    })),
  }, requestId);
}

export async function setStatementBalances(
  db: SupabaseClient, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(SetStatementBalancesInput, input);
  return callApi<string>(db, 'set_statement_balances', {
    p_batch: parsed.batchId,
    p_opening: parsed.opening,
    p_closing: parsed.closing,
  }, requestId);
}

export async function rejectImportBatch(
  db: SupabaseClient, batchId: string, reason: string, requestId?: string,
): Promise<string> {
  return callApi<string>(db, 'reject_import_batch', {
    p_batch: batchId,
    p_reason: reason,
  }, requestId);
}

/**
 * Marks a document deleted and returns its storage path, which the Storage signer then removes
 * (ADR-043.4). The row is kept: `storage.cleanup_orphans` finishes the job if the object delete
 * fails, and a `deleted` row with no object is recoverable where a missing row is not.
 */
export async function deleteDocument(
  db: SupabaseClient, documentId: string, requestId?: string,
): Promise<string> {
  return callApi<string>(db, 'delete_document', { p_document: documentId }, requestId);
}
