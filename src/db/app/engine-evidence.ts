import 'server-only';
import { Decimal } from '@/core/money/decimal';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { newId, nowIso, orgRow } from '../schema';

/**
 * The evidence rows the engine's own outputs write (EVIDENCE_MODEL.md §5): one `evidence_bundles`
 * row per Health score, forecast, scenario, Funding assessment or metric, and its ordered
 * `evidence_items`. Shared by the engine area's files so every bundle is the same whole row.
 *
 * Both tables are append-only (`append_only_guard`): nothing here updates or deletes, and the
 * engine area offers no function that would.
 */

export interface BundleInput {
  readonly orgId: string;
  readonly kind: string;
  readonly originTable: string;
  readonly originId: string | null;
  readonly calculationRunId: string | null;
  readonly createdBy: string | null;
  readonly createdByType?: string;
}

export interface ItemInput {
  readonly item_type: string;
  readonly ref_id?: string | null;
  readonly ref_revision_no?: number | null;
  readonly query_descriptor?: unknown;
  /** bytea as lowercase hex, no `\x` prefix. */
  readonly descriptor_hash?: string | null;
  readonly label: string;
  readonly claim?: string | null;
  readonly assurance_level: string;
}

/** Writes a bundle and its items (sort_order 0, 1, …); returns the bundle id. Writes only. */
export function writeBundle(tx: Transaction, fs: Firestore, bundle: BundleInput, items: readonly ItemInput[]): string {
  const id = newId();
  const now = nowIso();
  tx.set(orgRow(fs, bundle.orgId, 'evidence_bundles', id), {
    id, organization_id: bundle.orgId, kind: bundle.kind, origin_table: bundle.originTable,
    origin_id: bundle.originId, calculation_run_id: bundle.calculationRunId,
    created_by_type: bundle.createdByType ?? 'system', created_by: bundle.createdBy,
    created_at: now, origin_message_id: null,
  });
  items.forEach((item, sort) => {
    const itemId = newId();
    tx.set(orgRow(fs, bundle.orgId, 'evidence_items', itemId), {
      id: itemId, organization_id: bundle.orgId, bundle_id: id, sort_order: sort, item_type: item.item_type,
      ref_id: item.ref_id ?? null, ref_revision_no: item.ref_revision_no ?? null,
      query_descriptor: item.query_descriptor ?? null, descriptor_hash: item.descriptor_hash ?? null,
      label: item.label, claim: item.claim ?? null, assurance_level: item.assurance_level, created_at: now,
    });
  });
  return id;
}

/**
 * A `numeric(p, s)` value as the column would store it: a decimal string with exactly `scale`
 * places, rounded half away from zero as PostgreSQL rounds. Null stays null; '' is null (`nullif`).
 */
export function numericText(value: unknown, scale: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return new Decimal(String(value)).toFixed(scale, Decimal.ROUND_HALF_UP);
}

/** `nullif(x, '')::uuid` and friends: a text field of a jsonb payload, '' and absent as null. */
export function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s === '' ? null : s;
}

/** `(x ->> 'n')::smallint|integer`: a whole number, or null. */
export function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  // A count, not money: integer text only, rounded as the cast rounds `3.5` → 4.
  const text = String(value).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  return new Decimal(text).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * `writeBundle` with an id chosen beforehand — for a caller whose audit event (prepared with the
 * transaction's reads, before any write) has to name the bundle it is about to write.
 */
export function writeBundleAt(
  tx: Transaction, fs: Firestore, id: string, bundle: BundleInput, items: readonly ItemInput[],
): string {
  const now = nowIso();
  tx.set(orgRow(fs, bundle.orgId, 'evidence_bundles', id), {
    id, organization_id: bundle.orgId, kind: bundle.kind, origin_table: bundle.originTable,
    origin_id: bundle.originId, calculation_run_id: bundle.calculationRunId,
    created_by_type: bundle.createdByType ?? 'system', created_by: bundle.createdBy,
    created_at: now, origin_message_id: null,
  });
  items.forEach((item, sort) => {
    const itemId = newId();
    tx.set(orgRow(fs, bundle.orgId, 'evidence_items', itemId), {
      id: itemId, organization_id: bundle.orgId, bundle_id: id, sort_order: sort, item_type: item.item_type,
      ref_id: item.ref_id ?? null, ref_revision_no: item.ref_revision_no ?? null,
      query_descriptor: item.query_descriptor ?? null, descriptor_hash: item.descriptor_hash ?? null,
      label: item.label, claim: item.claim ?? null, assurance_level: item.assurance_level, created_at: now,
    });
  });
  return id;
}
