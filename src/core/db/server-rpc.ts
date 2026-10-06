import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { currentOrgScope, scopedServiceClient } from './service-client';

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

/**
 * The client every `api_server.*` call is made on.
 *
 * Inside a job it is the SCOPED client for that job's organization, so the call carries
 * `x-motion-org` and `app.require_scope` / `app.audit` can check it (ADR-090). This file used to
 * keep one unscoped client of its own, which is why the organization scope never reached a single
 * `api_server.*` call even before the `set_config` fault: the scope was asserted on a different
 * client from the one making the requests (audit H1).
 *
 * Outside a job — a page, a route handler, a server action — there is no organization scope to
 * carry, and none is claimed. Those paths pass a human actor instead, which the function
 * re-validates against `app.has_permission_of`.
 */
function serverClient(): SupabaseClient {
  const scope = currentOrgScope();
  if (scope) return scopedServiceClient(scope);
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
      | 'funding.assess'
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

/** One tool call as `api_server.ai_persist_turn` records it (AI_ARCHITECTURE.md §4). */
export interface PersistedToolCall {
  readonly sequence: number;
  readonly tool_name: string;
  readonly input: Record<string, unknown>;
  readonly authorized: boolean;
  readonly denial_reason: string | null;
  readonly output_hash: string | null;
  readonly output_summary: Record<string, unknown> | null;
  readonly duration_ms: number | null;
  readonly error: string | null;
  /** Every evidence id this call returned — the only ids the bundle may cite (§14.2). */
  readonly returned_ids: readonly string[];
  /** Every descriptor hash (hex) this call returned. */
  readonly returned_hashes: readonly string[];
}

export interface PersistedBundleItem {
  readonly item_type: string;
  readonly ref_id: string | null;
  readonly ref_revision_no: number | null;
  readonly query_descriptor: unknown | null;
  readonly descriptor_hash: string | null;
  readonly label: string;
  readonly claim: string | null;
  readonly assurance_level: string;
}


/**
 * A conversation opened on a member's behalf by the server — the live evaluation job acting as its
 * requester (AI_ARCHITECTURE.md §12; ADR-081). Bound to `(org, actor)` like every turn after it.
 */
export async function createConversationAs(actor: ServerRpcActor, organizationId: string): Promise<string> {
  const { data, error } = await serverClient().schema('api_server').rpc('ai_create_conversation', {
    p_actor: actor.userId, p_org: organizationId,
  });
  if (error) throw toMotionError(error, actor.requestId);
  return data as string;
}

/**
 * Persists the USER half of a turn (AI_ARCHITECTURE.md §2 step 4; ADR-076). Charges the quota and
 * the 10/min throttle before any model call; throws `QuotaExceeded` when spent.
 */
export async function persistUserTurn(
  actor: ServerRpcActor,
  input: { organizationId: string; conversationId: string; message: string },
): Promise<{ messageId: string; quota: Record<string, number | null> }> {
  const { data, error } = await serverClient().schema('api_server').rpc('ai_persist_turn', {
    p_actor: actor.userId, p_org: input.organizationId, p_conversation: input.conversationId,
    p_user_message: input.message,
  });
  if (error) throw toMotionError(error, actor.requestId);
  const row = data as { message_id: string; quota: Record<string, number | null> };
  return { messageId: row.message_id, quota: row.quota };
}

/**
 * Persists the ASSISTANT half of a turn (§2 step 11): the message, every tool call and the
 * `ai_response` bundle, in one transaction. `grounding_status`, the tool-call log and the token
 * counts are facts the server observed, and this is the only path that writes them (R2-A-01).
 */
export async function persistAssistantTurn(
  actor: ServerRpcActor,
  input: {
    organizationId: string;
    conversationId: string;
    assistant: {
      structured_response: unknown | null;
      grounding_status: 'passed' | 'degraded' | 'failed' | 'not_applicable';
      grounding_report: unknown | null;
      period_context: unknown | null;
      prompt_version: string;
      model: string | null;
      input_tokens: number;
      output_tokens: number;
      latency_ms: number;
      title: string | null;
      context_changed?: boolean;
    };
    toolCalls: readonly PersistedToolCall[];
    bundle: { calculation_run_id: string | null; items: readonly PersistedBundleItem[] } | null;
  },
): Promise<{ messageId: string; evidenceBundleId: string | null }> {
  const { data, error } = await serverClient().schema('api_server').rpc('ai_persist_turn', {
    p_actor: actor.userId, p_org: input.organizationId, p_conversation: input.conversationId,
    p_assistant: input.assistant, p_tool_calls: input.toolCalls, p_bundle: input.bundle,
  });
  if (error) throw toMotionError(error, actor.requestId);
  const row = data as { message_id: string; evidence_bundle_id: string | null };
  return { messageId: row.message_id, evidenceBundleId: row.evidence_bundle_id ?? null };
}

/**
 * Ends every session of one user (SECURITY_MODEL.md §4; ADR-075).
 *
 * GoTrue has no admin endpoint that does this for another user, so it is done where a session
 * actually lives — `auth.sessions` and `auth.refresh_tokens` — by a service-only function. Access
 * never depended on it (RLS re-resolves per request); it is the defence against a long-lived tab.
 * Returns the number of sessions ended.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  return serverRpc<number>('revoke_user_sessions', { p_user: userId });
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

/**
 * Queue a recalculation for every organisation with figures from an older engine version (ADR-120):
 * `api_server.enqueue_engine_upgrade`, through the existing `app.enqueue_recalculation`. Idempotent
 * and resumable; returns how many organisations were queued (or re-found already queued).
 */
export async function enqueueEngineUpgrade(engineVersion: string): Promise<number> {
  return serverRpc<number>('enqueue_engine_upgrade', { p_engine_version: engineVersion });
}

/**
 * ADR-147: queue a full recalculation for every organisation whose Health Scores were all worked out
 * under another Health config (`api_server.enqueue_health_upgrade`). Idempotent and resumable.
 */
export async function enqueueHealthUpgrade(configVersion: string): Promise<number> {
  return serverRpc<number>('enqueue_health_upgrade', { p_config_version: configVersion });
}

/**
 * FU-6 (ADR-131): one `calculation.run` (trigger `scheduled`) per active organisation whose latest
 * succeeded run is dated before today in its own timezone. Idempotent per organisation and date.
 */
export async function enqueueScheduledRecalculation(): Promise<number> {
  return serverRpc<number>('enqueue_scheduled_recalculation', {});
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

/**
 * The banking pass (Phase 13, ADR-101): the calculation run's plan of rule categorisations,
 * transfer pairs and recurring groups, applied in one transaction. `runId` may be null — the pass
 * runs BEFORE the run row exists, so its writes are inside the fingerprint (ADR-047.8).
 */
export async function applyBankingPass(
  organizationId: string,
  runId: string | null,
  plan: Record<string, unknown>,
): Promise<Record<string, number>> {
  const counts = await serverRpc<Record<string, number>>('apply_banking_pass', {
    p_org: organizationId,
    p_run: runId,
    p_plan: plan,
  });
  return counts ?? {};
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

/**
 * Writes one forecast run, its figures and its evidence bundle in one transaction (ADR-099).
 *
 * `api_server` and not `api`: a forecast is a fact the SERVER observed about the engine's own
 * output, in the same sense a health score is, and `authenticated` holds no write privilege on the
 * tables in any case. The actor is passed explicitly and re-validated in SQL against
 * `dashboard.view` for the organisation, so a server call cannot forecast for somebody who may not
 * see the figures it is made of.
 */
export async function finishForecast(input: {
  actor: string;
  organizationId: string;
  run: Record<string, unknown>;
  values: ReadonlyArray<Record<string, unknown>>;
}): Promise<string> {
  return serverRpc<string>('finish_forecast', {
    p_actor: input.actor,
    p_org: input.organizationId,
    p_input: input.run,
    p_values: input.values,
  });
}

/**
 * A what-if scenario, written whole with its evidence (Phase 12, ADR-100).
 *
 * The assumptions are the user's intent, but the FIGURES are what the deterministic engine worked
 * out — a server-observed fact, in exactly the sense a grounded AI answer is one. `api.*` is
 * granted to `authenticated`, so a browser that could reach a scenario-writing `api.*` function
 * could publish any number it liked under MOTION's name; this goes through `api_server`, and the
 * human actor is re-validated in SQL against `intelligence.recompute`.
 */
export async function finishScenario(input: {
  actor: string;
  organizationId: string;
  run: Record<string, unknown>;
  values: ReadonlyArray<Record<string, unknown>>;
}): Promise<string> {
  return serverRpc<string>('finish_scenario', {
    p_actor: input.actor,
    p_org: input.organizationId,
    p_input: input.run,
    p_values: input.values,
  });
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
/**
 * A set-returning `api_server` read, in full.
 *
 * PostgREST's `max_rows` (1,000) applies to a FUNCTION's result exactly as to a table's, and
 * truncates silently: `aggregate_periods` over an organisation with 1,200 customers returned 1,000
 * cells and the engine computed revenue from the ones it was handed (ADR-120 hardening). So every
 * set-returning server read pages, ordered on its full grouping key so pages never overlap or skip.
 * Each page re-evaluates the function at the same arguments — the aggregation instant is one of
 * them — so the pages are one consistent result.
 */
const RPC_PAGE = 1000;

async function serverRpcAll(
  fn: string, args: Record<string, unknown>, orderBy: readonly string[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += RPC_PAGE) {
    let query = serverClient().schema('api_server').rpc(fn, args);
    for (const column of orderBy) query = query.order(column, { ascending: true, nullsFirst: true });
    const { data, error } = await query.range(from, from + RPC_PAGE - 1);
    if (error) throw toMotionError(error);
    const page = (data ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < RPC_PAGE) return out;
  }
}

/** The grouping key of `app.aggregate_periods`, then its sums, so the order is total. */
const AGGREGATE_ORDER = [
  'period_id', 'source', 'standard_category', 'account_id', 'counterparty_id', 'bank_account_id',
  'balance_kind', 'balance_basis', 'invoice_type', 'transfer_kind', 'unpaired_transfer',
  'debit', 'credit', 'amount', 'row_count',
] as const;

export async function aggregatePeriods(
  orgId: string, from: string, to: string, aggregatedAt: string,
): Promise<Record<string, unknown>[]> {
  return serverRpcAll('aggregate_periods', {
    p_org: orgId, p_from: from, p_to: to, p_aggregated_at: aggregatedAt,
  }, AGGREGATE_ORDER);
}

export async function aggregateTransferLegs(
  orgId: string, from: string, to: string, aggregatedAt: string,
): Promise<Record<string, unknown>[]> {
  return serverRpcAll('aggregate_transfer_legs', {
    p_org: orgId, p_from: from, p_to: to, p_aggregated_at: aggregatedAt,
  }, ['period_id', 'bank_account_id', 'transfer_kind', 'inflow', 'outflow', 'row_count']);
}

/**
 * One account-day at a time: every accepted, current row of every bank account, summed per day up
 * to `to`, visible at `aggregatedAt` (ADR-124 D-1). The per-account cash history reads it to move a
 * printed balance on from the day it was stated.
 */
export async function bankDailyMovements(
  orgId: string, to: string, aggregatedAt: string,
): Promise<Record<string, unknown>[]> {
  return serverRpcAll('bank_daily_movements', { p_org: orgId, p_to: to, p_aggregated_at: aggregatedAt },
    ['bank_account_id', 'transaction_date']);
}

export async function batchCoverage(
  orgId: string, from: string, to: string,
): Promise<Record<string, unknown>[]> {
  // Ordered newest-committed first, as the function itself orders, with the id as the tie-break.
  return serverRpcAll('batch_coverage', { p_org: orgId, p_from: from, p_to: to }, ['batch_id'])
    .then((rows) => [...rows].sort((a, b) =>
      String(b.committed_at).localeCompare(String(a.committed_at))
      || String(a.batch_id).localeCompare(String(b.batch_id))));
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
  actor: ServerRpcActor, orgId: string, batchId: string, stage: string, message: string, deferred = false,
): Promise<void> {
  await serverRpc('fail_import_batch', {
    p_actor: actor.userId, p_org: orgId, p_batch: batchId,
    p_stage: stage, p_message: message, p_deferred: deferred,
  });
}

// ---------------------------------------------------------------------------
// Claude-assisted PDF extraction (IMPORT_ENGINE.md §5.4; ADR-084). The job's three writes.
// ---------------------------------------------------------------------------

export async function beginExtraction(
  actor: ServerRpcActor, organizationId: string,
  input: { batchId: string; documentId: string; pagesTotal: number },
): Promise<void> {
  await serverRpc('begin_extraction', {
    p_actor: actor.userId, p_org: organizationId, p_batch: input.batchId, p_document: input.documentId,
    p_pages_total: input.pagesTotal,
  });
}

/** ADR-150: a Receipts batch waiting to be read becomes AI-read; the reviewer's expense account is kept. */
export async function beginReceiptExtraction(
  actor: ServerRpcActor, organizationId: string,
  input: { batchId: string; documentId: string; pagesTotal: number; accountId: string },
): Promise<void> {
  await serverRpc('begin_receipt_extraction', {
    p_actor: actor.userId, p_org: organizationId, p_batch: input.batchId, p_document: input.documentId,
    p_pages_total: input.pagesTotal, p_account: input.accountId,
  });
}

/** BEFORE every model call: the flag, the daily page budget and the monthly ceiling (R2-C-11). */
export async function chargeExtractionPage(actor: ServerRpcActor, organizationId: string, documentId: string): Promise<void> {
  await serverRpc('charge_extraction_page', { p_actor: actor.userId, p_org: organizationId, p_document: documentId });
}

export async function recordExtractionPage(
  actor: ServerRpcActor, organizationId: string,
  input: {
    batchId: string; page: number; outcome: 'extracted' | 'failed' | 'deferred';
    tokensIn?: number; tokensOut?: number; confidence?: string | null; lineCount?: number | null; error?: string | null;
    balancesRead?: { opening?: string; closing?: string } | null;
  },
): Promise<void> {
  await serverRpc('record_extraction_page', {
    p_actor: actor.userId, p_org: organizationId, p_batch: input.batchId, p_page: input.page, p_outcome: input.outcome,
    p_tokens_in: input.tokensIn ?? 0, p_tokens_out: input.tokensOut ?? 0, p_confidence: input.confidence ?? null,
    p_line_count: input.lineCount ?? null, p_error: input.error ?? null, p_balances_read: input.balancesRead ?? null,
  });
}

// ---------------------------------------------------------------------------------------------
// Phase 15 — the adviser analyst's turn record (ADR-113)
// ---------------------------------------------------------------------------------------------

/**
 * Opens a portfolio turn BEFORE the model is called: the database re-checks that the actor
 * advises every organisation in scope and charges the 10/min throttle. `PermissionDenied` for a
 * scope the actor may not advise, whatever the server asked for.
 */
export async function beginPortfolioTurn(
  actor: ServerRpcActor,
  input: { question: string; scopeOrganizationIds: readonly string[]; promptVersion: string },
): Promise<string> {
  const { data, error } = await serverClient().schema('api_server').rpc('portfolio_ai_begin_turn', {
    p_actor: actor.userId, p_question: input.question, p_scope: [...input.scopeOrganizationIds],
    p_prompt_version: input.promptVersion,
  });
  if (error) throw toMotionError(error, actor.requestId);
  return data as string;
}

/** Records what the server observed of the turn: the validated answer (or none), grounding, tokens. */
export async function finishPortfolioTurn(
  actor: ServerRpcActor,
  input: {
    turnId: string; answer: unknown | null; grounding: 'passed' | 'degraded' | 'failed' | 'not_applicable';
    model: string | null; inputTokens: number; outputTokens: number;
  },
): Promise<void> {
  const { error } = await serverClient().schema('api_server').rpc('portfolio_ai_finish_turn', {
    p_actor: actor.userId, p_turn: input.turnId, p_answer: input.answer, p_grounding: input.grounding,
    p_model: input.model, p_tokens_in: input.inputTokens, p_tokens_out: input.outputTokens,
  });
  if (error) throw toMotionError(error, actor.requestId);
}

/**
 * Phase 17: stores what a composed report said (`public.reports`, append-only). Server-asserted and
 * scoped — the job and the Custom AI Report's server action are the only callers.
 */
export async function recordReport(
  actor: ServerRpcActor | null,
  input: {
    organizationId: string;
    kind: 'daily_brief' | 'weekly_intelligence' | 'adviser' | 'custom_ai' | 'funding_readiness';
    windowStart: string;
    windowEnd: string;
    periodId: string | null;
    jobId: string | null;
    origin: 'scheduled' | 'requested';
    content: unknown;
    contentVersion: string;
  },
): Promise<string> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('record_report', {
      p_actor: actor?.userId ?? null,
      p_org: input.organizationId,
      p_kind: input.kind,
      p_window_start: input.windowStart,
      p_window_end: input.windowEnd,
      p_period: input.periodId,
      p_job: input.jobId,
      p_origin: input.origin,
      p_content: input.content,
      p_content_version: input.contentVersion,
    });
  if (error) throw toMotionError(error, actor?.requestId);
  return data as string;
}

/** Phase 17: records the PDF of a stored report; the path is derived by the database. */
export async function recordReportPdf(
  actor: ServerRpcActor | null,
  input: {
    organizationId: string;
    reportId: string;
    jobId: string | null;
    fileId: string;
    sha256: Uint8Array;
    byteSize: number;
  },
): Promise<string> {
  const { data, error } = await serverClient()
    .schema('api_server')
    .rpc('record_report_pdf', {
      p_actor: actor?.userId ?? null,
      p_org: input.organizationId,
      p_report: input.reportId,
      p_job: input.jobId,
      p_file: input.fileId,
      p_sha256: `\\x${Buffer.from(input.sha256).toString('hex')}`,
      p_bytes: input.byteSize,
    });
  if (error) throw toMotionError(error, actor?.requestId);
  return data as string;
}

/** Phase 17: the hourly sweep that queues yesterday's brief and, on Mondays, last week's report. */
export async function enqueueScheduledReports(): Promise<number> {
  return serverRpc<number>('enqueue_scheduled_reports', {});
}

/** Phase 16 (ADR-145): writes Funding Readiness assessments (refused while the flag is off). */
export async function finishFunding(organizationId: string, assessments: unknown[], trigger: string): Promise<number> {
  return serverRpc<number>('finish_funding', { p_org: organizationId, p_assessments: assessments, p_trigger: trigger });
}

/** Phase 16 (ADR-145): the nightly backstop for enabled organisations whose latest month is unassessed. */
export async function enqueueFundingBackstop(): Promise<number> {
  return serverRpc<number>('enqueue_funding_backstop', {});
}
