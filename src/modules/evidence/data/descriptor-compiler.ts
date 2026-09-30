import { ValidationError } from '@/core/errors';
import type {
  DescriptorFilterKey,
  DescriptorFilters,
  DescriptorTable,
  QueryDescriptorV1,
} from '../domain/descriptor';

/**
 * The descriptor compiler (EVIDENCE_MODEL.md §3.1).
 *
 * "Compiles filters into a fixed query-builder mapping — an allow-list of columns per table; no
 * string interpolation." Two consequences that are easy to lose sight of:
 *
 *  * A filter key that is not allowed for the target table is a **ValidationError**, never a
 *    silently ignored key. A dropped filter widens a selection, and a widened selection stops
 *    reconciling to the metric it is supposed to evidence.
 *  * Nothing here builds a string. Column names come from the per-table tables below; values are
 *    passed to the query builder as values. There is no `.or('...')` anywhere: the one condition
 *    that would need it (an invoice open at a date: `paid_date IS NULL OR paid_date > d`) is
 *    emitted as a post-filter instead, evaluated in the resolver against fetched rows.
 *
 * `compileDescriptor` is a pure function returning a plain object, so the compilation of a fixture
 * descriptor can be asserted — and asserted to be identical twice — without a database.
 */

export type FilterOp = 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'isNull';

export interface CompiledFilter {
  readonly column: string;
  readonly op: FilterOp;
  readonly value: string | number | boolean | readonly string[] | null;
}

/**
 * A condition the database cannot express without either a `.or()` string or history the row does
 * not carry. Applied in the resolver, after the as-of state and category history are known.
 */
export type PostFilter =
  /** §3 / FINANCIAL_ENGINE.md §3 `receivables`: unpaid at the date (`paid_date > d` counts as unpaid). */
  | { readonly kind: 'open_at'; readonly date: string }
  /** ADR-034: with `as_of` the category comes from `category_history`, not the current column. */
  | { readonly kind: 'as_of_category_in'; readonly ids: readonly string[] }
  /** ADR-028: only `cash_transfer` legs are excluded; a card repayment is real cash movement. */
  | { readonly kind: 'as_of_exclude_cash_transfers' }
  | { readonly kind: 'as_of_exclude_all_transfers' };

export interface CompiledOrder {
  readonly column: string;
  readonly ascending: boolean;
}

export interface CompiledQuery {
  readonly table: DescriptorTable;
  /** Explicit select list; never `*`. */
  readonly columns: readonly string[];
  readonly filters: readonly CompiledFilter[];
  readonly postFilters: readonly PostFilter[];
  readonly order: readonly CompiledOrder[];
  /** The column summed into `total`, or `null` when a sum would be meaningless (or when `amountBasis` is not a column). */
  readonly amountColumn: string | null;
  /**
   * How a row's amount is read. `column` reads `amountColumn`. `invoice_net` applies the engine's
   * net-of-tax rule (`invoiceNetOfTax`, the mirror of `app.invoice_net`) signed by invoice type —
   * the basis every invoice-basis P&L figure is computed on. A receivables or payables descriptor
   * (one carrying `open_as_of` / `overdue_as_of`) keeps `balance_due`, because Σ balance_due IS that
   * figure; a P&L descriptor summed on `balance_due` listed a paid sale as £0 under revenue (ADR-105).
   *
   * `column_magnitude` reads the column's absolute value. A bank amount is signed, and an
   * outflow-direction selection therefore sums to the NEGATIVE of the figure it sits behind —
   * `cash_outflows` of £4,200.00 had a drill-down totalling −£4,200.00, while `cash_inflows`
   * matched, so the two halves of one statement disagreed about sign (ADR-109). The engine states
   * money out as a positive magnitude, as it does every expense, so the evidence does too. A
   * direction-filtered selection is all one way, so no row loses information by showing its size;
   * `transferKind` and the row's own description still say what each payment was.
   *
   * `ledger_reporting` reads a ledger line in REPORTING sign — the engine's account-type rule
   * (`ledgerLineAmount`) applied to the line's `direction` and its account's type at the as-of
   * instant. `ledger_entries.amount` is stored positive with the side in `direction`, so a plain
   * column sum added a refund to revenue instead of subtracting it: `revenue` 19,400.00 had a
   * drill-down of 21,400.00 (HIGH-6, ADR-111). A direction-filtered ledger selection is all one side
   * and keeps `column`.
   *
   * `invoice_open_at` totals a receivables or payables selection on the engine's own rule for what an
   * invoice still owed at the date (`invoiceOutstandingAt`): `balance_due`, or the whole
   * `total_amount` when it was paid AFTER the date, with credit notes subtracting (§3.4, ADR-047.5).
   * Σ `balance_due` read today's balance of every row: a March invoice paid in May counted £0 behind
   * March's receivables, and a credit note ADDED to what customers owed (ADR-120).
   *
   * `balance_reporting` reads a `period_balances` row's `closing_balance` — stored in NATURAL sign,
   * debit positive (ADR-027.1) — in reporting sign by the account's type at the as-of instant, the
   * rule the engine applies to every balance it reads. A trial-balance payables figure of 4,000.00
   * otherwise had a drill-down totalling −4,000.00 (ADR-120).
   */
  readonly amountBasis:
    | 'column' | 'invoice_net' | 'column_magnitude' | 'ledger_reporting' | 'invoice_open_at' | 'balance_reporting';
  /** The date an `invoice_open_at` selection is open at. */
  readonly openAt?: string;
  readonly asOf: { readonly calculationRunId: string; readonly aggregatedAt: string } | null;
  readonly limit: number;
  /** True for the four tables with a `record_status_events` lifecycle. */
  readonly hasRecordLifecycle: boolean;
}

/** The page size used when the descriptor omits `limit`. §6 shows "500 of 1,238 rows". */
export const DEFAULT_DESCRIPTOR_LIMIT = 500;

const CASH_TRANSFER = 'cash_transfer';

interface TableSpec {
  readonly columns: readonly string[];
  readonly filters: readonly DescriptorFilterKey[];
  readonly orderColumns: readonly string[];
  readonly amountColumn: string | null;
  readonly hasRecordLifecycle: boolean;
}

/**
 * The allow-list. A column absent from `columns` is never selected, a filter key absent from
 * `filters` is a ValidationError, and an order field absent from `orderColumns` is a
 * ValidationError.
 *
 * `bank_transactions.description_raw` and `counterparty_name_raw` are deliberately **not** here:
 * SELECT on those columns is revoked from `authenticated` because they carry a third party's sort
 * code and account number verbatim (ADR-038.4, ADR-044.2). Evidence shows
 * `description_normalized`.
 */
const TABLES: Record<DescriptorTable, TableSpec> = {
  ledger_entries: {
    columns: [
      'id', 'organization_id', 'entry_date', 'period_id', 'account_id', 'counterparty_id',
      'direction', 'amount', 'currency', 'description', 'reference', 'record_status',
      'assurance_level', 'superseded_by',
    ],
    filters: ['period_ids', 'account_ids', 'counterparty_ids', 'direction'],
    orderColumns: ['id', 'entry_date', 'amount', 'created_at'],
    // Unsigned: the sign lives in `direction` (see the ledger_entries table comment). Σ amount is
    // therefore Σ magnitude, which is what a direction-filtered driver list reconciles to.
    amountColumn: 'amount',
    hasRecordLifecycle: true,
  },
  bank_transactions: {
    columns: [
      'id', 'organization_id', 'transaction_date', 'period_id', 'bank_account_id',
      'counterparty_id', 'category_account_id', 'amount', 'currency', 'description_normalized',
      'reference', 'is_transfer', 'transfer_kind', 'record_status', 'assurance_level',
      'superseded_by',
    ],
    filters: [
      'period_ids', 'bank_account_ids', 'category_account_ids', 'counterparty_ids', 'direction',
      'exclude_transfers',
      'exclude_transfers',
  'exclude_cash_transfers',
    ],
    orderColumns: ['id', 'transaction_date', 'amount', 'created_at'],
    amountColumn: 'amount',
    hasRecordLifecycle: true,
  },
  invoices: {
    columns: [
      'id', 'organization_id', 'invoice_type', 'counterparty_id', 'invoice_number', 'issue_date',
      'due_date', 'period_id', 'subtotal', 'tax_amount', 'total_amount', 'amount_paid', 'balance_due',
      'currency', 'status', 'paid_date', 'description', 'record_status', 'assurance_level', 'superseded_by',
    ],
    filters: ['period_ids', 'counterparty_ids', 'invoice_types', 'open_as_of', 'overdue_as_of'],
    orderColumns: ['id', 'issue_date', 'due_date', 'total_amount', 'balance_due', 'created_at'],
    // See the module note in services/resolve.ts: the v1 invoice filters are the receivables /
    // payables ones, whose metric is Σ balance_due (FINANCIAL_ENGINE.md §3, `receivables`).
    amountColumn: 'balance_due',
    hasRecordLifecycle: true,
  },
  period_balances: {
    columns: [
      'id', 'organization_id', 'period_start', 'period_id', 'account_id', 'closing_balance',
      'currency', 'balance_kind', 'balance_basis', 'record_status', 'assurance_level',
      'superseded_by',
    ],
    filters: ['period_ids', 'account_ids'],
    orderColumns: ['id', 'period_start', 'closing_balance', 'created_at'],
    amountColumn: 'closing_balance',
    hasRecordLifecycle: true,
  },
  metric_snapshots: {
    columns: [
      'id', 'organization_id', 'calculation_run_id', 'period_id', 'metric_key', 'dimension_type',
      'dimension_id', 'value', 'unit', 'currency', 'basis', 'assurance_level', 'created_at',
    ],
    filters: ['period_ids', 'metric_keys', 'dimension'],
    orderColumns: ['id', 'created_at', 'value', 'metric_key', 'period_id'],
    // A snapshot selection mixes units (money, ratio, count, days). Summing them would produce a
    // number that means nothing, so `total` is null and the drawer reconciles per component.
    amountColumn: null,
    hasRecordLifecycle: false,
  },
};

/** Emission order for filters, fixed so two compilations of one descriptor are byte-identical. */
const FILTER_ORDER: readonly DescriptorFilterKey[] = [
  'period_ids',
  'account_ids',
  'counterparty_ids',
  'bank_account_ids',
  'category_account_ids',
  'invoice_types',
  'direction',
  'exclude_transfers',
  'exclude_cash_transfers',
  'open_as_of',
  'overdue_as_of',
  'metric_keys',
  'dimension',
];

function reject(message: string, path: string): never {
  throw new ValidationError('That evidence descriptor cannot be compiled.', [{ path, message }]);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted for the same reason the hash sorts: id order must not change the compiled query. */
function sortedIds(values: readonly string[]): readonly string[] {
  return [...values].sort(byCodeUnit);
}

class FilterSet {
  private readonly seen = new Set<string>();
  private readonly out: CompiledFilter[] = [];

  add(filter: CompiledFilter): void {
    const key = `${filter.column}|${filter.op}|${JSON.stringify(filter.value)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.out.push(filter);
  }

  list(): readonly CompiledFilter[] {
    return this.out;
  }
}

/**
 * "Open at date D": the invoice existed by D, is not void, and was not paid on or before D.
 * FINANCIAL_ENGINE.md §3 `receivables` — "if `paid_date > asOf` the invoice is treated as unpaid at
 * `asOf`". The nullable half of that test is the post-filter.
 */
function addOpenAt(filters: FilterSet, post: PostFilter[], date: string): void {
  filters.add({ column: 'issue_date', op: 'lte', value: date });
  addNotVoid(filters);
  post.push({ kind: 'open_at', date });
}

/**
 * A voided invoice is not a financial record of anything (ADR-107).
 *
 * `app.aggregate_periods` reads invoices under `record_status = 'accepted' and superseded_by is
 * null and status <> 'void'`, and every other invoice reader in the engine repeats that third
 * clause. The evidence layer carried only the first two, because the lifecycle pair is generic and
 * lives in the shared block while `status <> 'void'` sat inside `addOpenAt` — so the receivables and
 * payables shape excluded voided invoices and every P&L shape did not. A voided invoice therefore
 * appeared in the drill-down behind revenue, cost of sales, an expense category and a customer's
 * revenue, and from ADR-105 it contributed its full net to the total: the evidence behind a £3,250
 * figure summed to £10,250.
 *
 * `status` is an invoice's own business state, not a record-lifecycle event, so it is NOT in
 * `record_status_events` and is applied as a column predicate whether or not the selection is
 * pinned to a run — exactly as the engine's own re-read of the table applies it.
 */
function addNotVoid(filters: FilterSet): void {
  filters.add({ column: 'status', op: 'neq', value: 'void' });
}

function compileFilter(
  key: DescriptorFilterKey,
  descriptor: QueryDescriptorV1,
  filters: FilterSet,
  post: PostFilter[],
): void {
  const f: DescriptorFilters = descriptor.filters;
  const asOf = descriptor.as_of;

  switch (key) {
    case 'period_ids':
      if (f.period_ids) filters.add({ column: 'period_id', op: 'in', value: sortedIds(f.period_ids) });
      return;
    case 'account_ids':
      if (f.account_ids) filters.add({ column: 'account_id', op: 'in', value: sortedIds(f.account_ids) });
      return;
    case 'counterparty_ids':
      if (f.counterparty_ids) {
        filters.add({ column: 'counterparty_id', op: 'in', value: sortedIds(f.counterparty_ids) });
      }
      return;
    case 'bank_account_ids':
      if (f.bank_account_ids) {
        filters.add({ column: 'bank_account_id', op: 'in', value: sortedIds(f.bank_account_ids) });
      }
      return;
    case 'category_account_ids':
      if (!f.category_account_ids) return;
      // ADR-034: with as_of the category in force comes from category_history, so it cannot be a
      // column predicate — the row's current category may be a later recategorisation.
      if (asOf) post.push({ kind: 'as_of_category_in', ids: sortedIds(f.category_account_ids) });
      else {
        filters.add({
          column: 'category_account_id',
          op: 'in',
          value: sortedIds(f.category_account_ids),
        });
      }
      return;
    case 'invoice_types':
      if (f.invoice_types) {
        filters.add({ column: 'invoice_type', op: 'in', value: sortedIds(f.invoice_types) });
      }
      return;
    case 'direction': {
      const direction = f.direction;
      if (!direction) return;
      if (descriptor.table === 'ledger_entries') {
        if (direction !== 'debit' && direction !== 'credit') {
          reject(
            `direction '${direction}' is a cash direction; ledger_entries takes 'debit' or 'credit'`,
            'filters.direction',
          );
        }
        filters.add({ column: 'direction', op: 'eq', value: direction });
        return;
      }
      // bank_transactions: the amount is signed and the statement's own semantics are inflow /
      // outflow, so direction is a predicate on the sign rather than on a column.
      if (direction !== 'inflow' && direction !== 'outflow') {
        reject(
          `direction '${direction}' is a ledger direction; bank_transactions takes 'inflow' or 'outflow'`,
          'filters.direction',
        );
      }
      filters.add({ column: 'amount', op: direction === 'inflow' ? 'gt' : 'lt', value: 0 });
      return;
    }
    case 'exclude_transfers': {
      // 'all' drops every transfer leg, which is what the bank-basis P&L proxy needs: a transfer is
      // never income or expenditure whatever its kind (§4.4, ADR-047.12). 'cash_only' drops just the
      // cash-neutral pairs, so a card repayment stays in the cash figures (ADR-028).
      if (f.exclude_transfers === 'all') {
        if (asOf) post.push({ kind: 'as_of_exclude_all_transfers' });
        else filters.add({ column: 'is_transfer', op: 'eq', value: false });
      } else if (f.exclude_transfers === 'cash_only') {
        if (asOf) post.push({ kind: 'as_of_exclude_cash_transfers' });
        else filters.add({ column: 'transfer_kind', op: 'neq', value: CASH_TRANSFER });
      }
      return;
    }
    case 'exclude_cash_transfers':
      // The original spelling, equivalent to 'cash_only'. Kept so descriptors already written by an
      // earlier run stay resolvable — evidence must outlive the schema that produced it.
      if (f.exclude_cash_transfers !== true) return;
      if (f.exclude_transfers) return;   // the canonical key wins when both are present
      if (asOf) post.push({ kind: 'as_of_exclude_cash_transfers' });
      else filters.add({ column: 'transfer_kind', op: 'neq', value: CASH_TRANSFER });
      return;
    case 'open_as_of':
      if (f.open_as_of) addOpenAt(filters, post, f.open_as_of);
      return;
    case 'overdue_as_of':
      if (!f.overdue_as_of) return;
      addOpenAt(filters, post, f.overdue_as_of);
      // `due_date < d` also drops invoices with no due date, which is the documented behaviour:
      // they are excluded and counted in data_quality.warnings.no_due_dates (FINANCIAL_ENGINE.md §3).
      filters.add({ column: 'due_date', op: 'lt', value: f.overdue_as_of });
      return;
    case 'metric_keys':
      if (f.metric_keys) filters.add({ column: 'metric_key', op: 'in', value: [...f.metric_keys] });
      return;
    case 'dimension':
      if (!f.dimension) return;
      filters.add({ column: 'dimension_type', op: 'eq', value: f.dimension.type });
      filters.add({ column: 'dimension_id', op: 'eq', value: f.dimension.id });
      return;
  }
}

export function compileDescriptor(descriptor: QueryDescriptorV1): CompiledQuery {
  const spec = TABLES[descriptor.table];
  const allowed = new Set<DescriptorFilterKey>(spec.filters);

  for (const key of Object.keys(descriptor.filters) as DescriptorFilterKey[]) {
    if (descriptor.filters[key] === undefined) continue;
    if (!allowed.has(key)) {
      reject(`filter '${key}' is not available on ${descriptor.table}`, `filters.${key}`);
    }
  }

  const filters = new FilterSet();
  const post: PostFilter[] = [];

  if (descriptor.as_of && descriptor.table === 'metric_snapshots') {
    // §3: pin the run. This is the whole reason metric_snapshots may not be selected without as_of.
    filters.add({
      column: 'calculation_run_id',
      op: 'eq',
      value: descriptor.as_of.calculation_run_id,
    });
  }

  if (spec.hasRecordLifecycle && !descriptor.as_of) {
    // §3: without as_of the resolver returns currently accepted, non-superseded rows. With as_of no
    // status predicate is emitted at all — the events decide, because a row rejected today may have
    // been accepted then, and a row accepted today may not have existed yet.
    filters.add({ column: 'record_status', op: 'eq', value: 'accepted' });
    filters.add({ column: 'superseded_by', op: 'isNull', value: null });
  }

  // The third clause of the engine's invoice eligibility rule, for EVERY invoice shape (ADR-107).
  if (descriptor.table === 'invoices') addNotVoid(filters);

  for (const key of FILTER_ORDER) compileFilter(key, descriptor, filters, post);

  const order: CompiledOrder[] = descriptor.order.map((entry) => {
    if (!spec.orderColumns.includes(entry.field)) {
      reject(`order field '${entry.field}' is not available on ${descriptor.table}`, 'order');
    }
    return { column: entry.field, ascending: entry.dir === 'asc' };
  });

  // An invoice descriptor with no open/overdue filter is a P&L selection (revenue, cost of sales,
  // an expense category, a customer's revenue): its amount is the net the engine summed, not the
  // balance still owed (ADR-105).
  const invoicePnl = descriptor.table === 'invoices'
    && descriptor.filters.open_as_of === undefined
    && descriptor.filters.overdue_as_of === undefined;

  /*
   * A signed bank amount under a direction filter: the figure is a magnitude, so the total is too
   * (ADR-109). `inflow` rows are already positive, so this changes nothing for them.
   */
  const bankDirectional = descriptor.table === 'bank_transactions'
    && descriptor.filters.direction !== undefined;

  // A ledger selection over both sides is totalled in reporting sign (ADR-111).
  const ledgerNetted = descriptor.table === 'ledger_entries'
    && descriptor.filters.direction === undefined;

  // A balance selection totals in reporting sign, like a two-sided ledger selection (ADR-120).
  const balanceNetted = descriptor.table === 'period_balances';

  // A receivables / payables selection totals on the engine's outstanding-at rule (ADR-120).
  const openAt = descriptor.table === 'invoices'
    ? descriptor.filters.open_as_of ?? descriptor.filters.overdue_as_of
    : undefined;

  return {
    table: descriptor.table,
    columns: spec.columns,
    filters: filters.list(),
    postFilters: post,
    order,
    amountColumn: invoicePnl ? null : spec.amountColumn,
    amountBasis: invoicePnl
      ? 'invoice_net'
      : openAt !== undefined ? 'invoice_open_at'
      : balanceNetted ? 'balance_reporting'
      : bankDirectional ? 'column_magnitude' : ledgerNetted ? 'ledger_reporting' : 'column',
    ...(openAt !== undefined ? { openAt } : {}),
    asOf: descriptor.as_of
      ? {
          calculationRunId: descriptor.as_of.calculation_run_id,
          aggregatedAt: descriptor.as_of.aggregated_at,
        }
      : null,
    limit: descriptor.limit ?? DEFAULT_DESCRIPTOR_LIMIT,
    hasRecordLifecycle: spec.hasRecordLifecycle,
  };
}
