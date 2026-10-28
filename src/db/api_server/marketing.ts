import 'server-only';
import { arg, type DbFunctions } from '../registry';
import { raise } from '../raise';
import { globalRow, nowIso, orgRow } from '../schema';
import { runTx } from '../tx';
import { readerOf, type Db } from '../types';
import { prepareAudit } from '../app/audit';
import { requireScope } from '../app/scope';
import { prepareNotify } from '../app/shared';
import { btrim, leftChars } from '../app/financials-helpers';
import { marketingEnabled, marketingInFlightGuard } from '../app/marketing-reports';

/**
 * `api_server.*` functions of Marketing (ADR-170), ported from PostgreSQL (FIRESTORE_DATA_MODEL.md
 * §8): the `marketing.generate` job's three writes, on the job's scoped handle (`requireScope`). The
 * attempt was created by `api.request_marketing_report`; these only move it forward, and give up the
 * `marketing_reports_one_in_flight` slot when it finishes either way.
 *
 * A finished attempt is never changed again (`app.marketing_report_guard`): each write here only
 * touches an attempt still queued or running.
 */

const count = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/** `api_server.start_marketing_report(p_org, p_report)` → p_report, or null when there is nothing to do. */
async function start_marketing_report(db: Db, args: Record<string, unknown>): Promise<string | null> {
  const org = arg.str(args, 'p_org');
  requireScope(db, org);
  const orgId = org!;
  const reportId = arg.str(args, 'p_report');

  return runTx(db, async (tx) => {
    const ref = reportId ? orgRow(db.fs, orgId, 'marketing_reports', reportId) : null;
    const snap = ref ? await tx.get(ref) : null;
    if (!ref || !snap?.exists) raise.notFound();
    const status = String(snap.get('status'));
    if (status !== 'queued' && status !== 'running') return null;
    const now = nowIso();
    if (!(await marketingEnabled(db.fs, orgId, readerOf(tx)))) {
      const claim = await marketingInFlightGuard(db.fs, orgId).read(tx);
      tx.update(ref, { status: 'failed', failure: 'Marketing is switched off for this company.', finished_at: now, updated_at: now });
      if (claim.owner === reportId) claim.release(tx);
      return null;
    }
    tx.update(ref, { status: 'running', started_at: now, updated_at: now });
    return reportId;
  });
}

/**
 * `api_server.finish_marketing_report(p_org, p_report, p_content, p_model, p_prompt_version,
 * p_input_tokens, p_output_tokens)` → p_report. Stores the `marketing-v1` document with what it cost,
 * and tells the person who asked.
 */
async function finish_marketing_report(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.str(args, 'p_org');
  requireScope(db, org);
  const orgId = org!;
  const reportId = arg.str(args, 'p_report');
  const content = args.p_content;
  if (content === null || typeof content !== 'object' || Array.isArray(content)
    || (content as Record<string, unknown>).version !== 'marketing-v1') {
    raise.invalid('a marketing report is a marketing-v1 document');
  }
  if (JSON.stringify(content).length > 1_000_000) raise.invalid('the marketing report is too large to store');
  const model = btrim(String(args.p_model ?? ''));
  const promptVersion = btrim(String(args.p_prompt_version ?? ''));
  if (model === '' || promptVersion === '') raise.invalid('a finished report names its model and prompt version');
  const inputTokens = count(args.p_input_tokens);
  const outputTokens = count(args.p_output_tokens);
  if (inputTokens === null || inputTokens < 0 || outputTokens === null || outputTokens < 0) {
    raise.invalid('token counts are whole numbers from zero');
  }

  return runTx(db, async (tx) => {
    const ref = reportId ? orgRow(db.fs, orgId, 'marketing_reports', reportId) : null;
    const snap = ref ? await tx.get(ref) : null;
    if (!ref || !snap?.exists || snap.get('status') !== 'running') {
      raise.conflict('that marketing report is not being written');
    }
    const requestedBy = (snap.get('requested_by') as string | null | undefined) ?? null;
    const claim = await marketingInFlightGuard(db.fs, orgId).read(tx);
    const event = await prepareAudit(db, {
      organizationId: orgId, action: 'marketing.report_ready', targetTable: 'marketing_reports', targetId: reportId,
      after: { model, prompt_version: promptVersion },
      metadata: { input_tokens: inputTokens, output_tokens: outputTokens },
    }, tx);
    const organization = await tx.get(globalRow(db.fs, 'organizations', orgId));
    const notice = await prepareNotify(db.fs, {
      orgId, userId: requestedBy, actorId: null, permission: 'reports.view', kind: 'report_ready',
      title: 'Your marketing report is ready', body: null, href: `/app/${String(organization.get('slug') ?? '')}/marketing`,
    }, readerOf(tx));

    const now = nowIso();
    tx.update(ref, {
      status: 'ready', report: content, report_version: 'marketing-v1', failure: null, model,
      prompt_version: promptVersion, input_tokens: inputTokens, output_tokens: outputTokens,
      finished_at: now, updated_at: now,
    });
    if (claim.owner === reportId) claim.release(tx);
    event.write(tx);
    notice.write(tx);
    return reportId!;
  });
}

/**
 * `api_server.fail_marketing_report(p_org, p_report, p_failure, p_model, p_prompt_version,
 * p_input_tokens, p_output_tokens)` → p_report, or null when the attempt had already finished.
 */
async function fail_marketing_report(db: Db, args: Record<string, unknown>): Promise<string | null> {
  const org = arg.str(args, 'p_org');
  requireScope(db, org);
  const orgId = org!;
  const reportId = arg.str(args, 'p_report');
  const failureText = btrim(String(args.p_failure ?? ''));
  const failure = failureText === '' ? null : leftChars(failureText, 500);
  if (failure === null) raise.invalid('a failed report says why');
  const inputTokens = args.p_input_tokens === undefined ? 0 : count(args.p_input_tokens);
  const outputTokens = args.p_output_tokens === undefined ? 0 : count(args.p_output_tokens);
  if (inputTokens === null || inputTokens < 0 || outputTokens === null || outputTokens < 0) {
    raise.invalid('token counts are whole numbers from zero');
  }
  const optional = (v: unknown) => {
    const t = btrim(String(v ?? ''));
    return t === '' ? null : t;
  };

  return runTx(db, async (tx) => {
    const ref = reportId ? orgRow(db.fs, orgId, 'marketing_reports', reportId) : null;
    const snap = ref ? await tx.get(ref) : null;
    if (!ref || !snap?.exists) raise.notFound();
    const status = String(snap.get('status'));
    if (status !== 'queued' && status !== 'running') return null;
    const claim = await marketingInFlightGuard(db.fs, orgId).read(tx);
    const event = await prepareAudit(db, {
      organizationId: orgId, action: 'marketing.report_failed', targetTable: 'marketing_reports', targetId: reportId,
      after: { failure }, metadata: { input_tokens: inputTokens, output_tokens: outputTokens },
    }, tx);
    const now = nowIso();
    tx.update(ref, {
      status: 'failed', failure, model: optional(args.p_model), prompt_version: optional(args.p_prompt_version),
      input_tokens: inputTokens, output_tokens: outputTokens, finished_at: now, updated_at: now,
    });
    if (claim.owner === reportId) claim.release(tx);
    event.write(tx);
    return reportId;
  });
}

export const functions: DbFunctions = {
  start_marketing_report,
  finish_marketing_report,
  fail_marketing_report,
};
