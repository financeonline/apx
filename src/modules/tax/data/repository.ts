import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { VatInvoice } from '../domain/vat';

function check(error: unknown, requestId?: string): void {
  if (error) throw toMotionError(error, requestId);
}

/**
 * The invoices a VAT quarter reads (ADR-156): the CURRENT row of every accepted, non-superseded
 * invoice — the same population the engine's P&L and aging read (ADR-047.10) — dated in the window
 * by issue date (standard scheme) or by date paid (cash accounting). Void rows are excluded by the
 * domain, which owns that rule.
 */
export async function loadVatInvoices(
  db: SupabaseClient, orgId: string, from: string, to: string, by: 'issue_date' | 'paid_date', requestId?: string,
): Promise<VatInvoice[]> {
  const out: VatInvoice[] = [];
  const PAGE = 1000;
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db
      .from('invoices')
      .select('id, invoice_type, status, issue_date, paid_date, subtotal, tax_amount, total_amount, amount_paid')
      .eq('organization_id', orgId)
      .eq('record_status', 'accepted')
      .is('superseded_by', null)
      .gte(by, from)
      .lte(by, to)
      .order('id')
      .range(start, start + PAGE - 1);
    check(error, requestId);
    const rows = (data ?? []) as Record<string, unknown>[];
    out.push(...rows.map((r) => ({
      id: r.id as string,
      invoiceType: r.invoice_type as VatInvoice['invoiceType'],
      status: r.status as string,
      issueDate: r.issue_date as string,
      paidDate: (r.paid_date as string | null) ?? null,
      subtotal: r.subtotal === null || r.subtotal === undefined ? null : String(r.subtotal),
      taxAmount: r.tax_amount === null || r.tax_amount === undefined ? null : String(r.tax_amount),
      totalAmount: String(r.total_amount),
      amountPaid: String(r.amount_paid ?? '0'),
    })));
    if (rows.length < PAGE) return out;
  }
}

export interface OrganisationTaxFacts {
  readonly countryCode: string | null;
  readonly baseCurrency: string;
  readonly fiscalYearStartMonth: number;
  readonly timezone: string;
  readonly vatRegistered: boolean | null;
  readonly vatQuarterEndMonth: 1 | 2 | 3 | null;
  readonly vatScheme: 'standard' | 'cash_accounting' | 'flat_rate';
  readonly ctAssociatedCompanies: number;
}

export async function loadOrganisationTaxFacts(db: SupabaseClient, orgId: string, requestId?: string): Promise<OrganisationTaxFacts> {
  const { data, error } = await db
    .from('organizations')
    .select('country_code, base_currency, fiscal_year_start_month, timezone, settings')
    .eq('id', orgId)
    .maybeSingle();
  check(error, requestId);
  const row = (data ?? {}) as Record<string, unknown>;
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const qem = Number(settings.vat_quarter_end_month);
  const scheme = settings.vat_scheme;
  const assoc = Number(settings.ct_associated_companies);
  return {
    countryCode: (row.country_code as string | null) ?? null,
    baseCurrency: (row.base_currency as string | undefined) ?? 'GBP',
    fiscalYearStartMonth: Number(row.fiscal_year_start_month ?? 1),
    timezone: (row.timezone as string | undefined) ?? 'Europe/London',
    vatRegistered: typeof settings.vat_registered === 'boolean' ? settings.vat_registered : null,
    vatQuarterEndMonth: qem === 1 || qem === 2 || qem === 3 ? qem : null,
    vatScheme: scheme === 'cash_accounting' || scheme === 'flat_rate' ? scheme : 'standard',
    ctAssociatedCompanies: Number.isInteger(assoc) && assoc >= 0 ? assoc : 0,
  };
}
