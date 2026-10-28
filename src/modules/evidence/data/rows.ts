import 'server-only';
import Decimal from 'decimal.js';
import type { Query } from 'firebase-admin/firestore';
import { ValidationError } from '@/core/errors';
import { orgRows } from '@/db/rls';
import type { OrgTable } from '@/db/schema';
import type { Db } from '@/db/types';
import type { RecordStatusEvent, RecordStatusEventName, HistoryInterval } from '../domain/as-of';
import { RECORD_STATUS_EVENTS } from '../domain/as-of';
import type { CompiledFilter, CompiledQuery } from './descriptor-compiler';

/**
 * The I/O half of the resolver: fetching rows, lifecycle events and category history for the
 * **caller**, through the ported row policies (`src/db/rls.ts`), so the caller's permissions decide
 * what is visible (§3.1, ADR-013/ADR-026 reads). Nothing in this file reads as the server, and
 * nothing in it writes.
 */

export type Row = Record<string, unknown>;

/**
 * A hard ceiling on how many rows one descriptor may enumerate.
 *
 * `total` is Σ amount over the *whole* selection, not the returned page (§3), so the resolver has to
 * walk every matching row. Rather than quietly truncating — which would print a `total` that does
 * not reconcile and defeat the point of the number — the resolver refuses.
 */
export const MAX_SELECTION_ROWS = 50_000;

/** Firestore's ceiling on the values of one `in` filter. */
const IN_LIMIT = 30;

/**
 * The compiled filters, split into what Firestore runs and what is applied here.
 *
 * Equalities (`eq`, IS NULL) and ONE `in` of at most thirty values run in the query: equality
 * filters merge on single-field indexes, so no descriptor needs a composite index of its own. The
 * ranges, `neq` and any larger `in` are applied to the fetched rows with SQL's semantics — a NULL
 * never satisfies a comparison, and a number is compared as a number (money is a decimal string).
 */
function splitFilters(compiled: CompiledQuery): { query: CompiledFilter[]; post: CompiledFilter[] } {
  const query: CompiledFilter[] = [];
  const post: CompiledFilter[] = [];
  let inUsed = false;
  for (const filter of compiled.filters) {
    if (filter.op === 'eq' || filter.op === 'isNull') query.push(filter);
    else if (filter.op === 'in' && !inUsed && (filter.value as readonly string[]).length <= IN_LIMIT
      && (filter.value as readonly string[]).length > 0) {
      inUsed = true;
      query.push(filter);
    } else post.push(filter);
  }
  return { query, post };
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** SQL's comparison of a stored value with a filter value: numbers as numbers, the rest as text. */
function compare(stored: unknown, value: unknown): number {
  if (typeof value === 'number' || (typeof stored === 'number')) {
    return new Decimal(String(stored)).comparedTo(new Decimal(String(value)));
  }
  const a = String(stored);
  const b = String(value);
  if (NUMERIC.test(a) && NUMERIC.test(b)) return new Decimal(a).comparedTo(new Decimal(b));
  return a < b ? -1 : a > b ? 1 : 0;
}

function passes(row: Row, filter: CompiledFilter): boolean {
  const stored = row[filter.column];
  if (filter.op === 'isNull') return stored === null || stored === undefined;
  if (stored === null || stored === undefined) return false;
  switch (filter.op) {
    case 'eq': return compare(stored, filter.value) === 0;
    case 'neq': return compare(stored, filter.value) !== 0;
    case 'in': return (filter.value as readonly string[]).some((v) => compare(stored, v) === 0);
    case 'lt': return compare(stored, filter.value) < 0;
    case 'lte': return compare(stored, filter.value) <= 0;
    case 'gt': return compare(stored, filter.value) > 0;
    case 'gte': return compare(stored, filter.value) >= 0;
  }
}

/** PostgreSQL's ORDER BY: NULLs sort last ascending and first descending. */
function orderRows(rows: Row[], order: CompiledQuery['order']): void {
  rows.sort((x, y) => {
    for (const { column, ascending } of order) {
      const a = x[column];
      const b = y[column];
      const aNull = a === null || a === undefined;
      const bNull = b === null || b === undefined;
      if (aNull && bNull) continue;
      if (aNull || bNull) return (aNull ? 1 : -1) * (ascending ? 1 : -1);
      const c = compare(a, b);
      if (c !== 0) return ascending ? c : -c;
    }
    return 0;
  });
}

/**
 * Every matching row, in the descriptor's order, with only the descriptor's columns.
 *
 * The read is one organisation's collection — the descriptor carries no organization (§3) and a
 * bundle belongs to exactly one, so the scope is the collection named, never assumed from the
 * session. Only `compiled.columns` survive, so a column outside the allow-list (a raw bank
 * description) never reaches the resolver.
 */
export async function fetchSelectionRows(
  db: Db,
  orgId: string,
  compiled: CompiledQuery,
): Promise<Row[]> {
  const { query, post } = splitFilters(compiled);
  const fetched = await orgRows<Row>(db, orgId, compiled.table as OrgTable, (q) => {
    let next: Query = q;
    for (const filter of query) {
      if (filter.op === 'isNull') next = next.where(filter.column, '==', null);
      else if (filter.op === 'in') next = next.where(filter.column, 'in', [...(filter.value as readonly string[])]);
      else next = next.where(filter.column, '==', filter.value);
    }
    return next;
  });
  const rows = fetched.filter((row) => post.every((filter) => passes(row, filter)));
  if (rows.length > MAX_SELECTION_ROWS) {
    throw new ValidationError(
      'That evidence selection is too large to reconcile in one request.',
      [
        {
          path: 'filters',
          message: `A descriptor may enumerate at most ${MAX_SELECTION_ROWS} rows, because count and total are computed over the whole selection.`,
        },
      ],
    );
  }
  orderRows(rows, compiled.order);
  return rows.map((row) => Object.fromEntries(compiled.columns.map((c) => [c, row[c] ?? null])));
}

function isRecordStatusEvent(value: unknown): value is RecordStatusEventName {
  return typeof value === 'string' && (RECORD_STATUS_EVENTS as readonly string[]).includes(value);
}

/** Ids are read in batches of thirty, Firestore's ceiling on one `in` filter. */
const ID_BATCH = IN_LIMIT;

function batched<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * The lifecycle events at or before `instant` for the given records (ADR-034, ADR-047.1).
 *
 * `record_status_events` is append-only and readable under the T-data policy, so this is a plain
 * policy read.
 *
 * The tiebreak for events sharing an instant was the bigint identity `id`; a Firestore id is a uuid
 * and has no order. A stored `seq` is used when the writer records one; otherwise the event's place
 * in the lifecycle (`accepted` before `superseded` before `unsuperseded` …), which is the order one
 * transaction writes a record's events in.
 */
export async function fetchRecordStatusEvents(
  db: Db,
  orgId: string,
  recordTable: CompiledQuery['table'],
  recordIds: readonly string[],
  instant: string,
): Promise<RecordStatusEvent[]> {
  const events: RecordStatusEvent[] = [];
  const cutoff = new Date(instant).getTime();
  for (const batch of batched([...new Set(recordIds)], ID_BATCH)) {
    const rows = await orgRows<Row>(db, orgId, 'record_status_events',
      (q) => q.where('record_table', '==', recordTable).where('record_id', 'in', batch));
    for (const row of rows) {
      if (new Date(String(row.at)).getTime() > cutoff) continue;
      const event = row.event;
      if (!isRecordStatusEvent(event)) {
        // An enum value this build does not know is a schema change, not a row to guess at.
        throw new ValidationError('An unrecognised record status event was returned.', [
          { path: 'record_status_events.event', message: String(event) },
        ]);
      }
      events.push({
        recordId: String(row.record_id),
        event,
        at: String(row.at),
        seq: typeof row.seq === 'number' ? row.seq : RECORD_STATUS_EVENTS.indexOf(event),
      });
    }
  }
  return events;
}

export interface BankCategoryState {
  readonly categoryAccountId: string | null;
  readonly isTransfer: boolean;
  readonly transferKind: string;
}

/**
 * `category_history` for the given bank transactions (ADR-034, F-C-07): the category and
 * `transfer_kind` in force at an instant, so re-categorising one transaction later does not rewrite
 * what a past metric appears to be made of.
 */
export async function fetchCategoryHistory(
  db: Db,
  orgId: string,
  bankTransactionIds: readonly string[],
): Promise<Map<string, HistoryInterval<BankCategoryState>[]>> {
  const byRecord = new Map<string, HistoryInterval<BankCategoryState>[]>();
  for (const batch of batched([...new Set(bankTransactionIds)], ID_BATCH)) {
    const rows = await orgRows<Row>(db, orgId, 'category_history', (q) => q.where('bank_transaction_id', 'in', batch));
    for (const row of rows) {
      const key = String(row.bank_transaction_id);
      const list = byRecord.get(key) ?? [];
      list.push({
        validFrom: String(row.valid_from),
        validTo: row.valid_to === null || row.valid_to === undefined ? null : String(row.valid_to),
        value: {
          categoryAccountId:
            row.category_account_id === null || row.category_account_id === undefined
              ? null
              : String(row.category_account_id),
          isTransfer: row.is_transfer === true,
          transferKind: String(row.transfer_kind ?? 'none'),
        },
      });
      byRecord.set(key, list);
    }
  }
  return byRecord;
}

/**
 * `account_category_history` (ADR-034): an account's `standard_category` at an instant. Used for
 * *display* only — the descriptor may not filter by category (see domain/descriptor.ts) — so that
 * the records table shows the category the figure was built from, not today's.
 */
export async function fetchAccountCategoryHistory(
  db: Db,
  orgId: string,
  accountIds: readonly string[],
): Promise<Map<string, HistoryInterval<string>[]>> {
  const byAccount = new Map<string, HistoryInterval<string>[]>();
  for (const batch of batched([...new Set(accountIds)], ID_BATCH)) {
    const rows = await orgRows<Row>(db, orgId, 'account_category_history', (q) => q.where('account_id', 'in', batch));
    for (const row of rows) {
      const key = String(row.account_id);
      const list = byAccount.get(key) ?? [];
      list.push({
        validFrom: String(row.valid_from),
        validTo: row.valid_to === null || row.valid_to === undefined ? null : String(row.valid_to),
        value: String(row.standard_category),
      });
      byAccount.set(key, list);
    }
  }
  return byAccount;
}

/**
 * Each account's CURRENT `standard_category`. The fallback for a ledger line's sign when no
 * `account_category_history` interval covers the as-of instant, or when there is no as-of at all.
 */
export async function fetchAccountCategories(
  db: Db,
  orgId: string,
  accountIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const batch of batched([...new Set(accountIds)], ID_BATCH)) {
    const rows = await orgRows<Row>(db, orgId, 'accounts', (q) => q.where('id', 'in', batch));
    for (const row of rows) out.set(String(row.id), String(row.standard_category));
  }
  return out;
}
