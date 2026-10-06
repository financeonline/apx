'use server';

import { revalidatePath } from 'next/cache';
import { ValidationError } from '@/core/errors';
import {
  addActionComment, commentEngagementItem, createEngagementItem, markNotificationsRead, updateEngagementStatus,
  type EngagementKind, type EngagementStatus,
} from '@/modules/engagement';
import { getAccessContext } from '@/modules/tenancy';
import { done, fail, optionalText, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/** Team/Client Management actions (ADR-144). Each is one `api.*` call; the database checks the rest. */

export async function addActionCommentAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  const actionId = text(form, 'action_id');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await addActionComment(ctx, actionId, text(form, 'body'));
    revalidatePath(`/app/${orgSlug}/actions/${actionId}`);
    return done('Comment added.');
  } catch (error) {
    return fail(error, { requestId, action: 'actions.comment' });
  }
}

export async function createEngagementItemAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const kind = text(form, 'kind') as EngagementKind;
    if (kind !== 'request' && kind !== 'deliverable') throw new ValidationError('Choose a request or a deliverable.');
    await createEngagementItem(ctx, {
      kind, title: text(form, 'title'), detail: optionalText(form, 'detail') ?? null, dueDate: optionalText(form, 'due_date') ?? null,
    });
    revalidatePath(`/app/${orgSlug}/engagement`);
    return done(kind === 'request' ? 'Request sent to the team.' : 'Deliverable added.');
  } catch (error) {
    return fail(error, { requestId, action: 'engagement.create' });
  }
}

export async function updateEngagementStatusAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  const itemId = text(form, 'item_id');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await updateEngagementStatus(ctx, itemId, text(form, 'status') as EngagementStatus, optionalText(form, 'note') ?? null);
    revalidatePath(`/app/${orgSlug}/engagement/${itemId}`);
    revalidatePath(`/app/${orgSlug}/engagement`);
    return done('Status updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'engagement.status' });
  }
}

export async function commentEngagementItemAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  const itemId = text(form, 'item_id');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await commentEngagementItem(ctx, itemId, text(form, 'note'));
    revalidatePath(`/app/${orgSlug}/engagement/${itemId}`);
    return done('Comment added.');
  } catch (error) {
    return fail(error, { requestId, action: 'engagement.comment' });
  }
}

export async function markAllReadAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await markNotificationsRead(ctx, null);
    revalidatePath(`/app/${orgSlug}`, 'layout');
    return done('All marked as read.');
  } catch (error) {
    return fail(error, { requestId, action: 'notifications.read' });
  }
}
