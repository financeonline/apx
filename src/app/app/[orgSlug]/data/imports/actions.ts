'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import {
  commitImportBatch, decideImportRows, recordBatchConfirmation, rejectImportBatch,
  rollbackImportBatch, startImport,
} from '@/modules/imports';
import type { ImportType } from '@/modules/imports';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * The import wizard's writes (IMPORT_ENGINE.md §2–§12).
 *
 * Each is a thin call over a service that is itself thin over a SECURITY DEFINER function. The
 * permission is asserted here so the page can fail early with a sentence, and again in SQL so a
 * forged request achieves nothing (ADR-026).
 */

export async function startImportAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  let batchId: string | null = null;

  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'imports.create');

    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return fail(new Error('Choose a file to import.'), { requestId, action: 'imports.start' });
    }

    const bankAccount = form.get('bank_account_id');

    const result = await startImport({
      organizationId: ctx.orgId!,
      userId: ctx.userId,
      requestId: ctx.requestId,
      db: ctx.db,
      file,
      importType: text(form, 'import_type') as ImportType,
      periodStart: text(form, 'period_start'),
      periodEnd: text(form, 'period_end'),
      bankAccountId: typeof bankAccount === 'string' && bankAccount !== '' ? bankAccount : null,
    });

    batchId = result.batchId;
  } catch (error) {
    return fail(error, { requestId, action: 'imports.start' });
  }

  // Outside the try: `redirect` works by throwing, and catching it would turn a successful import
  // into an error message.
  revalidatePath(`/app/${orgSlug}/data/imports`);
  redirect(`/app/${orgSlug}/data/imports/${batchId}`);
}

export async function decideRowsAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'imports.review');

    const batchId = text(form, 'batch_id');
    const decision = text(form, 'decision');
    const rowIds = form.getAll('row_id').map(String).filter((id) => id !== '');
    const reason = String(form.get('reason') ?? '');

    if (rowIds.length === 0) {
      return fail(new Error('Choose at least one row.'), { requestId, action: 'imports.decide' });
    }

    await decideImportRows(ctx.db, {
      batchId,
      decisions: rowIds.map((rowId) => ({ rowId, decision, reason: reason === '' ? null : reason })),
    }, requestId);

    revalidatePath(`/app/${orgSlug}/data/imports/${batchId}`);
    return done(
      decision === 'keep'
        ? `${rowIds.length} row${rowIds.length === 1 ? '' : 's'} will be imported.`
        : `${rowIds.length} row${rowIds.length === 1 ? '' : 's'} will be skipped.`,
    );
  } catch (error) {
    return fail(error, { requestId, action: 'imports.decide' });
  }
}

export async function confirmBatchAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'imports.review');

    const batchId = text(form, 'batch_id');

    /*
     * A confirmation is not always a yes.
     *
     * `IMP-RANGE-015` SETS the declared export range rather than merely acknowledging it (ADR-047.6),
     * and the trial-balance codes set the basis and the sign — the engine reads those columns, so
     * they have to come from a human decision. Every field the form sends as `value_*` becomes part
     * of the confirmation's value, so a new code needs a field on the page and nothing here.
     */
    const value: Record<string, unknown> = {};
    for (const [key, entry] of form.entries()) {
      if (key.startsWith('value_')) value[key.slice(6)] = String(entry);
    }
    if (Object.keys(value).length === 0) value.answer = 'yes';

    await recordBatchConfirmation(ctx.db, batchId, text(form, 'code'), value, requestId);

    revalidatePath(`/app/${orgSlug}/data/imports/${batchId}`);
    return done('Noted.');
  } catch (error) {
    return fail(error, { requestId, action: 'imports.confirm' });
  }
}

export async function commitBatchAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    // RBAC §2.1: `imports.review` covers "map, resolve issues, commit, roll back".
    assertCan(ctx, 'imports.review');

    const batchId = text(form, 'batch_id');
    const result = await commitImportBatch(ctx.db, batchId, requestId);

    revalidatePath(`/app/${orgSlug}/data/imports/${batchId}`);
    revalidatePath(`/app/${orgSlug}/home`);

    return done(
      `${result.committed} row${result.committed === 1 ? '' : 's'} imported. `
      + 'Your figures are being recalculated.',
    );
  } catch (error) {
    // A commit-time duplicate collision comes back as a ConflictError with the rows already
    // re-flagged (§9.3), so the reviewer lands back on a screen that shows them.
    return fail(error, { requestId, action: 'imports.commit' });
  }
}

export async function rejectBatchAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'imports.review');

    const batchId = text(form, 'batch_id');
    await rejectImportBatch(ctx.db, batchId, text(form, 'reason'), requestId);

    revalidatePath(`/app/${orgSlug}/data/imports`);
    return done('Discarded. Nothing from that file was imported.');
  } catch (error) {
    return fail(error, { requestId, action: 'imports.reject' });
  }
}

export async function rollbackBatchAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'imports.review');

    const batchId = text(form, 'batch_id');
    const result = await rollbackImportBatch(ctx.db, batchId, text(form, 'reason'), requestId);

    revalidatePath(`/app/${orgSlug}/data/imports`);
    revalidatePath(`/app/${orgSlug}/home`);
    return done(
      `${result.rejected} row${result.rejected === 1 ? '' : 's'} removed. `
      + 'Your figures are being recalculated.',
    );
  } catch (error) {
    return fail(error, { requestId, action: 'imports.rollback' });
  }
}
