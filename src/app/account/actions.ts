'use server';

import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/core/db/user-client';
import { toMotionError } from '@/core/errors';
import { newRequestId } from '@/core/logging';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';
import { assertCan } from '@/core/permissions';
import { clearAiKey, setAiKey } from '@/modules/platform';
import { forgetAiKey } from '@/modules/ai';
import { getPlatformContext } from '@/modules/tenancy';

export async function updateProfileAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const requestId = newRequestId();
  try {
    const db = await createUserClient();
    // api.update_profile accepts only full_name, avatar_url, timezone, onboarding_state and
    // last_active_org_id; email and disabled_at are refused in SQL (ADR-038.3).
    const { error } = await db.schema('api').rpc('update_profile', {
      p_patch: { full_name: text(form, 'full_name'), timezone: text(form, 'timezone') },
    });
    if (error) throw toMotionError(error, requestId);
    revalidatePath('/account');
    return done('Saved.');
  } catch (error) {
    return fail(error, { requestId, action: 'account.updateProfile' });
  }
}

/**
 * The AI provider key (ADR-157), managed by a super admin from their own profile. The key is checked
 * with the provider, stored encrypted, and this server stops using the old one at once (other
 * servers within a minute). It is never echoed back. The database refuses anyone else.
 */
export async function setAiKeyAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'system.manage');
    const ending = await setAiKey(ctx, text(form, 'api_key'));
    forgetAiKey();
    revalidatePath('/account');
    return done(`Saved. The AI now uses the key ending ${ending}.`);
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.setAiKey' });
  }
}

export async function clearAiKeyAction(_previous: ActionResult | null, _form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'system.manage');
    const removed = await clearAiKey(ctx);
    forgetAiKey();
    revalidatePath('/account');
    return done(removed ? 'Removed. Add a new key to keep the AI working.' : 'There was no stored key to remove.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.clearAiKey' });
  }
}
