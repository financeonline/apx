import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';

/**
 * Service-role access — sanctioned use #3 of 3 (ADR-043; finding R2-A-01).
 *
 * `api.*` is granted to `authenticated`, so anything it accepts is something a browser can assert
 * with the user's own token. Facts the SERVER observed — a download happened, a scan passed, an AI
 * answer was grounded — are written through `api_server.*`, which only the service role may
 * execute. The human actor is passed explicitly and re-validated in SQL against the
 * actor-parameterised helpers, so a compromised browser cannot forge one.
 *
 * This is the only file allowed to name an `api_server.*` function; the
 * `motion/no-api-server-outside-server-rpc` lint rule enforces that.
 */

let cached: SupabaseClient | null = null;

function serverClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('server-rpc requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export interface ServerRpcActor {
  readonly userId: string;
  readonly requestId: string;
}

/** Read-side audit events (ADR-043.2). Returns the audit id the Storage signer later verifies. */
export async function recordAccessEvent(
  actor: ServerRpcActor,
  input: {
    organizationId: string | null;
    action:
      | 'document.downloaded'
      | 'report.downloaded'
      | 'export.created'
      | 'evidence.viewed'
      | 'org.data_viewed'
      | 'document.quarantined'
      | 'document.sent_to_ai'
      | 'auth.sign_in'
      | 'auth.sign_out'
      | 'auth.failed'
      | 'member.invitation_failed';
    targetTable?: string | null;
    targetId?: string | null;
    metadata?: Record<string, string | number | string[]>;
  },
): Promise<number> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('record_access_event', {
      p_actor: actor.userId,
      p_org: input.organizationId,
      p_action: input.action,
      p_target_table: input.targetTable ?? null,
      p_target_id: input.targetId ?? null,
      p_metadata: input.metadata ?? {},
      p_request_id: actor.requestId,
    });
  if (error) throw toMotionError(error, actor.requestId);
  return data as number;
}

/**
 * The shared rate-limit counter, for routes (`ROUTE_ARCHITECTURE.md` §5).
 *
 * Every `api.*` function throttles through `app.throttle`, whose counter is `api_rate_limits`. A
 * route cannot reach `app` — it is not an exposed schema — and an in-process counter would reset on
 * every deploy and would not be shared between instances, which is exactly what a download limit
 * has to survive. Raises `RATE_LIMITED` when the bucket is spent.
 */
export async function throttle(
  actor: ServerRpcActor,
  bucket: string,
  limit: number,
  window: string,
): Promise<void> {
  const { error } = await serverClient()
    .schema('api_server')
    .rpc('throttle', {
      p_actor: actor.userId, p_bucket: bucket, p_limit: limit, p_window: window,
    });
  if (error) throw toMotionError(error, actor.requestId);
}

/**
 * Records a rendered report (SERVICE_ARCHITECTURE.md §4.14, ADR-038.7).
 *
 * The object is written to `{org}/{period}/{file}.pdf` BEFORE this is called (ADR-043.4), so a row
 * never names an object that is not there; a crash between the two leaves an orphan object, which
 * `storage.cleanup_orphans` removes, rather than a download the product believes in and Storage
 * 404s.
 */
export async function recordReportFile(
  actor: ServerRpcActor | null,
  input: {
    organizationId: string;
    periodId: string;
    jobId: string | null;
    fileId: string;
    sha256: Uint8Array;
    byteSize: number;
  },
): Promise<string> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('record_report_file', {
      p_actor: actor?.userId ?? null,
      p_org: input.organizationId,
      p_period: input.periodId,
      p_job: input.jobId,
      p_file: input.fileId,
      p_sha256: `\\x${Buffer.from(input.sha256).toString('hex')}`,
      p_bytes: input.byteSize,
    });
  if (error) throw toMotionError(error, actor?.requestId);
  return data as string;
}

/** One item of a metric bundle, as `api_server.build_metric_bundle_as` takes it. */
export interface MetricBundleItem {
  readonly item_type: 'metric_snapshot' | 'calculation_run' | 'query' | 'counterparty' | 'account';
  readonly ref_id: string | null;
  readonly query_descriptor: unknown | null;
  readonly descriptor_hash: string | null;
  readonly label: string;
  readonly assurance_level: string;
}

/**
 * Materialises a metric's evidence bundle (EVIDENCE_MODEL.md §9; ADR-066).
 *
 * The items are derived on the server from the snapshot's own `evidence_query`
 * (`evidence/services/build-metric.ts`); the function re-derives the snapshot's tree in SQL and
 * refuses any item that is not part of it, re-checks the actor's `financials.view`, and returns the
 * existing bundle if one exists. No user token can reach this: a browser has no bundle-writing
 * surface at all, which is what closes PRODUCTION_AUDIT.md C2.
 */
export async function buildMetricBundle(
  actor: ServerRpcActor,
  input: { snapshotId: string; items: readonly MetricBundleItem[] },
): Promise<string> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('build_metric_bundle_as', {
      p_actor: actor.userId,
      p_snapshot: input.snapshotId,
      p_items: input.items,
    });
  if (error) throw toMotionError(error, actor.requestId);
  return data as string;
}

/**
 * The row half of `org.purge` (TENANCY_MODEL.md §2; ADR-067): re-verifies the organisation is still
 * scheduled and thirty days old, waits for its other jobs, deletes every tenant row, redacts the
 * audit trail and marks the organisation `deleted` — one transaction. No human actor: the purge is
 * the system honouring a request the owner made thirty days earlier and could have cancelled since.
 */
export async function purgeOrganization(
  organizationId: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('purge_organization', { p_org: organizationId, p_job: jobId });
  if (error) throw toMotionError(error);
  return data as Record<string, unknown>;
}

/**
 * Records one organization's share of a `storage.cleanup_orphans` sweep (SERVICE_ARCHITECTURE.md §7).
 *
 * The sweep is the only job that destroys customer data, and the row whose absence condemned each
 * object is by definition not there to show what happened. Counts only — object paths carry the
 * uploader's original filename, which audit metadata does not hold (ADR-038.9); the keys themselves
 * go to the job's log line, where an operator looking at a specific sweep will find them.
 */
export async function recordStorageCleanup(input: {
  organizationId: string;
  jobId: string;
  bucket: string;
  examined: number;
  removed: number;
  failed: number;
}): Promise<void> {
  await serverRpc('record_storage_cleanup', {
    p_org: input.organizationId,
    p_job: input.jobId,
    p_bucket: input.bucket,
    p_examined: input.examined,
    p_removed: input.removed,
    p_failed: input.failed,
  });
}

/**
 * The instant a calculation chunk aggregates as of (FINANCIAL_ENGINE.md §2.4 step 4).
 *
 * Read from the DATABASE, because `app.aggregate_periods` compares it against `created_at`, which
 * Postgres stamps. A worker clock in that comparison decides which rows a run can see, and gets it
 * wrong silently (ADR-063).
 */
export async function aggregationInstant(actor: ServerRpcActor | null): Promise<string> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('aggregation_instant');
  if (error) throw toMotionError(error, actor?.requestId);
  return data as string;
}

/** Server-originated job enqueue (ADR-043.3). User-intent jobs go through api.enqueue_job. */
export async function enqueueServerJob(
  actor: ServerRpcActor | null,
  input: {
    organizationId: string | null;
    jobType:
      | 'calculation.run'
      | 'document.extract'
      | 'import.commit_large'
      | 'alerts.evaluate'
      | 'report.render'
      | 'ai.eval'
      | 'storage.cleanup_orphans'
      | 'snapshots.compact';
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('enqueue_job', {
      p_actor: actor?.userId ?? null,
      p_org: input.organizationId,
      p_job_type: input.jobType,
      p_payload: input.payload ?? {},
    });
  if (error) throw toMotionError(error, actor?.requestId);
  return data as string;
}

// ---------------------------------------------------------------------------
// Job queue (ADR-013, ADR-044.6). The worker's two api_server calls live here rather than in the
// worker, because this file is the sanctioned home for the server-asserted surface — a job claim
// asserts "this worker now owns this job", which is a fact about the server, not a user intent.
// ---------------------------------------------------------------------------

export interface ClaimedJobRow {
  readonly jobId: string;
  /** NULL for platform-level jobs. This — never the payload — is what scopes the work. */
  readonly organizationId: string | null;
  readonly jobType: string;
  readonly payload: Record<string, unknown>;
  readonly requestedBy: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
}

interface RawClaim {
  job_id: string;
  organization_id: string | null;
  job_type: string;
  payload: Record<string, unknown> | null;
  requested_by: string | null;
  attempts: number;
  max_attempts: number;
}

/** Atomically claim one runnable job, or return null when the queue is empty. */
export async function claimJob(workerId: string): Promise<ClaimedJobRow | null> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('claim_job', { p_worker: workerId });

  if (error) throw new Error(`could not claim a job: ${error.message}`);

  const row = (data as RawClaim[] | null)?.[0];
  if (!row) return null;

  return {
    jobId: row.job_id,
    organizationId: row.organization_id,
    jobType: row.job_type,
    payload: row.payload ?? {},
    requestedBy: row.requested_by,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

/**
 * Record a terminal outcome. Deliberately a separate call from the claim: if the worker dies in
 * between, the job stays `running` and is reclaimed after its budget, rather than being lost.
 */
export async function finishJob(
  jobId: string,
  status: 'succeeded' | 'failed' | 'dead' | 'deferred_upstream',
  result: Record<string, unknown> = {},
  errorMessage: string | null = null,
): Promise<void> {
  const { error } = await serverClient()
    .schema('api_server')
    .rpc('finish_job', { p_job: jobId, p_status: status, p_result: result, p_error: errorMessage });

  // Must be loud: an unrecorded outcome leaves the job `running`, so it will be reclaimed and the
  // work may run twice. Swallowing this would hide a real duplicate-execution risk.
  if (error) throw new Error(`could not record the outcome of job ${jobId}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Documents (ADR-043.4). The upload handshake is server-asserted end to end: the browser may not
// choose the id, the storage path, or whether its own file passed a scan.
// ---------------------------------------------------------------------------

/**
 * Creates the `source_documents` row and RETURNS the id the server generated. The storage path is
 * derived from that id inside SQL, so a caller cannot aim a write at another organization's prefix.
 * A file whose bytes already exist raises CONFLICT carrying the earlier document's id.
 */
export async function registerDocument(
  actor: ServerRpcActor,
  organizationId: string,
  meta: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('register_document', {
      p_actor: actor.userId,
      p_org: organizationId,
      p_meta: meta,
      p_request_id: actor.requestId ?? null,
    });

  if (error) throw toMotionError(error, actor.requestId);
  return data as string;
}

/**
 * Closes the handshake. The document becomes `ready` only after SQL has confirmed the object exists
 * at the declared size — a row claiming a file that is not there would give the parser something to
 * read that does not exist.
 */
export async function finalizeUpload(
  actor: ServerRpcActor,
  organizationId: string,
  input: {
    documentId: string;
    byteSize: number;
    scanResult: unknown;
    status: string;
  },
): Promise<void> {
  const { error } = await serverClient()
    .schema('api_server')
    .rpc('finalize_upload', {
      p_actor: actor.userId,
      p_org: organizationId,
      p_document: input.documentId,
      p_byte_size: input.byteSize,
      p_scan_result: input.scanResult,
      p_status: input.status,
      p_request_id: actor.requestId ?? null,
    });

  if (error) throw toMotionError(error, actor.requestId);
}

// ---------------------------------------------------------------------------
// The calculation run, the health score and the alert engine (FINANCIAL_ENGINE.md §2.4, §7, §8.3).
//
// These are the server's own assertions about a computation it performed — "this run started",
// "these are its snapshots", "this is the score", "these alerts changed". None of them is a user
// intent, and none may be reachable from a browser, so they live here behind the service role like
// every other `api_server.*` call (ADR-043).
// ---------------------------------------------------------------------------

async function serverRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await serverClient().schema('api_server').rpc(fn, args);
  if (error) throw toMotionError(error);
  return data as T;
}

/**
 * Deletes throttle-counter rows older than two days (DATABASE_ARCHITECTURE.md §7 `api_rate_limits`;
 * ADR-074). Run by the platform-wide nightly sweep, whose job the retention always was. Returns the
 * number of rows removed.
 */
export async function pruneRateLimits(): Promise<number> {
  return serverRpc<number>('prune_rate_limits', {});
}

/**
 * Queues the one platform-wide `storage.cleanup_orphans` for a calendar date, keyed on the date
 * (SERVICE_ARCHITECTURE.md §7; ADR-074). Idempotent: the same date returns the same job.
 */
export async function enqueueNightlySweep(date?: string): Promise<string> {
  return serverRpc<string>('enqueue_nightly_sweep', date === undefined ? {} : { p_date: date });
}

export async function startCalculationRun(
  input: Record<string, unknown>,
): Promise<{ runId: string; noChange: boolean }> {
  const raw = await serverRpc<{ runId?: string; run_id?: string; noChange?: boolean; no_change?: boolean }>(
    'start_calculation_run', input,
  );
  return {
    runId: (raw.runId ?? raw.run_id) as string,
    noChange: (raw.noChange ?? raw.no_change) === true,
  };
}

export async function finishChunk(input: Record<string, unknown>): Promise<{ written: number }> {
  const written = await serverRpc<number>('finish_chunk', input);
  return { written: Number(written ?? 0) };
}

export async function finishCalculationRun(
  runId: string,
  organizationId: string,
  status: 'succeeded' | 'failed',
  stats: Record<string, unknown>,
  error?: unknown,
): Promise<void> {
  await serverRpc('finish_calculation_run', {
    p_org: organizationId,
    p_run: runId,
    p_status: status,
    p_stats: stats,
    p_error: error === undefined ? null : error,
  });
}

export async function setPeriodCompleteness(
  organizationId: string, periods: string[], complete: boolean[],
): Promise<void> {
  if (periods.length === 0) return;
  await serverRpc('set_period_completeness', {
    p_org: organizationId, p_periods: periods, p_complete: complete,
  });
}

export async function finishHealth(input: Record<string, unknown>): Promise<{ written: number }> {
  const written = await serverRpc<number>('finish_health', input);
  return { written: Number(written ?? 0) };
}

export async function persistAlerts(
  input: Record<string, unknown>,
): Promise<Record<string, number>> {
  const counts = await serverRpc<Record<string, number>>('persist_alerts', input);
  return counts ?? {};
}

/**
 * The engine's three aggregation reads (§2.2, §2.4 step 4).
 *
 * They live in `app`, which is deliberately not exposed to PostgREST, so the engine reaches them
 * through `api_server` wrappers. The repository used to call them unqualified, which resolved to
 * `public` and returned PGRST202 on every calculation — the defect ADR-057.2 records.
 */
export async function aggregatePeriods(
  orgId: string, from: string, to: string, aggregatedAt: string,
): Promise<Record<string, unknown>[]> {
  return serverRpc<Record<string, unknown>[]>('aggregate_periods', {
    p_org: orgId, p_from: from, p_to: to, p_aggregated_at: aggregatedAt,
  }).then((rows) => rows ?? []);
}

export async function aggregateTransferLegs(
  orgId: string, from: string, to: string, aggregatedAt: string,
): Promise<Record<string, unknown>[]> {
  return serverRpc<Record<string, unknown>[]>('aggregate_transfer_legs', {
    p_org: orgId, p_from: from, p_to: to, p_aggregated_at: aggregatedAt,
  }).then((rows) => rows ?? []);
}

export async function batchCoverage(
  orgId: string, from: string, to: string,
): Promise<Record<string, unknown>[]> {
  return serverRpc<Record<string, unknown>[]>('batch_coverage', {
    p_org: orgId, p_from: from, p_to: to,
  }).then((rows) => rows ?? []);
}

// ---------------------------------------------------------------------------
// The import pipeline's three server-asserted writes (IMPORT_ENGINE.md §7).
//
// What the parser OBSERVED about a file — these rows, these issues, this failure — is a server fact
// (ADR-043). A browser must not be able to assert that a row validated cleanly.
// ---------------------------------------------------------------------------

export async function writeImportRows(
  actor: ServerRpcActor, orgId: string, batchId: string, rows: unknown[],
): Promise<number> {
  const written = await serverRpc<number>('write_import_rows', {
    p_actor: actor.userId, p_org: orgId, p_batch: batchId, p_rows: rows,
  });
  return Number(written ?? 0);
}

export async function setBatchValidation(
  actor: ServerRpcActor,
  orgId: string,
  batchId: string,
  batchIssues: unknown[],
  required: string[],
  rowCounts: Record<string, number>,
  statement: Record<string, unknown> | null,
): Promise<void> {
  await serverRpc('set_batch_validation', {
    p_actor: actor.userId, p_org: orgId, p_batch: batchId,
    p_batch_issues: batchIssues, p_required: required,
    p_row_counts: rowCounts, p_statement: statement,
  });
}

export async function failImportBatch(
  actor: ServerRpcActor, orgId: string, batchId: string, stage: string, message: string,
): Promise<void> {
  await serverRpc('fail_import_batch', {
    p_actor: actor.userId, p_org: orgId, p_batch: batchId,
    p_stage: stage, p_message: message, p_deferred: false,
  });
}
