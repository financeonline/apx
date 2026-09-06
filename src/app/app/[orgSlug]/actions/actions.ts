'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import {
  assignAction, createAction, createFromAlert, setStatus, updateAction,
  type ActionPriority, type ActionStatus,
} from '@/modules/actions';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * The Action Centre's writes (SOW §17; SERVICE_ARCHITECTURE.md §4.13).
 *
 * Each of these is the SECOND permission check, never the only one: every `api.*` function below
 * re-asserts in SQL, and `api.update_own_action` decides for itself whether the caller owns the row
 * (ADR-026). A forged request reaches the database and is refused there.
 */

function optional(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export async function createActionAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;

    await createAction(ctx, {
      title: text(form, 'title'),
      issue: optional(form, 'issue'),
      recommendation: optional(form, 'recommendation'),
      priority: (optional(form, 'priority') ?? 'medium') as ActionPriority,
      ownerUserId: optional(form, 'owner_user_id'),
      dueDate: optional(form, 'due_date'),
    });

    revalidatePath(`/app/${orgSlug}/actions`);
    revalidatePath(`/app/${orgSlug}/home`);
    return done('Added to the Action Centre.');
  } catch (error) {
    return fail(error, { requestId, action: 'actions.create' });
  }
}

/**
 * Move an action along and record what came of it.
 *
 * One server action for every role: a client reaches the same code and the database decides what
 * they may do with it. Branching here on who is asking would put the rule in two places, and the
 * one in the browser's reach is the one that would drift (ADR-003).
 */
export async function setStatusAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;

    const status = text(form, 'status') as ActionStatus;
    await setStatus(ctx, text(form, 'action_id'), status, {
      outcomeNotes: optional(form, 'outcome_notes'),
      outcomeValue: optional(form, 'outcome_value'),
      dismissedReason: optional(form, 'dismissed_reason'),
    });

    revalidatePath(`/app/${orgSlug}/actions`);
    revalidatePath(`/app/${orgSlug}/actions/${text(form, 'action_id')}`);
    revalidatePath(`/app/${orgSlug}/home`);
    return done(MESSAGES[status] ?? 'Updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'actions.set_status' });
  }
}

export async function assignActionAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await assignAction(ctx, text(form, 'action_id'), optional(form, 'owner_user_id'));

    revalidatePath(`/app/${orgSlug}/actions`);
    revalidatePath(`/app/${orgSlug}/actions/${text(form, 'action_id')}`);
    return done(optional(form, 'owner_user_id') === null ? 'Unassigned.' : 'Assigned.');
  } catch (error) {
    return fail(error, { requestId, action: 'actions.assign' });
  }
}

export async function updateActionAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await updateAction(ctx, text(form, 'action_id'), {
      title: text(form, 'title'),
      priority: (optional(form, 'priority') ?? 'medium') as ActionPriority,
      dueDate: optional(form, 'due_date'),
    });

    revalidatePath(`/app/${orgSlug}/actions/${text(form, 'action_id')}`);
    revalidatePath(`/app/${orgSlug}/actions`);
    return done('Updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'actions.update' });
  }
}

/** From an alert, pinning what the alert said at the moment somebody decided to act (ADR-034). */
export async function createFromAlertAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await createFromAlert(ctx, text(form, 'alert_id'));

    revalidatePath(`/app/${orgSlug}/insights`);
    revalidatePath(`/app/${orgSlug}/actions`);
    revalidatePath(`/app/${orgSlug}/home`);
    return done('Added to the Action Centre, with the figures behind it.');
  } catch (error) {
    return fail(error, { requestId, action: 'actions.create_from_alert' });
  }
}

const MESSAGES: Readonly<Record<string, string>> = {
  open: 'Re-opened.',
  in_progress: 'Marked as in progress.',
  completed: 'Marked as done.',
  dismissed: 'Dismissed.',
};
