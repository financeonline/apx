'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { createBankAccount } from '@/modules/financials';
import { markTransfer, overrideBankCategory } from '@/modules/banking';
import { fail, done, optionalText, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Banking edits (Phase 13, ADR-101; SERVICE_ARCHITECTURE.md §4.7, §8.9).
 *
 * Every action builds its context from the slug in the form, asserts the permission before the
 * service, and the `api.*` function re-checks it in SQL (ADR-026). Each edit queues a
 * recalculation (`banking_edit`), so the figures on screen catch up on their own.
 */

export async function createBankAccountAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'financials.edit');
    // No currency is sent: `api.create_bank_account` uses the organisation's (ADR-101).
    await createBankAccount(ctx.db, ctx.orgId!, {
      name: text(form, 'name'),
      bankName: text(form, 'bank_name'),
      accountType: text(form, 'account_type'),
      accountNumberMasked: last4(optionalText(form, 'account_last4')),
      sortCodeMasked: optionalText(form, 'sort_code_masked') || undefined,
    }, requestId);
    revalidatePath(`/app/${orgSlug}/money/banking`);
    return done('Account added. Upload a statement for it from Add data.');
  } catch (error) {
    return fail(error, { requestId, action: 'banking.createAccount' });
  }
}

/** Only the last four digits are ever stored (ADR-029.4). */
function last4(value: string | undefined): string | undefined {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 0) return undefined;
  return `****${digits.slice(-4)}`;
}

export async function categoriseTransactionAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  const transactionId = text(form, 'transaction_id');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'banking.reconcile');
    const accountId = optionalText(form, 'category_account_id') || null;
    await overrideBankCategory(ctx.db, transactionId, accountId, requestId);
    revalidatePath(`/app/${orgSlug}/money/banking/transactions/${transactionId}`);
    revalidatePath(`/app/${orgSlug}/money/banking`);
    return done('Category saved. Your figures are being updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'banking.categorise' });
  }
}

export async function pairTransferAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  const transactionId = text(form, 'transaction_id');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'banking.reconcile');
    // An empty pair unmarks. The KIND is never sent: SQL derives it from the two accounts (ADR-028).
    const pairId = optionalText(form, 'pair_id') || null;
    await markTransfer(ctx.db, transactionId, pairId, requestId);
    revalidatePath(`/app/${orgSlug}/money/banking/transactions/${transactionId}`);
    revalidatePath(`/app/${orgSlug}/money/banking`);
    return done(pairId ? 'Marked as a transfer. Your figures are being updated.' : 'No longer a transfer. Your figures are being updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'banking.pairTransfer' });
  }
}
