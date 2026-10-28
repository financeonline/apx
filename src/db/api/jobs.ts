import 'server-only';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import { globalCollection, globalRow, orgCollection, orgRow } from '../schema';
import { runTx } from '../tx';
import { uidOf, type Db } from '../types';
import { requireOrg, requirePermission } from '../app/access';
import { prepareAudit } from '../app/audit';
import { prepareEnqueue } from '../app/jobs';
import { throttle } from '../app/throttle';
import { JOB_TYPES, addDays, isoDow, localDate, parseDate } from '../app/jobs-types';

/**
 * `api.*` functions of the job queue (JOB_ARCHITECTURE.md; ADR-013, ADR-043.3), ported from
 * PostgreSQL (FIRESTORE_DATA_MODEL.md §8).
 *
 * `enqueue_job` is the only way a person asks for work: a recalculation, a report rendered or
 * composed. Everything else is server-originated (`api_server.enqueue_job`). The payload a person
 * sends is never stored as sent — each type keeps only the fields it reads, and derives the rest
 * (a recalculation is always `recalc_manual`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `p_payload ->> 'x'`: a string as is, any other JSON value as its text, absent as null. */
function field(payload: Record<string, unknown>, name: string): string | null {
  const v = payload[name];
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** `app.funding_enabled`: `features ->> 'funding_readiness' = 'true'`. */
function fundingEnabled(features: Record<string, unknown> | undefined): boolean {
  const v = features?.funding_readiness;
  return v === true || v === 'true';
}

/** `api.enqueue_job`: a user-intent job (ADR-043.3). Returns the queued job's id. */
async function enqueue_job(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.req(args, 'p_org');
  const jobType = arg.req(args, 'p_job_type');
  if (!JOB_TYPES.has(jobType)) raise.invalid(`${jobType} is not a job type`);
  const input = arg.obj(args, 'p_payload');
  const uid = uidOf(db);

  await throttle(db.fs, uid, `enqueue_job:${jobType}`, 30, 3600);
  await requireOrg(db, org);

  let payload: Record<string, unknown>;
  let key: string;

  if (jobType === 'calculation.run') {
    await requirePermission(db, org, 'intelligence.recompute');
    payload = { trigger: 'recalc_manual', periodFrom: field(input, 'periodFrom'), periodTo: field(input, 'periodTo') };
    key = `calculation.run:${org}`;
  } else if (jobType === 'report.render') {
    await requirePermission(db, org, 'reports.generate');
    if (Object.prototype.hasOwnProperty.call(input, 'reportId')) {
      const report = field(input, 'reportId');
      if (report !== null && !UUID.test(report)) raise.invalid('reportId is not a uuid');
      // Resolved through the reports policy: another person's Custom AI Report, or another
      // organisation's report, is simply not there.
      const snap = report ? await orgRow(db.fs, org, 'reports', report).get() : null;
      if (!snap?.exists || (snap.get('report_kind') === 'custom_ai' && snap.get('requested_by') !== uid)) raise.notFound();
      payload = { reportId: report!.toLowerCase() };
      key = `report.render:${org}:r:${report!.toLowerCase()}`;
    } else {
      payload = { periodId: field(input, 'periodId') };
      key = `report.render:${org}:${field(input, 'periodId') ?? ''}`;
    }
  } else if (jobType === 'report.compose') {
    await requirePermission(db, org, 'reports.generate');
    const kind = field(input, 'kind');
    const orgSnap = await globalRow(db.fs, 'organizations', org).get();
    const today = localDate(new Date(), String(orgSnap.get('timezone') ?? 'Europe/London'));

    if (kind === 'daily_brief' || kind === 'weekly_intelligence') {
      const start = parseDate(input.windowStart);
      if (start === 'invalid') raise.invalid('windowStart is not a date');
      if (start === null) raise.invalid('windowStart is required');
      let end: string;
      if (kind === 'daily_brief') {
        end = start;
      } else {
        if (isoDow(start) !== 1) raise.invalid('a week starts on a Monday');
        end = addDays(start, 6);
      }
      // A brief for a day still in progress would be stored as if the day were over.
      if (end >= today) raise.invalid(`that ${kind === 'daily_brief' ? 'day' : 'week'} has not finished yet`);
      payload = { kind, windowStart: start, windowEnd: end, origin: 'requested' };
      key = `report.compose:${org}:${kind}:${start}`;
    } else if (kind === 'adviser') {
      // The window is the latest complete month with figures; the job derives it.
      payload = { kind: 'adviser', origin: 'requested' };
      key = `report.compose:${org}:adviser`;
    } else if (kind === 'funding_readiness') {
      // REQ-RP-05: only while Funding Readiness is switched on (U-5).
      if (!fundingEnabled(orgSnap.get('features') as Record<string, unknown> | undefined)) raise.notFound();
      payload = { kind: 'funding_readiness', origin: 'requested', periodId: field(input, 'periodId') };
      key = `report.compose:${org}:funding_readiness`;
    } else {
      raise.invalid(`${kind ?? 'unnamed'} reports are not composed by a job`);
    }
  } else {
    raise.denied(`${jobType} is not a user-requestable job`);
  }

  return runTx(db, async (tx) => {
    const job = await prepareEnqueue(db.fs, {
      organizationId: org, jobType, payload, requestedBy: uid, idempotencyKey: key, merge: 'shallow',
    }, tx);
    const audit = await prepareAudit(db, {
      organizationId: org, action: 'job.enqueued', targetTable: 'jobs', targetId: job.id, after: { job_type: jobType },
    }, tx);
    job.write(tx);
    audit.write(tx);
    return job.id;
  });
}

/** `api.is_recalculating`: a calculation for this organisation is queued or running. */
async function is_recalculating(db: Db, args: Record<string, unknown>): Promise<boolean> {
  const org = arg.req(args, 'p_org');
  await requireOrg(db, org);
  const snap = await globalCollection(db.fs, 'jobs')
    .where('organization_id', '==', org)
    .where('job_type', '==', 'calculation.run')
    .where('status', 'in', ['queued', 'running'])
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * `api.has_accepted_records`: the organisation has at least one accepted, current financial record —
 * the four tables the engine reads, under the same filter (`record_status = 'accepted' and
 * superseded_by is null`).
 */
async function has_accepted_records(db: Db, args: Record<string, unknown>): Promise<boolean> {
  const org = arg.req(args, 'p_org');
  await requirePermission(db, org, 'dashboard.view');
  for (const table of ['ledger_entries', 'bank_transactions', 'invoices', 'period_balances'] as const) {
    const snap = await orgCollection(db.fs, org, table)
      .where('record_status', '==', 'accepted')
      .where('superseded_by', '==', null)
      .limit(1)
      .get();
    if (!snap.empty) return true;
  }
  return false;
}

export const functions: DbFunctions = { enqueue_job, is_recalculating, has_accepted_records };
