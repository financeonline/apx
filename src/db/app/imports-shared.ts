import 'server-only';
import type { Firestore } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { uidOf, type Db } from '../types';
import { auditStampOf, triggerStamp } from './imports-records';
import { computeCommit, type CommitResultRow, type ImportCtx } from './imports-commit';
import { runImportOperation } from './imports-exec';
import type { Data } from './imports-ws';

/**
 * What the import area's `api.*` and `api_server.*` files share: finding an organisation from a
 * batch or document id, the enum checks the SQL casts made, and the commit entry point both the
 * reviewer's commit and the queued large commit use.
 */

/**
 * `select b.organization_id from public.import_batches b where b.id = p_batch`: the functions take
 * a bare batch id, so the organisation is found with a collection-group query on the row's `id`
 * (it needs the single-field `id` index with collection-group scope in production). Null when there
 * is no such batch; the caller then raises NotFound before anything else is said.
 */
export async function orgOfRow(
  fs: Firestore, table: 'import_batches' | 'source_documents', id: string | null,
  keep: (d: Data) => boolean = () => true,
): Promise<{ orgId: string; row: Data } | null> {
  if (!id) return null;
  const snap = await fs.collectionGroup(table).where('id', '==', id).limit(2).get();
  for (const d of snap.docs) {
    const row = d.data();
    const orgId = d.ref.parent.parent?.id;
    if (orgId && row.organization_id === orgId && keep(row)) return { orgId, row };
  }
  return null;
}

export const IMPORT_TYPES = ['general_ledger', 'trial_balance', 'pnl_report', 'balance_sheet', 'bank_statement',
  'sales_invoices', 'purchase_invoices', 'sales_report', 'purchase_report', 'receipts', 'budget'] as const;
/** `api.start_import_batch`'s CASE: the table an import type's rows are committed into. */
export function importTargetOf(importType: (typeof IMPORT_TYPES)[number]): string {
  switch (importType) {
    case 'general_ledger': case 'receipts': return 'ledger_entries';
    case 'trial_balance': case 'pnl_report': case 'balance_sheet': return 'period_balances';
    case 'bank_statement': return 'bank_transactions';
    case 'budget': return 'budget_lines';
    default: return 'invoices';
  }
}
export const EXTRACTION_METHODS = ['csv', 'xlsx', 'pdf_text', 'pdf_claude', 'manual', 'ocr'] as const;
export const DOCUMENT_KINDS = ['bank_statement', 'general_ledger', 'trial_balance', 'pnl_report', 'balance_sheet',
  'sales_report', 'purchase_report', 'invoice', 'receipt', 'other', 'unknown', 'budget'] as const;
export const BATCH_STATUSES = ['created', 'parsing', 'mapping', 'validating', 'awaiting_review', 'committing',
  'committed', 'rolled_back', 'rejected', 'failed'] as const;
export const ROW_STATUSES = ['pending', 'valid', 'warning', 'error', 'duplicate', 'skipped', 'committed', 'rejected'] as const;
export const REVIEWER_DECISIONS = ['none', 'keep', 'skip'] as const;
export const BALANCE_BASES = ['cumulative', 'movement'] as const;
export const BALANCE_SIGNS = ['natural', 'reporting'] as const;
export const INVOICE_LIST_KINDS = ['full', 'open_items'] as const;

/** The SQL cast of a text to an enum: the value, or a refusal naming the enum. */
export function enumOf<T extends string>(values: readonly T[], value: unknown, enumName: string): T {
  const v = String(value);
  if (!(values as readonly string[]).includes(v)) raise.invalid(`invalid input value for enum ${enumName}: "${v}"`);
  return v as T;
}

/** The same, for a nullable column: null stays null. */
export function enumOrNull<T extends string>(values: readonly T[], value: unknown, enumName: string): T | null {
  return value === null || value === undefined ? null : enumOf(values, value, enumName);
}

/** `app.import_batch_in_review`: the statuses in which a batch is still being prepared. */
export function importBatchInReview(status: unknown): boolean {
  return ['created', 'parsing', 'mapping', 'validating', 'awaiting_review', 'failed'].includes(String(status));
}

/** The context every commit and rollback runs with: who acts, and how its audit rows name them. */
export async function importCtx(db: Db, orgId: string, actorId: string | null, requestId: string | null = null): Promise<ImportCtx> {
  const stamp = await auditStampOf(db, actorId, requestId);
  return { db, orgId, actorId, uid: uidOf(db), stamp, rowStamp: triggerStamp(db, stamp) };
}

/** `app.commit_import_batch(org, batch, actor)` through the executor (one transaction, or a plan). */
export async function commitImportBatch(db: Db, orgId: string, batchId: string, actorId: string | null): Promise<CommitResultRow> {
  const ctx = await importCtx(db, orgId, actorId);
  return runImportOperation(db, orgId, 'commit', batchId, (ws) => computeCommit(ws, ctx, batchId));
}

/** A hex string as `decode(x, 'hex')` accepts it, lower-cased; a malformed one is refused. */
export function hexOf(value: unknown, what = 'value'): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/^\\x/, '').toLowerCase();
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) raise.invalid(`invalid hexadecimal data for ${what}`);
  return s;
}
