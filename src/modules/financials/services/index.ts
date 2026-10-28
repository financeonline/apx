import 'server-only';
import { z } from 'zod';
import type { Db } from '@/db/types';
import { callApi } from '@/core/db';
import { ValidationError } from '@/core/errors';
import {
  CreateBankAccountInput, MergeCounterpartiesInput, RemapAccountInput, SetLoanSecurityInput, SetOpeningBalanceInput,
  SupersedeRecordInput, UpdateCounterpartyInput,
} from '../domain/validation';

/**
 * The financial write surface.
 *
 * Every function here is a thin, validated wrapper over one `api.*` SECURITY DEFINER function. It
 * does no authorization of its own: permission, tenancy and every invariant are decided in SQL,
 * where a direct PostgREST call cannot go round them (ADR-026, SECURITY_MODEL.md §5). What these
 * add is a typed input, a readable error, and one place to look for "what can be written".
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

/**
 * Re-categorise an account. This is the single most consequential edit in the product: it changes
 * every metric the account contributes to, in every period, which is why the SQL function closes the
 * previous `account_category_history` row and queues a recalculation (ADR-034).
 */
export async function remapAccount(
  db: Db, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(RemapAccountInput, input);
  return callApi<string>(db, 'remap_account', {
    p_account: parsed.accountId,
    p_category: parsed.standardCategory,
  }, requestId);
}

/**
 * ADR-156: mark a loan or long-term liability account secured or unsecured ("unmarked" clears it).
 * Nothing in the imported data says which, so the business says it; the engine reads it for the
 * loans-by-security figures, so the SQL function queues a recalculation, as a re-mapping does.
 */
export async function setLoanSecurity(
  db: Db, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(SetLoanSecurityInput, input);
  return callApi<string>(db, 'set_account_loan_security', {
    p_account: parsed.accountId,
    p_security: parsed.security,
  }, requestId);
}

export async function updateCounterparty(
  db: Db, input: unknown, requestId?: string,
): Promise<string> {
  const { counterpartyId, ...patch } = parse(UpdateCounterpartyInput, input);
  // Only the keys the caller actually supplied are sent: the SQL side treats a present key as an
  // instruction and an absent one as "leave alone", so spreading undefined would clear fields.
  const p_patch: Record<string, unknown> = {};
  if (patch.name !== undefined) p_patch.name = patch.name;
  if (patch.kind !== undefined) p_patch.kind = patch.kind;
  if (patch.defaultExpenseCategory !== undefined) {
    p_patch.default_expense_category = patch.defaultExpenseCategory;
  }
  if (patch.email !== undefined) p_patch.email = patch.email;
  if (patch.notes !== undefined) p_patch.notes = patch.notes;
  if (patch.isActive !== undefined) p_patch.is_active = patch.isActive;

  return callApi<string>(db, 'update_counterparty', {
    p_counterparty: counterpartyId,
    p_patch,
  }, requestId);
}

/**
 * Merge one counterparty into another. Nothing is deleted: the losing row keeps every invoice and
 * transaction that named it and gains a `merged_into_id` the engine follows, so the evidence trail
 * for past periods stays intact.
 */
export async function mergeCounterparties(
  db: Db, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(MergeCounterpartiesInput, input);
  return callApi<string>(db, 'merge_counterparties', {
    p_from: parsed.fromId,
    p_into: parsed.intoId,
  }, requestId);
}

export async function createBankAccount(
  db: Db, orgId: string, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(CreateBankAccountInput, input);
  return callApi<string>(db, 'create_bank_account', {
    p_org: orgId,
    p_input: {
      name: parsed.name,
      bank_name: parsed.bankName,
      account_number_masked: parsed.accountNumberMasked ?? null,
      sort_code_masked: parsed.sortCodeMasked ?? null,
      currency: parsed.currency ?? null,
      account_type: parsed.accountType,
      ledger_account_id: parsed.ledgerAccountId ?? null,
    },
  }, requestId);
}

export async function setOpeningBalance(
  db: Db, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(SetOpeningBalanceInput, input);
  return callApi<string>(db, 'set_opening_balance', {
    p_account: parsed.bankAccountId,
    p_amount: parsed.amount,
    p_date: parsed.date,
  }, requestId);
}

/**
 * Correct a financial record. There is no in-place amendment anywhere in the system (ADR-026.6):
 * the old row is pointed at its replacement and a `record_status_events` row records the change, so
 * a figure published last month can still be explained by the data that produced it.
 */
export async function supersedeRecord(
  db: Db, input: unknown, requestId?: string,
): Promise<string> {
  const parsed = parse(SupersedeRecordInput, input);
  return callApi<string>(db, 'supersede_record', {
    p_table: parsed.table,
    p_record: parsed.recordId,
    p_replacement: parsed.replacementId,
  }, requestId);
}

/**
 * ADR-047.4 / IMP-GL-011. An opening-balance journal is not trading activity; flagging it excludes
 * it from the P&L and makes it the opening position instead. The flag applies to every line of the
 * journal, because a journal is one economic event however many lines express it.
 */
export async function setOpeningBalanceFlag(
  db: Db, entryId: string, flag: boolean, requestId?: string,
): Promise<number> {
  return callApi<number>(db, 'set_opening_balance_flag', {
    p_entry: entryId,
    p_flag: flag,
  }, requestId);
}
