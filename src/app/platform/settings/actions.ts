'use server';

import { revalidatePath } from 'next/cache';
import { assertCan } from '@/core/permissions';
import { updatePlatformSetting } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { done, fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * The platform's defaults (ROUTE_ARCHITECTURE.md §156). `api.update_platform_settings` is super
 * admin at aal2 and audits `platform.settings_changed`; this validates the shape of the value so a
 * typo cannot put a string where every reader expects a number.
 */

/** Keys this page may set, and how their value is read. Anything else is refused here. */
const NUMERIC_KEYS = new Set(['ai_quota_daily', 'ai_token_ceiling_monthly', 'ai_extraction_pages_per_day']);

export async function updateSettingAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'system.manage');
    const key = text(form, 'key');
    const raw = text(form, 'value').trim();

    if (NUMERIC_KEYS.has(key)) {
      if (!/^\d{1,12}$/.test(raw)) {
        return fail(new Error('That limit must be a whole number.'), { requestId: ctx.requestId, action: 'platform.updateSetting' });
      }
      await updatePlatformSetting(ctx, key, Number.parseInt(raw, 10));
    } else {
      // Every other setting is JSON in the table; a malformed value would break its readers.
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return fail(new Error('That value is not valid JSON.'), { requestId: ctx.requestId, action: 'platform.updateSetting' });
      }
      await updatePlatformSetting(ctx, key, value);
    }

    revalidatePath('/platform/settings');
    return done('Saved. It applies to every organisation without its own limit.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.updateSetting' });
  }
}

