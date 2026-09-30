import { z } from 'zod';
import { ValidationError } from '@/core/errors';

/**
 * `QueryDescriptorV1` — the declarative, versioned selection an evidence item stores instead of SQL
 * (EVIDENCE_MODEL.md §3, ADR-009).
 *
 * Three properties of this file are load-bearing rather than stylistic:
 *
 *  1. It is **strict**. An unknown key or an unknown `v` fails validation; there is no best-effort
 *     query, because a descriptor that quietly ignored a filter would resolve to a different set
 *     than the one the metric was computed from (§3, "Unknown keys or an unknown `v` fail
 *     validation … never a best-effort query").
 *  2. `standard_categories` is deliberately absent (ADR-034). A category is a *mutable property of
 *     an account*; filtering by it would make an old bundle follow a later remap and stop
 *     reconciling. Engine descriptors name `account_ids` / `category_account_ids` /
 *     `bank_account_ids` resolved at run time instead.
 *  3. A descriptor never carries an `organization_id` and never crosses tables (§3). Tenancy comes
 *     from the bundle and from RLS; the resolver adds the organization filter itself.
 *
 * It is produced only by engine code and alert rules and is **never part of a model-visible schema**
 * (ADR-032.6) — nothing here is ever parsed from AI or end-user input.
 */

export const DESCRIPTOR_TABLES = [
  'ledger_entries',
  'bank_transactions',
  'invoices',
  'period_balances',
  'metric_snapshots',
] as const;
export type DescriptorTable = (typeof DESCRIPTOR_TABLES)[number];

/**
 * The arrays that are sorted ascending as strings before the canonical form is hashed
 * (ADR-046.2). Kept next to the schema so a new array filter cannot be added without deciding
 * whether it belongs here.
 */
export const ID_ARRAY_FILTER_KEYS = [
  'period_ids',
  'account_ids',
  'category_account_ids',
  'counterparty_ids',
  'bank_account_ids',
  'invoice_types',
] as const;

export const DESCRIPTOR_DIRECTIONS = ['debit', 'credit', 'inflow', 'outflow'] as const;
export type DescriptorDirection = (typeof DESCRIPTOR_DIRECTIONS)[number];

export const INVOICE_TYPES = ['sales', 'purchase', 'sales_credit_note', 'purchase_credit_note'] as const;

/** `metric_dimension_enum` minus `none`: a dimension filter names a dimension, so `none` is absent. */
export const DIMENSION_TYPES = ['account', 'standard_category', 'counterparty', 'bank_account'] as const;

/** §3: `limit` ≤ 1,000. */
export const MAX_DESCRIPTOR_LIMIT = 1000;

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD');

/**
 * An instant, with an explicit offset. `aggregated_at` selects rows by their lifecycle events, so a
 * timestamp whose zone had to be guessed would silently move the boundary of a selection.
 */
const instant = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/,
    'Expected an ISO 8601 timestamp with an explicit UTC offset',
  );

const DimensionSchema = z.strictObject({
  type: z.enum(DIMENSION_TYPES),
  id: uuid,
});

const FiltersSchema = z.strictObject({
  period_ids: z.array(uuid).min(1).optional(),
  account_ids: z.array(uuid).min(1).optional(),
  counterparty_ids: z.array(uuid).min(1).optional(),
  bank_account_ids: z.array(uuid).min(1).optional(),
  category_account_ids: z.array(uuid).min(1).optional(),
  invoice_types: z.array(z.enum(INVOICE_TYPES)).min(1).optional(),
  direction: z.enum(DESCRIPTOR_DIRECTIONS).optional(),
  /**
   * Which transfer legs the selection drops.
   *
   * Two spellings existed in the documents and neither covered both needs (ADR-049.7, now resolved
   * by ADR-051): `EVIDENCE_MODEL.md §3` had `exclude_cash_transfers: true`, which cash metrics need
   * — a cash-like↔cash-like pair cancels, but a card repayment is a real outflow and must stay
   * (ADR-028). `FINANCIAL_ENGINE.md §4.4` and ADR-047.12 need `exclude_transfers: 'all'` for the
   * bank-basis P&L proxy, where every transfer kind is excluded.
   *
   * `exclude_transfers` is the canonical key and expresses both. `exclude_cash_transfers: true` is
   * retained as the equivalent of `'cash_only'` so descriptors already written stay valid.
   */
  exclude_transfers: z.enum(['all', 'cash_only']).optional(),
  exclude_cash_transfers: z.boolean().optional(),
  open_as_of: isoDate.optional(),
  overdue_as_of: isoDate.optional(),
  /**
   * The statement kind a balance selection reads (ADR-123, audit F-6). The engine takes ONE statement
   * per period — trial balance over balance sheet (ADR-047.4) — so its drill-down must too: with both
   * covering a month, a selection by period and account alone summed each balance twice.
   */
  balance_kind: z.enum(['trial_balance', 'pnl_report', 'balance_sheet']).optional(),
  metric_keys: z.array(z.string().min(1)).min(1).optional(),
  dimension: DimensionSchema.optional(),
});
export type DescriptorFilters = z.infer<typeof FiltersSchema>;
export type DescriptorFilterKey = keyof DescriptorFilters;

/**
 * ADR-047.7 / ADR-046.2: the as-of instant is the **producing chunk's** `aggregated_at`, not the
 * run's `finished_at`. A run spans several chunk transactions, and a record superseded between two
 * of them must still resolve to what the chunk that produced the snapshot actually read (R2-C-10).
 */
const AsOfSchema = z.strictObject({
  calculation_run_id: uuid,
  aggregated_at: instant,
});
export type DescriptorAsOf = z.infer<typeof AsOfSchema>;

const OrderEntrySchema = z.strictObject({
  field: z.string().min(1),
  dir: z.enum(['asc', 'desc']),
});
export type DescriptorOrderEntry = z.infer<typeof OrderEntrySchema>;

/** §3: `order` always ends with `id asc` so pagination is deterministic. */
export const TERMINAL_ORDER: DescriptorOrderEntry = { field: 'id', dir: 'asc' };

function endsWithIdAsc(order: readonly DescriptorOrderEntry[]): boolean {
  const last = order[order.length - 1];
  return last !== undefined && last.field === TERMINAL_ORDER.field && last.dir === TERMINAL_ORDER.dir;
}

/** Appends `id asc` when the caller omitted it, per §3. */
export function withTerminalOrder(
  order: readonly DescriptorOrderEntry[] | undefined,
): DescriptorOrderEntry[] {
  const base = order ?? [];
  return endsWithIdAsc(base) ? [...base] : [...base, { ...TERMINAL_ORDER }];
}

const BaseDescriptorSchema = z.strictObject({
  // A literal, not a range: an unknown `v` is a descriptor written by a version of the engine this
  // build does not understand, and guessing at it would fabricate evidence.
  v: z.literal(1),
  table: z.enum(DESCRIPTOR_TABLES),
  filters: FiltersSchema.default({}),
  as_of: AsOfSchema.optional(),
  order: z.array(OrderEntrySchema).min(1).max(8).optional(),
  limit: z.number().int().min(1).max(MAX_DESCRIPTOR_LIMIT).optional(),
});

export const QueryDescriptorV1Schema = BaseDescriptorSchema.superRefine((value, ctx) => {
  // §3 / ADR-032.6: metric_snapshots is append-only across runs. Without `as_of` a selection could
  // mix snapshots from two runs and reconcile to nothing.
  if (value.table === 'metric_snapshots' && value.as_of === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['as_of'],
      message: "table 'metric_snapshots' requires as_of so a selection cannot mix calculation runs",
    });
  }
}).transform((value) => ({ ...value, order: withTerminalOrder(value.order) }));

export type QueryDescriptorV1 = z.infer<typeof QueryDescriptorV1Schema>;

/** §2.3 / ADR-034: `metric_snapshots.evidence_query` is a leaf descriptor or a list of components. */
export const EvidenceQuerySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('leaf'), descriptor: QueryDescriptorV1Schema }),
  z.strictObject({
    kind: z.literal('derived'),
    components: z.array(z.strictObject({ name: z.string().min(1), snapshot_id: uuid })).min(1),
  }),
]);
export type EvidenceQuery = z.infer<typeof EvidenceQuerySchema>;

/**
 * Parse, or throw `ValidationError` with the issues attached.
 *
 * The `standard_categories` case gets its own sentence: it is the one rejection whose reason is a
 * decision rather than a typo, and a future engineer reading "Unrecognized key" would reasonably
 * assume it was an oversight (ADR-034).
 */
export function parseQueryDescriptor(input: unknown): QueryDescriptorV1 {
  const result = QueryDescriptorV1Schema.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    const mentionsCategories =
      issue.code === 'unrecognized_keys' && issue.keys.includes('standard_categories');
    return {
      path: path.length > 0 ? path : 'descriptor',
      message: mentionsCategories
        ? "'standard_categories' is not a v1 filter: a category is a mutable property of an account, " +
          'so filtering by it would make old evidence follow a later remap. Name account_ids, ' +
          'category_account_ids or bank_account_ids resolved at run time instead (ADR-034).'
        : issue.message,
    };
  });

  throw new ValidationError('That evidence descriptor is not valid.', issues);
}
