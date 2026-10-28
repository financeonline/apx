import { createHash } from 'node:crypto';
import type { DocumentData } from 'firebase-admin/firestore';
import { newId, nowIso, orgCollection, orgRow, uniqueGuard } from '@/db/schema';
import { fs } from './setup';

/**
 * Fixtures for the Imports, documents and storage suites (Team I), in the shapes
 * FIRESTORE_DATA_MODEL.md §3 gives: every column of `source_documents`, `import_batches` and
 * `import_rows` present with its PostgreSQL default, `bytea` as lowercase hex, dates `YYYY-MM-DD`.
 * Organisations, members, bank accounts and counterparties come from `f-fixtures.ts`.
 */

type Row = DocumentData;

let seq = 0;

/** A distinct sha256 (hex) per call, so `source_documents_sha_unique` never collides by accident. */
export function freshSha(): string {
  seq += 1;
  return createHash('sha256').update(`${Date.now()}:${seq}:${Math.random()}`).digest('hex');
}

/** A document row (and its sha guard), as `register_document` + `finalize_upload` leave it. */
export async function seedDocument(orgId: string, input: {
  status?: string; kind?: string; filename?: string; mime?: string; byteSize?: number; sha?: string;
  hasTextLayer?: boolean | null; pageCount?: number | null; uploadedBy?: string | null;
} = {}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const sha = input.sha ?? freshSha();
  const filename = input.filename ?? 'f.csv';
  await fs().runTransaction(async (tx) => {
    tx.set(orgRow(fs(), orgId, 'source_documents', id), {
      id, organization_id: orgId, storage_bucket: 'source-documents', storage_path: `${orgId}/${id}/${filename}`,
      original_filename: filename, mime_type: input.mime ?? 'text/csv', byte_size: input.byteSize ?? 10, sha256: sha,
      document_kind: input.kind ?? 'bank_statement', page_count: input.pageCount ?? null,
      has_text_layer: input.hasTextLayer ?? null, extracted_text_path: null, status: input.status ?? 'ready',
      scan_result: {}, uploaded_by: input.uploadedBy ?? null, deleted_at: null, created_at: now, updated_at: now,
    });
    tx.set(uniqueGuard(fs(), { orgId }, 'source_documents_sha_unique', [sha]).ref, {
      owner_id: id, constraint: 'source_documents_sha_unique', created_at: now,
    });
  });
  return id;
}

const TARGET: Record<string, string> = {
  general_ledger: 'ledger_entries', receipts: 'ledger_entries', trial_balance: 'period_balances',
  pnl_report: 'period_balances', balance_sheet: 'period_balances', bank_statement: 'bank_transactions',
  budget: 'budget_lines', sales_invoices: 'invoices', purchase_invoices: 'invoices', sales_report: 'invoices',
  purchase_report: 'invoices',
};

export interface BatchSpec {
  importType?: string;
  status?: string;
  method?: string;
  bankAccountId?: string | null;
  documentId?: string;
  required?: string[];
  confirmations?: Record<string, unknown>;
  periodStart?: string | null;
  periodEnd?: string | null;
  batchIssues?: unknown[];
  balanceBasis?: string | null;
  balanceSign?: string;
  invoiceListKind?: string | null;
  pageConfirmations?: Record<string, unknown>;
  extractionStats?: Record<string, unknown>;
  createdBy?: string | null;
}

/** An import batch row with every column (the defaults of `public.import_batches`). */
export async function seedBatch(orgId: string, spec: BatchSpec = {}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const importType = spec.importType ?? 'bank_statement';
  const documentId = spec.documentId ?? await seedDocument(orgId);
  await orgRow(fs(), orgId, 'import_batches', id).set({
    id, organization_id: orgId, source_document_id: documentId, import_type: importType,
    target_table: TARGET[importType], bank_account_id: spec.bankAccountId ?? null, mapping_id: null,
    mapping_snapshot: null, status: spec.status ?? 'awaiting_review', row_counts: {},
    period_start: spec.periodStart === undefined ? '2026-05-01' : spec.periodStart,
    period_end: spec.periodEnd === undefined ? '2026-05-31' : spec.periodEnd,
    statement_opening_balance: null, statement_closing_balance: null, balance_sign: spec.balanceSign ?? 'natural',
    fiscal_year_start_month_at_commit: null, invoice_list_kind: spec.invoiceListKind ?? null,
    balance_basis: spec.balanceBasis ?? null, extraction_method: spec.method ?? 'csv', pages_extracted: null,
    pages_failed: null, created_by: spec.createdBy ?? null, reviewed_by: null, committed_at: null, rolled_back_at: null,
    rolled_back_reason: null, replaced_batch_id: null, error_summary: null, calculation_job_id: null,
    calculation_run_id: null, created_at: now, updated_at: now, batch_issues: spec.batchIssues ?? [],
    confirmations: spec.confirmations ?? {}, required_confirmations: spec.required ?? [],
    page_confirmations: spec.pageConfirmations ?? {}, review_token: newId(), extraction_stats: spec.extractionStats ?? {},
  });
  return id;
}

export interface RowSpec {
  rowNumber: number;
  mapped: Record<string, unknown> | null;
  status: string;
  hash?: string | null;
  decision?: string;
  reason?: string | null;
  duplicateOfTable?: string | null;
  duplicateOf?: string | null;
  sourcePage?: number | null;
  issues?: unknown[];
}

/** Import rows of a batch (what `write_import_rows` stores). Returns their ids in order. */
export async function seedRows(orgId: string, batchId: string, rows: readonly RowSpec[]): Promise<string[]> {
  const now = nowIso();
  const ids: string[] = [];
  const writer = fs().bulkWriter();
  for (const r of rows) {
    const id = newId();
    ids.push(id);
    void writer.set(orgRow(fs(), orgId, 'import_rows', id), {
      id, organization_id: orgId, batch_id: batchId, row_number: r.rowNumber, source_ref: `csv:row:${r.rowNumber}`,
      raw_data: { source: 'line' }, mapped_data: r.mapped, status: r.status, issues: r.issues ?? [],
      dedupe_hash: r.hash ?? null,
      duplicate_of_table: r.duplicateOf ? (r.duplicateOfTable ?? 'bank_transactions') : null,
      duplicate_of_id: r.duplicateOf ?? null, duplicate_within_batch_row_id: null,
      reviewer_decision: r.decision ?? 'none', reviewer_reason: r.reason ?? null, committed_table: null,
      committed_record_id: null, created_at: now, updated_at: now, fixed_by: null, fixed_at: null,
      source_page: r.sourcePage ?? null,
    });
  }
  await writer.close();
  return ids;
}

/** Rows of a table matching every equality, read as the server (fixture checks only). */
export async function where(orgId: string, table: Parameters<typeof orgCollection>[2], eq: Record<string, unknown>): Promise<Row[]> {
  let q: FirebaseFirestore.Query = orgCollection(fs(), orgId, table);
  for (const [k, v] of Object.entries(eq)) q = q.where(k, '==', v);
  return (await q.get()).docs.map((d) => d.data());
}

const RECORD_GUARDS = [
  'invoices_identity_unique', 'single_current_balance', 'single_current_budget', 'source_documents_sha_unique',
  'import_mappings_signature_unique',
];

/**
 * Deletes every document of these tables in one organisation (a suite's `beforeEach` reset), and
 * the unique-key guards those rows held — never the chart's account guards.
 */
export async function clearTables(orgId: string, tables: ReadonlyArray<Parameters<typeof orgCollection>[2]>): Promise<void> {
  for (const t of tables) await fs().recursiveDelete(orgCollection(fs(), orgId, t));
  const guards = await fs().collection('organizations').doc(orgId).collection('_unique')
    .where('constraint', 'in', RECORD_GUARDS).get();
  const writer = fs().bulkWriter();
  for (const g of guards.docs) void writer.delete(g.ref);
  await writer.close();
  await fs().recursiveDelete(fs().collection('organizations').doc(orgId).collection('_locks'));
  await fs().recursiveDelete(fs().collection('organizations').doc(orgId).collection('_import_plans'));
}
