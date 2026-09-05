'use server';

import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/core/db/user-client';
import { toMotionError } from '@/core/errors';
import { newRequestId } from '@/core/logging';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

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
