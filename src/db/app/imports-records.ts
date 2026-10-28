import 'server-only';
import Decimal from 'decimal.js';
import type { Firestore } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { globalRow, newId, nowIso, orgCollection, orgDoc, orgRow, uniqueGuard, type OrgTable } from '../schema';
import { readerOf, uidOf, type Db, type Reader } from '../types';
import { actorTypeOf } from './access';
import { fiscalPosition, monthStart, periodId } from './shared';
import { chunks, type Data, type WorkingSet } from './imports-ws';

/**
 * The financial-record helpers the import pipeline shares with the areas that change records after
 * import (banking, financials, the engine): the ports of `app.supersede_row`,
 * `app.record_status_event`, `app.write_category_history`, `app.batch_record_assurance` and of the
 * triggers on the five record tables (FIRESTORE_DATA_MODEL.md §4) — `period_assign`,
 * `mask_description`, `superseded_at_set`, `open_*_category_history`, `audit_diff`,
 * `flag_runs_stale` and the partial unique indexes.
 *
 * Every helper works on a `WorkingSet` (src/db/app/imports-ws.ts): it reads through it and changes
 * it in memory, and the caller writes the set's final state once — so a helper can be used inside a
 * transaction without breaking Firestore's reads-before-writes rule.
 */

export const RECORD_TABLES = ['ledger_entries', 'bank_transactions', 'invoices', 'period_balances', 'budget_lines'] as const;
export type RecordTable = (typeof RECORD_TABLES)[number];

export function isRecordTable(t: unknown): t is RecordTable {
  return typeof t === 'string' && (RECORD_TABLES as readonly string[]).includes(t);
}

export const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

// ── The audit stamp ──────────────────────────────────────────────────────────────────────────────

/**
 * Who an audit row names, worked out once per operation rather than per row (`app.audit`'s two
 * branches): a USER caller is the actor whatever the function was given; a SERVICE caller names the
 * person it acted for (`p_actor`), or nobody — a system event.
 */
export interface AuditStamp {
  readonly orgScope: string | null;
  readonly actorId: string | null;
  readonly actorType: string;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export async function auditStampOf(
  db: Db, serviceActor: string | null, requestId: string | null = null, r: Reader = readerOf(),
): Promise<AuditStamp> {
  const actorId = db.actor.kind === 'user' ? db.actor.userId : serviceActor;
  return {
    orgScope: db.actor.kind === 'service' ? db.actor.scope : null,
    actorId,
    actorType: await actorTypeOf(db.fs, actorId, r),
    requestId: db.actor.kind === 'user' ? (db.meta.requestId ?? null) : (requestId ?? db.meta.requestId ?? null),
    ip: db.meta.ip ?? null,
    userAgent: db.meta.userAgent ? db.meta.userAgent.slice(0, 256) : null,
  };
}

/** The stamp the row triggers used: `app.audit` called without an actor — the user, or the system. */
export function triggerStamp(db: Db, stamp: AuditStamp): AuditStamp {
  return db.actor.kind === 'user' ? stamp : { ...stamp, actorId: null, actorType: 'system' };
}

export interface AuditEntry {
  readonly action: string;
  readonly targetTable?: string | null;
  readonly targetId?: string | null;
  readonly before?: Data | null;
  readonly after?: Data | null;
  readonly metadata?: Data | null;
}

/** One `audit_events` row, written into the working set; returns its id. */
export function auditInto(ws: WorkingSet, orgId: string | null, stamp: AuditStamp, e: AuditEntry): string {
  if (stamp.orgScope && orgId !== stamp.orgScope) {
    raise.invalid('audit organization does not match the scoped organization');
  }
  const id = newId();
  ws.set(globalRow(ws.fs, 'audit_events', id), {
    id,
    organization_id: orgId,
    actor_user_id: stamp.actorId,
    actor_type: stamp.actorType,
    action: e.action,
    target_table: e.targetTable ?? null,
    target_id: e.targetId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    metadata: e.metadata ?? {},
    ip: stamp.ip,
    user_agent: stamp.userAgent,
    request_id: stamp.requestId ?? newId(),
    created_at: nowIso(),
  });
  return id;
}

/** The `audit_diff` trigger on a record table: `db.<table>.insert|update|delete`, whole rows. */
export function auditRowChange(
  ws: WorkingSet, stamp: AuditStamp, table: string, op: 'insert' | 'update' | 'delete',
  before: Data | null, after: Data | null,
): void {
  const row = after ?? before ?? {};
  auditInto(ws, str(row.organization_id), stamp, {
    action: `db.${table}.${op}`, targetTable: table,
    targetId: str(row.id) ?? str(row.user_id) ?? str(row.organization_id),
    before, after, metadata: { source: 'trigger' },
  });
}

// ── Record status history ────────────────────────────────────────────────────────────────────────

/**
 * `app.record_status_event` plus the `record_superseded` trigger (`app.flag_runs_stale`): one entry
 * in a record's status history, and every RUNNING calculation of the organisation marked stale,
 * because what it is reading has just changed underneath it. `flagRunsStale` must have been called
 * once for the organisation in this working set first (it is a query, so it reads).
 */
export function statusEventInto(
  ws: WorkingSet,
  e: { orgId: string; table: RecordTable; recordId: string; event: string; relatedId?: string | null; batchId?: string | null; actorId: string | null },
): string {
  const id = newId();
  ws.set(orgRow(ws.fs, e.orgId, 'record_status_events', id), {
    id, organization_id: e.orgId, record_table: e.table, record_id: e.recordId, event: e.event,
    related_record_id: e.relatedId ?? null, import_batch_id: e.batchId ?? null,
    actor_user_id: e.actorId, at: nowIso(),
  });
  return id;
}

/** Loads the organisation's running calculations and marks them stale (`app.flag_runs_stale`). */
export async function flagRunsStale(ws: WorkingSet, orgId: string): Promise<number> {
  const col = orgCollection(ws.fs, orgId, 'calculation_runs');
  const running = await ws.query(col, col.where('status', '==', 'running'), (d) => d.status === 'running');
  const now = nowIso();
  for (const run of running) {
    if (run.stale === true) continue;
    ws.update(orgRow(ws.fs, orgId, 'calculation_runs', String(run.id)), { stale: true, updated_at: now });
  }
  return running.length;
}

// ── Fiscal periods (`period_assign`) ─────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthEnd(start: string): string {
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  return `${start.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** A valid `YYYY-MM-DD` date, or null. */
export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/**
 * The `period_assign` trigger for a set of dates: each date's month gets a fiscal period (created
 * when missing — only that month, as the trigger did, never the months between), and the returned
 * map gives each month start its period id. Reads, then writes into the set.
 */
export async function assignPeriods(ws: WorkingSet, orgId: string, dates: readonly string[]): Promise<Map<string, string>> {
  const starts = [...new Set(dates.map((d) => monthStart(d)))].sort();
  const out = new Map<string, string>();
  if (starts.length === 0) return out;
  const org = await ws.get(globalRow(ws.fs, 'organizations', orgId));
  const fyMonth = org ? Number(org.fiscal_year_start_month) : NaN;
  if (!org || !Number.isFinite(fyMonth)) raise.notFound();
  const refs = starts.map((s) => orgRow(ws.fs, orgId, 'fiscal_periods', periodId(orgId, s)));
  const current = await ws.load(refs);
  const now = nowIso();
  starts.forEach((s, i) => {
    const id = periodId(orgId, s);
    out.set(s, id);
    if (current[i]) return;
    const pos = fiscalPosition(s, fyMonth);
    ws.set(refs[i]!, {
      id, organization_id: orgId, period_start: s, period_end: monthEnd(s),
      fiscal_year: pos.fiscal_year, fiscal_quarter: pos.fiscal_quarter,
      label: `${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`,
      is_complete: false, is_locked: false, created_at: now, updated_at: now,
    });
  });
  return out;
}

// ── Bank descriptions (`mask_description`) ───────────────────────────────────────────────────────

/**
 * `app.mask_description` (ADR-038.4): sort codes and 6–8 digit account numbers keep only their last
 * four digits; whitespace collapses. `\m`/`\M` (PostgreSQL word boundaries) are `\b` here.
 */
export function maskDescription(raw: string | null): string | null {
  let t = raw ?? '';
  t = t.replace(/\b(\d{2})-(\d{2})-(\d{2})\b/g, '****$2$3');
  t = t.replace(/\b\d{2,4}(\d{4})\b/g, '****$1');
  const out = t.replace(/\s+/g, ' ').trim();
  return out === '' ? null : out;
}

// ── Category history ─────────────────────────────────────────────────────────────────────────────

/** `app.open_bank_category_history`: a new transaction's first category-history entry. */
export function openBankCategoryHistory(ws: WorkingSet, txn: Data, changedBy: string | null): void {
  const id = newId();
  const orgId = String(txn.organization_id);
  ws.set(orgRow(ws.fs, orgId, 'category_history', id), {
    id, organization_id: orgId, bank_transaction_id: txn.id,
    category_account_id: txn.category_account_id ?? null, is_transfer: txn.is_transfer ?? false,
    transfer_kind: txn.transfer_kind ?? 'none', source: txn.category_source ?? 'none',
    valid_from: txn.created_at ?? nowIso(), valid_to: null, changed_by: changedBy, created_at: nowIso(),
  });
}

/** `app.open_account_category_history`: a new account's first category entry. */
export function openAccountCategoryHistory(ws: WorkingSet, account: Data, changedBy: string | null): void {
  const id = newId();
  const orgId = String(account.organization_id);
  ws.set(orgRow(ws.fs, orgId, 'account_category_history', id), {
    id, organization_id: orgId, account_id: account.id, standard_category: account.standard_category,
    valid_from: account.created_at ?? nowIso(), valid_to: null, changed_by: changedBy, created_at: nowIso(),
  });
}

/**
 * `app.write_category_history`: closes the transaction's open entry (`valid_to`, set once — the
 * `history_close_only` rule) and opens the new one. Reads the open entries, then writes.
 */
export async function writeCategoryHistory(
  ws: WorkingSet,
  e: { orgId: string; txnId: string; categoryId: string | null; isTransfer: boolean; kind: string; source: string; changedBy: string | null },
): Promise<void> {
  const col = orgCollection(ws.fs, e.orgId, 'category_history');
  const open = await ws.query(col, col.where('bank_transaction_id', '==', e.txnId),
    (d) => d.bank_transaction_id === e.txnId && d.valid_to === null);
  const now = nowIso();
  for (const h of open) ws.update(orgRow(ws.fs, e.orgId, 'category_history', String(h.id)), { valid_to: now });
  const id = newId();
  ws.set(orgRow(ws.fs, e.orgId, 'category_history', id), {
    id, organization_id: e.orgId, bank_transaction_id: e.txnId, category_account_id: e.categoryId,
    is_transfer: e.isTransfer, transfer_kind: e.kind, source: e.source,
    valid_from: now, valid_to: null, changed_by: e.changedBy, created_at: now,
  });
}

// ── Partial unique indexes on records ────────────────────────────────────────────────────────────

/**
 * The guard a CURRENT record holds — `invoices_identity_unique`, `single_current_balance`,
 * `single_current_budget` are partial on `record_status = 'accepted' and superseded_by is null`.
 * Null for a table without one, or for a row that is not current.
 */
export function currentGuardRef(fs: Firestore, table: RecordTable, row: Data) {
  const orgId = String(row.organization_id);
  switch (table) {
    case 'invoices':
      return uniqueGuard(fs, { orgId }, 'invoices_identity_unique', [str(row.invoice_type), str(row.counterparty_id), str(row.invoice_number)]).ref;
    case 'period_balances':
      return uniqueGuard(fs, { orgId }, 'single_current_balance', [str(row.period_id), str(row.account_id), str(row.balance_kind)]).ref;
    case 'budget_lines':
      return uniqueGuard(fs, { orgId }, 'single_current_budget', [str(row.period_id), str(row.account_id)]).ref;
    default:
      return null;
  }
}

const CURRENT_INDEX: Partial<Record<RecordTable, string>> = {
  invoices: 'invoices_identity_unique',
  period_balances: 'single_current_balance',
  budget_lines: 'single_current_budget',
};

export const isCurrent = (row: Data | null | undefined): boolean =>
  !!row && row.record_status === 'accepted' && (row.superseded_by ?? null) === null;

/**
 * Keeps a record's partial-index guard in step with its state, comparing the state before and after
 * a change: a row entering the index takes the guard (CONFLICT when another current row holds it,
 * as `23505` was), a row leaving it releases the guard. The guards must be loaded first
 * (`loadGuards`), because claiming one is a read.
 */
export function syncCurrentGuard(ws: WorkingSet, table: RecordTable, before: Data | null, after: Data | null): void {
  const constraint = CURRENT_INDEX[table];
  if (!constraint) return;
  const wasRef = before && isCurrent(before) ? currentGuardRef(ws.fs, table, before) : null;
  const nowRef = after && isCurrent(after) ? currentGuardRef(ws.fs, table, after) : null;
  if (wasRef && (!nowRef || wasRef.path !== nowRef.path)) {
    const g = ws.peek(wasRef);
    if (g === undefined) throw new Error(`guard not loaded: ${wasRef.path}`);
    if (g && g.owner_id === before!.id) ws.delete(wasRef);
  }
  if (nowRef) {
    const g = ws.peek(nowRef);
    if (g === undefined) throw new Error(`guard not loaded: ${nowRef.path}`);
    if (g && g.owner_id !== after!.id) {
      raise.conflict(`duplicate key value violates unique constraint "${constraint}"`, { existingId: g.owner_id });
    }
    if (!g) ws.set(nowRef, { owner_id: after!.id, constraint, created_at: nowIso() });
  }
}

/** Loads the current-index guards of these rows (as they are and as they will be). */
export async function loadGuards(ws: WorkingSet, table: RecordTable, rows: ReadonlyArray<Data | null>): Promise<void> {
  const refs = rows.filter((r): r is Data => !!r).map((r) => currentGuardRef(ws.fs, table, r)).filter((r) => r !== null);
  for (const c of chunks(refs, 300)) await ws.load(c);
}

// ── Supersession (`app.supersede_row`, `superseded_at_set`) ──────────────────────────────────────

/**
 * `app.supersede_row`: `p_record` is replaced by `p_replacement`. CONFLICT when the record is
 * already superseded or does not exist. Sets `superseded_at` (the `superseded_at_set` trigger),
 * releases the record's current-index guard, writes the row audit and the `superseded` history
 * entry. The record and its guard must already be loaded.
 */
export function supersedeRow(
  ws: WorkingSet, stamp: AuditStamp,
  e: { orgId: string; table: RecordTable; recordId: string; replacementId: string | null; batchId: string | null; actorId: string | null },
): void {
  const ref = orgRow(ws.fs, e.orgId, e.table, e.recordId);
  const before = ws.peek(ref);
  if (before === undefined) throw new Error(`supersedeRow: ${ref.path} was not loaded`);
  if (!before || (before.superseded_by ?? null) !== null) {
    raise.conflict('that record is already superseded or does not exist');
  }
  const now = nowIso();
  const after = ws.update(ref, {
    superseded_by: e.replacementId, superseded_at: e.replacementId ? now : null, updated_at: now,
  });
  syncCurrentGuard(ws, e.table, before, after);
  auditRowChange(ws, stamp, e.table, 'update', before, after);
  statusEventInto(ws, {
    orgId: e.orgId, table: e.table, recordId: e.recordId, event: 'superseded',
    relatedId: e.replacementId, batchId: e.batchId, actorId: e.actorId,
  });
}

/**
 * Changes a record through the triggers: `superseded_at_set`, `set_updated_at`, the guard and the
 * row audit. The record (and its guards) must be loaded. Returns the new state.
 */
export function updateRecord(ws: WorkingSet, stamp: AuditStamp, table: RecordTable, orgId: string, id: string, patch: Data): Data {
  const ref = orgRow(ws.fs, orgId, table, id);
  const before = ws.peek(ref);
  if (!before) throw new Error(`updateRecord: ${ref.path} was not loaded`);
  const now = nowIso();
  const extra: Data = { updated_at: now };
  if ('superseded_by' in patch) {
    const next = patch.superseded_by ?? null;
    if (next === null) extra.superseded_at = null;
    else if (next !== (before.superseded_by ?? null)) extra.superseded_at = now;
  }
  const after = ws.update(ref, { ...patch, ...extra });
  syncCurrentGuard(ws, table, before, after);
  auditRowChange(ws, stamp, table, 'update', before, after);
  return after;
}

// ── Assurance (`app.batch_record_assurance`) ─────────────────────────────────────────────────────

const unreconciled = (batch: Data): boolean => Array.isArray(batch.batch_issues)
  && (batch.batch_issues as Data[]).some((i) => i && (i.code === 'IMP-BAL-006' || i.code === 'IMP-BAL-007'));

/** What a batch's commit stamps on its records: AI-read is inferred; an unreconciled PDF calculated. */
export function batchRecordAssurance(batch: Data): 'inferred' | 'calculated' | 'verified' {
  if (batch.extraction_method === 'pdf_claude') return 'inferred';
  if (batch.extraction_method === 'pdf_text') return unreconciled(batch) ? 'calculated' : 'verified';
  return 'verified';
}

// ── Building a record from an import row ─────────────────────────────────────────────────────────

/** A numeric(18,2) value as stored: a decimal string with two places, or null. */
export function money(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    return new Decimal(String(v)).toFixed(2);
  } catch {
    raise.invalid(`invalid input syntax for type numeric: "${String(v)}"`);
  }
}

const bool = (v: unknown): boolean | null => (v === null || v === undefined || v === '' ? null : v === true || v === 'true' || v === 't');

/** A row's mapped date for `col`, or the trigger's own refusal. */
function requireDate(m: Data, col: string, label = col): string {
  const d = isoDate(m[col]);
  if (!d) raise.invalid(`${label} is required to assign a fiscal period`);
  return d;
}

export interface RecordSource {
  readonly orgId: string;
  readonly batchId: string;
  readonly documentId: string | null;
  readonly bankAccountId: string | null;
  readonly assurance: string;
  readonly periods: ReadonlyMap<string, string>;
}

/**
 * The record an import row becomes — the column lists of `app.commit_import_batch`'s inserts (and
 * `app.promote_dependants`'), with every default the table would have filled in and the triggers'
 * derived columns (`period_id`, `description_normalized`, `balance_due`).
 */
export function recordFromRow(
  table: RecordTable, row: Data, src: RecordSource, id: string,
  extra: { recordStatus: string; duplicateReviewed: boolean; promotedFrom?: string | null; closing?: string | null; kind?: string; basis?: string },
): Data {
  const m = (row.mapped_data ?? {}) as Data;
  const now = nowIso();
  const base = {
    id, organization_id: src.orgId,
    source_document_id: src.documentId, import_batch_id: src.batchId, import_row_id: row.id, source_ref: str(row.source_ref),
    record_status: extra.recordStatus, assurance_level: src.assurance,
    superseded_by: null, superseded_at: null, rejected_reason: null,
    created_at: now, updated_at: now,
  };
  const currency = str(m.currency) ?? 'GBP';
  const period = (d: string) => src.periods.get(monthStart(d))!;
  switch (table) {
    case 'ledger_entries': {
      const date = requireDate(m, 'entry_date');
      return {
        ...base, entry_date: date, period_id: period(date), account_id: str(m.account_id),
        direction: str(m.direction), amount: money(m.amount), currency,
        description: str(m.description), reference: str(m.reference), counterparty_id: str(m.counterparty_id),
        journal_ref: str(m.journal_ref), dedupe_hash: str(row.dedupe_hash), duplicate_reviewed: extra.duplicateReviewed,
        is_opening_balance: bool(m.is_opening_balance) ?? false, promoted_from_batch_id: extra.promotedFrom ?? null,
      };
    }
    case 'bank_transactions': {
      const date = requireDate(m, 'transaction_date');
      const description = str(m.description);
      return {
        ...base, bank_account_id: src.bankAccountId, transaction_date: date, posted_date: isoDate(m.posted_date),
        period_id: period(date), amount: money(m.amount), currency, description_raw: description,
        description_normalized: maskDescription(description), counterparty_name_raw: str(m.counterparty_name),
        counterparty_id: str(m.counterparty_id), category_account_id: null, category_source: 'none',
        balance_after: money(m.balance_after), reference: str(m.reference), is_transfer: false,
        transfer_pair_id: null, transfer_kind: 'none', recurring_group_id: null, matched_ledger_entry_id: null,
        dedupe_hash: str(row.dedupe_hash), duplicate_reviewed: extra.duplicateReviewed,
        promoted_from_batch_id: extra.promotedFrom ?? null,
      };
    }
    case 'invoices': {
      const date = requireDate(m, 'issue_date');
      const total = money(m.total_amount);
      const paid = money(m.amount_paid) ?? '0.00';
      return {
        ...base, invoice_type: str(m.invoice_type), counterparty_id: str(m.counterparty_id),
        invoice_number: str(m.invoice_number), issue_date: date, due_date: isoDate(m.due_date), period_id: period(date),
        subtotal: money(m.subtotal), tax_amount: money(m.tax_amount), total_amount: total, amount_paid: paid,
        balance_due: total === null ? null : new Decimal(total).minus(paid).toFixed(2),
        currency, status: str(m.status) ?? 'open', paid_date: isoDate(m.paid_date), description: str(m.description),
        dedupe_hash: str(row.dedupe_hash), duplicate_reviewed: extra.duplicateReviewed,
        promoted_from_batch_id: extra.promotedFrom ?? null,
      };
    }
    case 'period_balances': {
      const date = requireDate(m, 'period_start');
      return {
        ...base, period_start: date, period_id: period(date), account_id: str(m.account_id),
        opening_balance: money(m.opening_balance), debit_total: money(m.debit_total), credit_total: money(m.credit_total),
        closing_balance: extra.closing ?? money(m.closing_balance), currency, balance_kind: extra.kind ?? 'balance_sheet',
        balance_basis: extra.basis ?? 'movement', duplicate_reviewed: extra.duplicateReviewed,
        promoted_from_batch_id: extra.promotedFrom ?? null,
      };
    }
    case 'budget_lines': {
      const date = monthStart(requireDate(m, 'period_start'));
      return {
        ...base, period_start: date, period_id: period(date), account_id: str(m.account_id),
        amount: money(m.amount), currency,
      };
    }
  }
}

/** NOT NULL columns of each record table that come from the row: a missing one fails like the insert did. */
const REQUIRED: Record<RecordTable, readonly string[]> = {
  ledger_entries: ['account_id', 'direction', 'amount'],
  bank_transactions: ['bank_account_id', 'amount'],
  invoices: ['invoice_type', 'counterparty_id', 'invoice_number', 'total_amount'],
  period_balances: ['account_id', 'closing_balance'],
  budget_lines: ['account_id', 'amount'],
};

/** `invoice_type_enum`: an invoice's side, and its credit notes. */
export const INVOICE_TYPES = ['sales', 'purchase', 'sales_credit_note', 'purchase_credit_note'] as const;
/** `invoice_status_enum`. */
export const INVOICE_STATUSES = ['open', 'partially_paid', 'paid', 'void'] as const;
/** `entry_direction_enum`. */
export const ENTRY_DIRECTIONS = ['debit', 'credit'] as const;

/** The enum columns the inserts cast from the row's text (`::public.…_enum`). */
const ENUMS: Partial<Record<RecordTable, ReadonlyArray<readonly [string, string, readonly string[]]>>> = {
  ledger_entries: [['direction', 'entry_direction_enum', ENTRY_DIRECTIONS]],
  invoices: [
    ['invoice_type', 'invoice_type_enum', INVOICE_TYPES],
    ['status', 'invoice_status_enum', INVOICE_STATUSES],
  ],
};

export function assertRecordComplete(table: RecordTable, rec: Data): void {
  for (const col of REQUIRED[table]) {
    if (rec[col] === null || rec[col] === undefined) {
      raise.invalid(`null value in column "${col}" of relation "${table}" violates not-null constraint`);
    }
  }
  for (const [col, name, values] of ENUMS[table] ?? []) {
    if (rec[col] !== null && !values.includes(String(rec[col]))) {
      raise.invalid(`invalid input value for enum ${name}: "${String(rec[col])}"`);
    }
  }
}

/** A reference a record names must be a row of the same organisation (the `same_org_ref` triggers). */
export async function assertSameOrg(ws: WorkingSet, orgId: string, table: OrgTable, id: string | null, label: string): Promise<void> {
  if (!id) return;
  const row = await ws.get(orgRow(ws.fs, orgId, table, id));
  if (!row) raise.invalid(`${label} references a row that does not exist`);
}

/** The organisation's lock document for import commits, rollbacks and attestations (see imports-commit.ts). */
export function importLockRef(fs: Firestore, orgId: string) {
  return orgDoc(fs, orgId).collection('_locks').doc('imports');
}

export { uidOf };
