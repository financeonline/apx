import 'server-only';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { globalRow, nowIso, ORG_SINGLETON_ID, orgCollection, orgRow, uniqueGuard } from '../schema';
import { readerOf, type Reader } from '../types';

/**
 * The Investment Pack's helpers (ADR-171), ported from the `app` schema: whether the system is on
 * (`app.investment_enabled`), the AI allowance it is held to (`app.effective_quota`,
 * `app.ai_tokens_used_this_month`, CD-24), the "one pack in flight" key, and what the
 * `investment_job_ended` trigger on `jobs` did.
 *
 * `effective_quota` and `ai_tokens_used_this_month` are also the AI analyst's and Marketing's
 * (Teams A and F); they are written here so Team R does not wait on them — the lead may move them
 * to `src/db/app/` and keep one copy.
 */

/** `app.investment_enabled(org)`: on unless `features.module_investment` says otherwise. */
export async function investmentEnabled(fs: Firestore, orgId: string, r: Reader = readerOf()): Promise<boolean> {
  const org = await r.get(globalRow(fs, 'organizations', orgId));
  if (!org.exists) return false;
  const features = (org.get('features') as Record<string, unknown> | undefined) ?? {};
  return !('module_investment' in features) || features.module_investment === true;
}

type QuotaKey = 'ai_quota_daily' | 'ai_token_ceiling_monthly' | 'ai_extraction_pages_per_day';

/** `app.effective_quota(org, key)`: the organisation's own setting, else the platform default, else null. */
export async function effectiveQuota(fs: Firestore, orgId: string, key: QuotaKey, r: Reader = readerOf()): Promise<number | null> {
  const own = await r.get(orgRow(fs, orgId, 'platform_org_settings', ORG_SINGLETON_ID));
  const ownLimit = own.exists ? own.get(key) : null;
  if (ownLimit !== null && ownLimit !== undefined) return Number(ownLimit);
  const platform = await r.get(globalRow(fs, 'platform_settings', key));
  const limit = platform.exists ? platform.get('value') : null;
  if (limit === null || limit === undefined) return null;
  const n = Number(limit);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** The first instant of the current UTC month (`date_trunc('month', now() at time zone 'utc')`). */
function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/**
 * `app.ai_tokens_used_this_month(org)`: every token the organisation spent this UTC month — analyst
 * answers, document reading, and every Marketing and Investment attempt in the month it finished.
 */
export async function aiTokensUsedThisMonth(fs: Firestore, orgId: string, r: Reader = readerOf()): Promise<number> {
  const since = monthStartIso();
  const [messages, batches, marketing, investment] = await Promise.all([
    r.query(orgCollection(fs, orgId, 'ai_messages').where('created_at', '>=', since)),
    r.query(orgCollection(fs, orgId, 'import_batches').where('updated_at', '>=', since)),
    r.query(orgCollection(fs, orgId, 'marketing_reports').where('finished_at', '>=', since)),
    r.query(orgCollection(fs, orgId, 'investment_reports').where('finished_at', '>=', since)),
  ]);
  let total = 0;
  for (const d of messages.docs) total += n(d.get('input_tokens')) + n(d.get('output_tokens'));
  for (const d of batches.docs) {
    const stats = (d.get('extraction_stats') as Record<string, unknown> | null | undefined) ?? {};
    total += n(stats.tokens_in) + n(stats.tokens_out);
  }
  for (const d of [...marketing.docs, ...investment.docs]) total += n(d.get('input_tokens')) + n(d.get('output_tokens'));
  return total;
}

/**
 * `investment_reports_one_in_flight` (unique on organisation WHERE status in queued/running): a guard
 * held by the attempt under way, released whenever it leaves those two states.
 */
export function inFlightGuard(fs: Firestore, orgId: string) {
  return uniqueGuard(fs, { orgId }, 'investment_reports_one_in_flight', []);
}

export const PACK_NOT_FINISHED = 'The pack could not be finished. Refresh it to try again.';

/**
 * The `investment_job_ended` trigger (`AFTER UPDATE OF status ON jobs` when an `investment.generate`
 * job becomes succeeded / dead / failed): an attempt still queued or running behind a job that has
 * ended can never finish, so it is marked failed and gives up the slot.
 *
 * For Team E's `finish_job` / `cancel_job` / reclaim: call it with the job's reads, before any write.
 */
export async function prepareInvestmentJobEnded(
  fs: Firestore, orgId: string | null, jobId: string, tx: Transaction,
): Promise<{ write(tx: Transaction): void }> {
  if (!orgId) return { write() {} };
  const open = await tx.get(orgCollection(fs, orgId, 'investment_reports').where('job_id', '==', jobId));
  const stuck = open.docs.filter((d) => d.get('status') === 'queued' || d.get('status') === 'running');
  const guard = stuck.length > 0 ? await inFlightGuard(fs, orgId).read(tx) : null;
  return {
    write(t) {
      const now = nowIso();
      for (const d of stuck) {
        t.update(d.ref, { status: 'failed', failure: PACK_NOT_FINISHED, finished_at: now, updated_at: now });
        if (guard && guard.owner === d.id) guard.release(t);
      }
    },
  };
}
