import 'server-only';
import type { DocumentData, DocumentReference, Transaction } from 'firebase-admin/firestore';
import type { Permission } from '@/core/permissions';
import { raise } from '../raise';
import { arg, type DbFunction, type DbFunctions } from '../registry';
import { globalCollection, globalRow, newId, nowIso, orgCollection, orgRow, uniqueGuard } from '../schema';
import { runTx } from '../tx';
import { readerOf, type Db, type Reader } from '../types';
import { hasPermissionOf } from '../app/access';
import { prepareAudit, type PreparedAudit } from '../app/audit';
import { prepareEnqueue } from '../app/jobs';
import { requireScope, requireServer } from '../app/scope';
import { prepareNotify } from '../app/shared';
import {
  ALERT_KEY_KINDS, ALERT_REASONS, ALERT_STATUSES, ALERT_SUBJECTS, REPORT_KINDS, SEVERITIES,
  checkSameOrgRef, checkViolation, dateValue, enumValue, hexValue, nonEmpty, orgPeople, sameOrgRefTarget, textOf,
} from '../app/actions-helpers';
import { prepareAlertBundle } from '../app/actions-evidence';
import { inFlightGuard, investmentEnabled } from '../app/investment-quota';

/**
 * Reporting's server-observed facts (ADR-043, ADR-090), ported from PostgreSQL
 * (FIRESTORE_DATA_MODEL.md §8): composed reports and their PDFs (Phase 17), the monthly report file,
 * the hourly sweep that queues the scheduled briefs, the Investment Pack's three job writes
 * (ADR-171), and the alert engine's write, `persist_alerts` (ALERTS_MODEL.md §8).
 *
 * Every function first refuses anything but the server (`requireServer`), and every organisation
 * write must run inside that organisation's job scope (`requireScope`). What the triggers did is done
 * by the writer: `notify_report_ready` on `reports`, `set_updated_at` and the immutability guards on
 * `investment_reports` and `alerts`, `same_org_ref` on alerts / evidence, and the CHECK constraints
 * the rows were held to (raised with PostgreSQL's own sentence, as CONFLICT — `23514`).
 */

const day = (iso: string, plus: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plus);
  return d.toISOString().slice(0, 10);
};
/** ISO weekday, Monday = 1 (`extract(isodow from …)`). */
const isoDow = (iso: string): number => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

// ── Composed reports (Phase 17) ──────────────────────────────────────────────────────────────────

/** The `reports` CHECK constraints, in the order PostgreSQL would report them. */
function checkReport(row: DocumentData): void {
  if (!row.content || typeof row.content !== 'object' || Array.isArray(row.content)) checkViolation('reports', 'reports_content_object');
  if (row.report_kind === 'monthly_management') checkViolation('reports', 'reports_kind_composed');
  if (row.origin !== 'scheduled' && row.origin !== 'requested') checkViolation('reports', 'reports_origin');
  const v = String(row.content_version ?? '');
  if (v.length < 1 || v.length > 40) checkViolation('reports', 'reports_content_version');
  if (row.window_end < row.window_start) checkViolation('reports', 'reports_window');
  if (row.report_kind === 'daily_brief' && row.window_end !== row.window_start) checkViolation('reports', 'reports_daily_window');
  if (row.report_kind === 'weekly_intelligence'
    && !(isoDow(row.window_start) === 1 && row.window_end === day(row.window_start, 6))) {
    checkViolation('reports', 'reports_weekly_window');
  }
  if (row.origin === 'scheduled' && row.requested_by !== null) checkViolation('reports', 'reports_scheduled_has_no_actor');
  if (row.report_kind === 'custom_ai' && !(row.origin === 'requested' && row.requested_by !== null)) {
    checkViolation('reports', 'reports_custom_is_requested');
  }
  if (['adviser', 'custom_ai', 'funding_readiness'].includes(row.report_kind) && row.period_id === null) {
    checkViolation('reports', 'reports_period_required');
  }
}

/**
 * The `notify_report_ready` trigger: the weekly and adviser reports only (a notification every
 * morning for the daily brief would be noise, and a custom report is its author's own), to every
 * person who can read it — ADR-172: these two kinds are internal reports, readable with
 * `financials.view` as well.
 */
async function prepareReportReady(
  db: Db, orgId: string, row: DocumentData, r: Reader,
): Promise<Array<{ write(tx: Transaction): void }>> {
  if (row.report_kind !== 'weekly_intelligence' && row.report_kind !== 'adviser') return [];
  const org = await r.get(globalRow(db.fs, 'organizations', orgId));
  const slug = org.exists ? String(org.get('slug')) : '';
  const out: Array<{ write(tx: Transaction): void }> = [];
  for (const person of await orgPeople(db.fs, orgId, r)) {
    if (!(await hasPermissionOf(db.fs, person, orgId, 'financials.view', r))) continue;
    out.push(await prepareNotify(db.fs, {
      orgId, userId: person, actorId: row.requested_by as string | null, permission: 'reports.view' as Permission,
      kind: 'report_ready',
      title: row.report_kind === 'weekly_intelligence' ? 'Your weekly report is ready' : 'An Accountant/CFO Report is ready',
      body: `Covering ${row.window_start} to ${row.window_end}.`,
      href: `/app/${slug}/reports/r/${row.id}`,
    }, r));
  }
  return out;
}

/** `api_server.record_report`: stores what a composed report said (append-only). */
const record_report: DbFunction = async (db, args) => {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const actor = arg.str(args, 'p_actor');
  const kind = enumValue(REPORT_KINDS, args.p_kind, 'report_kind_enum');
  const origin = arg.str(args, 'p_origin');
  const periodId = arg.str(args, 'p_period');
  const jobId = arg.str(args, 'p_job');
  const contentVersion = arg.str(args, 'p_content_version');
  const windowStart = dateValue(arg.req(args, 'p_window_start'))!;
  const windowEnd = dateValue(arg.req(args, 'p_window_end'))!;

  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    // A person's report is theirs only while they may make one. The scheduled sweep has no actor.
    if (actor !== null) {
      if (kind === 'custom_ai') {
        if (!((await hasPermissionOf(db.fs, actor, orgId, 'reports.view', r))
          && (await hasPermissionOf(db.fs, actor, orgId, 'ai.use', r)))) {
          raise.denied('reports.view and ai.use');
        }
      } else if (!(await hasPermissionOf(db.fs, actor, orgId, 'reports.generate', r))) {
        raise.denied('reports.generate');
      }
    } else if (origin !== 'scheduled') {
      raise.invalid('a requested report names who requested it');
    }
    if (periodId !== null && !(await r.get(orgRow(db.fs, orgId, 'fiscal_periods', periodId))).exists) raise.notFound();

    const id = newId();
    const row = {
      id, organization_id: orgId, report_kind: kind, window_start: windowStart, window_end: windowEnd,
      period_id: periodId, origin, requested_by: actor, job_id: jobId, content: args.p_content ?? null,
      content_version: contentVersion, created_at: nowIso(),
    };
    checkReport(row);
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'report.composed', targetTable: 'reports', targetId: id, before: null,
      after: { report_kind: kind, window_start: windowStart, window_end: windowEnd, origin, content_version: contentVersion },
      metadata: { job_id: jobId }, actorId: actor,
    }, tx);
    const notices = await prepareReportReady(db, orgId, row, r);

    tx.set(orgRow(db.fs, orgId, 'reports', id), row);
    audit.write(tx);
    for (const n of notices) n.write(tx);
    return id;
  });
};

/**
 * A `report_files` row with its `report_files_object_unique` (storage_bucket, storage_path) guard. The
 * caller names the FILE, never the PATH (R2-A-09): the path is derived here, so a caller cannot point
 * a download at another organisation's object.
 */
async function prepareReportFile(
  db: Db, tx: Transaction, orgId: string, row: DocumentData, audit: Parameters<typeof prepareAudit>[1],
): Promise<{ write(tx: Transaction): void }> {
  const ref = orgRow(db.fs, orgId, 'report_files', String(row.id));
  const existing = await tx.get(ref);
  const claim = await uniqueGuard(db.fs, { orgId }, 'report_files_object_unique', [row.storage_bucket, row.storage_path]).read(tx);
  if (existing.exists) raise.conflict('duplicate key value violates unique constraint "report_files_pkey"');
  const prepared = await prepareAudit(db, audit, tx);
  return {
    write(t) {
      claim.take(t, String(row.id), 'duplicate key value violates unique constraint "report_files_object_unique"');
      t.set(ref, row);
      prepared.write(t);
    },
  };
}

function reportFileRow(input: {
  id: string; orgId: string; periodId: string | null; reportId: string | null; kind: string; jobId: string | null;
  path: string; sha256: string | null; bytes: number | null; actor: string | null;
}): DocumentData {
  const row = {
    id: input.id, organization_id: input.orgId, period_id: input.periodId, report_kind: input.kind,
    job_id: input.jobId, storage_bucket: 'reports', storage_path: input.path, sha256: input.sha256,
    byte_size: input.bytes, generated_by: input.actor, evidence_bundle_id: null, deleted_at: null,
    created_at: nowIso(), report_id: input.reportId,
  };
  const monthly = row.report_kind === 'monthly_management' && row.period_id !== null && row.report_id === null;
  const composed = row.report_kind !== 'monthly_management' && row.report_id !== null;
  if (!monthly && !composed) checkViolation('report_files', 'report_files_subject');
  return row;
}

/** `api_server.record_report_file`: the monthly management report's rendered PDF (ADR-038.7, ADR-043.4). */
const record_report_file: DbFunction = async (db, args) => {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  // ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  // arrives with no scope, or with another organization's, is refused before it writes anything.
  requireScope(db, orgId);
  const actor = arg.str(args, 'p_actor');
  const periodId = arg.req(args, 'p_period');
  const jobId = arg.str(args, 'p_job');
  const id = arg.str(args, 'p_file') ?? newId();
  const sha256 = hexValue(args.p_sha256);
  const bytes = arg.num(args, 'p_bytes');

  return runTx(db, async (tx) => {
    if (!(await tx.get(orgRow(db.fs, orgId, 'fiscal_periods', periodId))).exists) raise.notFound();
    const row = reportFileRow({
      id, orgId, periodId, reportId: null, kind: 'monthly_management', jobId,
      path: `${orgId}/${periodId}/${id}.pdf`, sha256, bytes, actor,
    });
    const file = await prepareReportFile(db, tx, orgId, row, {
      organizationId: orgId, action: 'report.generated', targetTable: 'report_files', targetId: id, before: null,
      after: { period_id: periodId, byte_size: bytes }, metadata: { job_id: jobId }, actorId: actor,
    });
    file.write(tx);
    return id;
  });
};

/** `api_server.record_report_pdf`: the PDF of a stored (composed) report; the path is derived here. */
const record_report_pdf: DbFunction = async (db, args) => {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const actor = arg.str(args, 'p_actor');
  const reportId = arg.req(args, 'p_report');
  const jobId = arg.str(args, 'p_job');
  const id = arg.str(args, 'p_file') ?? newId();
  const sha256 = hexValue(args.p_sha256);
  const bytes = arg.num(args, 'p_bytes');

  return runTx(db, async (tx) => {
    const report = await tx.get(orgRow(db.fs, orgId, 'reports', reportId));
    if (!report.exists) raise.notFound();
    const kind = String(report.get('report_kind'));
    const row = reportFileRow({
      id, orgId, periodId: (report.get('period_id') as string | null) ?? null, reportId, kind, jobId,
      path: `${orgId}/r/${reportId}/${id}.pdf`, sha256, bytes, actor,
    });
    const file = await prepareReportFile(db, tx, orgId, row, {
      organizationId: orgId, action: 'report.generated', targetTable: 'report_files', targetId: id, before: null,
      after: { report_id: reportId, report_kind: kind, byte_size: bytes }, metadata: { job_id: jobId }, actorId: actor,
    });
    file.write(tx);
    return id;
  });
};

/** The organisation's local calendar date, or null for a time zone the runtime does not know. */
function localDate(at: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return null;
  }
}

/**
 * `api_server.enqueue_scheduled_reports(now)`: the hourly sweep — yesterday's daily brief for every
 * active organisation MOTION has calculated for, and on a local Monday last week's report. Once per
 * organisation, kind and window: a job in any state, or a report already stored, means done.
 */
const enqueue_scheduled_reports: DbFunction = async (db, args) => {
  requireServer(db);
  const now = args.p_now ? new Date(String(args.p_now)) : new Date();
  const orgs = (await globalCollection(db.fs, 'organizations').where('status', '==', 'active').get()).docs
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let count = 0;
  for (const org of orgs) {
    const today = localDate(now, String(org.get('timezone') ?? ''));
    if (!today) continue;
    // An organisation MOTION has never calculated for has nothing to brief on.
    const ran = await orgCollection(db.fs, org.id, 'calculation_runs').where('status', '==', 'succeeded').limit(1).get();
    if (ran.empty) continue;

    for (const kind of ['daily_brief', 'weekly_intelligence'] as const) {
      let start: string;
      let end: string;
      if (kind === 'daily_brief') {
        start = day(today, -1);
        end = start;
      } else {
        // Only on a local Monday, for the week that ended last night.
        if (isoDow(today) !== 1) continue;
        start = day(today, -7);
        end = day(today, -1);
      }
      const key = `report.compose:${org.id}:${kind}:${start}`;
      const job = await globalCollection(db.fs, 'jobs').where('job_type', '==', 'report.compose')
        .where('idempotency_key', '==', key).limit(1).get();
      if (!job.empty) continue;
      const stored = await orgCollection(db.fs, org.id, 'reports').where('report_kind', '==', kind)
        .where('window_start', '==', start).limit(1).get();
      if (!stored.empty) continue;

      const created = await runTx(db, async (tx) => {
        const enqueue = await prepareEnqueue(db.fs, {
          organizationId: org.id, jobType: 'report.compose',
          payload: { kind, windowStart: start, windowEnd: end, origin: 'scheduled' },
          requestedBy: null, idempotencyKey: key,
        }, tx);
        // `on conflict do nothing`: a job another sweep queued meanwhile stands as it is.
        if (enqueue.merged) return false;
        const audit = await prepareAudit(db, {
          organizationId: org.id, action: 'job.enqueued', targetTable: 'jobs', targetId: enqueue.id, before: null,
          after: { job_type: 'report.compose', reason: 'scheduled', report_kind: kind, window_start: start },
          metadata: {}, actorId: null,
        }, tx);
        enqueue.write(tx);
        audit.write(tx);
        return true;
      });
      if (created) count += 1;
    }
  }
  return count;
};

// ── Investment Pack (ADR-171) ────────────────────────────────────────────────────────────────────

/** `api_server.start_investment_report`: marks the attempt running; null when there is nothing to do. */
const start_investment_report: DbFunction = async (db, args) => {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const reportId = arg.req(args, 'p_report');
  return runTx(db, async (tx) => {
    const ref = orgRow(db.fs, orgId, 'investment_reports', reportId);
    const snap = await tx.get(ref);
    if (!snap.exists) raise.notFound();
    const status = String(snap.get('status'));
    if (status !== 'queued' && status !== 'running') return null;
    const enabled = await investmentEnabled(db.fs, orgId, readerOf(tx));
    const guard = enabled ? null : await inFlightGuard(db.fs, orgId).read(tx);
    const now = nowIso();
    if (!enabled) {
      tx.update(ref, { status: 'failed', failure: 'Investment is switched off for this company.', finished_at: now, updated_at: now });
      if (guard!.owner === reportId) guard!.release(tx);
      return null;
    }
    tx.update(ref, { status: 'running', started_at: now, updated_at: now });
    return reportId;
  });
};

function checkTokens(input: number | null, output: number | null): void {
  if ((input ?? -1) < 0 || (output ?? -1) < 0 || !Number.isInteger(input) || !Number.isInteger(output)) {
    raise.invalid('token counts are whole numbers from zero');
  }
}

/** `api_server.finish_investment_report`: stores the finished pack and tells the requester. */
const finish_investment_report: DbFunction = async (db, args) => {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const reportId = arg.req(args, 'p_report');
  const content = args.p_content as Record<string, unknown> | null | undefined;
  const model = (arg.str(args, 'p_model') ?? '').trim();
  const promptVersion = (arg.str(args, 'p_prompt_version') ?? '').trim();
  const inputTokens = arg.num(args, 'p_input_tokens');
  const outputTokens = arg.num(args, 'p_output_tokens');

  if (!content || typeof content !== 'object' || Array.isArray(content) || content.version !== 'investment-v1') {
    raise.invalid('an investment pack is an investment-v1 document');
  }
  if (JSON.stringify(content).length > 1_000_000) raise.invalid('the investment pack is too large to store');
  if (model === '' || promptVersion === '') raise.invalid('a finished pack names its model and prompt version');
  checkTokens(inputTokens, outputTokens);
  if (model.length > 200) checkViolation('investment_reports', 'investment_reports_model');
  if (promptVersion.length > 200) checkViolation('investment_reports', 'investment_reports_prompt');

  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const ref = orgRow(db.fs, orgId, 'investment_reports', reportId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('status') !== 'running') raise.conflict('that investment pack is not being written');
    const requestedBy = (snap.get('requested_by') as string | null) ?? null;
    const guard = await inFlightGuard(db.fs, orgId).read(tx);
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'investment.report_ready', targetTable: 'investment_reports', targetId: reportId,
      before: null, after: { model, prompt_version: promptVersion },
      metadata: { input_tokens: inputTokens, output_tokens: outputTokens },
    }, tx);
    const org = await r.get(globalRow(db.fs, 'organizations', orgId));
    const notice = await prepareNotify(db.fs, {
      orgId, userId: requestedBy, actorId: null, permission: 'reports.view' as Permission, kind: 'report_ready',
      title: 'Your investment pack is ready', body: null, href: `/app/${org.exists ? String(org.get('slug')) : ''}/investment`,
    }, r);

    const now = nowIso();
    tx.update(ref, {
      status: 'ready', report: content, report_version: 'investment-v1', failure: null, model,
      prompt_version: promptVersion, input_tokens: inputTokens, output_tokens: outputTokens, finished_at: now, updated_at: now,
    });
    if (guard.owner === reportId) guard.release(tx);
    audit.write(tx);
    notice.write(tx);
    return reportId;
  });
};

/** `api_server.fail_investment_report`: a failed attempt with the sentence the person is shown. */
const fail_investment_report: DbFunction = async (db, args) => {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const reportId = arg.req(args, 'p_report');
  const failure = nonEmpty((arg.str(args, 'p_failure') ?? '').trim())?.slice(0, 500) ?? null;
  const model = nonEmpty((arg.str(args, 'p_model') ?? '').trim());
  const promptVersion = nonEmpty((arg.str(args, 'p_prompt_version') ?? '').trim());
  const inputTokens = args.p_input_tokens === undefined ? 0 : arg.num(args, 'p_input_tokens');
  const outputTokens = args.p_output_tokens === undefined ? 0 : arg.num(args, 'p_output_tokens');

  if (failure === null) raise.invalid('a failed pack says why');
  checkTokens(inputTokens, outputTokens);
  if (model !== null && model.length > 200) checkViolation('investment_reports', 'investment_reports_model');
  if (promptVersion !== null && promptVersion.length > 200) checkViolation('investment_reports', 'investment_reports_prompt');

  return runTx(db, async (tx) => {
    const ref = orgRow(db.fs, orgId, 'investment_reports', reportId);
    const snap = await tx.get(ref);
    if (!snap.exists) raise.notFound();
    const status = String(snap.get('status'));
    if (status !== 'queued' && status !== 'running') return null;
    const guard = await inFlightGuard(db.fs, orgId).read(tx);
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'investment.report_failed', targetTable: 'investment_reports', targetId: reportId,
      before: null, after: { failure }, metadata: { input_tokens: inputTokens, output_tokens: outputTokens },
    }, tx);
    const now = nowIso();
    tx.update(ref, {
      status: 'failed', failure, model, prompt_version: promptVersion,
      input_tokens: inputTokens, output_tokens: outputTokens, finished_at: now, updated_at: now,
    });
    if (guard.owner === reportId) guard.release(tx);
    audit.write(tx);
    return reportId;
  });
};

// ── Alerts (ALERTS_MODEL.md §8) ──────────────────────────────────────────────────────────────────

/** `same_org_ref_subject` on alerts: what `subject_id` names, by `subject_type`. */
const SUBJECT_REF: Readonly<Record<string, string>> = {
  account: 'accounts', counterparty: 'counterparties', bank_transaction: 'bank_transactions',
  recurring_group: 'recurring_payment_groups', none: '-', standard_category: '-',
};

type Change = Record<string, unknown>;
type Counts = { inserted: number; revised: number; touched: number; resolved: number };

const CHANGE_KINDS = new Set(['insert', 'revision', 'touch', 'resolve']);

function jsonbOrEmpty(v: unknown): unknown {
  return v === undefined || v === null ? {} : v;
}

/** `alert_revisions_no_unique` (alert_id, revision_no): one revision per number per alert. */
const revisionGuard = (db: Db, orgId: string, alertId: string, no: number) =>
  uniqueGuard(db.fs, { orgId }, 'alert_revisions_no_unique', [alertId, no]);

function revisionRow(orgId: string, alertId: string, no: number, change: Change, bundleId: string, runId: string): DocumentData {
  return {
    id: newId(), organization_id: orgId, alert_id: alertId, revision_no: no,
    rule_version: textOf(change, 'rule_version'),
    severity: enumValue(SEVERITIES, change.severity, 'severity_enum'),
    explanation: textOf(change, 'explanation'),
    threshold_summary: jsonbOrEmpty(change.threshold_summary),
    evidence_bundle_id: bundleId, calculation_run_id: runId, created_at: nowIso(),
  };
}

/** One `insert` change: a new alert, unless its dedupe key already stands (ADR-018). */
async function persistInsert(db: Db, orgId: string, runId: string, change: Change): Promise<boolean> {
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const dedupeKey = textOf(change, 'dedupe_key');
    if (dedupeKey === null) raise.invalid('null value in column "dedupe_key" of relation "alerts" violates not-null constraint');
    // The unique dedupe key makes a re-run idempotent even if the planner and the database disagree
    // about what already exists. Nothing is duplicated; the row simply stands.
    const claim = await uniqueGuard(db.fs, { orgId }, 'alert_dedupe', [dedupeKey]).read(tx);
    if (claim.owner) return false;

    const alertId = newId();
    const now = nowIso();
    const subjectType = enumValue(ALERT_SUBJECTS, change.subject_type, 'alert_subject_enum');
    const subjectId = nonEmpty(textOf(change, 'subject_id'));
    const alert = {
      id: alertId, organization_id: orgId, rule_key: textOf(change, 'rule_key'), rule_version: textOf(change, 'rule_version'),
      severity: enumValue(SEVERITIES, change.severity, 'severity_enum'), metric_key: nonEmpty(textOf(change, 'metric_key')),
      period_id: textOf(change, 'period_id'), subject_type: subjectType, subject_id: subjectId,
      title: textOf(change, 'title'), explanation: textOf(change, 'explanation'),
      threshold_summary: jsonbOrEmpty(change.threshold_summary),
      recommended_next_step: nonEmpty(textOf(change, 'recommended_next_step')),
      current_revision_id: null as string | null, status: 'open', status_changed_by: null, status_changed_at: null,
      status_reason_code: 'user', status_reason: null, action_id: null, dedupe_key: dedupeKey,
      key_kind: enumValue(ALERT_KEY_KINDS, change.key_kind, 'alert_key_kind_enum'), calculation_run_id: runId,
      first_seen_at: now, reopened_at: null, dismissed_at: null, last_evaluated_at: now, created_at: now, updated_at: now,
    };
    for (const col of ['rule_key', 'rule_version', 'period_id', 'title', 'explanation'] as const) {
      if (alert[col] === null) raise.invalid(`null value in column "${col}" of relation "alerts" violates not-null constraint`);
    }
    await checkSameOrgRef(r, sameOrgRefTarget(db.fs, orgId,
      { table: 'alerts', idCol: 'subject_id', discCol: 'subject_type' }, SUBJECT_REF, subjectType, subjectId),
    { table: 'alerts', idCol: 'subject_id' });

    const bundle = await prepareAlertBundle(db.fs, orgId, runId, alertId, change.evidence, r);
    const revision = revisionRow(orgId, alertId, 1, change, bundle.id!, runId);
    const revClaim = await revisionGuard(db, orgId, alertId, 1).read(tx);
    alert.current_revision_id = String(revision.id);
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'alert.created', targetTable: 'alerts', targetId: alertId, before: null,
      after: { rule_key: textOf(change, 'rule_key'), severity: textOf(change, 'severity') }, metadata: { run_id: runId },
    }, tx);

    tx.set(orgRow(db.fs, orgId, 'alerts', alertId), alert);
    claim.take(tx, alertId);
    bundle.write(tx);
    tx.set(orgRow(db.fs, orgId, 'alert_revisions', String(revision.id)), revision);
    revClaim.take(tx, String(revision.id));
    audit.write(tx);
    return true;
  });
}

/** One `revision` change: a material change — a new numbered revision with its own evidence. */
async function persistRevision(db: Db, orgId: string, runId: string, change: Change): Promise<boolean> {
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const alertId = textOf(change, 'alert_id');
    if (!alertId) return false;
    const ref = orgRow(db.fs, orgId, 'alerts', alertId);
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const a = snap.data()!;
    const before = { severity: a.severity, status: a.status };

    const revisions = await tx.get(orgCollection(db.fs, orgId, 'alert_revisions').where('alert_id', '==', alertId));
    const no = revisions.docs.reduce((max, d) => Math.max(max, Number(d.get('revision_no') ?? 0)), 0) + 1;
    const revClaim = await revisionGuard(db, orgId, alertId, no).read(tx);
    if (revClaim.owner) raise.conflict('duplicate key value violates unique constraint "alert_revisions_no_unique"');

    const status = enumValue(ALERT_STATUSES, change.status, 'alert_status_enum');
    const reasonText = nonEmpty(textOf(change, 'status_reason_code'));
    const reason = reasonText !== null ? enumValue(ALERT_REASONS, reasonText, 'alert_status_reason_enum') : a.status_reason_code;
    const bundle = await prepareAlertBundle(db.fs, orgId, runId, alertId, change.evidence, r);
    const revision = revisionRow(orgId, alertId, no, change, bundle.id!, runId);
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'alert.reevaluated', targetTable: 'alerts', targetId: alertId, before,
      after: { severity: textOf(change, 'severity'), status: textOf(change, 'status') },
      metadata: { run_id: runId, revision_no: no },
    }, tx);

    const now = nowIso();
    const changed = a.status !== status;
    const reopened = change.reopened === true || change.reopened === 'true';
    const title = textOf(change, 'title');
    const periodId = textOf(change, 'period_id');
    if (title === null) raise.invalid('null value in column "title" of relation "alerts" violates not-null constraint');
    if (periodId === null) raise.invalid('null value in column "period_id" of relation "alerts" violates not-null constraint');
    bundle.write(tx);
    tx.set(orgRow(db.fs, orgId, 'alert_revisions', String(revision.id)), revision);
    revClaim.take(tx, String(revision.id));
    tx.update(ref, {
      severity: revision.severity,
      explanation: revision.explanation,
      title,
      threshold_summary: revision.threshold_summary,
      recommended_next_step: nonEmpty(textOf(change, 'recommended_next_step')),
      // §8.1: a state alert's period moves to the latest evaluated one; first_seen_at never does.
      period_id: periodId,
      status,
      status_reason_code: reason,
      status_changed_at: changed ? now : (a.status_changed_at ?? null),
      // A status the ENGINE changed has no user behind it.
      status_changed_by: changed ? null : (a.status_changed_by ?? null),
      reopened_at: reopened ? now : (a.reopened_at ?? null),
      current_revision_id: revision.id,
      calculation_run_id: runId,
      last_evaluated_at: now,
      updated_at: now,
    });
    audit.write(tx);
    return true;
  });
}

/**
 * One `touch` change: nothing material changed (§8.1). No revision, no audit, no notification — only
 * the fact that the engine looked again. Counted whether or not the alert still exists, as in SQL.
 */
async function persistTouch(db: Db, orgId: string, change: Change): Promise<void> {
  const alertId = textOf(change, 'alert_id');
  if (!alertId) return;
  const periodId = textOf(change, 'period_id');
  await runTx(db, async (tx) => {
    const ref = orgRow(db.fs, orgId, 'alerts', alertId);
    if (!(await tx.get(ref)).exists) return;
    if (periodId === null) raise.invalid('null value in column "period_id" of relation "alerts" violates not-null constraint');
    const now = nowIso();
    tx.update(ref, { last_evaluated_at: now, period_id: periodId, updated_at: now });
  });
}

/** One `resolve` change: the condition cleared; only an open or acknowledged alert resolves. */
async function persistResolve(db: Db, orgId: string, runId: string, change: Change): Promise<boolean> {
  const alertId = textOf(change, 'alert_id');
  if (!alertId) return false;
  return runTx(db, async (tx) => {
    const ref: DocumentReference = orgRow(db.fs, orgId, 'alerts', alertId);
    const snap = await tx.get(ref);
    if (!snap.exists || !['open', 'acknowledged'].includes(String(snap.get('status')))) return false;
    const reason = enumValue(ALERT_REASONS, change.status_reason_code, 'alert_status_reason_enum');
    const audit: PreparedAudit = await prepareAudit(db, {
      organizationId: orgId, action: 'alert.status_changed', targetTable: 'alerts', targetId: alertId,
      before: { status: 'open' }, after: { status: 'resolved', reason: textOf(change, 'status_reason_code') },
      metadata: { run_id: runId },
    }, tx);
    const now = nowIso();
    tx.update(ref, {
      status: 'resolved', status_reason_code: reason, status_changed_at: now, status_changed_by: null,
      last_evaluated_at: now, updated_at: now,
    });
    audit.write(tx);
    return true;
  });
}

/**
 * `api_server.persist_alerts(org, run, changes)`: applies the planner's changes for one calculation
 * run — insert, revision, touch, resolve — and records the evaluation.
 *
 * PostgreSQL applied the whole list in one transaction. A Firestore transaction holds 500 writes and
 * an insert alone writes its alert, two guards, a bundle with its items, a revision and an audit
 * event, so each change is its own transaction here. Every change is idempotent against what is
 * already stored (the dedupe guard, the next revision number, the status a resolve requires), so a
 * job retried after a partial failure re-plans from what was written and converges. An unknown
 * change kind is refused BEFORE anything is written, as the SQL's rollback refused it.
 */
const persist_alerts: DbFunction = async (db, args) => {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  // ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  // arrives with no scope, or with another organization's, is refused before it writes anything.
  requireScope(db, orgId);
  const runId = arg.req(args, 'p_run');
  if (!(await orgRow(db.fs, orgId, 'calculation_runs', runId).get()).exists) raise.notFound();

  const changes = (arg.arr<Change>(args, 'p_changes') ?? []);
  for (const c of changes) {
    const kind = textOf(c, 'kind');
    if (!kind || !CHANGE_KINDS.has(kind)) raise.conflict(`unknown change kind ${kind ?? ''}`.trimEnd());
  }

  const counts: Counts = { inserted: 0, revised: 0, touched: 0, resolved: 0 };
  for (const change of changes) {
    switch (change.kind) {
      case 'insert':
        if (await persistInsert(db, orgId, runId, change)) counts.inserted += 1;
        break;
      case 'revision':
        if (await persistRevision(db, orgId, runId, change)) counts.revised += 1;
        break;
      case 'touch':
        await persistTouch(db, orgId, change);
        counts.touched += 1;
        break;
      default:
        if (await persistResolve(db, orgId, runId, change)) counts.resolved += 1;
    }
  }

  await runTx(db, async (tx) => {
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'alerts.evaluated', targetTable: null, targetId: null, before: null,
      after: { ...counts }, metadata: { run_id: runId },
    }, tx);
    audit.write(tx);
  });
  return { ...counts };
};

/** `api_server.*` functions of this area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8). */
export const functions: DbFunctions = {
  record_report,
  record_report_file,
  record_report_pdf,
  enqueue_scheduled_reports,
  start_investment_report,
  finish_investment_report,
  fail_investment_report,
  persist_alerts,
};
