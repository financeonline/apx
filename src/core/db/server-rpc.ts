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
