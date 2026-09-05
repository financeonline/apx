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
