'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { setOpeningBalance } from '@/modules/financials';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * The opening-balance form (UX_ARCHITECTURE.md §4 bank-only variant, CD-06).
 *
 * A bank statement says what moved, not what was there to begin with. Without the opening balance
 * the cash figure is not computable, and §4 forbids showing it as £0 — so this is the one edit that
 * turns "—" into a number on the Cash page.
 *
 * The shape is the one every action follows (SERVICE_ARCHITECTURE.md §8.9): the context is built
 * from the slug in the form and never trusted from anything else, `assertCan` runs before the
 * service, and `api.set_opening_balance` re-checks `financials.edit` in SQL, where a direct
 * PostgREST call cannot get round it (ADR-026).
 */
export async function setOpeningBalanceAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'financials.edit');

    await setOpeningBalance(ctx.db, {
      bankAccountId: text(form, 'bank_account_id'),
      amount: text(form, 'amount'),
      date: text(form, 'balance_date'),
    }, requestId);

    revalidatePath(`/app/${orgSlug}/money/cash`);
    return done('Saved. Your cash figures are being updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'money.setOpeningBalance' });
  }
}
