import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { negate } from '@/core/money';

/**
 * The two reads Section 03 of the Marketing report (ADR-170) needs that no existing reader serves on
 * a job's client. Everything else it reads — the engine's figures, the periods, the accounts, the
 * products and the campaign spend — goes through the modules that own them (`services/financials.ts`).
 *
 * Called with the Marketing report job's scoped service client, so every query names the
 * organisation (ADR-013, ADR-090; `motion/no-unscoped-service-query`). Nothing here writes.
 */

const PAGE = 1000;

/** Every page of a read, so PostgREST's row cap (`max_rows = 1000`) can never silently cut a total. */
async function paged<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw toMotionError(error);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export interface FinancialSettings {
  /** `organizations.base_currency`. */
  readonly currency: string;
  /** `organizations.fiscal_year_start_month`, 1–12 (CD-09). */
  readonly fiscalYearStartMonth: number;
}

export async function loadFinancialSettings(db: SupabaseClient, orgId: string): Promise<FinancialSettings> {
  const { data, error } = await db.from('organizations')
    .select('base_currency, fiscal_year_start_month').eq('id', orgId).maybeSingle();
  if (error) throw toMotionError(error);
  const row = data as { base_currency?: string | null; fiscal_year_start_month?: number | null } | null;
  return {
    currency: row?.base_currency ?? 'GBP',
    fiscalYearStartMonth: Number(row?.fiscal_year_start_month ?? 1),
  };
}

export interface ProductLineSale {
  readonly periodId: string;
  readonly productId: string;
  /** Signed: a sales line positive, a sales credit note's line negative. */
  readonly amount: string;
}

/**
 * The sales lines attributed to a product in the given months — the rows behind the `sales` figure of
 * `api.product_period_summary` (ADR-102), with its rule exactly: lines on accepted, live, un-voided
 * sales invoices count, a sales credit note's lines count negatively, and the month is the invoice's.
 *
 * Read here rather than through that function because it is an `api.*` function checked against the
 * signed-in user (`app.require_permission(…, 'customers.view')`), and a job has no user. The summing
 * is the domain's (`buildMarketingFinancials`), in Decimal.
 */
export async function loadProductLineSales(
  db: SupabaseClient, orgId: string, periodIds: readonly string[],
): Promise<ProductLineSale[]> {
  if (periodIds.length === 0) return [];
  const rows = await paged<{ product_id: string; amount: unknown; invoices: unknown }>((from, to) => db
    .from('invoice_lines')
    .select('id, product_id, amount, invoices!invoice_lines_invoice_fk!inner(period_id, invoice_type)')
    .eq('organization_id', orgId)
    .not('product_id', 'is', null)
    .in('invoices.period_id', [...periodIds])
    .in('invoices.invoice_type', ['sales', 'sales_credit_note'])
    .eq('invoices.record_status', 'accepted')
    .is('invoices.superseded_by', null)
    .neq('invoices.status', 'void')
    .order('id')
    .range(from, to));
  return rows.flatMap((row) => {
    // PostgREST types a to-one embed as an array or an object depending on the version; the FK is single-valued.
    const invoice = (Array.isArray(row.invoices) ? row.invoices[0] : row.invoices) as
      { period_id: string; invoice_type: string } | undefined;
    if (invoice === undefined) return [];
    const amount = String(row.amount);
    return [{
      periodId: invoice.period_id,
      productId: row.product_id,
      amount: invoice.invoice_type === 'sales_credit_note' ? negate(amount).toString() : amount,
    }];
  });
}
