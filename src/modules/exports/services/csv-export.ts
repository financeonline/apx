import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { csvLine } from '@/core/csv';
import { NotFound, toMotionError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';

/**
 * CSV export (ROUTE_ARCHITECTURE.md §167; SECURITY_MODEL.md §8 step 4, §12; ADR-038.4).
 *
 * Four kinds, each a plain table of what the organisation's figures rest on. Everything is read
 * through the caller's own client, so RLS decides what is visible; only `record_status = accepted`
 * rows are exported (a superseded or rejected record is history, not data); and a bank line's text
 * is `description_normalized` only — the raw statement text with account numbers in it never
 * leaves the review screens (R2-A-04). Rows are read in pages and yielded as lines, so a ten-year
 * ledger streams rather than sits in memory.
 */

export const EXPORT_KINDS = ['ledger', 'bank_transactions', 'invoices', 'metrics'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(value: string): value is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(value);
}

const PAGE = 1_000;

interface Column<Row> {
  readonly header: string;
  readonly cell: (row: Row) => string | number | null | undefined;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nested = (v: unknown, key: string): string | null => {
  const inner = v as Record<string, unknown> | null;
  return inner && typeof inner === 'object' ? str(inner[key]) : null;
};

const LEDGER: readonly Column<Row>[] = [
  { header: 'entry_date', cell: (r) => str(r.entry_date) },
  { header: 'period', cell: (r) => nested(r.fiscal_periods, 'label') },
  { header: 'account_code', cell: (r) => nested(r.accounts, 'code') },
  { header: 'account', cell: (r) => nested(r.accounts, 'name') },
  { header: 'standard_category', cell: (r) => nested(r.accounts, 'standard_category') },
  { header: 'direction', cell: (r) => str(r.direction) },
  { header: 'amount', cell: (r) => str(r.amount) },
  { header: 'currency', cell: (r) => str(r.currency) },
  { header: 'description', cell: (r) => str(r.description) },
  { header: 'reference', cell: (r) => str(r.reference) },
  { header: 'journal_ref', cell: (r) => str(r.journal_ref) },
  { header: 'counterparty', cell: (r) => nested(r.counterparties, 'name') },
  { header: 'assurance_level', cell: (r) => str(r.assurance_level) },
  { header: 'source_ref', cell: (r) => str(r.source_ref) },
];

const BANK: readonly Column<Row>[] = [
  { header: 'transaction_date', cell: (r) => str(r.transaction_date) },
  { header: 'period', cell: (r) => nested(r.fiscal_periods, 'label') },
  { header: 'bank_account', cell: (r) => nested(r.bank_accounts, 'name') },
  { header: 'amount', cell: (r) => str(r.amount) },
  { header: 'currency', cell: (r) => str(r.currency) },
  // ADR-038.4: the masked text only. `description_raw` is not in the select and is not readable here.
  { header: 'description', cell: (r) => str(r.description_normalized) },
  { header: 'reference', cell: (r) => str(r.reference) },
  { header: 'balance_after', cell: (r) => str(r.balance_after) },
  { header: 'counterparty', cell: (r) => nested(r.counterparties, 'name') },
  { header: 'category', cell: (r) => str(r.category_name) },
  { header: 'is_transfer', cell: (r) => (r.is_transfer === true ? 'yes' : 'no') },
  { header: 'assurance_level', cell: (r) => str(r.assurance_level) },
  { header: 'source_ref', cell: (r) => str(r.source_ref) },
];

const INVOICES: readonly Column<Row>[] = [
  { header: 'invoice_type', cell: (r) => str(r.invoice_type) },
  { header: 'invoice_number', cell: (r) => str(r.invoice_number) },
  { header: 'counterparty', cell: (r) => nested(r.counterparties, 'name') },
  { header: 'issue_date', cell: (r) => str(r.issue_date) },
  { header: 'due_date', cell: (r) => str(r.due_date) },
  { header: 'period', cell: (r) => nested(r.fiscal_periods, 'label') },
  { header: 'subtotal', cell: (r) => str(r.subtotal) },
  { header: 'tax_amount', cell: (r) => str(r.tax_amount) },
  { header: 'total_amount', cell: (r) => str(r.total_amount) },
  { header: 'amount_paid', cell: (r) => str(r.amount_paid) },
  { header: 'balance_due', cell: (r) => str(r.balance_due) },
  { header: 'currency', cell: (r) => str(r.currency) },
  { header: 'status', cell: (r) => str(r.status) },
  { header: 'paid_date', cell: (r) => str(r.paid_date) },
  { header: 'description', cell: (r) => str(r.description) },
  { header: 'assurance_level', cell: (r) => str(r.assurance_level) },
  { header: 'source_ref', cell: (r) => str(r.source_ref) },
];

const METRICS: readonly Column<Row>[] = [
  { header: 'period', cell: (r) => nested(r.fiscal_periods, 'label') },
  { header: 'metric_key', cell: (r) => str(r.metric_key) },
  { header: 'dimension_type', cell: (r) => str(r.dimension_type) },
  { header: 'dimension', cell: (r) => str(r.dimension_key) ?? str(r.dimension_id) },
  { header: 'value', cell: (r) => nested(r.metric_snapshots, 'value') },
  { header: 'unit', cell: (r) => nested(r.metric_snapshots, 'unit') },
  { header: 'currency', cell: (r) => nested(r.metric_snapshots, 'currency') },
  { header: 'basis', cell: (r) => nested(r.metric_snapshots, 'basis') },
  { header: 'assurance_level', cell: (r) => nested(r.metric_snapshots, 'assurance_level') },
  { header: 'snapshot_id', cell: (r) => str(r.snapshot_id) },
];

interface Source {
  readonly table: string;
  readonly select: string;
  readonly order: readonly string[];
  readonly acceptedOnly: boolean;
  readonly columns: readonly Column<Row>[];
  readonly filename: string;
}

const SOURCES: Readonly<Record<ExportKind, Source>> = {
  ledger: {
    table: 'ledger_entries',
    select: 'entry_date, direction, amount, currency, description, reference, journal_ref, assurance_level, source_ref, fiscal_periods(label), accounts(code, name, standard_category), counterparties(name)',
    order: ['entry_date', 'id'], acceptedOnly: true, columns: LEDGER, filename: 'ledger',
  },
  bank_transactions: {
    table: 'bank_transactions',
    select: 'transaction_date, amount, currency, description_normalized, reference, balance_after, is_transfer, assurance_level, source_ref, fiscal_periods(label), bank_accounts(name), counterparties(name), category_account_id',
    order: ['transaction_date', 'id'], acceptedOnly: true, columns: BANK, filename: 'bank-transactions',
  },
  invoices: {
    table: 'invoices',
    select: 'invoice_type, invoice_number, issue_date, due_date, subtotal, tax_amount, total_amount, amount_paid, balance_due, currency, status, paid_date, description, assurance_level, source_ref, fiscal_periods(label), counterparties(name)',
    order: ['issue_date', 'id'], acceptedOnly: true, columns: INVOICES, filename: 'invoices',
  },
  metrics: {
    table: 'metric_current',
    select: 'metric_key, dimension_type, dimension_id, dimension_key, snapshot_id, fiscal_periods(label, period_start), metric_snapshots(value, unit, currency, basis, assurance_level)',
    order: ['period_id', 'metric_key', 'dimension_type', 'dimension_key', 'dimension_id'], acceptedOnly: false, columns: METRICS, filename: 'metrics',
  },
};

export function exportFilename(kind: ExportKind, today: string): string {
  return `apx-${SOURCES[kind].filename}-${today}.csv`;
}

/**
 * The CSV, line by line. The header first; then every accepted row in a stable order, in pages.
 * Throws before the first line when the caller may not export, so the route can answer with a
 * status rather than a half-written file.
 */
export async function* exportCsv(ctx: AccessContext, kind: ExportKind): AsyncGenerator<string> {
  assertCan(ctx, 'data.export');
  if (!ctx.orgId) throw new NotFound();
  const source = SOURCES[kind];
  const db: SupabaseClient = ctx.db;

  // `bank_transactions.category_account_id` is an org-composite reference with no simple foreign
  // key PostgREST can embed (ADR-044.8), so the category names are read once and joined here.
  const categoryNames = kind === 'bank_transactions' ? await accountNames(db, ctx.orgId, ctx.requestId) : null;

  yield csvLine(source.columns.map((c) => c.header));
  for (let offset = 0; ; offset += PAGE) {
    let query = db.from(source.table).select(source.select).eq('organization_id', ctx.orgId);
    if (source.acceptedOnly) query = query.eq('record_status', 'accepted');
    for (const column of source.order) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(offset, offset + PAGE - 1);
    if (error) throw toMotionError(error, ctx.requestId);
    const rows = (data ?? []) as unknown as Row[];
    for (const row of rows) {
      if (categoryNames !== null) row.category_name = categoryNames.get(String(row.category_account_id ?? '')) ?? null;
      yield csvLine(source.columns.map((c) => c.cell(row)));
    }
    if (rows.length < PAGE) break;
  }
}

async function accountNames(db: SupabaseClient, orgId: string, requestId?: string): Promise<Map<string, string>> {
  const { data, error } = await db.from('accounts').select('id, name').eq('organization_id', orgId);
  if (error) throw toMotionError(error, requestId);
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
}
