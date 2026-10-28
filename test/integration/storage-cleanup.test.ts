import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createServiceClient, enqueueNightlySweep, pruneRateLimits } from '@/core/db';
import { putObject, listOrganizationPrefixes, removeObjectsForOrganization } from '@/core/storage/signer';
import { storage, storageBucketName } from '@/db/firestore';
import { globalRow, hashKey, newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import {
  drainJobs, runStorageCleanupJob, ORPHAN_GRACE_MS, type ClaimedJob, type JobOutcome,
} from '@/modules/jobs';
import { createAuthUser, deleteOrg, drainUntilFinished, fs } from './setup';
import { auditsOf, makeOrg } from './f-fixtures';
import { freshSha } from './i-fixtures';

/**
 * `storage.cleanup_orphans` — the orphan sweep (SERVICE_ARCHITECTURE.md §7; TENANCY_MODEL.md §8;
 * SECURITY_MODEL.md §5b; ADR-043.4, ADR-062.2).
 *
 * This is the only job in APX that destroys customer data, so the interesting assertions are not
 * the ones about what it removes — they are the ones about what it must never remove. A sweep that
 * collected nothing would be a nuisance; a sweep that collected one live file would be an incident,
 * and the failure would surface as a 404 on a download weeks later, with nothing left to explain it.
 *
 * The suite seeds one object for each way an object can be claimed or unclaimed and asserts every
 * outcome against ONE sweep, because "was it removed?" is a property of a sweep, not of a query.
 *
 * Ageing, on Firebase Storage: an object's `timeCreated` is stamped by Storage and cannot be
 * backdated (PostgreSQL let the old suite rewrite `storage.objects.created_at`). So instead of
 * making the objects old, the sweep is run with this process's clock moved forward by twice the
 * grace period (`vi.setSystemTime`) — the same "everything is beyond the grace period" situation,
 * measured from the other end. The one object that must be YOUNG is the exception that cannot be
 * produced that way, so the grace period is proved by its own sweep first, at the real time, when
 * every seeded object is young: it must remove nothing. Only organisation-scoped sweeps run with
 * the moved clock, so a sweep here can never age another suite's objects on the shared emulator.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `s${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.storage.itest.motion`;
const SOURCE = 'source-documents';
const REPORTS = 'reports';

/**
 * Twice the grace period, derived rather than written as "48 hours": a fixture that hard-coded the
 * age would keep passing if somebody shortened the grace period to a minute, which is exactly the
 * change this suite exists to catch.
 */
const AGED_MS = ORPHAN_GRACE_MS * 2;

let ownerA: string;
let ownerB: string;
let orgA: string;
let orgB: string;
let periodA: string;
let periodB: string;
let youngOutcome: JobOutcome;
let scopedOutcome: JobOutcome;
let scopedBOutcome: JobOutcome;
const jobIds: string[] = [];

/** Every fixture key, named so the assertions below read as sentences rather than as paths. */
const keys = {
  aOrphan: '', aLive: '', aSidecar: '', aYoung: '', aSoftDeleted: '',
  aReportLive: '', aReportOrphan: '',
  bOrphan: '', bLive: '', bReportLive: '',
};

const bucketOf = (key: string) => (key.endsWith('.pdf') ? REPORTS : SOURCE);

async function put(bucket: string, key: string): Promise<void> {
  const orgId = key.split('/')[0]!;
  const type = bucket === REPORTS ? 'application/pdf' : 'text/csv';
  await putObject({ orgId, userId: 'itest' }, bucket, key, new TextEncoder().encode('fixture'), type);
}

/** Whether the bytes are still in Storage: that is the whole assertion. */
async function stored(bucket: string, key: string): Promise<boolean> {
  const [exists] = await storage().bucket(storageBucketName()).file(`${bucket}/${key}`).exists();
  return exists;
}

async function seedDocument(
  orgId: string, documentId: string, path: string,
  options: { softDeleted?: boolean; extractedTextPath?: string } = {},
): Promise<void> {
  const now = nowIso();
  await orgRow(fs(), orgId, 'source_documents', documentId).set({
    id: documentId, organization_id: orgId, storage_bucket: SOURCE, storage_path: path,
    original_filename: 'fixture.csv', mime_type: 'text/csv', byte_size: 7, sha256: freshSha(),
    document_kind: 'general_ledger', page_count: null, has_text_layer: null,
    extracted_text_path: options.extractedTextPath ?? null, status: options.softDeleted ? 'deleted' : 'ready',
    scan_result: {}, uploaded_by: null, deleted_at: options.softDeleted ? now : null, created_at: now, updated_at: now,
  });
}

async function seedReportFile(orgId: string, periodId: string, fileId: string, path: string): Promise<void> {
  await orgRow(fs(), orgId, 'report_files', fileId).set({
    id: fileId, organization_id: orgId, period_id: periodId, report_kind: 'monthly_management', job_id: null,
    storage_bucket: REPORTS, storage_path: path, sha256: null, byte_size: 7, generated_by: null,
    evidence_bundle_id: null, deleted_at: null, created_at: nowIso(), report_id: null,
  });
}

/** A `running` job document, the state the worker puts a job in before calling its handler. */
async function claimedJob(orgId: string | null): Promise<ClaimedJob> {
  const id = newId();
  const now = nowIso();
  await globalRow(fs(), 'jobs', id).set({
    id, organization_id: orgId, job_type: 'storage.cleanup_orphans', idempotency_key: null, payload: {},
    requested_by: null, status: 'running', attempts: 1, max_attempts: 3, run_after: now, locked_at: now,
    locked_by: `itest-${RUN}`, last_error: null, result: null, finished_at: null, created_at: now, updated_at: now,
  });
  jobIds.push(id);
  return {
    jobId: id, organizationId: orgId, jobType: 'storage.cleanup_orphans', payload: {}, requestedBy: null, attempts: 1, maxAttempts: 3,
  } as ClaimedJob;
}

/** Runs one organisation's sweep with the clock moved `AGED_MS` forward. */
async function agedSweep(orgId: string): Promise<JobOutcome> {
  const job = await claimedJob(orgId);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + AGED_MS);
  try {
    return await runStorageCleanupJob(job, { db: createServiceClient() });
  } finally {
    vi.useRealTimers();
  }
}

async function firstPeriod(orgId: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'fiscal_periods').orderBy('period_start').limit(1).get();
  return snap.docs[0]!.id;
}

beforeAll(async () => {
  ownerA = await createAuthUser(`owner-a@${DOMAIN}`);
  ownerB = await createAuthUser(`owner-b@${DOMAIN}`);
  orgA = await makeOrg(ownerA, `ITest Docs Storage A ${RUN}`);
  orgB = await makeOrg(ownerB, `ITest Docs Storage B ${RUN}`);
  periodA = await firstPeriod(orgA);
  periodB = await firstPeriod(orgB);

  const docLiveA = newId();
  const docSoftDeletedA = newId();
  const docLiveB = newId();
  const reportLiveA = newId();
  const reportOrphanA = newId();
  const reportLiveB = newId();

  keys.aOrphan = `${orgA}/${newId()}/orphan.csv`;
  keys.aLive = `${orgA}/${docLiveA}/live.csv`;
  keys.aSidecar = `${orgA}/${docLiveA}/text.json`;
  keys.aYoung = `${orgA}/${newId()}/just-uploaded.csv`;
  keys.aSoftDeleted = `${orgA}/${docSoftDeletedA}/removed-by-a-user.csv`;
  keys.aReportLive = `${orgA}/${periodA}/${reportLiveA}.pdf`;
  keys.aReportOrphan = `${orgA}/${periodA}/${reportOrphanA}.pdf`;
  keys.bOrphan = `${orgB}/${newId()}/orphan.csv`;
  keys.bLive = `${orgB}/${docLiveB}/live.csv`;
  keys.bReportLive = `${orgB}/${periodB}/${reportLiveB}.pdf`;

  await seedDocument(orgA, docLiveA, keys.aLive, { extractedTextPath: keys.aSidecar });
  await seedDocument(orgA, docSoftDeletedA, keys.aSoftDeleted, { softDeleted: true });
  await seedDocument(orgB, docLiveB, keys.bLive);
  await seedReportFile(orgA, periodA, reportLiveA, keys.aReportLive);
  await seedReportFile(orgB, periodB, reportLiveB, keys.bReportLive);

  for (const key of Object.values(keys)) await put(bucketOf(key), key);

  // 1. At the real time every seeded object is inside the grace period: nothing may go.
  youngOutcome = await runStorageCleanupJob(await claimedJob(orgA), { db: createServiceClient() });
  // The in-flight upload has made its point; the aged sweep below would (rightly) see it as old.
  await removeObjectsForOrganization(orgA, SOURCE, [keys.aYoung]);

  // 2. Everything beyond the grace period: each case now turns on whether a row claims it.
  scopedOutcome = await agedSweep(orgA);
}, 120_000);

afterAll(async () => {
  for (const [name, key] of Object.entries(keys)) {
    const orgId = name.startsWith('a') ? orgA : orgB;
    await removeObjectsForOrganization(orgId, bucketOf(key), [key]).catch(() => undefined);
  }
  for (const id of jobIds) await globalRow(fs(), 'jobs', id).delete();
  await deleteOrg(orgA);
  await deleteOrg(orgB);
});

describe('a sweep of one organisation', () => {
  it('succeeds rather than failing for want of a registered handler', () => {
    expect(youngOutcome.status).toBe('succeeded');
    expect(scopedOutcome.status).toBe('succeeded');
  });

  it('never removes an object younger than the grace period', () => {
    /*
     * The case the grace period exists for. The upload order is signer-write → register → finalize
     * (ADR-043.4), so between the object and its row there is a window in which an entirely healthy
     * upload looks exactly like an orphan — at the real time, every seeded object is in that window.
     */
    expect((youngOutcome.result as { removed: number }).removed).toBe(0);
  });

  it('removes an object that no live row claims', async () => {
    expect(await stored(SOURCE, keys.aOrphan)).toBe(false);
  });

  it('never removes an object a live row still claims', async () => {
    expect(await stored(SOURCE, keys.aLive)).toBe(true);
  });

  it('removes an object whose row has been soft-deleted', async () => {
    // `api.delete_document` marks the row and the signer removes the object; when that removal fails
    // the row stays `deleted` and this is what finishes the job (ADR-043.4).
    expect(await stored(SOURCE, keys.aSoftDeleted)).toBe(false);
  });

  it('never removes the extracted-text sidecar of a live document', async () => {
    // `text.json` has no row of its own — it is claimed through `extracted_text_path`.
    expect(await stored(SOURCE, keys.aSidecar)).toBe(true);
  });

  it('sweeps the reports bucket by the same rule', async () => {
    expect(await stored(REPORTS, keys.aReportOrphan)).toBe(false);
    expect(await stored(REPORTS, keys.aReportLive)).toBe(true);
  });

  it("never touches another organisation's objects", async () => {
    // B's orphan is as orphaned and as old as A's. The only thing keeping it is the prefix, which is
    // the assertion the signer makes on every key it is handed (TENANCY_MODEL.md §8).
    expect(await stored(SOURCE, keys.bOrphan)).toBe(true);
    expect(await stored(SOURCE, keys.bLive)).toBe(true);
    expect(await stored(REPORTS, keys.bReportLive)).toBe(true);
  });

  it('reports what it removed, and records it in counts rather than paths', async () => {
    const result = scopedOutcome.result as { removed: number; capped: boolean };
    expect(result.removed, 'A had exactly three orphans: two documents and one report').toBe(3);
    expect(result.capped).toBe(false);

    const audited = await auditsOf(orgA, 'storage.orphans_removed');
    expect(audited, 'one audit row per bucket that lost something').toHaveLength(2);
    const paths = audited.filter((a) => /orphan\.csv|\.pdf/.test(JSON.stringify(a.after ?? null)));
    expect(paths, 'audit metadata carries ids and counts, never filenames (ADR-038.9)').toHaveLength(0);
  });
});

describe('a platform-wide sweep through the queue', () => {
  let jobId: string;

  beforeAll(async () => {
    // At the real time: a platform-wide sweep with a moved clock would age every other suite's
    // objects on the shared emulator, so this one proves reach and restraint; removal across
    // organisations is proved by B's own aged sweep below.
    const now = nowIso();
    jobId = newId();
    await globalRow(fs(), 'jobs', jobId).set({
      id: jobId, organization_id: null, job_type: 'storage.cleanup_orphans', idempotency_key: null, payload: {},
      requested_by: null, status: 'queued', attempts: 0, max_attempts: 3, run_after: now, locked_at: null,
      locked_by: null, last_error: null, result: null, finished_at: null, created_at: now, updated_at: now,
    });
    jobIds.push(jobId);
    const status = await drainUntilFinished((max) => drainJobs(max), jobId);
    const job = (await globalRow(fs(), 'jobs', jobId).get()).data();
    expect(status, String(job?.last_error ?? '')).toBe('succeeded');
    scopedBOutcome = await agedSweep(orgB);
  }, 180_000);

  it('reaches every organisation, not only the one that queued it', async () => {
    const { organizationIds } = await listOrganizationPrefixes(SOURCE);
    expect(organizationIds).toEqual(expect.arrayContaining([orgA, orgB]));
    const result = (await globalRow(fs(), 'jobs', jobId).get()).get('result') as { buckets: Array<{ bucket: string; organisations: number }> };
    expect(result.buckets.find((b) => b.bucket === SOURCE)!.organisations).toBeGreaterThanOrEqual(2);
    // And B's orphan, as aged as A's, goes the same way under B's own sweep.
    expect(scopedBOutcome.status).toBe('succeeded');
    expect(await stored(SOURCE, keys.bOrphan)).toBe(false);
  });

  it('still refuses to remove anything a live row claims, in either organisation', async () => {
    expect(await stored(SOURCE, keys.bLive)).toBe(true);
    expect(await stored(REPORTS, keys.bReportLive)).toBe(true);
    expect(await stored(SOURCE, keys.aLive)).toBe(true);
    expect(await stored(SOURCE, keys.aSidecar)).toBe(true);
    expect(await stored(REPORTS, keys.aReportLive)).toBe(true);
  });

  it('records the grace period it applied on the job row', async () => {
    const result = (await globalRow(fs(), 'jobs', jobId).get()).get('result') as { graceHours: number };
    expect(Number(result.graceHours)).toBe(ORPHAN_GRACE_MS / 3_600_000);
  });
});

describe('the platform sweep is scheduled, and it prunes the throttle counter (ADR-074)', () => {
  it('queues exactly one sweep per calendar date, whoever asks and however often', async () => {
    const date = '2031-01-15';
    const first = await enqueueNightlySweep(date);
    const second = await enqueueNightlySweep(date);
    expect(second, 'the same date returns the same job').toBe(first);
    const job = (await globalRow(fs(), 'jobs', first).get()).data()!;
    expect(`${job.job_type}|${job.organization_id ?? 'platform'}|${job.idempotency_key}`)
      .toBe(`storage.cleanup_orphans|platform|storage.cleanup_orphans:${date}`);
    const other = await enqueueNightlySweep('2031-01-16');
    expect(other).not.toBe(first);
    jobIds.push(first, other);
  });

  it('prunes rate-limit rows older than two days and keeps every live window', async () => {
    const actor = newId();
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const windows: Array<[string, number]> = [
      ['rpc', minute - 3 * 86_400_000],
      ['rpc', minute - 25 * 3_600_000],
      ['upload:org', day - 86_400_000],
      ['rpc', minute],
    ];
    for (const [bucket, at] of windows) {
      const windowStart = new Date(at).toISOString();
      await globalRow(fs(), 'api_rate_limits', hashKey([actor, bucket, windowStart])).set({
        actor_user_id: actor, bucket, window_start: windowStart, count: 5, updated_at: nowIso(),
      });
    }
    const pruned = await pruneRateLimits();
    expect(pruned).toBeGreaterThanOrEqual(1);

    // The three-day-old row is gone; the 25-hour, one-day and current rows all stay (two-day keep).
    const left = await fs().collection('api_rate_limits').where('actor_user_id', '==', actor).get();
    expect(left.size).toBe(3);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(left.docs.filter((d) => String(d.get('window_start')) < twoDaysAgo)).toHaveLength(0);
    for (const d of left.docs) await d.ref.delete();
  });

  it('the platform-wide run reports what it pruned; a per-organisation run leaves the counter alone', async () => {
    const platform = await runStorageCleanupJob(await claimedJob(null), { db: createServiceClient() });
    expect(platform.status).toBe('succeeded');
    expect(typeof (platform.result as { rateLimitRowsPruned: unknown }).rateLimitRowsPruned).toBe('number');
    expect((scopedOutcome.result as { rateLimitRowsPruned: unknown }).rateLimitRowsPruned,
      'a per-organisation sweep does not touch a platform table').toBeNull();
  }, 120_000);
});
