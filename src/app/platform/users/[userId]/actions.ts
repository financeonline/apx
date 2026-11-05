'use server';

import { revalidatePath } from 'next/cache';
import { assertCan, permissionsFor } from '@/core/permissions';
import { saveAnalystAccess } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { done, fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/** The super admin saves one analyst's access in one company (ADR-187). */
export async function saveAnalystAccessAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.users.manage');
    const userId = text(form, 'user_id');
    await saveAnalystAccess(ctx, {
      organizationId: text(form, 'org_id'),
      employeeUserId: userId,
      departments: form.getAll('department').filter((v): v is string => typeof v === 'string'),
      permissions: form.getAll('permission').filter((v): v is string => typeof v === 'string'),
      analystDefaults: permissionsFor('employee'),
    });
    revalidatePath(`/platform/users/${userId}`);
    return done('Saved. It applies on their next page.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.saveAnalystAccess' });
  }
}
