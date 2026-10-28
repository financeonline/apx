import 'server-only';
import { z } from 'zod';
import type { Db } from '@/db/types';
import { callApi } from '@/core/db';
import { ConflictError, ValidationError } from '@/core/errors';
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
  db: Db, input: unknown, requestId?: string,
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
      extraction_method: parsed.extractionMethod ?? 'csv',
    },
  }, requestId);
}

export async function saveImportMapping(
  db: Db, input: unknown, requestId?: string,
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
  db: Db, input: unknown, requestId?: string,
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
  db: Db, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(SetStatementBalancesInput, input);
  return callApi<string>(db, 'set_statement_balances', {
    p_batch: parsed.batchId,
    p_opening: parsed.opening,
    p_closing: parsed.closing,
  }, requestId);
}

export async function rejectImportBatch(
  db: Db, batchId: string, reason: string, requestId?: string,
): Promise<string> {
  return callApi<string>(db, 'reject_import_batch', {
    p_batch: batchId,
    p_reason: reason,
  }, requestId);
}

/*
 * `deleteDocument` used to live here too: a bare `api.delete_document` wrapper with no permission
 * check, no object removal, no caller, and a public export from this module's barrel. Deleting a
 * document is `modules/documents`' `deleteDocument(ctx, id)`, which asserts `imports.review` and
 * removes the object; the database enforces the permission either way, so nothing was exposed, but
 * an unguarded twin of a guarded operation is an invitation and it is gone (ADR-094).
 */

/**
 * Commit, rollback and replace (IMPORT_ENGINE.md §11, §12).
 *
 * Each is a thin wrapper over the `api.*` function that does the real work (`src/db/api/imports.ts`).
 * The gate, the duplicate re-check, the supersession rules and the promotion of dependants all live
 * there, behind the server, where no browser request can go round them. What these add is a typed result and — for the one
 * case the database deliberately signals rather than raises — a readable error.
 */

export interface CommitResult {
  readonly status: 'committed' | 'conflict' | 'needs_confirmation';
  readonly committed: number;
  readonly superseded: number;
  readonly collisions?: number;
  /** Step 0F (N-3): how many accepted balance lines this report would replace (IMP-COV-013). */
  readonly replaces?: number;
  readonly job?: string | null;
}

/**
 * Commits a reviewed batch.
 *
 * A duplicate collision comes back as a RESULT rather than an exception, because raising inside the
 * transaction would roll back the re-flagging the reviewer needs to see (§9.3). It is turned into a
 * ConflictError here, at the boundary, once the flagging is safely committed.
 */
export async function commitImportBatch(
  db: Db, batchId: string, requestId?: string,
): Promise<CommitResult> {
  const result = await callApi<CommitResult>(db, 'commit_import_batch', { p_batch: batchId }, requestId);

  if (result.status === 'conflict') {
    throw new ConflictError(
      `${result.collisions ?? 0} row${result.collisions === 1 ? '' : 's'} now duplicate data committed since this file was checked. The rows have been re-flagged for review.`,
      { batchId, collisions: result.collisions },
    );
  }
  // Step 0F (N-3): a corrected report replaces the one already imported for its month(s) only once
  // the reviewer has said so. Nothing was written; the question is now on the review page.
  if (result.status === 'needs_confirmation') {
    throw new ConflictError(
      'This file replaces a report already imported for the same month. Confirm the replacement on this page, then import it again.',
      { batchId, replaces: result.replaces },
    );
  }
  return result;
}

export async function rollbackImportBatch(
  db: Db, batchId: string, reason: string, requestId?: string,
): Promise<{ rejected: number; promoted: number; restored: number }> {
  if (reason.trim() === '') {
    throw new ValidationError('Say why this import is being rolled back.');
  }
  return callApi(db, 'rollback_import_batch', { p_batch: batchId, p_reason: reason }, requestId);
}

/** The corrected-file path: roll back the old batch and commit the new one in one transaction. */
export async function replaceImportBatch(
  db: Db, oldBatchId: string, newBatchId: string, reason: string, requestId?: string,
): Promise<unknown> {
  if (reason.trim() === '') {
    throw new ValidationError('Say why this import is being replaced.');
  }
  return callApi(db, 'replace_import_batch', {
    p_old_batch: oldBatchId, p_new_batch: newBatchId, p_reason: reason,
  }, requestId);
}

/** Records one of the confirmations §8.2 requires before a batch of this shape may commit. */
export async function recordBatchConfirmation(
  db: Db, batchId: string, code: string, value: Record<string, unknown>,
  requestId?: string,
): Promise<string> {
  return callApi<string>(db, 'record_batch_confirmation', {
    p_batch: batchId, p_code: code, p_value: value,
  }, requestId);
}

export async function confirmPdfPage(
  db: Db, batchId: string, page: number, requestId?: string,
): Promise<string> {
  return callApi<string>(db, 'confirm_pdf_page', { p_batch: batchId, p_page: page }, requestId);
}

/**
 * Creates the accounts a file names that the chart does not have yet (§6.5).
 *
 * `ledger_entries.account_id` is NOT NULL, so a ledger naming accounts MOTION has never seen cannot
 * commit at all until they exist. §6.5's rule is that they are created and left `uncategorised`
 * until a human confirms them — visible on `/data/accounts`, and marked incomplete everywhere they
 * feed a figure, rather than guessed at silently.
 */
export async function createImportAccounts(
  db: Db,
  batchId: string,
  accounts: ReadonlyArray<{ name: string; code?: string | null; standardCategory?: string | null }>,
  requestId?: string,
): Promise<number> {
  if (accounts.length === 0) return 0;
  return callApi<number>(db, 'create_import_accounts', {
    p_batch: batchId,
    p_accounts: accounts.map((a) => ({
      name: a.name,
      code: a.code ?? null,
      standard_category: a.standardCategory ?? null,
    })),
  }, requestId);
}

/**
 * Creates the customers or suppliers an invoice list names that MOTION does not have yet (§6.6).
 *
 * `invoices.counterparty_id` is NOT NULL, so an invoice for a customer MOTION has never seen could
 * not commit until it existed — and nothing created one. Only names are sent: the KIND (customer for
 * a sales list, supplier for a purchase list) is decided in SQL from the batch, never by the caller.
 */
export async function createImportCounterparties(
  db: Db,
  batchId: string,
  names: readonly string[],
  requestId?: string,
): Promise<number> {
  if (names.length === 0) return 0;
  return callApi<number>(db, 'create_import_counterparties', {
    p_batch: batchId,
    p_names: names,
  }, requestId);
}
