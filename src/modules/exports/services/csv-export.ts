import 'server-only';
import type { Query } from 'firebase-admin/firestore';
import { csvLine } from '@/core/csv';
import { NotFound } from '@/core/errors';
import { documentIdField, type OrgTable } from '@/db/schema';
import type { Db } from '@/db/types';
import { readRows, readRowsByIds } from '@/db/app/caller-reads';
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
 *
 * On Firestore each page is ordered by ONE field and the document id (= the row's id), which the
 * single-field index serves, so no composite index is needed; `record_status` is applied here. The
 * old embedded selects are second reads per page through the same read policies.
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

/** An embedded resource of the old select: the column holding its id, its table, and the key it lands under. */
interface Embed {
  readonly column: string;
  readonly table: OrgTable;
  readonly as: string;
}

interface Source {
  readonly table: OrgTable;
  /** The date the rows are ordered by, then by id; null for `metric_current`, sorted whole. */
  readonly orderField: string | null;
  readonly acceptedOnly: boolean;
  readonly embeds: readonly Embed[];
  readonly columns: readonly Column<Row>[];
  readonly filename: string;
}

const PERIOD: Embed = { column: 'period_id', table: 'fiscal_periods', as: 'fiscal_periods' };
const COUNTERPARTY: Embed = { column: 'counterparty_id', table: 'counterparties', as: 'counterparties' };

const SOURCES: Readonly<Record<ExportKind, Source>> = {
  ledger: {
    table: 'ledger_entries', orderField: 'entry_date', acceptedOnly: true,
    embeds: [PERIOD, { column: 'account_id', table: 'accounts', as: 'accounts' }, COUNTERPARTY],
    columns: LEDGER, filename: 'ledger',
  },
  bank_transactions: {
    table: 'bank_transactions', orderField: 'transaction_date', acceptedOnly: true,
    embeds: [PERIOD, { column: 'bank_account_id', table: 'bank_accounts', as: 'bank_accounts' }, COUNTERPARTY],
    columns: BANK, filename: 'bank-transactions',
  },
  invoices: {
    table: 'invoices', orderField: 'issue_date', acceptedOnly: true,
    embeds: [PERIOD, COUNTERPARTY],
    columns: INVOICES, filename: 'invoices',
  },
  metrics: {
    table: 'metric_current', orderField: null, acceptedOnly: false,
    embeds: [PERIOD, { column: 'snapshot_id', table: 'metric_snapshots', as: 'metric_snapshots' }],
    columns: METRICS, filename: 'metrics',
  },
};

/** `order by period_id, metric_key, dimension_type, dimension_key, dimension_id` (NULLS LAST). */
const METRIC_ORDER = ['period_id', 'metric_key', 'dimension_type', 'dimension_key', 'dimension_id'] as const;
function metricOrder(a: Row, b: Row): number {
  for (const key of METRIC_ORDER) {
    const x = a[key] ?? null; const y = b[key] ?? null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** Joins one page's embedded resources onto its rows, as PostgREST did (null when not visible). */
async function embed(db: Db, orgId: string, source: Source, rows: Row[]): Promise<void> {
  for (const e of source.embeds) {
    const found = await readRowsByIds<Row>(db, orgId, e.table, rows.map((r) => str(r[e.column])));
    const byId = new Map(found.map((r) => [String(r.id), r]));
    for (const row of rows) row[e.as] = byId.get(String(row[e.column] ?? '')) ?? null;
  }
}

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
  const db: Db = ctx.db;
  const orgId = ctx.orgId;

  // `bank_transactions.category_account_id` is an org-composite reference with no simple foreign
  // key PostgREST can embed (ADR-044.8), so the category names are read once and joined here.
  const categoryNames = kind === 'bank_transactions' ? await accountNames(db, orgId) : null;

  const emit = function* (rows: Row[]): Generator<string> {
    for (const row of rows) {
      if (categoryNames !== null) row.category_name = categoryNames.get(String(row.category_account_id ?? '')) ?? null;
      yield csvLine(source.columns.map((c) => c.cell(row)));
    }
  };

  yield csvLine(source.columns.map((c) => c.header));
  const orderField = source.orderField;
  if (orderField === null) {
    const rows = (await readRows<Row>(db, orgId, source.table)).sort(metricOrder);
    for (let i = 0; i < rows.length; i += PAGE) {
      const page = rows.slice(i, i + PAGE);
      await embed(db, orgId, source, page);
      yield* emit(page);
    }
    return;
  }

  let after: [unknown, string] | null = null;
  for (;;) {
    const cursor: [unknown, string] | null = after;
    const page: Row[] = await readRows<Row>(db, orgId, source.table, (q): Query => {
      const ordered = q.orderBy(orderField).orderBy(documentIdField()).limit(PAGE);
      return cursor === null ? ordered : ordered.startAfter(cursor[0], cursor[1]);
    });
    if (page.length === 0) break;
    const last: Row = page[page.length - 1]!;
    after = [last[orderField] ?? null, String(last.id)];
    const rows = source.acceptedOnly ? page.filter((r) => r.record_status === 'accepted') : page;
    await embed(db, orgId, source, rows);
    yield* emit(rows);
    if (page.length < PAGE) break;
  }
}

async function accountNames(db: Db, orgId: string): Promise<Map<string, string>> {
  const rows = await readRows<{ id: string; name: string }>(db, orgId, 'accounts');
  return new Map(rows.map((a) => [a.id, a.name]));
}
