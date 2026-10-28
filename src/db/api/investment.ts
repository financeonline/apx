import 'server-only';
import Decimal from 'decimal.js';
import { raise } from '../raise';
import { arg, type DbFunction, type DbFunctions } from '../registry';
import { globalRow, newId, nowIso, orgCollection, orgRow } from '../schema';
import { runTx } from '../tx';
import { readerOf, uidOf } from '../types';
import { requirePermission } from '../app/access';
import { prepareAudit } from '../app/audit';
import { prepareEnqueue } from '../app/jobs';
import { throttle } from '../app/throttle';
import {
  aiTokensUsedThisMonth, effectiveQuota, inFlightGuard, investmentEnabled, PACK_NOT_FINISHED,
} from '../app/investment-quota';

/**
 * `api.request_investment_report` (ADR-171), ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8).
 *
 * The SQL serialised requests per organisation with `pg_advisory_xact_lock` and enforced "one pack
 * in flight" with a partial unique index. Here the `investment_reports_one_in_flight` guard document
 * does both: the transaction that creates an attempt reads it first and takes it with the writes, so
 * two presses at once produce one attempt and one job, and the second press is handed the first's id.
 *
 * Order, as in SQL: refusals (permission, module, amount) → expire attempts whose job has ended → the
 * attempt already under way (spends nothing) → the monthly AI allowance → three packs an hour →
 * create the attempt and its one-attempt job.
 */

const ACTIVE_JOB = new Set(['queued', 'running', 'deferred_upstream']);

const request_investment_report: DbFunction = async (db, args) => {
  const orgId = arg.req(args, 'p_org');
  const uid = uidOf(db);
  await throttle(db.fs, uid, 'rpc', 120, 60);
  await requirePermission(db, orgId, 'reports.generate');
  await requirePermission(db, orgId, 'ai.use');
  // A switched-off system is absent, not refused (ADR-158).
  if (!(await investmentEnabled(db.fs, orgId))) raise.notFound();

  // The amount to allocate, when the analyst entered one: money, to the penny, at least one whole
  // currency unit — the pack's figures are whole units (`buildInvestmentFigures`), so less would round
  // to nothing to allocate — and within any company's means. ±Infinity fails the same two tests; NaN
  // is refused by name.
  let assumptions: Record<string, unknown> = {};
  const raw = args.p_surplus;
  if (raw !== null && raw !== undefined && raw !== '') {
    let d: Decimal;
    try {
      d = new Decimal(typeof raw === 'number' ? raw : String(raw).trim());
    } catch {
      raise.invalid(`invalid input syntax for type numeric: "${String(raw)}"`);
    }
    if (d.isNaN()) raise.invalid('the amount to allocate must be a number');
    const surplus = d.isFinite() ? d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : d;
    if (surplus.lt(1)) raise.invalid('Enter an amount of at least 1.');
    if (surplus.gt(1_000_000_000_000)) raise.invalid('the amount to allocate must be 1,000,000,000,000 or less');
    assumptions = { surplus: surplus.toFixed(2) };
  }

  // An attempt whose job has ended cannot hold the slot (`investment_job_ended` normally sees to
  // this; this covers a job document that is gone). Returns the attempt still under way, if any.
  const inFlight = await runTx(db, async (tx) => {
    const open = await tx.get(orgCollection(db.fs, orgId, 'investment_reports').where('status', 'in', ['queued', 'running']));
    const jobs = await Promise.all(open.docs.map((d) => {
      const jobId = d.get('job_id') as string | null;
      return jobId ? tx.get(globalRow(db.fs, 'jobs', jobId)) : Promise.resolve(null);
    }));
    const guard = await inFlightGuard(db.fs, orgId).read(tx);
    const dead = open.docs.filter((_, i) => !(jobs[i]?.exists && ACTIVE_JOB.has(String(jobs[i]!.get('status')))));
    const live = open.docs.filter((d) => !dead.includes(d));
    const now = nowIso();
    for (const d of dead) {
      tx.update(d.ref, { status: 'failed', failure: PACK_NOT_FINISHED, finished_at: now, updated_at: now });
      if (guard.owner === d.id) guard.release(tx);
    }
    return live[0]?.id ?? null;
  });
  // One at a time: a second press returns the attempt already under way, and spends nothing.
  if (inFlight) return { report_id: inFlight, created: false };

  // The same monthly ceiling the analyst, the PDF reader and Marketing are held to (CD-24).
  const ceiling = await effectiveQuota(db.fs, orgId, 'ai_token_ceiling_monthly');
  if (ceiling !== null && (await aiTokensUsedThisMonth(db.fs, orgId)) >= ceiling) {
    raise.quota("this company's AI allowance for the month has been used");
  }

  // Three packs an hour per organisation. Counted here, after every refusal above, so a refused or
  // repeated press costs nothing.
  await throttle(db.fs, orgId, 'investment_report', 3, 3600);

  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const guard = await inFlightGuard(db.fs, orgId).read(tx);
    if (guard.owner) {
      const holder = await r.get(orgRow(db.fs, orgId, 'investment_reports', guard.owner));
      const status = holder.exists ? String(holder.get('status')) : null;
      // A press that raced this one: hand back the attempt it made.
      if (status === 'queued' || status === 'running') return { report_id: guard.owner, created: false };
    }
    const reportId = newId();
    const job = await prepareEnqueue(db.fs, {
      organizationId: orgId, jobType: 'investment.generate', payload: { reportId }, requestedBy: uid,
      idempotencyKey: `investment.generate:${reportId}`,
      // One attempt: each is a paid model call, and a failure is the person's to retry, not the queue's.
      maxAttempts: 1,
    }, tx);
    const requested = await prepareAudit(db, {
      organizationId: orgId, action: 'investment.report_requested', targetTable: 'investment_reports',
      targetId: reportId, before: null, after: { job_id: job.id, assumptions }, metadata: {},
    }, tx);
    const enqueued = await prepareAudit(db, {
      organizationId: orgId, action: 'job.enqueued', targetTable: 'jobs', targetId: job.id,
      before: null, after: { job_type: 'investment.generate' }, metadata: {},
    }, tx);

    const now = nowIso();
    tx.set(orgRow(db.fs, orgId, 'investment_reports', reportId), {
      id: reportId, organization_id: orgId, status: 'queued', assumptions, report: null, report_version: null,
      failure: null, requested_by: uid, job_id: job.id, model: null, prompt_version: null,
      input_tokens: 0, output_tokens: 0, created_at: now, started_at: null, finished_at: null, updated_at: now,
    });
    guard.take(tx, reportId);
    job.write(tx);
    requested.write(tx);
    enqueued.write(tx);
    return { report_id: reportId, created: true };
  });
};

/** `api.*` functions of this area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8). */
export const functions: DbFunctions = { request_investment_report };
