'use server';

import { revalidatePath } from 'next/cache';
import { assertCan } from '@/core/permissions';
import { updateOrgQuotas, updateOrganizationAsPlatform } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { done, fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * What a super admin may change about a customer organisation (ROUTE_ARCHITECTURE.md §150).
 *
 * `api.update_organization` owns the rules for status, plan and features — status moves only
 * between active and suspended, deletion goes through `api.request_deletion`, and quota keys are
 * refused there because they are platform-controlled. `api.update_platform_org_settings` owns the
 * quotas. These actions are the forms.
 */

export async function setOrgStatusAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.orgs.manage');
    const orgId = text(form, 'org_id');
    const status = text(form, 'status');
    await updateOrganizationAsPlatform(ctx, orgId, { status });
    revalidatePath(`/platform/organizations/${orgId}`);
    return done(status === 'suspended' ? 'The organisation is suspended.' : 'The organisation is active again.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.setOrgStatus' });
  }
}

export async function setOrgFeatureAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.orgs.manage');
    const orgId = text(form, 'org_id');
    const feature = text(form, 'feature');
    const enabled = form.get('enabled') === 'yes';
    // `features` is patched whole, so the current set is sent back with this one key changed.
    const current = JSON.parse(text(form, 'current_features')) as Record<string, unknown>;
    await updateOrganizationAsPlatform(ctx, orgId, { features: { ...current, [feature]: enabled } });
    revalidatePath(`/platform/organizations/${orgId}`);
    return done(enabled ? `${feature} is on for this organisation.` : `${feature} is off.`);
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.setOrgFeature' });
  }
}

export async function setOrgQuotasAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.orgs.manage');
    const orgId = text(form, 'org_id');
    const patch: Record<string, unknown> = {};
    for (const key of ['ai_quota_daily', 'ai_token_ceiling_monthly', 'ai_extraction_pages_per_day']) {
      const raw = String(form.get(key) ?? '').trim();
      if (raw === '') continue;
      if (!/^\d{1,12}$/.test(raw)) {
        return fail(new Error(`${key.replace(/_/g, ' ')} must be a whole number.`), { requestId: ctx.requestId, action: 'platform.setOrgQuotas' });
      }
      patch[key] = Number.parseInt(raw, 10);
    }
    const notes = String(form.get('notes') ?? '').trim();
    if (notes !== '') patch.notes = notes.slice(0, 1000);
    if (Object.keys(patch).length === 0) return done('Nothing to change.');
    await updateOrgQuotas(ctx, orgId, patch);
    revalidatePath(`/platform/organizations/${orgId}`);
    return done('Saved. Blank fields keep the platform default.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.setOrgQuotas' });
  }
}
