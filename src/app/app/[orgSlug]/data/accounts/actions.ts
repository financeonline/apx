'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { remapAccount, setLoanSecurity } from '@/modules/financials';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Re-map an account to a standard category (ADR-004, ADR-034).
 *
 * This is the most consequential edit in the product: an account's category decides which metric it
 * feeds, in every period, so the SQL function closes the account's history row, opens a new one and
 * queues a recalculation in the same transaction. It also refuses a SEEDED account outright — a
 * system account IS its category, and re-mapping one would leave the organisation with no target
 * for that category at all.
 */
export async function remapAccountAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'financials.edit');

    await remapAccount(ctx.db, {
      accountId: text(form, 'account_id'),
      standardCategory: text(form, 'standard_category'),
    }, requestId);

    revalidatePath(`/app/${orgSlug}/data/accounts`);
    return done('Saved. Your figures are being updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'accounts.remap' });
  }
}

/**
 * Mark a loan or long-term liability account secured or unsecured (ADR-156). "unmarked" clears it.
 * The engine reads the marking for the loans-by-security figures, so the SQL function queues a
 * recalculation, as a re-mapping does; it refuses any other category.
 */
export async function setLoanSecurityAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'financials.edit');

    await setLoanSecurity(ctx.db, {
      accountId: text(form, 'account_id'),
      security: text(form, 'loan_security'),
    }, requestId);

    revalidatePath(`/app/${orgSlug}/data/accounts`);
    return done('Saved. Your figures are being updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'accounts.setLoanSecurity' });
  }
}
