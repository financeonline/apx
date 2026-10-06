'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { ValidationError } from '@/core/errors';
import { mergeCounterparties, updateCounterparty } from '@/modules/financials';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * D-5 (owner decision): resolving customers and suppliers HELD for an identity decision — records
 * that became one name when keys became Unicode-aware (ADR-136, migration 20261006000001). Both
 * actions go through the existing audited `api.*` functions; the database's name trigger re-keys a
 * record once no other held record shares its name.
 */
async function run(form: FormData, action: string, body: (ctx: Awaited<ReturnType<typeof getAccessContext>>) => Promise<string>): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'customers.edit');
    const message = await body(ctx);
    revalidatePath(`/app/${orgSlug}/customers/held`);
    revalidatePath(`/app/${orgSlug}/customers`);
    return done(message);
  } catch (error) {
    return fail(error, { requestId, action });
  }
}

/** "They are the same business": every other record of the group is merged into the chosen one. */
export async function mergeHeldAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(form, 'customers.mergeHeld', async (ctx) => {
    const into = text(form, 'into_id');
    const others = form.getAll('member_id').map(String).filter((id) => id !== into);
    if (into === '' || others.length === 0) throw new ValidationError('Choose the record to keep.');
    for (const from of others) await mergeCounterparties(ctx.db, { fromId: from, intoId: into }, ctx.requestId);
    // Re-saving the name re-derives its key: with the others merged away, it takes the plain one.
    await updateCounterparty(ctx.db, { counterpartyId: into, name: text(form, 'into_name') }, ctx.requestId);
    return 'Merged. Imports naming this customer are accepted again.';
  });
}

/** "They are different businesses": one record is renamed; the last one left is re-saved. */
export async function renameHeldAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(form, 'customers.renameHeld', async (ctx) => {
    const name = text(form, 'name').trim();
    if (name === '') throw new ValidationError('Give the record a name.');
    await updateCounterparty(ctx.db, { counterpartyId: text(form, 'counterparty_id'), name }, ctx.requestId);
    return 'Saved.';
  });
}
