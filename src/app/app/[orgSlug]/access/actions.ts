'use server';

import { revalidatePath } from 'next/cache';
import {
  getAccessContext,
  requestAccess,
  withdrawAccessRequest,
  type SwitchablePermission,
} from '@/modules/tenancy';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';
import { asSwitchable } from '../settings/team/access-view';
import { plainRequestRefusal } from './access-view';

/**
 * "Request more information" from the requester's side (ADR-172), in the shape of every settings
 * action (SERVICE_ARCHITECTURE.md §8.9): the context from the slug, never from the form, then the
 * service — which refuses an owner and APX staff, drops what the person already holds and checks the
 * message length — and then `api.request_access`, which re-checks all of it and enforces one waiting
 * request and five a day. Those two refusals are put into plain words; nothing is swallowed.
 */

export async function requestAccessAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const permissions = form
      .getAll('permissions')
      .map((value) => (typeof value === 'string' ? asSwitchable(value) : null))
      .filter((value): value is SwitchablePermission => value !== null);
    // Not trimmed here: the service trims, and refuses more than 1,000 characters in its own words.
    const raw = form.get('message');
    const message = typeof raw === 'string' ? raw : null;
    await requestAccess(ctx, { permissions, message });
    revalidatePath(`/app/${orgSlug}`, 'layout');
    return done('Sent. The company’s owner and admins have been told; their answer will appear here and in your notifications.');
  } catch (error) {
    const result = fail(error, { requestId, action: 'access.request' });
    return result.ok ? result : { ok: false, error: plainRequestRefusal(result.error) };
  }
}

export async function withdrawAccessRequestAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await withdrawAccessRequest(ctx, text(form, 'request_id'));
    revalidatePath(`/app/${orgSlug}`, 'layout');
    return done('Withdrawn. You can ask again whenever you need to.');
  } catch (error) {
    const result = fail(error, { requestId, action: 'access.withdraw' });
    return result.ok ? result : { ok: false, error: plainRequestRefusal(result.error) };
  }
}
