import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { createConversationAs } from '@/core/db';
import { log } from '@/core/logging';
import { runLiveSuite, shortfalls, type ModelTransport } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `ai.eval` (AI_ARCHITECTURE.md §12; TEST_STRATEGY.md §10.3; ADR-081).
 *
 * The nightly live run: the golden questions asked for real against the job's organisation, AS the
 * person who requested the job. The job is server-enqueued only (`api.enqueue_job` refuses it for
 * every non-service caller, ADR-043.3); its result carries the metrics and every verdict, which is
 * what `/platform/jobs` shows and what CI reads. A run below the §10.3 targets fails the job so the
 * night is red — it is enqueued with one attempt, because a retry would only spend the allowance
 * again on the same model.
 *
 * The acting context is built from the requester's membership, re-read before every tool call, so
 * the loop's F-C-17 rule holds here exactly as it does for a browser turn.
 */

/** The one seam a test uses: the model transport. Production leaves it unset and gets the live one. */
export const evalDeps: { transport: ModelTransport | undefined } = { transport: undefined };

async function contextFor(db: SupabaseClient, orgId: string, userId: string, requestId: string): Promise<AccessContext | null> {
  const { data, error } = await db
    .from('organization_memberships')
    .select('role, status')
    .eq('organization_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.status !== 'active') return null;
  const role = data.role as EffectiveRole;
  return {
    userId, orgId, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db, requestId, now: () => new Date(), organizationStatus: 'active',
  };
}

export async function runAiEvalJob(job: ClaimedJob, scope: { db: unknown }): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) return { status: 'failed', error: 'ai.eval has no organization to ask about' };
  if (job.requestedBy === null) return { status: 'failed', error: 'ai.eval acts as the person who requested it, and nobody did' };

  const db = scope.db as SupabaseClient;
  const ctx = await contextFor(db, orgId, job.requestedBy, job.jobId);
  if (ctx === null) return { status: 'failed', error: 'the requester is not an active member of this organisation' };

  const actor = { userId: job.requestedBy, requestId: job.jobId };
  const report = await runLiveSuite({
    ctx,
    createConversation: () => createConversationAs(actor, orgId),
    resolveAccess: async () => {
      const fresh = await contextFor(db, orgId, job.requestedBy!, job.jobId);
      if (fresh === null) throw new Error('the requester lost access during the run');
      return fresh;
    },
    ...(evalDeps.transport ? { transport: evalDeps.transport } : {}),
  });

  const counts = { golden: 0, adversarial: 0, trap: 0 };
  for (const r of report.results) counts[r.set] += 1;
  // The live set is the §10 questions, not the recorded corpus: its size is not what §12 sizes.
  const below = shortfalls(report.metrics, { golden: 40, adversarial: 40, trap: 30 });
  const result = {
    prompt_version: report.promptVersion, model: report.model, started_at: report.startedAt, duration_ms: report.durationMs,
    metrics: report.metrics, cases: report.results.map((r) => ({ id: r.id, ok: r.ok, outcome: r.outcome, mode: r.mode, tool_calls: r.toolCalls, failures: r.failures })),
    below_target: below,
  };
  log.info('ai.eval finished', { organizationId: orgId, cases: report.results.length, failures: report.metrics.failures, below });
  return below.length === 0
    ? { status: 'succeeded', result }
    : { status: 'failed', result, error: `below target: ${below.join('; ')}` };
}
