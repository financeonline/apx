'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { callApi, enqueueServerJob } from '@/core/db';
import { parseMoney } from '@/core/money';
import { setStatementBalancesAndRevalidate } from '@/modules/imports';
import { assertCan } from '@/core/permissions';
import { ValidationError } from '@/core/errors';
import {
  attestReportCompleteness, commitImportBatch, decideImportRows, recordBatchConfirmation, rejectImportBatch,
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
    // re-flagged (§9.3), so the reviewer lands back on a screen that shows them. So does a report
    // that would replace one already imported (IMP-COV-013, Step 0F): the page must re-render to ask.
    revalidatePath(`/app/${orgSlug}/data/imports/${text(form, 'batch_id')}`);
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

/**
 * "Read with AI" (IMPORT_ENGINE.md §5.4; ADR-084; CD-35). The only path that creates a
 * `document.extract` job: a reviewer, after the consent line, on a batch the deterministic parser
 * could not read. `api_server.enqueue_job` re-checks `imports.review`; `begin_extraction` re-checks
 * the organisation's `ai_pdf_extraction` flag and the batch's state when the job runs.
 */
export async function requestAiReadingAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'imports.review');
    if (!ctx.orgId) throw new Error('No organisation.');
    if (form.get('consent') !== 'yes') {
      return fail(new Error('Please confirm you understand the text of this document will be sent to the AI provider.'), { requestId, action: 'imports.aiReading' });
    }
    const batchId = text(form, 'batch_id');
    const documentId = text(form, 'document_id');
    await enqueueServerJob({ userId: ctx.userId, requestId }, {
      organizationId: ctx.orgId, jobType: 'document.extract', payload: { document_id: documentId, batch_id: batchId },
    });
    revalidatePath(`/app/${orgSlug}/data/imports/${batchId}`);
    return done('MOTION is reading the document. This page will show the rows when it is done.');
  } catch (error) {
    return fail(error, { requestId, action: 'imports.aiReading' });
  }
}

/**
 * "I have compared all rows on page N" (§5.4). The page-wide tick is offered only when the page's
 * confidence was high and `IMP-PDF-002` passed; otherwise every row on the page must have been
 * decided first. Both are re-checked here, and `api.confirm_pdf_page` re-checks the permission and
 * the batch's method.
 */
export async function confirmPdfPageAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'imports.review');
    if (!ctx.orgId) throw new Error('No organisation.');
    const batchId = text(form, 'batch_id');
    const page = Number.parseInt(text(form, 'page'), 10);
    if (!Number.isInteger(page) || page < 1) throw new Error('Which page?');

    const { data: batch, error } = await ctx.db.from('import_batches').select('extraction_stats, statement_opening_balance, statement_closing_balance')
      .eq('organization_id', ctx.orgId).eq('id', batchId).maybeSingle();
    if (error) throw error;
    const stats = (batch?.extraction_stats ?? {}) as { confidence?: Record<string, string>; balances_read?: { opening?: string; closing?: string } };
    const typed = batch as { statement_opening_balance: number | string | null; statement_closing_balance: number | string | null } | null;
    const same = (a?: string, b?: number | string | null) => a !== undefined && b !== null && b !== undefined && parseMoney(a).equals(parseMoney(String(b)));
    const copiedFromModel = same(stats.balances_read?.opening, typed?.statement_opening_balance) && same(stats.balances_read?.closing, typed?.statement_closing_balance);
    const { data: rows, error: rowsError } = await ctx.db.from('import_rows').select('status, issues, reviewer_decision')
      .eq('organization_id', ctx.orgId).eq('batch_id', batchId).eq('source_page', page);
    if (rowsError) throw rowsError;
    const pageRows = (rows ?? []) as Array<{ status: string; issues: Array<{ code: string }>; reviewer_decision: string }>;
    const lineCountAgrees = pageRows.every((r) => !r.issues.some((i) => i.code === 'IMP-PDF-002'));
    const pageWide = stats.confidence?.[String(page)] === 'high' && lineCountAgrees && !copiedFromModel;
    const everyRowDecided = pageRows.every((r) => r.reviewer_decision !== 'none' || r.status === 'skipped');
    if (!pageWide && !everyRowDecided) {
      return fail(new Error(`Page ${page} cannot be confirmed as a whole; confirm each row on it first.`), { requestId, action: 'imports.confirmPage' });
    }

    await callApi(ctx.db, 'confirm_pdf_page', { p_batch: batchId, p_page: page }, requestId);
    revalidatePath(`/app/${orgSlug}/data/imports/${batchId}`);
    return done(`Page ${page} confirmed.`);
  } catch (error) {
    return fail(error, { requestId, action: 'imports.confirmPage' });
  }
}

/**
 * The printed balances, typed from the page, and the batch judged again on them (IMPORT_ENGINE.md
 * §5.3, §5.4; ADR-085). `api.set_statement_balances` records who typed them; the re-validation runs
 * the same gate the pipeline ran, over the rows that will commit.
 */
export async function statementBalancesAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'imports.review');
    const batchId = text(form, 'batch_id');
    const money = /^-?\d{1,16}(\.\d{1,2})?$/;
    const opening = text(form, 'opening').replace(/[,£\s]/g, '');
    const closing = text(form, 'closing').replace(/[,£\s]/g, '');
    if (!money.test(opening) || !money.test(closing)) {
      return fail(new Error('Enter both balances as figures, for example 1234.56.'), { requestId, action: 'imports.balances' });
    }
    const result = await setStatementBalancesAndRevalidate(ctx, { batchId, opening, closing });
    revalidatePath(`/app/${orgSlug}/data/imports/${batchId}`);
    return done(result.reconciled
      ? 'The statement reconciles to the balances you entered.'
      : result.comparison === 'matches_ai'
        ? 'Those are the balances the AI read, so they cannot vouch for its rows. Confirm each row against the page.'
        : 'Saved. The transactions do not add up to those balances; see the note above.');
  } catch (error) {
    return fail(error, { requestId, action: 'imports.balances' });
  }
}

/**
 * Step 0F follow-up: an owner or admin confirms what an EXISTING report covers, for one import and
 * one month, after reviewing the stored file — no re-upload. The database enforces the role, the
 * month and the reason, keeps every earlier answer, audits it and queues the recalculation.
 */
export async function attestCompletenessAction(
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
    const coverage = text(form, 'coverage');
    if (coverage !== 'complete' && coverage !== 'partial') {
      return fail(new ValidationError('Choose whether the report is complete or only part of it.'), { requestId, action: 'imports.attest' });
    }
    await attestReportCompleteness(ctx.db, {
      batchId, month: text(form, 'month'), coverage, reason: text(form, 'reason'),
    }, requestId);
    revalidatePath(`/app/${orgSlug}/data/imports/${batchId}`);
    revalidatePath(`/app/${orgSlug}/home`);
    return done('Recorded. Your figures are being recalculated.');
  } catch (error) {
    return fail(error, { requestId, action: 'imports.attest' });
  }
}
