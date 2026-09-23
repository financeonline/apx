import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError, ValidationError } from '@/core/errors';
import type { RecordStatusEvent, RecordStatusEventName, HistoryInterval } from '../domain/as-of';
import { RECORD_STATUS_EVENTS } from '../domain/as-of';
import type { CompiledQuery } from './descriptor-compiler';

/**
 * The I/O half of the resolver: fetching rows, lifecycle events and category history with the
 * **caller's** user-scoped client, so RLS decides what is visible (§3.1, ADR-013/ADR-026 reads).
 * Nothing in this file takes a service client, and nothing in it writes.
 */

export type Row = Record<string, unknown>;

/** PostgREST caps a response; the selection is walked in blocks of this size. */
const FETCH_BLOCK = 1000;

/**
 * A hard ceiling on how many rows one descriptor may enumerate.
 *
 * `total` is Σ amount over the *whole* selection, not the returned page (§3), so the resolver has to
 * walk every matching row. In SQL that is one aggregate; over PostgREST it is a scan. Rather than
 * quietly truncating — which would print a `total` that does not reconcile and defeat the point of
 * the number — the resolver refuses. Moving `count`/`total` into an `api.*` aggregate belongs with
 * the engine work in Phase 6, where `app.aggregate_periods` already lives.
 */
export const MAX_SELECTION_ROWS = 50_000;

/**
 * The slice of the PostgREST builder the compiler needs, described structurally rather than
 * imported from `@supabase/postgrest-js`. The compiled filters are a closed set of six operators
 * and an IS NULL; anything outside this interface cannot be reached from a descriptor.
 */
interface Builder {
  eq(column: string, value: unknown): Builder;
  neq(column: string, value: unknown): Builder;
  in(column: string, values: readonly unknown[]): Builder;
  lt(column: string, value: unknown): Builder;
  lte(column: string, value: unknown): Builder;
  gt(column: string, value: unknown): Builder;
  is(column: string, value: null): Builder;
  order(column: string, options: { ascending: boolean }): Builder;
  range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
}

function applyFilters(builder: Builder, compiled: CompiledQuery): Builder {
  let q = builder;
  for (const filter of compiled.filters) {
    switch (filter.op) {
      case 'eq':
        q = q.eq(filter.column, filter.value);
        break;
      case 'neq':
        q = q.neq(filter.column, filter.value);
        break;
      case 'in':
        q = q.in(filter.column, filter.value as readonly string[]);
        break;
      case 'lt':
        q = q.lt(filter.column, filter.value);
        break;
      case 'lte':
        q = q.lte(filter.column, filter.value);
        break;
      case 'gt':
        q = q.gt(filter.column, filter.value);
        break;
      case 'isNull':
        q = q.is(filter.column, null);
        break;
    }
  }
  return q;
}

/**
 * Every matching row, in the descriptor's order.
 *
 * `organization_id` is filtered explicitly even though RLS already restricts the caller to their
 * accessible organizations: the descriptor carries no organization (§3) and a bundle belongs to
 * exactly one, so the scope is asserted here rather than assumed from the session.
 */
export async function fetchSelectionRows(
  db: SupabaseClient,
  orgId: string,
  compiled: CompiledQuery,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset <= MAX_SELECTION_ROWS; offset += FETCH_BLOCK) {
    const base = db.from(compiled.table).select(compiled.columns.join(',')) as unknown as Builder;
    let q = applyFilters(base.eq('organization_id', orgId), compiled);
    for (const order of compiled.order) q = q.order(order.column, { ascending: order.ascending });

    const { data, error } = await q.range(offset, offset + FETCH_BLOCK - 1);
    if (error) throw toMotionError(error);

    const block = (data ?? []) as Row[];
    rows.push(...block);
    if (block.length < FETCH_BLOCK) return rows;
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
  }
  return rows;
}

function isRecordStatusEvent(value: unknown): value is RecordStatusEventName {
  return typeof value === 'string' && (RECORD_STATUS_EVENTS as readonly string[]).includes(value);
}

/** Ids are sent to PostgREST in batches so one URL never carries fifty thousand uuids. */
const ID_BATCH = 300;

function batched<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * The lifecycle events at or before `instant` for the given records (ADR-034, ADR-047.1).
 *
 * `record_status_events` is append-only and readable under the T-data policy, so this is a plain
 * RLS read. `id` comes back because it is the tiebreak for events sharing an instant.
 */
export async function fetchRecordStatusEvents(
  db: SupabaseClient,
  orgId: string,
  recordTable: CompiledQuery['table'],
  recordIds: readonly string[],
  instant: string,
): Promise<RecordStatusEvent[]> {
  const events: RecordStatusEvent[] = [];
  for (const batch of batched(recordIds, ID_BATCH)) {
    const { data, error } = await db
      .from('record_status_events')
      .select('id,record_id,event,at')
      .eq('organization_id', orgId)
      .eq('record_table', recordTable)
      .in('record_id', batch)
      .lte('at', instant);
    if (error) throw toMotionError(error);
    for (const row of (data ?? []) as Row[]) {
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
        seq: Number(row.id),
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
  db: SupabaseClient,
  orgId: string,
  bankTransactionIds: readonly string[],
): Promise<Map<string, HistoryInterval<BankCategoryState>[]>> {
  const byRecord = new Map<string, HistoryInterval<BankCategoryState>[]>();
  for (const batch of batched(bankTransactionIds, ID_BATCH)) {
    const { data, error } = await db
      .from('category_history')
      .select('bank_transaction_id,category_account_id,is_transfer,transfer_kind,valid_from,valid_to')
      .eq('organization_id', orgId)
      .in('bank_transaction_id', batch);
    if (error) throw toMotionError(error);
    for (const row of (data ?? []) as Row[]) {
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
  db: SupabaseClient,
  orgId: string,
  accountIds: readonly string[],
): Promise<Map<string, HistoryInterval<string>[]>> {
  const byAccount = new Map<string, HistoryInterval<string>[]>();
  for (const batch of batched(accountIds, ID_BATCH)) {
    const { data, error } = await db
      .from('account_category_history')
      .select('account_id,standard_category,valid_from,valid_to')
      .eq('organization_id', orgId)
      .in('account_id', batch);
    if (error) throw toMotionError(error);
    for (const row of (data ?? []) as Row[]) {
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
  db: SupabaseClient,
  orgId: string,
  accountIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const batch of batched(accountIds, ID_BATCH)) {
    const { data, error } = await db
      .from('accounts')
      .select('id,standard_category')
      .eq('organization_id', orgId)
      .in('id', batch);
    if (error) throw toMotionError(error);
    for (const row of (data ?? []) as Row[]) out.set(String(row.id), String(row.standard_category));
  }
  return out;
}
