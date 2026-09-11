import 'server-only';
import { NotFound, isMotionError, toMotionError } from '@/core/errors';
import { assertCan, can } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import type { AssuranceLevel } from '../domain/assurance';
import type { Row } from '../data/rows';
import { requireOrgId } from './resolve';
import { getDocumentReference, type DocumentReference } from './document';

/**
 * The two ends of the chain (EVIDENCE_MODEL.md §1, §5.1; ADR-096).
 *
 * The drawer walks the chain DOWNWARD — a figure opens its calculation, its records, and a row's
 * source document. That is the question "where did this number come from?", and it was already
 * answered. These two services answer the same question asked from the other end, which nothing
 * could answer before:
 *
 *   * `getRecordProvenance` — a reader is looking at ONE record. Where did this row come from, is it
 *     still counted, and which line of which file is it?
 *   * `getDocumentEvidence` — a reader is looking at ONE file. What rests on it?
 *
 * Neither computes anything and neither invents a link. Every relation here is a stored column:
 * a record carries `source_document_id`, `import_batch_id`, `import_row_id` and `period_id`; a
 * batch carries its declared range, its committed counts and the calculation run its commit
 * triggered. Where a link is absent the answer is "there is no file behind this row", which is a
 * real state — a row restored by a rollback, created by a merge, or typed in by hand has no file —
 * and saying so is the point. EVIDENCE_MODEL.md §8.6: a reference that cannot be resolved is worse
 * than no reference.
 */

/**
 * The four record kinds in the product's own words.
 *
 * `UX_ARCHITECTURE.md §7` forbids showing a reader a table name, and a URL is something a reader
 * reads and pastes into a ticket. The slug is therefore the vocabulary, and the table name it maps
 * to never leaves the server.
 */
export const RECORD_KINDS = {
  ledger: 'ledger_entries',
  bank: 'bank_transactions',
  invoice: 'invoices',
  balance: 'period_balances',
} as const;

export type RecordKind = keyof typeof RECORD_KINDS;

export const RECORD_KIND_LABELS: Readonly<Record<RecordKind, string>> = {
  ledger: 'Ledger entry',
  bank: 'Bank transaction',
  invoice: 'Invoice',
  balance: 'Trial balance line',
};

export function isRecordKind(value: string): value is RecordKind {
  return Object.prototype.hasOwnProperty.call(RECORD_KINDS, value);
}

/** What is left of a row's life: whether it still counts, and why not when it does not. */
export interface RecordStanding {
  /** `accepted` · `rejected` · `pending` — the column, not an interpretation of it. */
  readonly status: string | null;
  /** §7: the assurance the record itself carries, which the figure above it inherits at best. */
  readonly assurance: AssuranceLevel | null;
  readonly superseded: boolean;
  /** The row that replaced this one, so a reader can follow the correction forward (§6). */
  readonly supersededById: string | null;
  readonly supersededAt: string | null;
  /** Why the reviewer rejected it. Present only on a rejected row. */
  readonly rejectedReason: string | null;
  /**
   * Whether this row is inside the figures.
   *
   * The same rule the resolver applies to a selection (`isVisibleAtInstant`): accepted and not
   * superseded. Stated here so a reader looking at ONE row gets the same answer the drawer's
   * reconciliation gives for the set it belongs to.
   */
  readonly countsTowardsFigures: boolean;
}

export interface RecordImport {
  readonly batchId: string;
  readonly importType: string;
  readonly status: string;
  readonly committedAt: string | null;
  /** The batch's DECLARED export range, which is what coverage is judged on (ADR-047.6). */
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
}

export interface RecordProvenance {
  readonly kind: RecordKind;
  readonly kindLabel: string;
  readonly recordId: string;
  readonly date: string | null;
  readonly description: string | null;
  /** NUMERIC as a string, never a number (ADR-006). */
  readonly amount: string | null;
  readonly currency: string | null;
  readonly periodId: string | null;
  readonly periodLabel: string | null;
  readonly standing: RecordStanding;
  /** `null` for a row no import produced — a rollback restore, a merge, a hand-entered figure. */
  readonly importedBy: RecordImport | null;
  /**
   * The file and the line within it, through the SAME permission-aware path the drawer's level 4
   * uses. A client gets the line reference and `locked: true` rather than the filename (§10, CD-17).
   * `null` when this row has no file behind it at all.
   */
  readonly document: DocumentReference | null;
}

const AMOUNT_COLUMN: Readonly<Record<RecordKind, string>> = {
  ledger: 'amount',
  bank: 'amount',
  invoice: 'total_amount',
  balance: 'amount',
};

const DATE_COLUMN: Readonly<Record<RecordKind, string>> = {
  ledger: 'entry_date',
  bank: 'transaction_date',
  invoice: 'issue_date',
  // A trial balance line is about a period, not a day; the period below is its date.
  balance: 'created_at',
};

const DESCRIPTION_COLUMN: Readonly<Record<RecordKind, string>> = {
  ledger: 'description',
  // ADR-038.4: the masked form is the only one a reader is ever shown. `description_raw` is not
  // selectable here on purpose — it carries account numbers printed in statement lines.
  bank: 'description_normalized',
  invoice: 'description',
  balance: 'balance_kind',
};

function str(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

/**
 * Where one record came from.
 *
 * Read entirely through the caller's own client, so RLS decides what exists: a record id belonging
 * to another organisation resolves to nothing and is answered `NotFound`, never "forbidden", which
 * would confirm the row exists for somebody (SECURITY_MODEL.md §14). The organisation comes from the
 * request's AccessContext and never from an argument.
 */
export async function getRecordProvenance(
  ctx: AccessContext,
  kind: RecordKind,
  recordId: string,
): Promise<RecordProvenance> {
  assertCan(ctx, 'financials.view');
  const orgId = requireOrgId(ctx);
  const table = RECORD_KINDS[kind];

  const columns = [
    'id', 'period_id', 'record_status', 'assurance_level', 'superseded_by', 'superseded_at',
    'rejected_reason', 'currency', 'import_batch_id',
    `${DATE_COLUMN[kind]}`, `${DESCRIPTION_COLUMN[kind]}`, `${AMOUNT_COLUMN[kind]}`,
  ];

  const { data, error } = await ctx.db
    .from(table)
    .select(columns.join(', '))
    .eq('organization_id', orgId)
    .eq('id', recordId)
    .maybeSingle();
  if (error) throw toMotionError(error, ctx.requestId);
  if (!data) throw new NotFound();
  const record = data as unknown as Row;

  const status = str(record, 'record_status');
  const superseded = record.superseded_by !== null && record.superseded_by !== undefined;
  const standing: RecordStanding = {
    status,
    assurance: (str(record, 'assurance_level') as AssuranceLevel | null),
    superseded,
    supersededById: str(record, 'superseded_by'),
    supersededAt: str(record, 'superseded_at'),
    rejectedReason: str(record, 'rejected_reason'),
    countsTowardsFigures: status === 'accepted' && !superseded,
  };

  const periodId = str(record, 'period_id');
  const [periodLabel, importedBy] = await Promise.all([
    loadPeriodLabel(ctx, orgId, periodId),
    loadImport(ctx, orgId, str(record, 'import_batch_id')),
  ]);

  /*
   * The document half is delegated rather than re-queried. `getDocumentReference` owns the client
   * rule, the line reference and the "no file behind this row" case; a second implementation here
   * would be a second place for those three answers to drift.
   */
  let document: DocumentReference | null = null;
  try {
    document = await getDocumentReference(ctx, { table, id: recordId });
  } catch (cause) {
    if (!isMotionError(cause) || cause.code !== 'NOT_FOUND') throw cause;
    document = null;
  }

  return {
    kind,
    kindLabel: RECORD_KIND_LABELS[kind],
    recordId,
    date: str(record, DATE_COLUMN[kind]),
    description: str(record, DESCRIPTION_COLUMN[kind]),
    amount: str(record, AMOUNT_COLUMN[kind]),
    currency: str(record, 'currency'),
    periodId,
    periodLabel,
    standing,
    importedBy,
    document,
  };
}

async function loadPeriodLabel(
  ctx: AccessContext, orgId: string, periodId: string | null,
): Promise<string | null> {
  if (periodId === null) return null;
  const { data, error } = await ctx.db
    .from('fiscal_periods').select('label')
    .eq('organization_id', orgId).eq('id', periodId).maybeSingle();
  if (error) throw toMotionError(error, ctx.requestId);
  return (data as { label?: string } | null)?.label ?? null;
}

async function loadImport(
  ctx: AccessContext, orgId: string, batchId: string | null,
): Promise<RecordImport | null> {
  if (batchId === null) return null;
  const { data, error } = await ctx.db
    .from('import_batches')
    .select('id, import_type, status, committed_at, period_start, period_end')
    .eq('organization_id', orgId).eq('id', batchId).maybeSingle();
  if (error) throw toMotionError(error, ctx.requestId);
  const row = data as Row | null;
  if (!row) return null;
  return {
    batchId,
    importType: String(row.import_type),
    status: String(row.status),
    committedAt: str(row, 'committed_at'),
    periodStart: str(row, 'period_start'),
    periodEnd: str(row, 'period_end'),
  };
}

// ---------------------------------------------------------------------------------------------
// The other end: what rests on one file.
// ---------------------------------------------------------------------------------------------

export interface DocumentImport {
  readonly batchId: string;
  readonly importType: string;
  readonly status: string;
  readonly committedAt: string | null;
  readonly rolledBackAt: string | null;
  /** What the rows became: the four record kinds, in the product's words. */
  readonly kind: RecordKind | null;
  readonly kindLabel: string | null;
  /** From `import_batches.row_counts`, written once at commit — not counted again here. */
  readonly rowsCommitted: number | null;
  readonly rowsSuperseded: number | null;
  readonly rowsTotal: number | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** The run the commit triggered, which is when the figures that rest on this file were worked out. */
  readonly calculationRunId: string | null;
}

export interface DocumentEvidence {
  readonly documentId: string;
  readonly filename: string;
  readonly documentKind: string;
  readonly status: string;
  readonly uploadedAt: string;
  readonly imports: readonly DocumentImport[];
  /**
   * The months this file put data into, oldest first, each with the label a reader recognises.
   *
   * Deliberately "contributed to" and not "produced": a month's figures rest on every file that
   * covers it, and claiming this one produced them would be the kind of overstatement §1 exists to
   * prevent. The months are taken from the batches' DECLARED ranges (ADR-047.6), which is the same
   * range coverage and completeness are judged on.
   */
  readonly periods: ReadonlyArray<{ readonly id: string; readonly label: string; readonly periodStart: string }>;
  /** Committed rows across every import of this file. `0` is a real answer: nothing rests on it yet. */
  readonly recordsCommitted: number;
}

/**
 * What rests on one file.
 *
 * `documents.view` — the same permission the library and the viewer require, so this adds no reach:
 * a client cannot read `source_documents` under RLS in any case (§10, CD-17).
 *
 * Four indexed reads and no scan: the document by id, its batches through
 * `import_batches_document_lookup (organization_id, source_document_id)`, and the periods those
 * batches declare through `fiscal_periods_org_start_unique`. The row counts are read off the batch
 * where the commit wrote them rather than counted again, which is what keeps this O(batches).
 */
export async function getDocumentEvidence(
  ctx: AccessContext,
  documentId: string,
): Promise<DocumentEvidence> {
  assertCan(ctx, 'documents.view');
  const orgId = requireOrgId(ctx);

  const { data: docData, error: docError } = await ctx.db
    .from('source_documents')
    .select('id, original_filename, document_kind, status, created_at')
    .eq('organization_id', orgId).eq('id', documentId).maybeSingle();
  if (docError) throw toMotionError(docError, ctx.requestId);
  if (!docData) throw new NotFound();
  const doc = docData as unknown as Row;

  const { data: batchData, error: batchError } = await ctx.db
    .from('import_batches')
    .select('id, import_type, target_table, status, committed_at, rolled_back_at, row_counts, period_start, period_end, calculation_run_id')
    .eq('organization_id', orgId)
    .eq('source_document_id', documentId)
    .order('created_at', { ascending: false });
  if (batchError) throw toMotionError(batchError, ctx.requestId);

  const batches = (batchData ?? []) as unknown as Row[];
  const imports: DocumentImport[] = batches.map((b) => {
    const counts = (b.row_counts ?? {}) as Record<string, unknown>;
    const kind = kindOfTable(str(b, 'target_table'));
    return {
      batchId: String(b.id),
      importType: String(b.import_type),
      status: String(b.status),
      committedAt: str(b, 'committed_at'),
      rolledBackAt: str(b, 'rolled_back_at'),
      kind,
      kindLabel: kind === null ? null : RECORD_KIND_LABELS[kind],
      rowsCommitted: countOrNull(counts.committed),
      rowsSuperseded: countOrNull(counts.superseded),
      rowsTotal: countOrNull(counts.total),
      periodStart: str(b, 'period_start'),
      periodEnd: str(b, 'period_end'),
      calculationRunId: str(b, 'calculation_run_id'),
    };
  });

  /*
   * Only a committed import puts anything into the figures. A rolled-back one is history: its rows
   * were taken back out, so counting its months here would tell a reader this file is behind
   * figures it is no longer behind.
   */
  const live = imports.filter((i) => i.status === 'committed' && i.rolledBackAt === null);
  const recordsCommitted = live.reduce((sum, i) => sum + (i.rowsCommitted ?? 0), 0);

  return {
    documentId,
    filename: String(doc.original_filename),
    documentKind: String(doc.document_kind),
    status: String(doc.status),
    uploadedAt: String(doc.created_at),
    imports,
    periods: await loadPeriodsCovered(ctx, orgId, live),
    recordsCommitted,
  };
}

function kindOfTable(table: string | null): RecordKind | null {
  for (const [kind, name] of Object.entries(RECORD_KINDS)) {
    if (name === table) return kind as RecordKind;
  }
  return null;
}

/** A row COUNT off `row_counts`, not money — money never leaves this module as a number (ADR-006). */
function countOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The months the live imports declare, in one range query rather than one query per batch. */
async function loadPeriodsCovered(
  ctx: AccessContext,
  orgId: string,
  imports: readonly DocumentImport[],
): Promise<DocumentEvidence['periods']> {
  const starts = imports.map((i) => i.periodStart).filter((d): d is string => d !== null);
  const ends = imports.map((i) => i.periodEnd).filter((d): d is string => d !== null);
  if (starts.length === 0 || ends.length === 0) return [];

  const from = starts.reduce((a, b) => (a < b ? a : b));
  const to = ends.reduce((a, b) => (a > b ? a : b));

  const { data, error } = await ctx.db
    .from('fiscal_periods')
    .select('id, label, period_start, period_end')
    .eq('organization_id', orgId)
    .lte('period_start', to)
    .gte('period_end', from)
    .order('period_start', { ascending: true });
  if (error) throw toMotionError(error, ctx.requestId);

  const rows = (data ?? []) as unknown as Row[];
  // A period counts only when some import's declared range actually overlaps it: the envelope above
  // is one query for many batches, and the envelope can be wider than any single range.
  return rows
    .filter((p) => imports.some((i) =>
      i.periodStart !== null && i.periodEnd !== null
      && String(p.period_start) <= i.periodEnd && String(p.period_end) >= i.periodStart))
    .map((p) => ({ id: String(p.id), label: String(p.label), periodStart: String(p.period_start) }));
}

/** Whether the reader may be offered the file itself, as opposed to the line reference (§10). */
export function mayOpenDocuments(ctx: AccessContext): boolean {
  return can(ctx, 'documents.view');
}
