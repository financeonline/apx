import type { DocumentData } from 'firebase-admin/firestore';
import { ensurePeriods, monthStart, normalizeName, periodId } from '@/db/app/shared';
import { globalCollection, globalRow, newId, nowIso, orgCollection, orgRow, type OrgTable } from '@/db/schema';
import { Decimal } from '@/core/money/decimal';
import { fs } from '../integration/setup';

/**
 * Engine-suite helpers on the Firestore emulator: a job written straight into the queue (what the
 * SQL fixtures' `insert into public.jobs` did), the figures a run left current, and bulk writers for
 * the suites that seed thousands of rows (ADR-120's row-cap fixture).
 */

/** A queued job with no idempotency key — the shape `insert into public.jobs (…)` produced. */
export async function seedJob(orgId: string | null, jobType: string, payload: Record<string, unknown>, options: {
  maxAttempts?: number; requestedBy?: string | null; idempotencyKey?: string | null; runAfter?: string;
} = {}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await globalRow(fs(), 'jobs', id).set({
    id, organization_id: orgId, job_type: jobType, idempotency_key: options.idempotencyKey ?? null, payload,
    requested_by: options.requestedBy ?? null, status: 'queued', attempts: 0, max_attempts: options.maxAttempts ?? 3,
    run_after: options.runAfter ?? now, locked_at: null, locked_by: null, last_error: null, result: null,
    finished_at: null, created_at: now, updated_at: now,
  });
  return id;
}

/** The organisation's newest job of a type (`order by created_at desc limit 1`), or null. */
export async function latestJob(orgId: string, jobType: string): Promise<DocumentData | null> {
  const snap = await globalCollection(fs(), 'jobs').where('organization_id', '==', orgId).where('job_type', '==', jobType).get();
  const rows = snap.docs.map((d) => d.data()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return rows[0] ?? null;
}

/** Every job of the organisation (newest first). */
export async function jobsOf(orgId: string): Promise<DocumentData[]> {
  const snap = await globalCollection(fs(), 'jobs').where('organization_id', '==', orgId).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Deletes the organisation's jobs (they live in the global `jobs` collection, outside `deleteOrg`). */
export async function deleteJobsOf(orgId: string): Promise<void> {
  const snap = await globalCollection(fs(), 'jobs').where('organization_id', '==', orgId).get();
  const writer = fs().bulkWriter();
  for (const d of snap.docs) {
    void writer.delete(d.ref);
    const key = d.get('idempotency_key') as string | null;
    if (key && d.get('status') === 'queued') {
      // The queued job's guard (`jobs_idempotency_queued`) is a global document too.
      const guards = await fs().collection('_unique').where('owner_id', '==', d.id).get();
      for (const g of guards.docs) void writer.delete(g.ref);
    }
  }
  await writer.close();
}

/** The current snapshot of one headline cell (`dimension_type = 'none'`), or null. */
export async function currentSnapshot(orgId: string, periodStart: string, metricKey: string): Promise<DocumentData | null> {
  const period = periodId(orgId, monthStart(periodStart));
  const pointers = await orgCollection(fs(), orgId, 'metric_current')
    .where('period_id', '==', period).where('metric_key', '==', metricKey).get();
  const pointer = pointers.docs.map((d) => d.data()).find((p) => p.dimension_type === 'none');
  if (!pointer) return null;
  const snap = await orgRow(fs(), orgId, 'metric_snapshots', String(pointer.snapshot_id)).get();
  return snap.exists ? snap.data()! : null;
}

/** A current headline value as money (two places), or null when there is none or it is NULL. */
export async function currentMoney(orgId: string, periodStart: string, metricKey: string): Promise<string | null> {
  const s = await currentSnapshot(orgId, periodStart, metricKey);
  return s?.value === null || s?.value === undefined ? null : new Decimal(String(s.value)).toFixed(2);
}

/** Writes many whole rows of one org table at once (BulkWriter); the rows carry their own `id`. */
export async function bulkWrite(orgId: string, table: OrgTable, rows: readonly Record<string, unknown>[]): Promise<void> {
  const writer = fs().bulkWriter();
  for (const row of rows) void writer.set(orgRow(fs(), orgId, table, String(row.id)), row);
  await writer.close();
}

/** A whole counterparty row (for `bulkWrite`). */
export function counterpartyRow(orgId: string, input: {
  name: string; kind?: string; defaultExpenseCategory?: string | null;
}): Record<string, unknown> {
  const now = nowIso();
  return {
    id: newId(), organization_id: orgId, name: input.name, normalized_name: normalizeName(input.name),
    kind: input.kind ?? 'customer', default_expense_category: input.defaultExpenseCategory ?? null, external_ref: null,
    email: null, notes: null, is_active: true, merged_into_id: null, created_at: now, updated_at: now,
  };
}

/** A whole accepted invoice row (for `bulkWrite`); its month must already have a fiscal period. */
export function invoiceRow(orgId: string, input: {
  type: string; counterpartyId: string; number: string; issue: string; due?: string | null;
  subtotal?: string | null; tax?: string | null; total: string; paid?: string; status?: string;
}): Record<string, unknown> {
  const now = nowIso();
  const money = (v: string | null | undefined) => (v === null || v === undefined ? null : new Decimal(v).toFixed(2));
  const total = money(input.total)!;
  const paid = money(input.paid ?? '0')!;
  return {
    id: newId(), organization_id: orgId, invoice_type: input.type, counterparty_id: input.counterpartyId,
    invoice_number: input.number, issue_date: input.issue, due_date: input.due ?? null,
    period_id: periodId(orgId, monthStart(input.issue)), subtotal: money(input.subtotal), tax_amount: money(input.tax),
    total_amount: total, amount_paid: paid, balance_due: new Decimal(total).minus(paid).toFixed(2), currency: 'GBP',
    status: input.status ?? 'open', paid_date: null, description: null, source_document_id: null, import_batch_id: null,
    import_row_id: null, source_ref: null, record_status: 'accepted', assurance_level: 'verified', dedupe_hash: null,
    duplicate_reviewed: false, superseded_by: null, superseded_at: null, promoted_from_batch_id: null,
    created_at: now, updated_at: now, rejected_reason: null,
  };
}

export { ensurePeriods };
