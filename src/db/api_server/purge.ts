import 'server-only';
import type { DocumentData, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import { globalCollection, globalRow, newId, nowIso, orgCollection, orgDoc, type OrgTable } from '../schema';
import { runTx } from '../tx';
import type { Db } from '../types';
import { audit } from '../app/audit';
import { releaseQueuedGuard } from '../app/jobs';
import { prepareRowAudit } from '../app/platform-row-audit';
import { requireScope } from '../app/scope';

/**
 * `api_server.purge_organization` — the row half of `org.purge` (TENANCY_MODEL.md §2 lifecycle;
 * ADR-038.9, ADR-067, ADR-090). The handler (`modules/jobs/handlers/org-purge.ts`) calls this
 * first and removes the Storage objects under `{orgId}/` second, so a cancellation between the two
 * finds the files still there.
 *
 * The steps and their order are the SQL function's:
 *
 *   1. refuse unless the server calls it scoped to this organisation; `already_deleted` on a retry;
 *      CONFLICT unless the organisation is `pending_deletion` and was so thirty days ago; `waiting`
 *      while any other job of the organisation is running;
 *   2. delete every tenant table, children before parents (the order is kept, though Firestore has
 *      no foreign keys to make it matter), counting the rows;
 *   3. delete every other job of the organisation (this one stays, so the worker can record it);
 *   4. the guard: any sub-collection of the organisation still holding a document is a table this
 *      order does not know — a loud CONFLICT, never a silent leftover;
 *   5. mark the organisation `deleted` (the row survives) and clear `profiles.last_active_org_id`;
 *   6. redact the audit trail (ADR-038.9): the events survive, what they carried does not;
 *   7. write `org.purged`, the one event about the organisation that keeps a payload — counts.
 *
 * What PostgreSQL did in ONE transaction is several steps here: a tenant can hold far more rows than
 * a Firestore transaction can. The verification (1) and the status change (5) are transactions; the
 * deletion between them is idempotent, so a purge that dies part-way is simply run again by the
 * worker, finds the organisation still `pending_deletion`, and deletes what is left — the counts in
 * that run's result are then that run's.
 *
 * The `audit_diff` trigger fired for every deleted row of an audited table, and the redaction then
 * stripped those events; they are written here already stripped (`db.<table>.delete`, no payload),
 * which is the state the SQL left them in, and they count among the redacted events.
 */

/** Children before parents, from the old FK graph — the SQL's `v_order`, unchanged. */
const ORDER: readonly OrgTable[] = [
  // `member_login_claims` was missing from the SQL list (its FK cascaded only from `organizations`,
  // which the purge keeps), so the guard would have refused an organisation holding one. It is first.
  'member_login_claims',
  'scenario_values', 'scenario_runs', 'forecast_values', 'forecast_runs',
  'invoice_lines', 'opportunities', 'campaign_spend', 'campaigns', 'marketing_channels', 'products',
  'report_completeness_attestations',
  'funding_current', 'funding_assessments',
  'marketing_reports', 'organization_profiles',
  'investment_reports',
  'member_permission_overrides', 'access_requests',
  'notifications', 'engagement_events', 'engagement_items', 'action_comments',
  'evidence_items', 'ai_feedback', 'ai_tool_calls', 'ai_messages', 'ai_conversations',
  'alert_revisions', 'alerts', 'actions', 'report_files', 'reports', 'evidence_bundles',
  'health_current', 'health_scores', 'metric_current', 'metric_snapshots',
  'category_history', 'account_category_history', 'record_status_events',
  'budget_lines', 'bank_transactions', 'recurring_payment_groups', 'ledger_entries', 'invoices',
  'period_balances', 'import_rows', 'calculation_runs', 'import_batches', 'import_mappings',
  'source_documents', 'counterparties', 'bank_accounts', 'accounts', 'fiscal_periods',
  'ownership_transfers', 'invitations', 'organization_assignments', 'organization_memberships',
  'platform_org_settings',
];

/** The org tables with the `audit_diff` trigger: each deleted row left a `db.<table>.delete` event. */
const AUDITED: ReadonlySet<OrgTable> = new Set<OrgTable>([
  'accounts', 'bank_accounts', 'bank_transactions', 'budget_lines', 'invitations', 'invoices',
  'ledger_entries', 'organization_assignments', 'organization_memberships', 'ownership_transfers',
  'period_balances', 'platform_org_settings',
]);

const PAGE = 500;

/** Walks a query page by page (document-id order), so no step holds a whole tenant in memory. */
async function eachPage(q: Query, fn: (docs: QueryDocumentSnapshot[]) => Promise<void>): Promise<void> {
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    const snap = await (cursor ? q.startAfter(cursor) : q).limit(PAGE).get();
    if (snap.empty) return;
    await fn(snap.docs);
    if (snap.size < PAGE) return;
    cursor = snap.docs[snap.docs.length - 1]!;
  }
}

/** The trigger's target: the row's `id`, else `user_id`, else `organization_id`. */
function targetOf(row: DocumentData): string | null {
  for (const k of ['id', 'user_id', 'organization_id']) {
    if (typeof row[k] === 'string' && row[k]) return row[k] as string;
  }
  return null;
}

async function purge_organization(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const org = arg.req(args, 'p_org');
  const job = arg.str(args, 'p_job');
  // ADR-090: this function only ever runs inside a job, and a job is always scoped.
  requireScope(db, org);
  const fs = db.fs;
  const orgRef = globalRow(fs, 'organizations', org);

  // 1. Re-verify, in one read-only transaction.
  const verdict = await runTx(db, async (tx) => {
    const snap = await tx.get(orgRef);
    if (!snap.exists) raise.notFound();
    const status = String(snap.get('status'));
    const requested = (snap.get('deletion_requested_at') as string | null) ?? null;
    // Idempotent: a retry after the rows went has nothing to re-verify and nothing to delete here.
    if (status === 'deleted') return { status: 'already_deleted' } as const;
    if (status !== 'pending_deletion' || requested === null) {
      raise.conflict(`${org} is not scheduled for deletion`);
    }
    if (new Date(requested).getTime() > Date.now() - 30 * 86_400_000) {
      raise.conflict(`${org} was scheduled for deletion less than 30 days ago (${requested})`);
    }
    // Waiting is not failing: the caller defers and comes back.
    const running = await tx.get(globalCollection(fs, 'jobs').where('organization_id', '==', org).where('status', '==', 'running'));
    const others = running.docs.filter((d) => d.id !== job).length;
    if (others > 0) return { status: 'waiting', running_jobs: others } as const;
    return { status: 'go' } as const;
  });
  if (verdict.status !== 'go') return verdict;

  // 2. Every tenant table, in order.
  const counts: Record<string, number> = {};
  const now = nowIso();
  for (const table of ORDER) {
    const coll = orgCollection(fs, org, table);
    const n = (await coll.count().get()).data().count;
    if (n === 0) continue;
    counts[table] = n;
    if (AUDITED.has(table)) {
      const writer = fs.bulkWriter();
      await eachPage(coll.select('id', 'user_id', 'organization_id'), async (docs) => {
        for (const d of docs) {
          const id = newId();
          void writer.set(globalRow(fs, 'audit_events', id), {
            id, organization_id: org, actor_user_id: null, actor_type: 'system', action: `db.${table}.delete`,
            target_table: table, target_id: targetOf(d.data()), before: null, after: null, metadata: {},
            ip: null, user_agent: null, request_id: newId(), created_at: now,
          });
        }
      });
      await writer.close();
    }
    await fs.recursiveDelete(coll);
  }
  // The unique-key guards go with the rows they guarded.
  await fs.recursiveDelete(orgDoc(fs, org).collection('_unique'));

  // 3. Every other job of the organisation; a queued one's idempotency key is released with it.
  let jobsDeleted = 0;
  const jobs = await globalCollection(fs, 'jobs').where('organization_id', '==', org).get();
  for (const d of jobs.docs) {
    if (d.id === job) continue;
    await fs.runTransaction(async (tx) => {
      if (d.get('status') === 'queued') {
        releaseQueuedGuard(fs, tx, { job_type: String(d.get('job_type')), idempotency_key: (d.get('idempotency_key') as string | null) ?? null });
      }
      tx.delete(d.ref);
    });
    jobsDeleted += 1;
  }
  if (jobsDeleted > 0) counts.jobs = jobsDeleted;

  // 4. The guard: what turns "a table was added and this list was not updated" into a loud failure.
  for (const sub of await orgDoc(fs, org).listCollections()) {
    if (sub.id === '_unique') continue;
    const left = (await sub.count().get()).data().count;
    if (left > 0) {
      raise.conflict(`purge left ${left} row(s) in ${sub.id}; the deletion order in api_server.purge_organization needs that table`);
    }
  }

  // 5. The organisation row survives, marked; nobody's last organisation points at it any more.
  await runTx(db, async (tx) => {
    const snap = await tx.get(orgRef);
    const people = await tx.get(globalCollection(fs, 'profiles').where('last_active_org_id', '==', org));
    const at = nowIso();
    const after = { ...snap.data()!, status: 'deleted', deleted_at: at, updated_at: at };
    const rowAudit = await prepareRowAudit(db, 'organizations', 'update', snap.data()!, after, tx);
    tx.set(orgRef, after);
    rowAudit.write(tx);
    for (const p of people.docs) tx.update(p.ref, { last_active_org_id: null, updated_at: at });
  });

  // 6. Redaction (ADR-038.9), after the status change so its own audit diff is redacted too.
  let redacted = 0;
  const writer = fs.bulkWriter();
  await eachPage(globalCollection(fs, 'audit_events').where('organization_id', '==', org), async (docs) => {
    for (const d of docs) {
      void writer.update(d.ref, { before: null, after: null, metadata: {}, ip: null, user_agent: null });
      redacted += 1;
    }
  });
  await writer.close();

  // 7. Written last: `after` holds counts, and nothing that was in the rows.
  await audit(db, {
    organizationId: org, action: 'org.purged', targetTable: 'organizations', targetId: org,
    after: { rows: counts, audit_events_redacted: redacted, job_id: job },
  });

  return { status: 'purged', rows: counts, audit_events_redacted: redacted };
}

/** `api_server.*` functions of this area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8). */
export const functions: DbFunctions = {
  purge_organization,
};
