import 'server-only';
import Decimal from 'decimal.js';
import type { DocumentData, DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import type { Permission } from '@/core/permissions';
import { raise } from '../raise';
import { globalRow, newId, nowIso, orgCollection, orgRow, uniqueGuard, type OrgTable } from '../schema';
import { readerOf, uidOf, type Db, type Reader } from '../types';
import { requirePermission } from './access';
import { prepareAudit, type PreparedAudit } from './audit';
import { heldNameKey, normalizeName } from './shared';
import { throttle } from './throttle';

/**
 * Helpers of the Financials, Banking, Commercial, Marketing and Engagement area (Team F), ported
 * from the `app` schema and from the triggers on this area's tables (FIRESTORE_DATA_MODEL.md §4, §6):
 * finding a row handed over by id alone, the `rpc` throttle, the `audit_diff` trigger, the
 * `derive_normalized_name` trigger and its unique key, `write_category_history`, `flag_runs_stale`,
 * and the readers that stand in for SQL's casts and CHECK constraints.
 *
 * Every `prepare*` does its reads now and returns a `write(tx)` that only writes (§7).
 */

type Row = Record<string, unknown>;

// ── The rpc throttle ─────────────────────────────────────────────────────────────────────────────

/**
 * `app.throttle(app.uid(), 'rpc', limit, interval '1 minute')`, the first line of most functions.
 * It is its own small transaction (the shared counter), so it counts even when the function then
 * refuses — the SQL counted inside the function's transaction and rolled a refused call back.
 */
export async function rpcThrottle(db: Db, limit = 120): Promise<void> {
  await throttle(db.fs, uidOf(db), 'rpc', limit, 60);
}

// ── Locating a row by id alone ───────────────────────────────────────────────────────────────────

export interface LocatedRow {
  readonly orgId: string;
  readonly ref: DocumentReference;
  readonly data: DocumentData;
}

/**
 * `select organization_id … from public.<table> where id = p_x`: the functions handed a bare id
 * (`p_account`, `p_txn`, `p_item` …) find the row's organisation first, then check the caller can
 * reach it, so "not reachable" and "does not exist" are the same NotFound (SECURITY_MODEL.md §14).
 *
 * A collection-group equality on `id` (a single-field collection-group index on `{table}.id`). The
 * organisation is taken from the document's PATH, never from its `organization_id` field.
 */
export async function locateOrgRow(fs: Firestore, table: OrgTable, id: string | null): Promise<LocatedRow | null> {
  if (!id) return null;
  const snap = await fs.collectionGroup(table).where('id', '==', id).limit(5).get();
  for (const doc of snap.docs) {
    const org = doc.ref.parent.parent;
    if (!org || org.parent.id !== 'organizations') continue;
    return { orgId: org.id, ref: doc.ref, data: doc.data() };
  }
  return null;
}

/** `locateOrgRow`, or NotFound. */
export async function locateOrNotFound(fs: Firestore, table: OrgTable, id: string | null): Promise<LocatedRow> {
  const found = await locateOrgRow(fs, table, id);
  if (!found) raise.notFound();
  return found;
}

/** Reads one org row inside a transaction; NotFound when it is gone (it may have moved since). */
export async function readRow(tx: Transaction, fs: Firestore, orgId: string, table: OrgTable, id: string): Promise<Row> {
  const snap = await tx.get(orgRow(fs, orgId, table, id));
  if (!snap.exists) raise.notFound();
  return snap.data()!;
}

/**
 * `app.require_commercial_edit(org)`: the rpc throttle, then a reachable organisation (NotFound) and
 * `customers.edit`.
 */
export async function requireCommercialEdit(db: Db, orgId: string | null): Promise<void> {
  await rpcThrottle(db);
  await requirePermission(db, orgId, 'customers.edit' as Permission);
}

// ── The audit_diff trigger ───────────────────────────────────────────────────────────────────────

/**
 * `app.audit_diff()`: one `db.<table>.<op>` event with the whole row before and after and
 * `{source: 'trigger'}`, for the audited tables this area writes (accounts, bank_accounts,
 * bank_transactions, ledger_entries, invoices, period_balances, budget_lines, organizations).
 */
export async function prepareRowAudit(
  db: Db, table: string, op: 'insert' | 'update' | 'delete', before: Row | null, after: Row | null, tx?: Transaction,
): Promise<PreparedAudit> {
  const row = after ?? before ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  return prepareAudit(db, {
    organizationId: table === 'organizations' ? str(row.id) : str(row.organization_id),
    action: `db.${table}.${op}`,
    targetTable: table,
    targetId: str(row.id) ?? str(row.user_id) ?? str(row.organization_id),
    before: op === 'insert' ? null : before,
    after: op === 'delete' ? null : after,
    metadata: { source: 'trigger' },
  }, tx);
}

// ── Names: derive_normalized_name and the *_name_unique guard ───────────────────────────────────

export interface PreparedName {
  /** The row's new `normalized_name`. */
  readonly normalized: string;
  write(tx: Transaction): void;
}

/**
 * The `derive_normalized_name` trigger (ADR-052.8, ADR-136) and the table's unique key, for a row
 * whose `name` is being written (an insert, or an UPDATE whose SET names `name`, which fires the
 * trigger even when the value is unchanged):
 *
 *  1. a name whose records await an identity decision (another row of the table keyed
 *     `<key> [held …]`, not merged away) is refused, so this row cannot become "the" one;
 *  2. `normalized_name` is always derived from the name, never taken from the caller;
 *  3. the `<constraint>` guard (key `[normalized_name]`) moves with it: the old key is released and
 *     the new one taken, and a key another row holds is CONFLICT with `conflictMessage`.
 */
export async function prepareName(
  fs: Firestore, tx: Transaction,
  input: {
    orgId: string; table: OrgTable; constraint: string; rowId: string; name: string;
    previousNormalized: string | null; conflictMessage: string;
  },
): Promise<PreparedName> {
  const key = normalizeName(input.name);
  const prefix = heldNameKey(key, '');
  const heldPrefix = prefix.slice(0, prefix.length - 1); // `<key> [held `
  const held = await tx.get(orgCollection(fs, input.orgId, input.table)
    .where('normalized_name', '>=', heldPrefix).where('normalized_name', '<', `${heldPrefix}￿`));
  const blocker = held.docs.map((d) => d.data()).find((r) => r.id !== input.rowId
    && (input.table !== 'counterparties' || r.merged_into_id === null || r.merged_into_id === undefined));
  if (blocker) {
    raise.conflict(`"${input.name}" shares its name with "${String(blocker.name)}", and they await a decision about whether they are the same; rename or merge them first`);
  }

  const fresh = await uniqueGuard(fs, { orgId: input.orgId }, input.constraint, [key]).read(tx);
  if (fresh.owner && fresh.owner !== input.rowId) raise.conflict(input.conflictMessage, { existingId: fresh.owner });
  const moving = input.previousNormalized !== null && input.previousNormalized !== key;
  const old = moving
    ? await uniqueGuard(fs, { orgId: input.orgId }, input.constraint, [input.previousNormalized]).read(tx)
    : null;
  return {
    normalized: key,
    write(t) {
      if (old && old.owner === input.rowId) old.release(t);
      fresh.take(t, input.rowId, input.conflictMessage);
    },
  };
}

// ── Category history ─────────────────────────────────────────────────────────────────────────────

/**
 * `app.write_category_history(org, txn, category, is_transfer, kind, source)`: close the open
 * `category_history` row of a transaction and open the next — so a figure computed as of an earlier
 * run can still say which category produced it (ADR-034). History rows only ever have `valid_to`
 * set once (`history_close_only`).
 */
export async function prepareCategoryHistory(
  db: Db, tx: Transaction, orgId: string, txnId: string,
  entry: { categoryAccountId: string | null; isTransfer: boolean; transferKind: string; source: string },
): Promise<{ write(t: Transaction): void }> {
  const open = await tx.get(orgCollection(db.fs, orgId, 'category_history')
    .where('bank_transaction_id', '==', txnId).where('valid_to', '==', null));
  const actor = uidOf(db);
  return {
    write(t) {
      const now = nowIso();
      for (const d of open.docs) t.update(d.ref, { valid_to: now });
      const id = newId();
      t.set(orgRow(db.fs, orgId, 'category_history', id), {
        id, organization_id: orgId, bank_transaction_id: txnId, category_account_id: entry.categoryAccountId,
        is_transfer: entry.isTransfer, transfer_kind: entry.transferKind, source: entry.source,
        valid_from: now, valid_to: null, changed_by: actor, created_at: now,
      });
    },
  };
}

/** `app.flag_runs_stale()`: a running calculation read data that just changed, so it is stale. */
export async function prepareFlagRunsStale(fs: Firestore, tx: Transaction, orgId: string): Promise<{ write(t: Transaction): void }> {
  const running = await tx.get(orgCollection(fs, orgId, 'calculation_runs').where('status', '==', 'running'));
  return { write(t) { for (const d of running.docs) t.update(d.ref, { stale: true }); } };
}

// ── The organisation ─────────────────────────────────────────────────────────────────────────────

/** The `organizations` row (the caller's reach is checked by the function before this). */
export async function readOrganization(fs: Firestore, orgId: string, r: Reader = readerOf()): Promise<Row> {
  const snap = await r.get(globalRow(fs, 'organizations', orgId));
  if (!snap.exists) raise.notFound();
  return snap.data()!;
}

/**
 * Today's date in the organisation's time zone — `(now() at time zone o.timezone)::date`.
 * `en-CA` formats as `YYYY-MM-DD`.
 */
export function todayIn(timeZone: string | null | undefined, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

// ── Value readers (the SQL casts and CHECK constraints) ─────────────────────────────────────────

/** `x::some_enum`: an unknown label was `22P02`; here it is a VALIDATION with the label named. */
export function enumValue<T extends string>(values: readonly T[], value: unknown, what: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    raise.invalid(`invalid input value for enum ${what}: "${String(value)}"`);
  }
  return value as T;
}

/** `x::numeric`: a Decimal, null for SQL NULL; not a number → VALIDATION. */
export function decimalOf(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? String(value) : String(value).trim();
  let d: Decimal;
  try {
    d = new Decimal(text);
  } catch {
    raise.invalid(`invalid input syntax for type numeric: "${text}"`);
  }
  if (!d.isFinite()) raise.invalid(`invalid input syntax for type numeric: "${text}"`);
  return d;
}

/** A `numeric(p, s)` column stores the value rounded to its scale (half away from zero). */
export function scaled(value: Decimal, scale: number): string {
  return value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed(scale);
}

/** `x::date`: `YYYY-MM-DD` (an ISO timestamp is cut to its date, as the cast did); null stays null. */
export function dateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    raise.invalid(`invalid input syntax for type date: "${text}"`);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** `x::boolean` from a jsonb `->>` read; null stays null. */
export function boolValue(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  const t = String(value).trim().toLowerCase();
  if (['true', 't', 'yes', 'y', 'on', '1'].includes(t)) return true;
  if (['false', 'f', 'no', 'n', 'off', '0'].includes(t)) return false;
  return raise.invalid(`invalid input syntax for type boolean: "${String(value)}"`);
}

/** `x::uuid`; null stays null. */
export function uuidValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) {
    raise.invalid(`invalid input syntax for type uuid: "${String(value)}"`);
  }
  return text;
}

/** A jsonb `->>` read: SQL text or null (a JSON number or boolean reads as its text). */
export function textOf(obj: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = obj?.[key];
  if (v === undefined || v === null) return null;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** `nullif(x, '')`. */
export function nonEmpty(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

/** `jsonb ? key`. */
export function has(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** The PostgreSQL sentence for a CHECK constraint the row would break (`23514` → CONFLICT). */
export function checkViolation(table: string, constraint: string): never {
  return raise.conflict(`new row for relation "${table}" violates check constraint "${constraint}"`);
}

/** `length(x)` in characters (code points), as PostgreSQL counts them. */
export function charLength(text: string): number {
  return [...text].length;
}

/** `left(x, n)` in characters. */
export function leftChars(text: string, n: number): string {
  return [...text].slice(0, n).join('');
}

/** `btrim(x)`: PostgreSQL trims spaces only. */
export function btrim(text: string): string {
  return text.replace(/^ +| +$/g, '');
}

/** Two jsonb values are equal (key order does not matter, as in jsonb). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, canon((v as Row)[k])]));
    }
    return v === undefined ? null : v;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export const STANDARD_CATEGORY_VALUES = [
  'revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'payroll', 'marketing',
  'interest_expense', 'tax_expense', 'depreciation', 'other_expense', 'cash', 'receivables',
  'inventory', 'other_current_asset', 'fixed_asset', 'other_asset', 'payables', 'credit_card',
  'loan', 'tax_liability', 'other_current_liability', 'long_term_liability', 'equity', 'drawings',
  'transfer', 'uncategorised',
] as const;
export const BANK_ACCOUNT_TYPES = ['current', 'savings', 'credit_card', 'loan', 'other'] as const;
export const COUNTERPARTY_KINDS = ['customer', 'supplier', 'both', 'unknown'] as const;
export const FINANCIAL_RECORD_TABLES = ['ledger_entries', 'bank_transactions', 'invoices', 'period_balances', 'budget_lines'] as const;
