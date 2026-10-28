import 'server-only';
import { orgRows } from '@/db/rls';
import type { Db } from '@/db/types';
import { organizationDoc } from '@/modules/tenancy';
import type { VatInvoice } from '../domain/vat';

/**
 * The invoices a VAT quarter reads (ADR-156): the CURRENT row of every accepted, non-superseded
 * invoice — the same population the engine's P&L and aging read (ADR-047.10) — dated in the window
 * by issue date (standard scheme) or by date paid (cash accounting). Void rows are excluded by the
 * domain, which owns that rule.
 */
export async function loadVatInvoices(
  db: Db, orgId: string, from: string, to: string, by: 'issue_date' | 'paid_date', requestId?: string,
): Promise<VatInvoice[]> {
  void requestId;
  // The date window is the query (one single-field range, no composite index); the current-row rule
  // (accepted, not superseded) is applied to the window's rows here.
  const rows = await orgRows<Record<string, unknown>>(db, orgId, 'invoices', (q) => q
    .where(by, '>=', from).where(by, '<=', to).orderBy(by));
  return rows
    .filter((r) => r.record_status === 'accepted' && (r.superseded_by ?? null) === null)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((r) => ({
      id: r.id as string,
      invoiceType: r.invoice_type as VatInvoice['invoiceType'],
      status: r.status as string,
      issueDate: r.issue_date as string,
      paidDate: (r.paid_date as string | null) ?? null,
      subtotal: r.subtotal === null || r.subtotal === undefined ? null : String(r.subtotal),
      taxAmount: r.tax_amount === null || r.tax_amount === undefined ? null : String(r.tax_amount),
      totalAmount: String(r.total_amount),
      amountPaid: String(r.amount_paid ?? '0'),
    }));
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

export async function loadOrganisationTaxFacts(db: Db, orgId: string, requestId?: string): Promise<OrganisationTaxFacts> {
  void requestId;
  const row = (await organizationDoc(db, orgId)) ?? {};
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
