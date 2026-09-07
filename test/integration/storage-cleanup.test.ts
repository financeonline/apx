import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createServiceClient } from '@/core/db';
import {
  drainJobs, runStorageCleanupJob, ORPHAN_GRACE_MS, type ClaimedJob, type JobOutcome,
} from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished, serviceStorage } from './setup';

/**
 * `storage.cleanup_orphans` — the orphan sweep (SERVICE_ARCHITECTURE.md §7; TENANCY_MODEL.md §8;
 * SECURITY_MODEL.md §5b; ADR-043.4, ADR-062.2).
 *
 * This is the only job in MOTION that destroys customer data, so the interesting assertions are not
 * the ones about what it removes — they are the four about what it must never remove. A sweep that
 * collected nothing would be a nuisance; a sweep that collected one live file would be an incident,
 * and the failure would surface as a 404 on a download weeks later, with nothing left to explain it.
 *
 * The suite therefore seeds one object for each way an object can be claimed or unclaimed, runs the
 * sweep ONCE, and asserts every outcome against that single run — because "was it removed?" is a
 * property of a sweep, not of a query, and re-running per case would let a bug that only fires on
 * the second pass go unseen.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `s${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.storage.itest`;
const SOURCE = 'source-documents';
const REPORTS = 'reports';

/**
 * Twice the grace period, derived rather than written as "48 hours": a fixture that hard-coded the
 * age would keep passing if somebody shortened the grace period to a minute, which is exactly the
 * change this suite exists to catch.
 */
const AGED_HOURS = (ORPHAN_GRACE_MS / 3_600_000) * 2;

let ownerA: string;
let ownerB: string;
let orgA: string;
let orgB: string;
let periodA: string;
let periodB: string;
let scopedOutcome: JobOutcome;

/** Every fixture key, named so the assertions below read as sentences rather than as paths. */
const keys = {
  aOrphan: '', aLive: '', aSidecar: '', aYoung: '', aSoftDeleted: '',
  aReportLive: '', aReportOrphan: '',
  bOrphan: '', bLive: '', bReportLive: '',
};

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

async function put(bucket: string, key: string): Promise<void> {
  const type = bucket === REPORTS ? 'application/pdf' : 'text/csv';
  const { error } = await serviceStorage().storage
    .from(bucket)
    .upload(key, new Blob(['fixture'], { type }), { contentType: type, upsert: true });
  if (error) throw new Error(`fixture object ${key} could not be stored: ${error.message}`);
}

/**
 * Backdates an object so the grace period no longer protects it.
 *
 * Storage stamps `updated_at` from a trigger on every write, so a plain UPDATE cannot make an object
 * look old — the trigger would put the timestamp straight back to now and the fixture would silently
 * test nothing. `session_replication_role = replica` suspends the trigger for the statement.
 */
function age(bucket: string, key: string): void {
  adminSql(`
    set session_replication_role = replica;
    update storage.objects
       set created_at = now() - interval '${AGED_HOURS} hours',
           updated_at = now() - interval '${AGED_HOURS} hours'
     where bucket_id = '${bucket}' and name = '${key}';
    reset session_replication_role;`);
}

/** Reads `storage.objects` directly: whether the bytes are still there is the whole assertion. */
function stored(bucket: string, key: string): boolean {
  return one(`
    select count(*) from storage.objects
     where bucket_id = '${bucket}' and name = '${key}'`) === '1';
}

function seedDocument(
  orgId: string, documentId: string, path: string,
  options: { softDeleted?: boolean; extractedTextPath?: string } = {},
): void {
  adminSql(`
    insert into public.source_documents
           (id, organization_id, storage_bucket, storage_path, original_filename, mime_type,
            byte_size, sha256, status, document_kind, extracted_text_path, deleted_at)
    values ('${documentId}', '${orgId}', '${SOURCE}', '${path}', 'fixture.csv', 'text/csv', 7,
            decode(md5('${documentId}'), 'hex'),
            '${options.softDeleted ? 'deleted' : 'ready'}', 'general_ledger',
            ${options.extractedTextPath ? `'${options.extractedTextPath}'` : 'null'},
            ${options.softDeleted ? 'now()' : 'null'})`);
}

function seedReportFile(orgId: string, periodId: string, fileId: string, path: string): void {
  adminSql(`
    insert into public.report_files
           (id, organization_id, period_id, report_kind, storage_bucket, storage_path, byte_size)
    values ('${fileId}', '${orgId}', '${periodId}', 'monthly_management', '${REPORTS}',
            '${path}', 7)`);
}

/** A `running` job row, which is the state the worker would have put it in before calling a handler. */
function claimedJobRow(orgId: string | null): string {
  return one(`
    insert into public.jobs (organization_id, job_type, payload, status, locked_at, locked_by,
                             attempts)
    values (${orgId === null ? 'null' : `'${orgId}'`}, 'storage.cleanup_orphans', '{}'::jsonb,
            'running', now(), 'itest-${RUN}', 1)
    returning id`);
}

beforeAll(async () => {
  ownerA = createAuthUser(`owner-a@${DOMAIN}`);
  ownerB = createAuthUser(`owner-b@${DOMAIN}`);

  const a = await clientFor(ownerA).schema('api').rpc('create_organization', {
    p_name: `ITest Storage A ${RUN}`,
  });
  if (a.error) throw new Error(`fixture org A failed: ${a.error.message}`);
  orgA = a.data as unknown as string;

  const b = await clientFor(ownerB).schema('api').rpc('create_organization', {
    p_name: `ITest Storage B ${RUN}`,
  });
  if (b.error) throw new Error(`fixture org B failed: ${b.error.message}`);
  orgB = b.data as unknown as string;

  periodA = one(`
    select id from public.fiscal_periods where organization_id = '${orgA}'
     order by period_start limit 1`);
  periodB = one(`
    select id from public.fiscal_periods where organization_id = '${orgB}'
     order by period_start limit 1`);

  const docLiveA = one(`select gen_random_uuid()`);
  const docSoftDeletedA = one(`select gen_random_uuid()`);
  const docLiveB = one(`select gen_random_uuid()`);
  const reportLiveA = one(`select gen_random_uuid()`);
  const reportOrphanA = one(`select gen_random_uuid()`);
  const reportLiveB = one(`select gen_random_uuid()`);

  keys.aOrphan = `${orgA}/${one(`select gen_random_uuid()`)}/orphan.csv`;
  keys.aLive = `${orgA}/${docLiveA}/live.csv`;
  keys.aSidecar = `${orgA}/${docLiveA}/text.json`;
  keys.aYoung = `${orgA}/${one(`select gen_random_uuid()`)}/just-uploaded.csv`;
  keys.aSoftDeleted = `${orgA}/${docSoftDeletedA}/removed-by-a-user.csv`;
  keys.aReportLive = `${orgA}/${periodA}/${reportLiveA}.pdf`;
  keys.aReportOrphan = `${orgA}/${periodA}/${reportOrphanA}.pdf`;
  keys.bOrphan = `${orgB}/${one(`select gen_random_uuid()`)}/orphan.csv`;
  keys.bLive = `${orgB}/${docLiveB}/live.csv`;
  keys.bReportLive = `${orgB}/${periodB}/${reportLiveB}.pdf`;

  seedDocument(orgA, docLiveA, keys.aLive, { extractedTextPath: keys.aSidecar });
  seedDocument(orgA, docSoftDeletedA, keys.aSoftDeleted, { softDeleted: true });
  seedDocument(orgB, docLiveB, keys.bLive);
  seedReportFile(orgA, periodA, reportLiveA, keys.aReportLive);
  seedReportFile(orgB, periodB, reportLiveB, keys.bReportLive);

  for (const key of Object.values(keys)) {
    await put(key.endsWith('.pdf') ? REPORTS : SOURCE, key);
  }

  // Everything except the in-flight upload is put beyond the grace period, so each case turns on
  // whether a row claims it rather than on how old it happens to be.
  for (const [name, key] of Object.entries(keys)) {
    if (name === 'aYoung') continue;
    age(key.endsWith('.pdf') ? REPORTS : SOURCE, key);
  }

  const job: ClaimedJob = {
    jobId: claimedJobRow(orgA),
    organizationId: orgA,
    jobType: 'storage.cleanup_orphans',
    payload: {},
    requestedBy: null,
    attempts: 1,
    maxAttempts: 3,
  };
  scopedOutcome = await runStorageCleanupJob(job, { db: createServiceClient() });
});

afterAll(async () => {
  const storage = serviceStorage();
  await storage.storage.from(SOURCE).remove(
    Object.values(keys).filter((key) => !key.endsWith('.pdf')),
  );
  await storage.storage.from(REPORTS).remove(
    Object.values(keys).filter((key) => key.endsWith('.pdf')),
  );
  adminSql(`
    delete from public.organizations where name like 'ITest Storage%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Storage %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.storage.itest' and created_at < now() - interval '1 hour';`);
});

describe('a sweep of one organisation', () => {
  it('succeeds rather than failing for want of a registered handler', () => {
    expect(scopedOutcome.status).toBe('succeeded');
  });

  it('removes an object that no live row claims', () => {
    expect(stored(SOURCE, keys.aOrphan)).toBe(false);
  });

  it('never removes an object a live row still claims', () => {
    expect(stored(SOURCE, keys.aLive)).toBe(true);
  });

  it('never removes an object younger than the grace period', () => {
    /*
     * The case the grace period exists for. The upload order is signer-write → register → finalize
     * (ADR-043.4), so between the object and its row there is a window in which an entirely healthy
     * upload looks exactly like an orphan — this object is that window, held open.
     */
    expect(stored(SOURCE, keys.aYoung)).toBe(true);
  });

  it('removes an object whose row has been soft-deleted', () => {
    // `api.delete_document` marks the row and the signer removes the object; when that removal fails
    // the row stays `deleted` and this is what finishes the job (ADR-043.4).
    expect(stored(SOURCE, keys.aSoftDeleted)).toBe(false);
  });

  it('never removes the extracted-text sidecar of a live document', () => {
    // `text.json` has no row of its own — it is claimed through `extracted_text_path`. Sweeping on
    // `storage_path` alone would delete the extracted text out from under a healthy document.
    expect(stored(SOURCE, keys.aSidecar)).toBe(true);
  });

  it('sweeps the reports bucket by the same rule', () => {
    expect(stored(REPORTS, keys.aReportOrphan)).toBe(false);
    expect(stored(REPORTS, keys.aReportLive)).toBe(true);
  });

  it("never touches another organisation's objects", () => {
    // B's orphan is as orphaned and as old as A's. The only thing keeping it is the prefix, which is
    // the assertion the signer makes on every key it is handed (TENANCY_MODEL.md §8).
    expect(stored(SOURCE, keys.bOrphan)).toBe(true);
    expect(stored(SOURCE, keys.bLive)).toBe(true);
    expect(stored(REPORTS, keys.bReportLive)).toBe(true);
  });

  it('reports what it removed, and records it in counts rather than paths', () => {
    const result = scopedOutcome.result as { removed: number; capped: boolean };
    expect(result.removed, 'A had exactly three orphans: two documents and one report').toBe(3);
    expect(result.capped).toBe(false);

    const audited = one(`
      select count(*) from public.audit_events
       where organization_id = '${orgA}' and action = 'storage.orphans_removed'`);
    expect(audited, 'one audit row per bucket that lost something').toBe('2');

    const paths = one(`
      select count(*) from public.audit_events
       where organization_id = '${orgA}' and action = 'storage.orphans_removed'
         and (after::text like '%orphan.csv%' or after::text like '%.pdf%')`);
    expect(paths, 'audit metadata carries ids and counts, never filenames (ADR-038.9)').toBe('0');
  });
});

describe('a platform-wide sweep through the queue', () => {
  let jobId: string;

  beforeAll(async () => {
    jobId = one(`
      insert into public.jobs (organization_id, job_type, payload)
      values (null, 'storage.cleanup_orphans', '{}'::jsonb)
      returning id`);
    const status = await drainUntilFinished((max) => drainJobs(max), jobId);
    expect(status, adminSql(`select coalesce(last_error, '') from public.jobs where id = '${jobId}'`))
      .toBe('succeeded');
  });

  it('reaches every organisation, not only the one that queued it', () => {
    // The same object the organisation-scoped sweep deliberately left alone.
    expect(stored(SOURCE, keys.bOrphan)).toBe(false);
  });

  it('still refuses to remove anything a live row claims, in either organisation', () => {
    expect(stored(SOURCE, keys.bLive)).toBe(true);
    expect(stored(REPORTS, keys.bReportLive)).toBe(true);
    expect(stored(SOURCE, keys.aLive)).toBe(true);
    expect(stored(SOURCE, keys.aSidecar)).toBe(true);
    expect(stored(SOURCE, keys.aYoung)).toBe(true);
    expect(stored(REPORTS, keys.aReportLive)).toBe(true);
  });

  it('records the grace period it applied on the job row', () => {
    const grace = one(`select result ->> 'graceHours' from public.jobs where id = '${jobId}'`);
    expect(Number(grace)).toBe(ORPHAN_GRACE_MS / 3_600_000);
  });
});
