import 'server-only';
import type { Query, QueryDocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import type { Permission } from '@/core/permissions';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import { globalCollection, globalRow, nowIso, orgCollection } from '../schema';
import { runTx } from '../tx';
import type { Db } from '../types';
import { hasPermissionOf } from '../app/access';
import { prepareAudit, type PreparedAudit } from '../app/audit';
import { jobRef, prepareEnqueue, prepareRecalculation } from '../app/jobs';
import { preparePeriods } from '../app/shared';
import { requireServer } from '../app/scope';
import {
  byCreated, coalescedPayload, isStale, orgStatuses, prepareJobEnded, queuedGuard, queuedTwin, type JobDoc,
} from '../app/jobs-queue';
import { JOB_TYPES, localDate, validTimezone } from '../app/jobs-types';

/**
 * `api_server.*` functions of the job queue (JOB_ARCHITECTURE.md; ADR-013, ADR-043.3, ADR-044.6,
 * ADR-120, ADR-131, ADR-147), ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8).
 *
 * The queue is the top-level `jobs` collection. Its one uniqueness rule —
 * `jobs_idempotency_queued_unique`, one QUEUED job per (job_type, idempotency_key) — is the guard
 * document `src/db/app/jobs.ts` and `jobs-queue.ts` keep: enqueueing merges into the holder, a claim
 * releases it, and a job returning to the queue takes it back or is coalesced into the twin that
 * holds it (FU-6), as the SQL did rather than violate the index.
 *
 * Every function first refuses a caller that is not the server (`requireServer`), the old
 * `app.role_claim() <> 'service_role'` check. `set_updated_at` is done by each write.
 */

/** An unscoped server handle for the queue's own audit events: the claim belongs to no tenant. */
function platformDb(db: Db): Db {
  return { ...db, actor: { kind: 'service', scope: null } };
}

function jobTypeArg(args: Record<string, unknown>): string {
  const t = arg.req(args, 'p_job_type');
  if (!JOB_TYPES.has(t)) raise.invalid(`${t} is not a job type`);
  return t;
}

// ── Enqueue ──────────────────────────────────────────────────────────────────────────────────────

/** Type → the permission the ACTOR must hold; system job types carry a null actor. */
const ACTOR_PERMISSION: Readonly<Record<string, { perm: Permission; actorRequired: boolean }>> = {
  'document.extract': { perm: 'imports.review', actorRequired: true },
  'import.commit_large': { perm: 'imports.review', actorRequired: true },
  'report.render': { perm: 'reports.generate', actorRequired: true },
  'calculation.run': { perm: 'intelligence.recompute', actorRequired: false },
};

/**
 * `api_server.enqueue_job`: server-originated work (ADR-043.3). User-intent jobs go through
 * `api.enqueue_job`; `org.purge` is enqueued by the deletion path alone (ADR-026.4).
 */
async function enqueue_job(db: Db, args: Record<string, unknown>): Promise<string> {
  requireServer(db);
  const actor = arg.str(args, 'p_actor');
  const org = arg.str(args, 'p_org');
  const jobType = jobTypeArg(args);
  const payload = arg.obj(args, 'p_payload');

  if (jobType === 'org.purge') raise.denied('org.purge is enqueued by the deletion trigger only');

  const rule = ACTOR_PERMISSION[jobType];
  if (rule) {
    const holds = actor !== null && org !== null && await hasPermissionOf(db.fs, actor, org, rule.perm);
    if ((rule.actorRequired && !holds) || (!rule.actorRequired && actor !== null && !holds)) {
      raise.denied(`${rule.perm} required`);
    }
  }

  if (org !== null) {
    const o = await globalRow(db.fs, 'organizations', org).get();
    if (!o.exists || o.get('status') === 'deleted') raise.notFound();
  }

  return runTx(db, async (tx) => {
    const job = await prepareEnqueue(db.fs, {
      organizationId: org, jobType, payload, requestedBy: actor,
      idempotencyKey: `${jobType}:${org ?? 'platform'}`, merge: 'shallow',
    }, tx);
    const audit = await prepareAudit(db, {
      organizationId: org, action: 'job.enqueued', targetTable: 'jobs', targetId: job.id,
      after: { job_type: jobType }, actorId: actor,
    }, tx);
    job.write(tx);
    audit.write(tx);
    return job.id;
  });
}

// ── Claim, reclaim, finish ───────────────────────────────────────────────────────────────────────

interface JobWrite {
  ref: FirebaseFirestore.DocumentReference;
  update: Record<string, unknown>;
}

const CLAIM_PAGE = 50;

/**
 * `api_server.claim_job`: atomically claim one runnable job (ADR-013), after returning any job whose
 * worker died to the queue (`app.reclaim_stale_jobs`, ADR-044.6 / R2-A-10).
 *
 * One transaction: it reads every running job (to reclaim the stale ones and to know which
 * organisations already have a calculation running — FU-16's "one calculation per organisation"),
 * then the queued jobs in claim order, re-reads the chosen one, and flips it to `running`.
 * Firestore's transaction locks the documents it read, so two workers racing for one job cannot both
 * win: the loser's transaction re-runs and sees it `running`. The SQL serialised claims with an
 * advisory lock instead; here the re-read of the running set inside each transaction is what keeps
 * two calculations of one organisation from being claimed at once.
 *
 * Returns `[]` when nothing is runnable, else one row, as `RETURNS TABLE` did.
 */
async function claim_job(db: Db, args: Record<string, unknown>): Promise<unknown[]> {
  requireServer(db);
  const worker = arg.req(args, 'p_worker');
  const fs = db.fs;
  const audits = platformDb(db);

  return runTx(db, async (tx) => {
    const nowMs = Date.now();
    const now = nowIso(new Date(nowMs));
    const jobs = globalCollection(fs, 'jobs');

    // ---- app.reclaim_stale_jobs: oldest first, the twin looked up as each job is handled. -------
    const running = (await tx.get(jobs.where('status', '==', 'running'))).docs.map((d) => d.data() as JobDoc);
    const stale = running.filter((j) => isStale(j, nowMs)).sort(byCreated);

    const writes = new Map<string, JobWrite>();
    const put = (id: string, update: Record<string, unknown>) => {
      const w = writes.get(id);
      if (w) Object.assign(w.update, update);
      else writes.set(id, { ref: jobRef(fs, id), update: { ...update } });
    };
    /** Guards this transaction takes (key → job id), so a later stale twin coalesces into it. */
    const taken = new Map<string, JobDoc>();
    /** The payload each twin ends with, folded in order. */
    const payloadOf = new Map<string, Record<string, unknown>>();
    const guardWrites = new Map<string, { ref: FirebaseFirestore.DocumentReference; owner: string | null }>();
    const enders: Array<{ write(t: Transaction, s: string): void; status: string }> = [];
    const prepared: PreparedAudit[] = [];
    const requeued: JobDoc[] = [];

    for (const r of stale) {
      const ended = await prepareJobEnded(fs, tx, r);
      const keyId = r.idempotency_key ? `${r.job_type}\u0000${r.idempotency_key}` : null;
      const twin = keyId ? (taken.get(keyId) ?? await queuedTwin(fs, tx, r.job_type, r.idempotency_key, r.id)) : null;

      if (twin) {
        const before = payloadOf.get(twin.id) ?? twin.payload ?? {};
        payloadOf.set(twin.id, coalescedPayload(r.job_type, before, r.payload ?? {}));
        put(r.id, {
          status: 'cancelled', locked_at: null, locked_by: null, finished_at: now, updated_at: now,
          last_error: `coalesced into queued job ${twin.id} after its worker was lost`,
        });
        enders.push({ write: ended.write, status: 'cancelled' });
      } else if (r.attempts + 1 >= r.max_attempts) {
        // Lost on its last attempt: dead, not queued. A queued job no claim will take would hold the
        // organisation's queue slot for ever.
        put(r.id, {
          status: 'dead', locked_at: null, locked_by: null, attempts: r.attempts + 1, finished_at: now,
          last_error: 'its worker was lost on the last attempt', updated_at: now,
        });
        enders.push({ write: ended.write, status: 'dead' });
        prepared.push(await prepareAudit(audits, {
          organizationId: r.organization_id, action: 'job.dead', targetTable: 'jobs', targetId: r.id,
          after: { job_type: r.job_type, error: 'worker lost on the last attempt' },
        }, tx));
      } else {
        put(r.id, { status: 'queued', locked_at: null, locked_by: null, attempts: r.attempts + 1, updated_at: now });
        const back: JobDoc = { ...r, status: 'queued', attempts: r.attempts + 1, locked_at: null };
        requeued.push(back);
        if (keyId && r.idempotency_key) {
          taken.set(keyId, back);
          const ref = queuedGuard(fs, r.job_type, r.idempotency_key).ref;
          guardWrites.set(ref.path, { ref, owner: r.id });
        }
      }
    }

    // ---- The claim. ------------------------------------------------------------------------------
    const staleIds = new Set(stale.map((j) => j.id));
    const calculating = new Set(running
      .filter((j) => !staleIds.has(j.id) && j.job_type === 'calculation.run' && j.organization_id)
      .map((j) => j.organization_id as string));

    const sortKey = (j: JobDoc) => `${j.run_after}\u0000${j.created_at}`;
    const pending = requeued.filter((j) => j.run_after <= now).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    let chosen: JobDoc | null = null;
    let cursor: QueryDocumentSnapshot | null = null;

    for (;;) {
      let q: Query = jobs.where('status', '==', 'queued').where('run_after', '<=', now)
        .orderBy('run_after').orderBy('created_at').limit(CLAIM_PAGE);
      if (cursor) q = q.startAfter(cursor);
      const page = await tx.get(q);
      const exhausted = page.size < CLAIM_PAGE;
      cursor = page.docs[page.docs.length - 1] ?? cursor;
      const lastKey = page.docs.length > 0 ? sortKey(page.docs[page.docs.length - 1]!.data() as JobDoc) : '';

      const fromPage = page.docs.map((d) => d.data() as JobDoc).filter((j) => !writes.has(j.id));
      const take = exhausted ? pending.length : pending.filter((j) => sortKey(j) <= lastKey).length;
      const candidates = [...fromPage, ...pending.splice(0, take)]
        .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));

      const statuses = await orgStatuses(fs, tx, candidates.map((j) => j.organization_id).filter((o): o is string => !!o));
      chosen = candidates.find((j) => j.attempts < j.max_attempts
        // ADR-038.12: work for a suspended or closing organisation waits, except the purge itself.
        && (j.organization_id === null || j.job_type === 'org.purge' || statuses.get(j.organization_id) === 'active')
        // FU-16: one calculation per organisation at a time.
        && !(j.job_type === 'calculation.run' && j.organization_id && calculating.has(j.organization_id))) ?? null;
      if (chosen || exhausted) break;
    }

    let row: Record<string, unknown> | null = null;
    if (chosen) {
      const fromThisTx = writes.has(chosen.id);
      // Re-read inside the transaction: the winner of a race sees it still queued.
      const fresh = fromThisTx ? chosen : ((await tx.get(jobRef(fs, chosen.id))).data() as JobDoc | undefined);
      if (fresh && fresh.status === 'queued') {
        const key = fresh.idempotency_key;
        if (key) {
          const ref = queuedGuard(fs, fresh.job_type, key).ref;
          if (fromThisTx) {
            guardWrites.delete(ref.path);
          } else {
            const g = await tx.get(ref);
            if (!g.exists || g.get('owner_id') === fresh.id) guardWrites.set(ref.path, { ref, owner: null });
          }
        }
        put(fresh.id, {
          status: 'running', locked_at: now, locked_by: worker, attempts: fresh.attempts + 1, updated_at: now,
        });
        row = {
          job_id: fresh.id, organization_id: fresh.organization_id, job_type: fresh.job_type,
          payload: payloadOf.get(fresh.id) ?? fresh.payload ?? {}, requested_by: fresh.requested_by,
          attempts: fresh.attempts + 1, max_attempts: fresh.max_attempts,
        };
      }
    }

    // ---- Writes. ---------------------------------------------------------------------------------
    for (const [id, payload] of payloadOf) put(id, { payload, updated_at: now });
    for (const w of writes.values()) tx.update(w.ref, w.update);
    for (const g of guardWrites.values()) {
      if (g.owner) tx.set(g.ref, { owner_id: g.owner, constraint: 'jobs_idempotency_queued', created_at: now });
      else tx.delete(g.ref);
    }
    for (const e of enders) e.write(tx, e.status);
    for (const a of prepared) a.write(tx);
    return row ? [row] : [];
  });
}

const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'dead', 'deferred_upstream']);

/**
 * `api_server.finish_job`: a terminal outcome. A failure with attempts left goes back to the queue
 * with exponential backoff; only an exhausted job is `dead`. A job that would go back to the queue
 * while a twin with its key already waits there is coalesced into the twin (FU-6).
 */
async function finish_job(db: Db, args: Record<string, unknown>): Promise<string> {
  requireServer(db);
  const jobId = arg.req(args, 'p_job');
  const status = arg.req(args, 'p_status');
  const result = arg.obj(args, 'p_result');
  const error = arg.str(args, 'p_error');
  if (!TERMINAL.has(status)) raise.invalid('finish_job records a terminal outcome only');
  const fs = db.fs;

  return runTx(db, async (tx) => {
    const ref = jobRef(fs, jobId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('status') !== 'running') raise.notFound();
    const job = snap.data() as JobDoc;
    const now = new Date();
    const nowText = nowIso(now);
    const ended = await prepareJobEnded(fs, tx, job);
    const retry = status === 'failed' && job.attempts < job.max_attempts;
    const backToQueue = retry;

    if (job.idempotency_key && (retry || status === 'deferred_upstream')) {
      const twin = await queuedTwin(fs, tx, job.job_type, job.idempotency_key, job.id);
      if (twin) {
        tx.update(jobRef(fs, twin.id), {
          payload: coalescedPayload(job.job_type, twin.payload ?? {}, job.payload ?? {}), updated_at: nowText,
        });
        tx.update(ref, {
          status: 'cancelled', locked_at: null, locked_by: null, finished_at: nowText, updated_at: nowText,
          last_error: `${error ?? ''} (coalesced into queued job ${twin.id})`, result,
        });
        ended.write(tx, 'cancelled');
        return jobId;
      }
    }

    const next = retry ? 'queued' : status === 'failed' ? 'dead' : status;
    const runAfter = retry
      ? nowIso(new Date(now.getTime() + 30_000 * Math.trunc(2 ** job.attempts)))
      : status === 'deferred_upstream'
        ? nowIso(new Date(now.getTime() + 600_000))
        : job.run_after;

    const deadAudit = next === 'dead'
      ? await prepareAudit(platformDb(db), {
        organizationId: job.organization_id, action: 'job.dead', targetTable: 'jobs', targetId: jobId,
        after: { job_type: job.job_type, error },
      }, tx)
      : null;

    tx.update(ref, {
      status: next, run_after: runAfter, locked_at: null, locked_by: null, last_error: error, result,
      finished_at: status === 'succeeded' || next === 'dead' ? nowText : null, updated_at: nowText,
    });
    // Back in the queue: it holds its key again (no twin holds it — checked above).
    if (backToQueue && job.idempotency_key) {
      tx.set(queuedGuard(fs, job.job_type, job.idempotency_key).ref, {
        owner_id: jobId, constraint: 'jobs_idempotency_queued', created_at: nowText,
      });
    }
    ended.write(tx, next);
    deadAudit?.write(tx);
    return jobId;
  });
}

// ── Sweeps ───────────────────────────────────────────────────────────────────────────────────────

interface RunDoc { id: string; status: string; engine_version: string; as_of: string; finished_at: string | null }

/** The latest succeeded run: `order by finished_at desc nulls last, id desc limit 1`. */
async function latestSucceededRun(db: Db, orgId: string): Promise<RunDoc | null> {
  const runs = (await orgCollection(db.fs, orgId, 'calculation_runs').where('status', '==', 'succeeded').get())
    .docs.map((d) => d.data() as RunDoc);
  runs.sort((a, b) => {
    if (a.finished_at !== b.finished_at) {
      if (a.finished_at === null) return 1;
      if (b.finished_at === null) return -1;
      return a.finished_at < b.finished_at ? 1 : -1;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return runs[0] ?? null;
}

async function orgsWithStatus(db: Db, statuses: readonly string[]): Promise<Array<{ id: string; timezone: string; features: Record<string, unknown> }>> {
  const snap = await globalCollection(db.fs, 'organizations').where('status', 'in', [...statuses]).get();
  return snap.docs
    .map((d) => ({ id: d.id, timezone: String(d.get('timezone') ?? 'Europe/London'), features: (d.get('features') ?? {}) as Record<string, unknown> }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One recalculation request for an organisation, with its audit when it queued a new job. */
async function enqueueUpgradeFor(
  db: Db, orgId: string, audit: (merged: boolean) => Record<string, unknown> | null,
): Promise<void> {
  await runTx(db, async (tx) => {
    const job = await prepareRecalculation(db.fs, orgId, 'recalc_manual', null, null, tx);
    const after = audit(job.merged);
    const a = after ? await prepareAudit(db, {
      organizationId: orgId, action: 'job.enqueued', targetTable: 'jobs', targetId: job.id, after,
    }, tx) : null;
    job.write(tx);
    a?.write(tx);
  });
}

/**
 * `api_server.enqueue_engine_upgrade` (ADR-120): a full recalculation for every active or suspended
 * organisation whose latest succeeded run is from another engine version. Idempotent: a request
 * merges into the one already waiting, and only a new job is audited. Returns how many were queued
 * (or re-found queued).
 */
async function enqueue_engine_upgrade(db: Db, args: Record<string, unknown>): Promise<number> {
  requireServer(db);
  const version = arg.str(args, 'p_engine_version');
  if (version === null || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    raise.invalid('an engine version is major.minor.patch');
  }
  let count = 0;
  for (const org of await orgsWithStatus(db, ['active', 'suspended'])) {
    const latest = await latestSucceededRun(db, org.id);
    if (latest === null || latest.engine_version === version) continue;
    await enqueueUpgradeFor(db, org.id, (merged) => (merged ? null : {
      job_type: 'calculation.run', reason: 'engine_upgrade', engine_version: version,
    }));
    count += 1;
  }
  return count;
}

/**
 * `api_server.enqueue_health_upgrade` (ADR-147): a full re-score for every active or suspended
 * organisation that has Health scores and none under `p_config_version`. Always audited.
 */
async function enqueue_health_upgrade(db: Db, args: Record<string, unknown>): Promise<number> {
  requireServer(db);
  const version = arg.str(args, 'p_config_version');
  if (version === null || !/^health\.config\.v[0-9]+$/.test(version)) {
    raise.invalid('a health config version is health.config.vN');
  }
  let count = 0;
  for (const org of await orgsWithStatus(db, ['active', 'suspended'])) {
    const scores = orgCollection(db.fs, org.id, 'health_scores');
    if ((await scores.limit(1).get()).empty) continue;
    if (!(await scores.where('config_version', '==', version).limit(1).get()).empty) continue;
    await enqueueUpgradeFor(db, org.id, () => ({
      job_type: 'calculation.run', reason: 'health_config_upgrade', config_version: version,
    }));
    count += 1;
  }
  return count;
}

/**
 * `api_server.enqueue_scheduled_recalculation` (FU-6, ADR-131): one `calculation.run` (trigger
 * `scheduled`) per active organisation whose latest succeeded run is dated before its own local
 * today — once per organisation and local date, whatever became of the job, and never beside a
 * calculation already waiting. A timezone the runtime does not know skips that organisation rather
 * than failing the sweep (the SQL joined `pg_timezone_names`).
 */
async function enqueue_scheduled_recalculation(db: Db, args: Record<string, unknown>): Promise<number> {
  requireServer(db);
  const nowArg = arg.str(args, 'p_now');
  const at = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(at.getTime())) raise.invalid('p_now is not a valid time');
  let count = 0;

  for (const org of await orgsWithStatus(db, ['active'])) {
    if (!validTimezone(org.timezone)) continue;
    const today = localDate(at, org.timezone);
    const latest = await latestSucceededRun(db, org.id);
    if (latest === null || !(latest.as_of < today)) continue;

    const queued = await runTx(db, async (tx) => {
      const jobs = globalCollection(db.fs, 'jobs').where('organization_id', '==', org.id).where('job_type', '==', 'calculation.run');
      const already = await tx.get(jobs.where('payload.trigger', '==', 'scheduled').where('payload.as_of', '==', today).limit(1));
      if (!already.empty) return false;
      const waiting = await tx.get(jobs.where('status', '==', 'queued').limit(1));
      if (!waiting.empty) return false;

      // A month nothing has been dated in yet has no fiscal period (`app.ensure_periods`).
      const periods = await preparePeriods(db.fs, org.id, today, today, tx);
      const job = await prepareEnqueue(db.fs, {
        organizationId: org.id, jobType: 'calculation.run',
        payload: { trigger: 'scheduled', triggerRefId: null, as_of: today },
        requestedBy: null, idempotencyKey: `calculation.run:${org.id}`,
      }, tx);
      // `on conflict do nothing`: a job waiting under the key is left exactly as it is.
      if (job.merged) {
        periods.write(tx);
        return false;
      }
      const audit = await prepareAudit(db, {
        organizationId: org.id, action: 'job.enqueued', targetTable: 'jobs', targetId: job.id,
        after: { job_type: 'calculation.run', reason: 'scheduled', as_of: today },
      }, tx);
      periods.write(tx);
      job.write(tx);
      audit.write(tx);
      return true;
    });
    if (queued) count += 1;
  }
  return count;
}

/**
 * `api_server.enqueue_nightly_sweep` (ADR-074): the one platform-wide `storage.cleanup_orphans` for
 * a calendar date. Already queued, or already RUN, for that date: the same job comes back — one sweep
 * a night is the contract, which the queued-only uniqueness alone would not keep.
 */
async function enqueue_nightly_sweep(db: Db, args: Record<string, unknown>): Promise<string> {
  requireServer(db);
  const raw = arg.str(args, 'p_date');
  const date = raw ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    raise.invalid('p_date is not a date');
  }
  const key = `storage.cleanup_orphans:${date}`;

  return runTx(db, async (tx) => {
    const existing = (await tx.get(globalCollection(db.fs, 'jobs')
      .where('job_type', '==', 'storage.cleanup_orphans').where('idempotency_key', '==', key)))
      .docs.map((d) => d.data() as JobDoc).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (existing[0]) return existing[0].id;

    const job = await prepareEnqueue(db.fs, {
      organizationId: null, jobType: 'storage.cleanup_orphans', payload: { date }, requestedBy: null, idempotencyKey: key,
    }, tx);
    const audit = await prepareAudit(platformDb(db), {
      organizationId: null, action: 'job.enqueued', targetTable: 'jobs', targetId: job.id,
      after: { job_type: 'storage.cleanup_orphans', date },
    }, tx);
    // `do update set payload = public.jobs.payload`: a waiting job keeps its payload.
    if (!job.merged) job.write(tx);
    audit.write(tx);
    return job.id;
  });
}

export const functions: DbFunctions = {
  enqueue_job,
  claim_job,
  finish_job,
  enqueue_engine_upgrade,
  enqueue_health_upgrade,
  enqueue_scheduled_recalculation,
  enqueue_nightly_sweep,
};
