import 'server-only';
import type { DocumentData, DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { newId, nowIso, orgCollection, orgRow } from '../schema';
import { readerOf, type Reader } from '../types';
import {
  checkViolation, enumValue, hexValue, nonEmpty, sameOrgRefTarget, textOf,
} from './actions-helpers';

/**
 * Evidence bundles written by the Actions and Alerts functions (EVIDENCE_MODEL.md §8.1): the alert
 * bundle `api_server.persist_alerts` builds for every revision (`app.build_alert_bundle`) and the
 * copy an action takes of its alert's or answer's bundle (`app.clone_bundle_for_action`).
 *
 * Bundles and items are append-only (the old `append_only_guard` trigger): nothing here, or anywhere,
 * updates or deletes one. Each helper follows the transaction rule (FIRESTORE_DATA_MODEL.md §7):
 * `prepare*` does every read; `write(tx)` only writes.
 */

const ITEM_TYPES = [
  'metric_snapshot', 'calculation_run', 'ledger_entry', 'bank_transaction', 'invoice', 'period_balance',
  'counterparty', 'account', 'source_document', 'fiscal_period', 'alert', 'query',
] as const;
const ASSURANCE = ['verified', 'calculated', 'estimated', 'inferred'] as const;

/** `same_org_ref_item` on evidence_items: what `ref_id` names, by `item_type`. */
const ITEM_REF: Readonly<Record<string, string>> = {
  metric_snapshot: 'metric_snapshots', calculation_run: 'calculation_runs', ledger_entry: 'ledger_entries',
  bank_transaction: 'bank_transactions', invoice: 'invoices', period_balance: 'period_balances',
  counterparty: 'counterparties', account: 'accounts', source_document: 'source_documents',
  fiscal_period: 'fiscal_periods', alert: 'alerts', query: '-',
};

export interface PreparedBundle {
  /** The new bundle's id, or null when there was nothing to copy. */
  readonly id: string | null;
  write(tx: Transaction): void;
}

/** The evidence_items CHECK constraints, in the order PostgreSQL would report them. */
function checkItem(row: DocumentData): void {
  if ((row.ref_id !== null) === (row.query_descriptor !== null)) checkViolation('evidence_items', 'evidence_item_xor');
  if (row.query_descriptor !== null && row.descriptor_hash === null) checkViolation('evidence_items', 'evidence_items_query_needs_hash');
  if (row.ref_revision_no !== null && row.item_type !== 'alert') checkViolation('evidence_items', 'evidence_items_revision_only_for_alerts');
  if ((row.item_type === 'query') !== (row.query_descriptor !== null)) checkViolation('evidence_items', 'evidence_items_query_is_descriptor');
}

/**
 * `app.build_alert_bundle(org, run, alert, evidence)`: a system bundle for one alert revision, with
 * the planner's items in order. The descriptor hash was computed in TypeScript through the one
 * RFC 8785 implementation (EVIDENCE_MODEL.md §3) and is stored as given (lowercase hex).
 *
 * Reads: each item's referenced row (`same_org_ref_item`), so a bundle never cites a row that is
 * not in this organisation.
 */
export async function prepareAlertBundle(
  fs: Firestore, orgId: string, runId: string, alertId: string, evidence: unknown, r: Reader,
): Promise<PreparedBundle> {
  const id = newId();
  const now = nowIso();
  const list = Array.isArray(evidence) ? (evidence as Record<string, unknown>[]) : [];
  const items: DocumentData[] = [];
  const refs: DocumentReference[] = [];
  list.forEach((item, sort) => {
    const descriptor = item.query_descriptor === undefined || item.query_descriptor === null ? null : item.query_descriptor;
    const row = {
      id: newId(), organization_id: orgId, bundle_id: id, sort_order: sort,
      item_type: enumValue(ITEM_TYPES, item.item_type, 'evidence_item_enum'),
      ref_id: nonEmpty(textOf(item, 'ref_id')),
      ref_revision_no: null,
      query_descriptor: descriptor as unknown,
      descriptor_hash: hexValue(textOf(item, 'descriptor_hash')),
      label: textOf(item, 'label'),
      claim: nonEmpty(textOf(item, 'claim')),
      assurance_level: enumValue(ASSURANCE, item.assurance_level, 'assurance_level_enum'),
      created_at: now,
    };
    if (row.label === null) raise.invalid('null value in column "label" of relation "evidence_items" violates not-null constraint');
    checkItem(row);
    const ref = sameOrgRefTarget(fs, orgId, { table: 'evidence_items', idCol: 'ref_id', discCol: 'item_type' },
      ITEM_REF, row.item_type, row.ref_id);
    if (ref && !(row.item_type === 'alert' && row.ref_id === alertId)) refs.push(ref);
    items.push(row);
  });
  for (const ref of refs) {
    if (!(await r.get(ref)).exists) raise.invalid('evidence_items.ref_id references a row that does not exist');
  }
  return {
    id,
    write(tx) {
      tx.set(orgRow(fs, orgId, 'evidence_bundles', id), {
        id, organization_id: orgId, kind: 'alert', origin_table: 'alerts', origin_id: alertId,
        calculation_run_id: runId, created_by_type: 'system', created_by: null, origin_message_id: null,
        created_at: now,
      });
      for (const item of items) tx.set(orgRow(fs, orgId, 'evidence_items', String(item.id)), item);
    },
  };
}

/**
 * `app.clone_bundle_for_action(org, source, action)`: the action's own bundle, a COPY of the source
 * bundle's items (§8.1) — a bundle is immutable, so the copy can never drift from what the reader saw,
 * and the source stays the evidence of the alert or the answer. A missing source is NOT_FOUND; no
 * source (null) means no bundle.
 */
export async function prepareCloneBundleForAction(
  fs: Firestore, orgId: string, sourceId: string | null, actionId: string, actorId: string | null,
  tx?: Transaction,
): Promise<PreparedBundle> {
  if (!sourceId) return { id: null, write() {} };
  const r = readerOf(tx);
  const source = await r.get(orgRow(fs, orgId, 'evidence_bundles', sourceId));
  if (!source.exists) raise.notFound();
  const b = source.data()!;
  const items = await r.query(orgCollection(fs, orgId, 'evidence_items').where('bundle_id', '==', sourceId));
  const id = newId();
  const now = nowIso();
  return {
    id,
    write(t) {
      t.set(orgRow(fs, orgId, 'evidence_bundles', id), {
        id, organization_id: orgId, kind: 'action', origin_table: 'actions', origin_id: actionId,
        calculation_run_id: b.calculation_run_id ?? null,
        origin_message_id: (b.kind === 'ai_response' ? b.origin_id : b.origin_message_id) ?? null,
        created_by_type: 'user', created_by: actorId, created_at: now,
      });
      for (const doc of items.docs) {
        const i = doc.data();
        const itemId = newId();
        t.set(orgRow(fs, orgId, 'evidence_items', itemId), {
          id: itemId, organization_id: orgId, bundle_id: id, sort_order: i.sort_order ?? 0,
          item_type: i.item_type, ref_id: i.ref_id ?? null, ref_revision_no: i.ref_revision_no ?? null,
          query_descriptor: i.query_descriptor ?? null, descriptor_hash: i.descriptor_hash ?? null,
          label: i.label, claim: i.claim ?? null, assurance_level: i.assurance_level, created_at: now,
        });
      }
    },
  };
}
