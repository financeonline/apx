import 'server-only';
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { ConflictError } from '@/core/errors';
import { raise } from '../raise';
import { nowIso, orgCollection, orgDoc, orgRow } from '../schema';
import { runTx } from '../tx';
import type { Db } from '../types';
import { plainLoader, txLoader, WorkingSet, type Data, type PlannedWrite } from './imports-ws';
import { importLockRef } from './imports-records';
import { prepareDataAdded, type FinalizeSpec, type Outcome } from './imports-commit';
import { prepareRecalcRequests } from './imports-recalc';

/**
 * Running an import commit, rollback or replacement against Firestore (FIRESTORE_DATA_MODEL.md §7).
 *
 * ── The organisation lock ──
 * `pg_advisory_xact_lock(hashtext('org:' || org))` serialised every commit, rollback and
 * completeness answer of one organisation. Here that is the document
 * `organizations/{org}/_locks/imports`: every such transaction reads it first and writes it last,
 * so two of them cannot both commit — the loser is retried by Firestore and then sees the winner's
 * result, as the second PL/pgSQL caller saw the first's after waiting for the lock.
 *
 * ── One transaction when it fits ──
 * The operation (src/db/app/imports-commit.ts) runs on a working set loaded through the
 * transaction, and the set's final state is written in the same transaction. That is every
 * ordinary import (up to `LIMITS.largeRows` rows and a write payload well inside Firestore's 10 MiB
 * commit limit), and for those nothing changed from PostgreSQL: all of it or none of it.
 *
 * ── A durable plan when it does not ──
 * A larger operation cannot be one Firestore commit. It is then made restartable instead:
 *
 *  1. CLAIM (one transaction): the lock document names this batch as its holder. From now on every
 *     other commit, rollback, replacement or attestation in the organisation is refused with CONFLICT
 *     ("still being committed"), and so is rejecting this batch.
 *  2. PLAN (no visible change): the operation runs on a working set read outside a transaction —
 *     safe because the holder keeps every other import writer out — and its final state is written,
 *     with `bulkWriter`, as numbered chunk documents under `organizations/{org}/_import_plans/{batch}`.
 *     A crash here leaves only the claim and invisible chunks: the OLD state is what everyone reads,
 *     and calling the operation again discards the chunks and plans afresh.
 *  3. READY (one transaction): the plan document records the chunk count and the result; a commit's
 *     batch shows `committing`.
 *  4. APPLY (one transaction per chunk): each chunk's documents are written and the plan's
 *     `applied` counter advanced together, so a chunk is applied exactly once. The LAST chunk holds
 *     the batch's own final state, and its transaction also enqueues the recalculation, sends the
 *     notifications, and releases the lock. A crash between chunks leaves a plan that the next call
 *     of the same operation on the same batch (the user retrying, or the `import.commit_large` job
 *     being reclaimed) finishes from where it stopped: the NEW state is always reachable, and the
 *     chunks are final document states, so applying one twice changes nothing.
 *
 * What a reader can see while chunks are being applied (seconds, for a five-thousand-row file) is
 * part of the batch's records accepted and part not yet — the one place this differs from the SQL.
 * The engine's recalculation is only requested by the last chunk, so no figure is computed from a
 * half-applied batch by the import itself.
 */

export const LIMITS = {
  /** Batches with more rows than this plan durably from the start. */
  largeRows: 1000,
  /** One transaction holds at most this many writes … */
  maxWrites: 2500,
  /** … and this much payload (Firestore's commit limit is 10 MiB). */
  maxBytes: 6_000_000,
  /** One plan chunk: at most this many documents and this many bytes (a document holds 1 MiB). */
  chunkWrites: 400,
  chunkBytes: 700_000,
  /** Tests only: stop (as a crash would) after this many chunks have been applied. */
  crashAfterChunks: null as number | null,
};

/** Tests only: shrink the limits to exercise the chunked path on a small batch. */
export function setImportLimits(next: Partial<typeof LIMITS>): typeof LIMITS {
  const previous = { ...LIMITS };
  Object.assign(LIMITS, next);
  return previous;
}

class TooLarge extends Error {}

export type ImportOp = 'commit' | 'rollback' | 'replace';

function planRef(fs: Firestore, orgId: string, batchId: string): DocumentReference {
  return orgDoc(fs, orgId).collection('_import_plans').doc(batchId);
}

const STILL_COMMITTING = 'another import in this organisation is still being committed; try again when it has finished';

/**
 * The transaction's half of `finalize`: recalculation, notifications, the job id on the batch.
 * Reads first (`prepare`), writes in `write`.
 */
async function prepareFinalize(
  db: Db, orgId: string, spec: FinalizeSpec | null | undefined, tx: Transaction, batchState: (id: string) => Data | null,
): Promise<{ write(tx: Transaction): void; job: string | null }> {
  if (!spec) return { write() {}, job: null };
  const recalc = spec.recalc.length > 0 ? await prepareRecalcRequests(db.fs, orgId, spec.recalc, spec.requestedBy, tx) : null;
  const notifyBatch = spec.notifyBatchId ? batchState(spec.notifyBatchId) : null;
  const notify = notifyBatch && notifyBatch.status === 'committed' ? await prepareDataAdded(db, tx, notifyBatch) : null;
  return {
    job: recalc?.id ?? null,
    write(t) {
      recalc?.write(t);
      if (recalc && spec.jobOnBatchId) {
        t.update(orgRow(db.fs, orgId, 'import_batches', spec.jobOnBatchId), { calculation_job_id: recalc.id });
      }
      notify?.write(t);
    },
  };
}

/** The commit's result names the recalculation job (`'job', v_job`), at the top or under `committed`. */
function withJob<R>(result: R, spec: FinalizeSpec | null | undefined, job: string | null): R {
  if (!spec?.jobOnBatchId || !result || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  if ('job' in r) return { ...r, job } as R;
  const committed = r.committed as Record<string, unknown> | undefined;
  if (committed && typeof committed === 'object' && 'job' in committed) return { ...r, committed: { ...committed, job } } as R;
  return result;
}

/**
 * Runs one import operation for `batchId` (the batch whose name the lock and plan carry). `compute`
 * must be repeatable: it is run again when Firestore retries the transaction, or when a plan is
 * discarded and made afresh.
 */
export async function runImportOperation<R>(
  db: Db, orgId: string, op: ImportOp, batchId: string, compute: (ws: WorkingSet) => Promise<Outcome<R>>,
): Promise<R> {
  const fs = db.fs;
  const lockRef = importLockRef(fs, orgId);

  // A plan this batch left unfinished is finished first — by the same operation only.
  const lock = (await lockRef.get()).data() ?? null;
  const holder = (lock?.holder_batch_id as string | null | undefined) ?? null;
  if (holder && holder !== batchId) raise.conflict(STILL_COMMITTING);
  if (holder === batchId) {
    if (lock?.holder_op !== op) raise.conflict('this batch is still being committed; finish that first');
    const plan = (await planRef(fs, orgId, batchId).get()).data();
    if (plan && plan.status === 'ready') return applyPlan<R>(db, orgId, batchId);
    return runChunked(db, orgId, op, batchId, compute);
  }

  const rows = await orgCollection(fs, orgId, 'import_rows').where('batch_id', '==', batchId).count().get();
  if (rows.data().count > LIMITS.largeRows) return runChunked(db, orgId, op, batchId, compute);

  try {
    return await runTx(db, async (tx) => {
      const current = (await tx.get(lockRef)).data();
      if (current?.holder_batch_id) raise.conflict(STILL_COMMITTING);
      const ws = new WorkingSet(fs, txLoader(tx));
      const out = await compute(ws);
      const fin = await prepareFinalize(db, orgId, out.finalize, tx,
        (id) => ws.peek(orgRow(fs, orgId, 'import_batches', id)) ?? null);
      const size = ws.size();
      if (size.writes > LIMITS.maxWrites || size.bytes > LIMITS.maxBytes) throw new TooLarge();
      ws.apply(tx);
      tx.set(lockRef, { holder_batch_id: null, holder_op: null, last_batch_id: batchId, touched_at: nowIso() });
      fin.write(tx);
      return withJob(out.result, out.finalize, fin.job);
    });
  } catch (error) {
    if (error instanceof TooLarge) return runChunked(db, orgId, op, batchId, compute);
    throw error;
  }
}

async function releaseLock(fs: Firestore, orgId: string, batchId: string): Promise<void> {
  const lockRef = importLockRef(fs, orgId);
  await fs.runTransaction(async (tx) => {
    const l = (await tx.get(lockRef)).data();
    if (l?.holder_batch_id === batchId) {
      tx.set(lockRef, { holder_batch_id: null, holder_op: null, last_batch_id: batchId, touched_at: nowIso() });
    }
  });
}

async function runChunked<R>(
  db: Db, orgId: string, op: ImportOp, batchId: string, compute: (ws: WorkingSet) => Promise<Outcome<R>>,
): Promise<R> {
  const fs = db.fs;
  const lockRef = importLockRef(fs, orgId);
  const pref = planRef(fs, orgId, batchId);

  // 1. CLAIM.
  await runTx(db, async (tx) => {
    const l = (await tx.get(lockRef)).data();
    if (l?.holder_batch_id && l.holder_batch_id !== batchId) raise.conflict(STILL_COMMITTING);
    tx.set(lockRef, { holder_batch_id: batchId, holder_op: op, last_batch_id: l?.last_batch_id ?? null, since: nowIso(), touched_at: nowIso() });
  });

  // 2. PLAN. Leftovers of an earlier attempt that never became ready are discarded first.
  await fs.recursiveDelete(pref);
  let out: Outcome<R>;
  let writes: PlannedWrite[];
  try {
    const ws = new WorkingSet(fs, plainLoader(fs));
    out = await compute(ws);
    writes = ws.writes();
  } catch (error) {
    await releaseLock(fs, orgId, batchId);
    throw error;
  }
  const batchPath = orgRow(fs, orgId, 'import_batches', batchId).path;
  const ordered = [...writes.filter((w) => w.ref.path !== batchPath), ...writes.filter((w) => w.ref.path === batchPath)];
  const parts: string[] = [];
  let current: Array<{ path: string; data?: Data | null; patch?: Data }> = [];
  let bytes = 0;
  for (const w of ordered) {
    // The batch's own document is always written whole: the last chunk's notifications read it.
    const item = w.patch && w.ref.path !== batchPath ? { path: w.ref.path, patch: w.patch } : { path: w.ref.path, data: w.data };
    const size = JSON.stringify(item).length;
    if (current.length > 0 && (current.length >= LIMITS.chunkWrites || bytes + size > LIMITS.chunkBytes)) {
      parts.push(JSON.stringify(current));
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  parts.push(JSON.stringify(current));
  const writer = fs.bulkWriter();
  parts.forEach((ops, i) => { void writer.set(pref.collection('chunks').doc(String(i).padStart(6, '0')), { index: i, ops }); });
  await writer.close();

  // 3. READY.
  const batchFinal = ordered.find((w) => w.ref.path === batchPath)?.data ?? null;
  await runTx(db, async (tx) => {
    const batchRef = orgRow(fs, orgId, 'import_batches', batchId);
    const b = (await tx.get(batchRef)).data();
    tx.set(pref, {
      op, batch_id: batchId, status: 'ready', chunks: parts.length, applied: 0,
      result: JSON.stringify(out.result ?? null), finalize: JSON.stringify(out.finalize ?? null), created_at: nowIso(),
    });
    if (op !== 'rollback' && b && batchFinal?.status === 'committed') tx.update(batchRef, { status: 'committing', updated_at: nowIso() });
  });

  // 4. APPLY.
  return applyPlan<R>(db, orgId, batchId);
}

async function applyPlan<R>(db: Db, orgId: string, batchId: string): Promise<R> {
  const fs = db.fs;
  const pref = planRef(fs, orgId, batchId);
  const lockRef = importLockRef(fs, orgId);
  for (;;) {
    const done = await runTx(db, async (tx) => {
      const plan = (await tx.get(pref)).data();
      if (!plan || plan.status !== 'ready') return { finished: true as const, plan: plan ?? null, job: null };
      const i = Number(plan.applied);
      const total = Number(plan.chunks);
      const chunk = (await tx.get(pref.collection('chunks').doc(String(i).padStart(6, '0')))).data();
      if (!chunk) throw new ConflictError('An import plan is incomplete. Please try again.');
      const ops = JSON.parse(String(chunk.ops)) as Array<{ path: string; data?: Data | null; patch?: Data }>;
      const last = i + 1 >= total;
      const spec = last ? (JSON.parse(String(plan.finalize)) as FinalizeSpec | null) : null;
      const states = new Map(ops.map((o) => [o.path, o.data ?? null]));
      const fin = last
        ? await prepareFinalize(db, orgId, spec, tx, (id) => states.get(orgRow(fs, orgId, 'import_batches', id).path) ?? null)
        : { write() {}, job: null };
      if (last) await tx.get(lockRef);
      for (const o of ops) {
        const ref = fs.doc(o.path);
        if (o.patch) tx.update(ref, o.patch);
        else if (o.data === null || o.data === undefined) tx.delete(ref);
        else tx.set(ref, o.data);
      }
      if (last) {
        tx.update(pref, { applied: i + 1, status: 'done', job: fin.job, finished_at: nowIso() });
        tx.set(lockRef, { holder_batch_id: null, holder_op: null, last_batch_id: batchId, touched_at: nowIso() });
        fin.write(tx);
        return { finished: true as const, plan: { ...plan, status: 'done', job: fin.job }, job: fin.job };
      }
      tx.update(pref, { applied: i + 1 });
      return { finished: false as const, plan, job: null, applied: i + 1 };
    });
    if (!done.finished && LIMITS.crashAfterChunks !== null && done.applied >= LIMITS.crashAfterChunks) {
      throw new Error('simulated crash while applying an import plan');
    }
    if (done.finished) {
      const plan = done.plan as Data | null;
      if (!plan) raise.conflict('this import has already been committed or rolled back');
      const result = JSON.parse(String(plan.result)) as R;
      const spec = JSON.parse(String(plan.finalize)) as FinalizeSpec | null;
      await fs.recursiveDelete(pref);
      return withJob(result, spec, (plan.job as string | null | undefined) ?? null);
    }
  }
}
