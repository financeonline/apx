'use server';

import { revalidatePath } from 'next/cache';
import { callApi } from '@/core/db';
import { assertCan } from '@/core/permissions';
import { getPlatformContext } from '@/modules/tenancy';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Requeue a dead or failed job (ROUTE_ARCHITECTURE.md §6 `/platform/jobs`; ADR-067).
 *
 * Authority is `api.requeue_job`: super admin only, and it refuses to revive an `org.purge` for an
 * organisation that is not genuinely pending deletion (ADR-044.6). The action adds nothing to that
 * — it is the button, not the rule.
 */
export async function requeueJobAction(formData: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.jobs.view');
    await callApi(ctx.db, 'requeue_job', { p_job: text(formData, 'jobId') }, ctx.requestId);
    revalidatePath('/platform/jobs');
    return done('Job queued again.');
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.requeueJob' });
  }
}

/**
 * The plain `<form action>` shape, which must return nothing. A refusal is thrown rather than
 * returned, so it reaches the error boundary instead of vanishing into a form that just reloads.
 */
export async function requeueJobForm(formData: FormData): Promise<void> {
  const result = await requeueJobAction(formData);
  if (!result.ok) throw new Error(result.error.message);
}
