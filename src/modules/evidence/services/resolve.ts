import 'server-only';
import { NotFound } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { parseDecimalOrNull, sum, toMoneyString, type Decimal } from '@/core/money';
import { invoiceNetOfTax, invoiceSignFor } from '@/modules/financial-engine';
import type { InvoiceStatus, InvoiceType } from '@/modules/financials';
import type { AccessContext } from '@/modules/tenancy';
import {
  selectVisibleRecordIds,
  valueInForceAt,
  type HistoryInterval,
  type RecordStatusEvent,
} from '../domain/as-of';
import { parseQueryDescriptor, type DescriptorTable, type QueryDescriptorV1 } from '../domain/descriptor';
import { compileDescriptor, type CompiledQuery, type PostFilter } from '../data/descriptor-compiler';
import {
  fetchAccountCategoryHistory,
  fetchCategoryHistory,
  fetchRecordStatusEvents,
  fetchSelectionRows,
  type BankCategoryState,
  type Row,
} from '../data/rows';

/**
 * `resolveDescriptor` (EVIDENCE_MODEL.md §3.1).
 *
 * The one guarantee everything else rests on: **the same descriptor with the same `as_of` returns
 * the same rows in the same order**, before and after an account remap, a bank recategorisation, a
 * supersession, a counterparty merge, a rollback or a restore (§8.7).
 *
 * How that is achieved here:
 *  * identities are stable — a descriptor names ids, never categories (ADR-034);
 *  * membership at `as_of.aggregated_at` is reconstructed from the append-only
 *    `record_status_events` log, never from `updated_at` or the `superseded_by` column, which a
 *    rollback resets (ADR-047.1);
 *  * the category and `transfer_kind` of a bank row come from `category_history` as of the same
 *    instant, so a later recategorisation cannot move a row into or out of a past selection;
 *  * ordering ends in `id asc`, so paging is a total order.
 *
 * Money never becomes a JS number: amounts arrive as strings, are summed as `Decimal`, and leave as
 * strings (ADR-006, §2.3 `resolved.total?: string`).
 */

export interface Cursor {
  readonly offset: number;
}

/** One row of the drawer's level 3 table (§6). */
export interface RecordView {
  readonly id: string;
  readonly table: DescriptorTable;
  readonly date: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly counterpartyId: string | null;
  /** The account (ledger/balances) or the as-of category account (bank rows). */
  readonly accountId: string | null;
  /** `accounts.standard_category` in force at the as-of instant, for display only. */
  readonly standardCategory: string | null;
  /** NUMERIC as a string; never a JS number (ADR-006). */
  readonly amount: string | null;
  readonly currency: string | null;
  readonly direction: string | null;
  readonly transferKind: string | null;
  readonly recordStatus: string | null;
  readonly superseded: boolean;
  readonly assuranceLevel: string | null;
  /** metric_snapshots only. */
  readonly metricKey: string | null;
}

export interface ResolvedSelection {
  readonly rows: RecordView[];
  /** Rows in the WHOLE selection, not in the returned page. */
  readonly count: number;
  /** Σ amount over the whole selection, so a truncated list still reconciles to the metric (§3). */
  readonly total: string | null;
  readonly nextCursor?: Cursor;
}

function str(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

/**
 * The organization the caller is acting in. `NotFound` rather than a permission error: §8.4 says
 * evidence outside the caller's organization must not even confirm its existence.
 */
export function requireOrgId(ctx: AccessContext): string {
  if (!ctx.orgId) throw new NotFound();
  return ctx.orgId;
}

/** §8.4: a bundle of organization A requested with organization B's context returns NotFound. */
export function assertBundleOrg(ctx: AccessContext, bundleOrgId: string | null): string {
  const orgId = requireOrgId(ctx);
  if (bundleOrgId !== orgId) throw new NotFound();
  return orgId;
}

interface AsOfProjection {
  readonly bankCategory: Map<string, BankCategoryState>;
  readonly accountCategory: Map<string, string>;
}

const EMPTY_PROJECTION: AsOfProjection = {
  bankCategory: new Map(),
  accountCategory: new Map(),
};

function accountIdsOf(table: DescriptorTable, rows: Row[], bank: Map<string, BankCategoryState>): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (table === 'bank_transactions') {
      const state = bank.get(String(row.id));
      const id = state ? state.categoryAccountId : str(row, 'category_account_id');
      if (id) ids.add(id);
    } else {
      const id = str(row, 'account_id');
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Restrict `rows` to those accepted and not superseded at the as-of instant, and work out the
 * category state in force at that instant.
 */
async function applyAsOf(
  ctx: AccessContext,
  orgId: string,
  compiled: CompiledQuery,
  rows: Row[],
): Promise<{ rows: Row[]; projection: AsOfProjection }> {
  const asOf = compiled.asOf;
  if (!asOf) return { rows, projection: EMPTY_PROJECTION };

  let visible = rows;
  if (compiled.hasRecordLifecycle) {
    const ids = rows.map((row) => String(row.id));
    const events: RecordStatusEvent[] = await fetchRecordStatusEvents(
      ctx.db,
      orgId,
      compiled.table,
      ids,
      asOf.aggregatedAt,
    );
    const keep = new Set(selectVisibleRecordIds(ids, events, asOf.aggregatedAt));
    visible = rows.filter((row) => keep.has(String(row.id)));
  }

  const bankCategory = new Map<string, BankCategoryState>();
  if (compiled.table === 'bank_transactions') {
    const history = await fetchCategoryHistory(
      ctx.db,
      orgId,
      visible.map((row) => String(row.id)),
    );
    for (const row of visible) {
      const id = String(row.id);
      const inForce = valueInForceAt(history.get(id) ?? [], asOf.aggregatedAt);
      // No history interval covering the instant means the row was never recategorised before it,
      // so the columns it was imported with are what the run saw.
      bankCategory.set(
        id,
        inForce ?? {
          categoryAccountId: str(row, 'category_account_id'),
          isTransfer: row.is_transfer === true,
          transferKind: String(row.transfer_kind ?? 'none'),
        },
      );
    }
  }

  const accountCategory = new Map<string, string>();
  const accountIds = accountIdsOf(compiled.table, visible, bankCategory);
  if (accountIds.length > 0) {
    const history: Map<string, HistoryInterval<string>[]> = await fetchAccountCategoryHistory(
      ctx.db,
      orgId,
      accountIds,
    );
    for (const accountId of accountIds) {
      const inForce = valueInForceAt(history.get(accountId) ?? [], asOf.aggregatedAt);
      if (inForce !== null) accountCategory.set(accountId, inForce);
    }
  }

  return { rows: visible, projection: { bankCategory, accountCategory } };
}

function applyPostFilters(
  rows: Row[],
  postFilters: readonly PostFilter[],
  projection: AsOfProjection,
): Row[] {
  let out = rows;
  for (const filter of postFilters) {
    switch (filter.kind) {
      case 'open_at': {
        // "Unpaid at the date": paid_date is unknown, or the payment happened after it
        // (FINANCIAL_ENGINE.md §3, `receivables`).
        // Both sides are `date` columns rendered as YYYY-MM-DD, for which lexicographic and
        // chronological order coincide; no Date parsing, so no timezone can shift the boundary.
        out = out.filter((row) => {
          const paid = str(row, 'paid_date');
          return paid === null || paid > filter.date;
        });
        break;
      }
      case 'as_of_category_in': {
        const allowed = new Set(filter.ids);
        out = out.filter((row) => {
          const state = projection.bankCategory.get(String(row.id));
          const categoryId = state ? state.categoryAccountId : str(row, 'category_account_id');
          return categoryId !== null && allowed.has(categoryId);
        });
        break;
      }
      case 'as_of_exclude_cash_transfers': {
        out = out.filter((row) => {
          const state = projection.bankCategory.get(String(row.id));
          const kind = state ? state.transferKind : String(row.transfer_kind ?? 'none');
          return kind !== 'cash_transfer';
        });
        break;
      }
      case 'as_of_exclude_all_transfers': {
        // The bank-basis P&L proxy: a transfer is never income or expenditure, whatever its kind
        // (§4.4, ADR-047.12). As with the cash case, the kind is taken from the categorisation in
        // force at the run's instant, not from the row's current value (ADR-034).
        out = out.filter((row) => {
          const state = projection.bankCategory.get(String(row.id));
          const kind = state ? state.transferKind : String(row.transfer_kind ?? 'none');
          return kind === 'none';
        });
        break;
      }
    }
  }
  return out;
}

const DATE_COLUMN: Record<DescriptorTable, string | null> = {
  ledger_entries: 'entry_date',
  bank_transactions: 'transaction_date',
  invoices: 'issue_date',
  period_balances: 'period_start',
  metric_snapshots: 'created_at',
};

const DESCRIPTION_COLUMN: Record<DescriptorTable, string | null> = {
  ledger_entries: 'description',
  // ADR-038.4: the raw description may carry a third party's account number and is not selectable.
  bank_transactions: 'description_normalized',
  invoices: 'description',
  period_balances: null,
  metric_snapshots: null,
};

/**
 * How a row's amount is read for this selection (ADR-105).
 *
 * `invoice_net`: the engine's net-of-tax rule signed by type, so credit notes subtract — the exact
 * basis the invoice-basis P&L summed, which is what makes Σ rows equal the figure. `column`: the
 * table's amount column (`balance_due` for receivables and payables, `amount` for ledger and bank).
 */
function amountReader(compiled: CompiledQuery): (row: Row) => string | null {
  if (compiled.amountBasis === 'invoice_net') {
    return (row) => {
      const totalAmount = str(row, 'total_amount');
      const invoiceType = str(row, 'invoice_type') as InvoiceType | null;
      if (totalAmount === null || invoiceType === null) return null;
      const { net } = invoiceNetOfTax({
        invoiceType,
        status: (str(row, 'status') ?? 'open') as InvoiceStatus,
        subtotal: str(row, 'subtotal'),
        taxAmount: str(row, 'tax_amount'),
        totalAmount,
      });
      return toMoneyString(invoiceSignFor(invoiceType) === 1 ? net : net.negated());
    };
  }
  const column = compiled.amountColumn;
  if (column === null) return (row) => (compiled.table === 'metric_snapshots' ? str(row, 'value') : null);
  if (compiled.amountBasis === 'column_magnitude') {
    return (row) => {
      const raw = str(row, column);
      if (raw === null) return null;
      const parsed = parseDecimalOrNull(raw, 'amount');
      return parsed === null ? null : toMoneyString(parsed.abs());
    };
  }
  return (row) => str(row, column);
}

function toRecordView(
  table: DescriptorTable,
  row: Row,
  amountOf: (row: Row) => string | null,
  projection: AsOfProjection,
): RecordView {
  const bankState = projection.bankCategory.get(String(row.id));
  const accountId =
    table === 'bank_transactions'
      ? (bankState ? bankState.categoryAccountId : str(row, 'category_account_id'))
      : str(row, 'account_id');
  const dateColumn = DATE_COLUMN[table];
  const descriptionColumn = DESCRIPTION_COLUMN[table];

  return {
    id: String(row.id),
    table,
    date: dateColumn ? str(row, dateColumn) : null,
    description: descriptionColumn ? str(row, descriptionColumn) : null,
    reference: str(row, 'reference'),
    counterpartyId: str(row, 'counterparty_id'),
    accountId,
    standardCategory: accountId ? (projection.accountCategory.get(accountId) ?? null) : null,
    // metric_snapshots has no summable amount column (mixed units), but the row's own value is
    // still what the drawer shows for it, so it is surfaced here while `total` stays null.
    amount: amountOf(row),
    currency: str(row, 'currency'),
    direction: str(row, 'direction'),
    transferKind: bankState ? bankState.transferKind : str(row, 'transfer_kind'),
    recordStatus: str(row, 'record_status'),
    superseded: row.superseded_by !== null && row.superseded_by !== undefined,
    assuranceLevel: str(row, 'assurance_level'),
    metricKey: str(row, 'metric_key'),
  };
}

/** Σ amount over the whole selection, as a money string; `null` when a sum has no meaning. */
function totalOf(rows: Row[], compiled: CompiledQuery, amountOf: (row: Row) => string | null): string | null {
  // A selection with no amount to sum (mixed-unit snapshots) has no total.
  if (compiled.amountBasis === 'column' && compiled.amountColumn === null) return null;
  const amounts: Decimal[] = [];
  for (const row of rows) {
    const parsed = parseDecimalOrNull(amountOf(row), 'amount');
    // NULL is "not known", which is not zero (FINANCIAL_ENGINE.md §1.5); it contributes nothing.
    if (parsed !== null) amounts.push(parsed);
  }
  return toMoneyString(sum(amounts));
}

/** Resolve an already-compiled descriptor. Shared by `resolveDescriptor` and `resolveItem`. */
export async function resolveCompiled(
  ctx: AccessContext,
  compiled: CompiledQuery,
  page?: Cursor,
): Promise<ResolvedSelection> {
  const orgId = requireOrgId(ctx);
  const fetched = await fetchSelectionRows(ctx.db, orgId, compiled);
  const { rows: asOfRows, projection } = await applyAsOf(ctx, orgId, compiled, fetched);
  const selection = applyPostFilters(asOfRows, compiled.postFilters, projection);

  const offset = Math.max(0, page?.offset ?? 0);
  const pageRows = selection.slice(offset, offset + compiled.limit);
  const nextOffset = offset + pageRows.length;

  const amountOf = amountReader(compiled);
  return {
    rows: pageRows.map((row) => toRecordView(compiled.table, row, amountOf, projection)),
    count: selection.length,
    total: totalOf(selection, compiled, amountOf),
    ...(nextOffset < selection.length ? { nextCursor: { offset: nextOffset } } : {}),
  };
}

/**
 * Re-execute a stored descriptor under the caller's RLS.
 *
 * `descriptor` is `unknown` on purpose: descriptors come back as JSONB written by an earlier engine
 * version, so they are validated on the way in every time rather than trusted (§3).
 */
export async function resolveDescriptor(
  ctx: AccessContext,
  descriptor: unknown,
  page?: Cursor,
): Promise<ResolvedSelection> {
  assertCan(ctx, 'financials.view');
  const parsed: QueryDescriptorV1 = parseQueryDescriptor(descriptor);
  return resolveCompiled(ctx, compileDescriptor(parsed), page);
}
