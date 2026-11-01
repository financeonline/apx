import 'server-only';
import { orgRowById, orgRows, readCtx } from '@/db/rls';
import { orgCollection, type OrgTable } from '@/db/schema';
import type { Db } from '@/db/types';
import type { Row } from './rows';

/**
 * Reads for the evidence tables themselves (EVIDENCE_MODEL.md §2).
 *
 * All of these run for the caller, through the ported row policies (`src/db/rls.ts`). That matters
 * most for `evidence_bundles`: the policy on that table already implements §8.9 — an `ai_response` bundle is readable only by the
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

/** One row by id with only `columns`, or null when it does not exist or the caller may not see it. */
async function one(
  db: Db,
  table: OrgTable,
  columns: string,
  orgId: string,
  id: string,
): Promise<Row | null> {
  const row = await orgRowById<Row>(db, orgId, table, id);
  if (row === null) return null;
  return project(row, columns);
}

function project(row: Row, columns: string): Row {
  return Object.fromEntries(columns.split(',').map((c) => [c, row[c] ?? null]));
}

const ITEM_COLUMNS =
  'id,organization_id,bundle_id,sort_order,item_type,ref_id,ref_revision_no,query_descriptor,descriptor_hash,label,claim,assurance_level';

export function fetchBundle(db: Db, orgId: string, bundleId: string): Promise<Row | null> {
  return one(
    db,
    'evidence_bundles',
    'id,organization_id,kind,origin_table,origin_id,calculation_run_id,created_by_type,created_by,created_at',
    orgId,
    bundleId,
  );
}

export async function fetchBundleItems(
  db: Db,
  orgId: string,
  bundleId: string,
): Promise<Row[]> {
  const rows = await orgRows<Row>(db, orgId, 'evidence_items', (q) => q.where('bundle_id', '==', bundleId));
  // sort_order then id: §2.2 calls items "ordered members", and id is the tiebreak that keeps two
  // items sharing a sort_order in a stable order between requests.
  rows.sort((a, b) => (Number(a.sort_order) - Number(b.sort_order))
    || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return rows.map((row) => project(row, ITEM_COLUMNS));
}

export function fetchEvidenceItem(
  db: Db,
  orgId: string,
  itemId: string,
): Promise<Row | null> {
  return one(db, 'evidence_items', ITEM_COLUMNS, orgId, itemId);
}

export function fetchCalculationRun(
  db: Db,
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

/**
 * `app.redact_metric_components`: the components a reader without the detail permission is shown —
 * no `*_id` / `*_ids` key, and only numbers, booleans, nulls, decimal strings and dates.
 */
export function redactMetricComponents(components: unknown): Record<string, unknown> {
  if (!components || typeof components !== 'object' || Array.isArray(components)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(components as Record<string, unknown>)) {
    if (/(^|_)ids?$/.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean'
      || (typeof value === 'string' && (/^-?[0-9]+(\.[0-9]+)?$/.test(value) || /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)))) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * One snapshot with its `components` and `evidence_query`.
 *
 * The two payload fields carry account and counterparty ids, bank account names and the record
 * descriptors behind a figure, so they are returned whole only to a reader the old definer view
 * `metric_snapshot_payloads` gave the detail to (ADR-172 hardening): `financials.view`, a
 * counterparty figure with `customers.view`, or — on a suspended organisation — the current figure
 * by the underlying role. Anyone else the snapshot policy admits gets the components redacted and no
 * `evidence_query`, exactly as the view returned them.
 */
export async function fetchMetricSnapshot(
  db: Db,
  orgId: string,
  snapshotId: string,
): Promise<Row | null> {
  const full = await orgRowById<Row>(db, orgId, 'metric_snapshots', snapshotId);
  if (full === null) return null;
  const row = project(
    full,
    'id,organization_id,calculation_run_id,period_id,metric_key,dimension_type,dimension_id,dimension_key,value,unit,currency,basis,assurance_level,data_quality',
  );
  const detail = await snapshotDetail(db, orgId, full);
  return {
    ...row,
    components: detail ? (full.components ?? {}) : redactMetricComponents(full.components),
    evidence_query: detail ? (full.evidence_query ?? null) : null,
  };
}

async function snapshotDetail(db: Db, orgId: string, snapshot: Row): Promise<boolean> {
  const c = await readCtx(db, orgId);
  if (!c) return false;
  const counterparty = snapshot.dimension_type === 'counterparty';
  if (await c.has('financials.view')) return true;
  if (counterparty && await c.has('customers.view')) return true;
  if (!(await c.frozenAny('financials.view')) && !(counterparty && await c.frozenAny('customers.view'))) return false;
  const current = await orgCollection(db.fs, orgId, 'metric_current')
    .where('snapshot_id', '==', String(snapshot.id)).limit(1).get();
  return !current.empty;
}

/**
 * A pinned record's lifecycle state.
 *
 * §8.3: superseded and rejected rows pinned by `ref_id` are still fetched — the resolver does not
 * filter pinned items by status — and the drawer shows the badge and the replacement link.
 */
export async function fetchPinnedLifecycle(
  db: Db,
  orgId: string,
  table: string,
  id: string,
): Promise<{ recordStatus: string | null; superseded: boolean | null }> {
  if (!LIFECYCLE_TABLES.has(table)) {
    // A run, an account, a counterparty or a period has no supersession lifecycle. `null` says
    // "this object cannot be superseded", which is not the same as "it is current".
    return { recordStatus: null, superseded: null };
  }
  const row = await one(db, table as OrgTable, 'id,organization_id,record_status,superseded_by', orgId, id);
  if (row === null) return { recordStatus: null, superseded: null };
  return {
    recordStatus: row.record_status === null || row.record_status === undefined ? null : String(row.record_status),
    superseded: row.superseded_by !== null && row.superseded_by !== undefined,
  };
}
