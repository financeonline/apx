import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { Row } from './rows';

/**
 * Reads for the evidence tables themselves (EVIDENCE_MODEL.md §2).
 *
 * All of these run under the caller's session. That matters most for `evidence_bundles`: the RLS
 * policy on that table already implements §8.9 — an `ai_response` bundle is readable only by the
 * origin message's owner or by an organization owner/admin — so this module must never reach for a
 * service client to "make the read work".
 */

/** §2.2: `item_type` is the discriminator a polymorphic `ref_id` resolves through (ADR-034). */
export const ITEM_TYPE_TABLE = {
  metric_snapshot: 'metric_snapshots',
  calculation_run: 'calculation_runs',
  ledger_entry: 'ledger_entries',
  bank_transaction: 'bank_transactions',
  invoice: 'invoices',
  period_balance: 'period_balances',
  counterparty: 'counterparties',
  account: 'accounts',
  source_document: 'source_documents',
  fiscal_period: 'fiscal_periods',
  alert: 'alerts',
} as const;

export type PinnedItemType = keyof typeof ITEM_TYPE_TABLE;
export type EvidenceItemType = PinnedItemType | 'query';

/** The four tables with a `record_status` / `superseded_by` lifecycle. */
export const LIFECYCLE_TABLES = new Set([
  'ledger_entries',
  'bank_transactions',
  'invoices',
  'period_balances',
]);

export function isPinnedItemType(value: string): value is PinnedItemType {
  return value in ITEM_TYPE_TABLE;
}

async function one(
  db: SupabaseClient,
  table: string,
  columns: string,
  orgId: string,
  id: string,
): Promise<Row | null> {
  const { data, error } = await db
    .from(table)
    .select(columns)
    .eq('organization_id', orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw toMotionError(error);
  return (data ?? null) as Row | null;
}

export function fetchBundle(db: SupabaseClient, orgId: string, bundleId: string): Promise<Row | null> {
  return one(
    db,
    'evidence_bundles',
    'id,organization_id,kind,origin_table,origin_id,calculation_run_id,created_by_type,created_by,created_at',
    orgId,
    bundleId,
  );
}

export async function fetchBundleItems(
  db: SupabaseClient,
  orgId: string,
  bundleId: string,
): Promise<Row[]> {
  const { data, error } = await db
    .from('evidence_items')
    .select(
      'id,organization_id,bundle_id,sort_order,item_type,ref_id,ref_revision_no,query_descriptor,descriptor_hash,label,claim,assurance_level',
    )
    .eq('organization_id', orgId)
    .eq('bundle_id', bundleId)
    // sort_order then id: §2.2 calls items "ordered members", and id is the tiebreak that keeps two
    // items sharing a sort_order in a stable order between requests.
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw toMotionError(error);
  return (data ?? []) as Row[];
}

export function fetchEvidenceItem(
  db: SupabaseClient,
  orgId: string,
  itemId: string,
): Promise<Row | null> {
  return one(
    db,
    'evidence_items',
    'id,organization_id,bundle_id,sort_order,item_type,ref_id,ref_revision_no,query_descriptor,descriptor_hash,label,claim,assurance_level',
    orgId,
    itemId,
  );
}

export function fetchCalculationRun(
  db: SupabaseClient,
  orgId: string,
  runId: string,
): Promise<Row | null> {
  return one(
    db,
    'calculation_runs',
    'id,organization_id,engine_version,as_of,as_of_ts,status,started_at,finished_at,chunks',
    orgId,
    runId,
  );
}

export function fetchMetricSnapshot(
  db: SupabaseClient,
  orgId: string,
  snapshotId: string,
): Promise<Row | null> {
  return one(
    db,
    'metric_snapshots',
    'id,organization_id,calculation_run_id,period_id,metric_key,dimension_type,dimension_id,value,unit,currency,basis,assurance_level,data_quality,components,evidence_query',
    orgId,
    snapshotId,
  );
}

/**
 * A pinned record's lifecycle state.
 *
 * §8.3: superseded and rejected rows pinned by `ref_id` are still fetched — the resolver does not
 * filter pinned items by status — and the drawer shows the badge and the replacement link.
 */
export async function fetchPinnedLifecycle(
  db: SupabaseClient,
  orgId: string,
  table: string,
  id: string,
): Promise<{ recordStatus: string | null; superseded: boolean | null }> {
  if (!LIFECYCLE_TABLES.has(table)) {
    // A run, an account, a counterparty or a period has no supersession lifecycle. `null` says
    // "this object cannot be superseded", which is not the same as "it is current".
    return { recordStatus: null, superseded: null };
  }
  const row = await one(db, table, 'id,organization_id,record_status,superseded_by', orgId, id);
  if (row === null) return { recordStatus: null, superseded: null };
  return {
    recordStatus: row.record_status === null || row.record_status === undefined ? null : String(row.record_status),
    superseded: row.superseded_by !== null && row.superseded_by !== undefined,
  };
}
