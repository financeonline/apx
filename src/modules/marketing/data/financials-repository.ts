import 'server-only';
import { negate } from '@/core/money';
import type { Db } from '@/db/types';
import { readOrganizationRow, readRows } from '@/db/app/financials-reads';

/**
 * The two reads Section 03 of the Marketing report (ADR-170) needs that no existing reader serves on
 * a job's handle. Everything else it reads — the engine's figures, the periods, the accounts, the
 * products and the campaign spend — goes through the modules that own them (`services/financials.ts`).
 *
 * Called with the Marketing report job's scoped service handle, so every read names the
 * organisation (ADR-013, ADR-090; `readRows` refuses any other). Nothing here writes.
 */

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface FinancialSettings {
  /** `organizations.base_currency`. */
  readonly currency: string;
  /** `organizations.fiscal_year_start_month`, 1–12 (CD-09). */
  readonly fiscalYearStartMonth: number;
}

export async function loadFinancialSettings(db: Db, orgId: string): Promise<FinancialSettings> {
  const row = await readOrganizationRow(db, orgId) as { base_currency?: string | null; fiscal_year_start_month?: number | null } | null;
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
  db: Db, orgId: string, periodIds: readonly string[],
): Promise<ProductLineSale[]> {
  if (periodIds.length === 0) return [];
  const periods = new Set(periodIds);
  // The invoices of those months, then their product lines: two reads joined here (the old inner
  // embed), each `in` at most 30 values.
  const invoices = new Map<string, Row>();
  const ids = [...periods];
  for (let i = 0; i < ids.length; i += 30) {
    for (const inv of await readRows<Row>(db, orgId, 'invoices', (q) => q.where('period_id', 'in', ids.slice(i, i + 30)))) {
      if ((inv.invoice_type === 'sales' || inv.invoice_type === 'sales_credit_note') && inv.record_status === 'accepted'
        && (inv.superseded_by ?? null) === null && inv.status !== 'void') invoices.set(String(inv.id), inv);
    }
  }
  const invoiceIds = [...invoices.keys()];
  const lines: Row[] = [];
  for (let i = 0; i < invoiceIds.length; i += 30) {
    lines.push(...await readRows<Row>(db, orgId, 'invoice_lines', (q) => q.where('invoice_id', 'in', invoiceIds.slice(i, i + 30))));
  }
  lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return lines.flatMap((row) => {
    const invoice = invoices.get(String(row.invoice_id));
    if (invoice === undefined || row.product_id === null || row.product_id === undefined) return [];
    const amount = String(row.amount);
    return [{
      periodId: String(invoice.period_id),
      productId: String(row.product_id),
      amount: invoice.invoice_type === 'sales_credit_note' ? negate(amount).toString() : amount,
    }];
  });
}
