import 'server-only';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { globalRow, nowIso, ORG_SINGLETON_ID, orgCollection, orgRow, uniqueGuard } from '../schema';
import { readerOf, type Reader } from '../types';

/**
 * Marketing's helpers (ADR-170), ported from the `app` schema: whether the system is on
 * (`app.marketing_enabled`), whether the company profile can be written about
 * (`app.company_profile_ready`), the "one report in flight" key, and what the `marketing_job_ended`
 * trigger on `jobs` did.
 */

/** `app.marketing_enabled(org)`: on unless `features.module_marketing` says otherwise (ADR-158). */
export async function marketingEnabled(fs: Firestore, orgId: string, r: Reader = readerOf()): Promise<boolean> {
  const org = await r.get(globalRow(fs, 'organizations', orgId));
  if (!org.exists) return false;
  const features = (org.get('features') as Record<string, unknown> | undefined) ?? {};
  return !('module_marketing' in features) || features.module_marketing === true;
}

/** `app.company_profile_ready(org)`: the profile says what the company sells, or the org its industry. */
export async function companyProfileReady(fs: Firestore, orgId: string, r: Reader = readerOf()): Promise<boolean> {
  const [profile, org] = await Promise.all([
    r.get(orgRow(fs, orgId, 'organization_profiles', ORG_SINGLETON_ID)),
    r.get(globalRow(fs, 'organizations', orgId)),
  ]);
  const filled = (v: unknown) => typeof v === 'string' && v.replace(/^ +| +$/g, '').length > 0;
  return (profile.exists && filled(profile.get('products_services'))) || (org.exists && filled(org.get('industry')));
}

/**
 * `marketing_reports_one_in_flight` (unique on organisation WHERE status in queued/running): a guard
 * with an empty key, held by the attempt under way and released whenever it leaves those two states.
 */
export function marketingInFlightGuard(fs: Firestore, orgId: string) {
  return uniqueGuard(fs, { orgId }, 'marketing_reports_one_in_flight', []);
}

export const REPORT_NOT_FINISHED = 'The report could not be finished. Refresh it to try again.';

/**
 * The `marketing_job_ended` trigger (`AFTER UPDATE OF status ON jobs` when a `marketing.generate`
 * job becomes succeeded / dead / cancelled): an attempt still queued or running behind a job that
 * has ended can never finish, so it is marked failed and gives up the slot.
 *
 * For Teams E and P (`finish_job`, `cancel_job`, the stale-job reclaim): call it with the job's
 * reads, before any write, when such a job reaches one of those states.
 */
export async function prepareMarketingJobEnded(
  fs: Firestore, orgId: string | null, jobId: string, tx: Transaction,
): Promise<{ write(tx: Transaction): void }> {
  if (!orgId) return { write() {} };
  const open = await tx.get(orgCollection(fs, orgId, 'marketing_reports').where('job_id', '==', jobId));
  const stuck = open.docs.filter((d) => d.get('status') === 'queued' || d.get('status') === 'running');
  const guard = stuck.length > 0 ? await marketingInFlightGuard(fs, orgId).read(tx) : null;
  return {
    write(t) {
      const now = nowIso();
      for (const d of stuck) {
        t.update(d.ref, { status: 'failed', failure: REPORT_NOT_FINISHED, finished_at: now, updated_at: now });
        if (guard && guard.owner === d.id) guard.release(t);
      }
    },
  };
}
