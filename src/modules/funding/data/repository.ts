import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { MetricObservation } from '@/modules/alerts';
import type { BankAccountRef } from '@/modules/financial-engine';

/**
 * Reads for Funding Readiness (ADR-145). Called with the job's scoped service client; every query names
 * the organisation. Nothing here writes — `api_server.finish_funding` does.
 */

const PAGE = 1000;
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

export interface PeriodRow { readonly id: string; readonly periodStart: string; readonly periodEnd: string; readonly label: string; readonly isComplete: boolean }

export async function loadPeriods(db: SupabaseClient, orgId: string): Promise<PeriodRow[]> {
  const rows = await paged<{ id: string; period_start: string; period_end: string; label: string; is_complete: boolean }>((a, b) =>
    db.from('fiscal_periods').select('id, period_start, period_end, label, is_complete').eq('organization_id', orgId).order('period_start').range(a, b));
  return rows.map((r) => ({ id: r.id, periodStart: r.period_start, periodEnd: r.period_end, label: r.label, isComplete: r.is_complete === true }));
}

/** The run each period's CURRENT figures came from (the newest, when a period mixes runs). */
export async function currentRunByPeriod(db: SupabaseClient, orgId: string): Promise<Map<string, string>> {
  const rows = await paged<{ period_id: string; calculation_run_id: string; calculation_runs: { finished_at: string | null } | null }>((a, b) =>
    db.from('metric_current').select('period_id, calculation_run_id, calculation_runs!inner(finished_at)')
      .eq('organization_id', orgId).eq('dimension_type', 'none').order('period_id').order('metric_key').range(a, b));
  const best = new Map<string, { run: string; at: string }>();
  for (const r of rows) {
    const at = r.calculation_runs?.finished_at ?? '';
    const seen = best.get(r.period_id);
    if (seen === undefined || at > seen.at || (at === seen.at && r.calculation_run_id > seen.run)) best.set(r.period_id, { run: r.calculation_run_id, at });
  }
  return new Map([...best.entries()].map(([p, v]) => [p, v.run]));
}

export async function currentAssessmentRuns(db: SupabaseClient, orgId: string): Promise<Map<string, string>> {
  const { data, error } = await db.from('funding_current').select('period_id, calculation_run_id').eq('organization_id', orgId);
  if (error) throw toMotionError(error);
  return new Map(((data ?? []) as Array<{ period_id: string; calculation_run_id: string }>).map((r) => [r.period_id, r.calculation_run_id]));
}

/** The current snapshots of the periods, undimensioned, as MetricObservation (the shape Health reads). */
export async function loadObservations(db: SupabaseClient, orgId: string, periodIds: readonly string[]): Promise<MetricObservation[]> {
  if (periodIds.length === 0) return [];
  const rows = await paged<Record<string, unknown>>((a, b) => db.from('metric_current')
    .select('period_id, metric_key, dimension_type, dimension_id, dimension_key, snapshot_id, metric_snapshots!inner(value, unit, basis, assurance_level, components, data_quality)')
    .eq('organization_id', orgId).in('period_id', [...periodIds]).eq('dimension_type', 'none')
    .order('period_id').order('metric_key').range(a, b));
  return rows.flatMap((r) => {
    const s = r.metric_snapshots as { value: unknown; unit: string; basis: string; assurance_level: string; components: Record<string, unknown> | null; data_quality: MetricObservation['dataQuality'] | null } | null;
    if (s === null) return [];
    return [{
      snapshotId: r.snapshot_id as string,
      periodId: r.period_id as string,
      metricKey: r.metric_key as string,
      dimensionType: 'none',
      dimensionId: null,
      dimensionKey: null,
      value: s.value === null || s.value === undefined ? null : String(s.value),
      unit: s.unit as MetricObservation['unit'],
      basis: s.basis as MetricObservation['basis'],
      assurance: s.assurance_level as MetricObservation['assurance'],
      components: s.components ?? {},
      dataQuality: s.data_quality ?? { completeness: 0, proxy: false, warnings: [], missing: [] },
    } as MetricObservation];
  });
}

export async function loadBankAccounts(db: SupabaseClient, orgId: string): Promise<BankAccountRef[]> {
  const rows = await paged<{ id: string; name: string; account_type: BankAccountRef['accountType']; opening_balance: unknown; opening_balance_date: string | null; is_active: boolean }>((a, b) =>
    db.from('bank_accounts').select('id, name, account_type, opening_balance, opening_balance_date, is_active').eq('organization_id', orgId).order('id').range(a, b));
  return rows.map((r) => ({ id: r.id, name: r.name, accountType: r.account_type, openingBalance: r.opening_balance === null ? null : String(r.opening_balance), openingBalanceDate: r.opening_balance_date, isActive: Boolean(r.is_active) }));
}

export interface StatementRow {
  readonly batchId: string; readonly bankAccountId: string; readonly periodStart: string; readonly periodEnd: string;
  readonly committedAt: string; readonly openingBalance: string | null; readonly closingBalance: string | null;
  readonly extractionMethod: string; readonly unreconciled: boolean;
}

/** The statements the run reads (`loadStatements` in the engine): committed, per bank account. */
export async function loadStatements(db: SupabaseClient, orgId: string): Promise<StatementRow[]> {
  const rows = await paged<Record<string, unknown>>((a, b) => db.from('import_batches')
    .select('id, bank_account_id, period_start, period_end, committed_at, statement_opening_balance, statement_closing_balance, batch_issues, extraction_method')
    .eq('organization_id', orgId).eq('status', 'committed').eq('target_table', 'bank_transactions')
    .not('bank_account_id', 'is', null).order('id').range(a, b));
  return rows.map((r) => {
    const issues = Array.isArray(r.batch_issues) ? (r.batch_issues as Array<{ code?: unknown }>) : [];
    return {
      batchId: r.id as string, bankAccountId: r.bank_account_id as string,
      periodStart: r.period_start as string, periodEnd: r.period_end as string, committedAt: String(r.committed_at),
      openingBalance: r.statement_opening_balance === null ? null : String(r.statement_opening_balance),
      closingBalance: r.statement_closing_balance === null ? null : String(r.statement_closing_balance),
      extractionMethod: String(r.extraction_method ?? 'csv'),
      unreconciled: issues.some((i) => i.code === 'IMP-BAL-006' || i.code === 'IMP-BAL-007'),
    };
  });
}

/** B3 as Health evaluated it for P (banking_health's rule application), read from the current score. */
export async function loadB3(db: SupabaseClient, orgId: string, periodId: string): Promise<{ suppressed: boolean; reason: string | null; count: number } | null> {
  const { data, error } = await db.from('health_current')
    .select('health_scores!health_current_score_fk!inner(breakdown)')
    .eq('organization_id', orgId).eq('period_id', periodId).maybeSingle();
  if (error) throw toMotionError(error);
  const scores = (data as { health_scores?: { breakdown?: unknown } | { breakdown?: unknown }[] } | null)?.health_scores;
  const breakdown = (Array.isArray(scores) ? scores[0]?.breakdown : scores?.breakdown) as Array<{ key: string; rules?: Array<{ rule: string; points: number; value: string | null; skipped_reason: string | null; result: string }> }> | undefined;
  const b3 = breakdown?.find((d) => d.key === 'banking_health')?.rules?.find((r) => r.rule === 'B3');
  if (b3 === undefined) return null;
  if (b3.skipped_reason !== null && b3.skipped_reason !== undefined) return { suppressed: true, reason: b3.skipped_reason, count: 0 };
  const count = Number.parseInt(b3.value ?? '0', 10);
  return { suppressed: false, reason: null, count: Number.isFinite(count) ? count : 0 };
}

export interface InvoiceRow {
  readonly invoiceType: 'sales' | 'purchase' | 'sales_credit_note' | 'purchase_credit_note';
  readonly issueDate: string; readonly dueDate: string | null; readonly totalAmount: string; readonly amountPaid: string;
  readonly balanceDue: string; readonly paidDate: string | null; readonly status: 'open' | 'partially_paid' | 'paid' | 'void';
}

/** Live invoices issued by `issuedBy`, for F5's gross population (aged with the engine's own rule). */
export async function loadInvoices(db: SupabaseClient, orgId: string, issuedBy: string): Promise<InvoiceRow[]> {
  const rows = await paged<Record<string, unknown>>((a, b) => db.from('invoices')
    .select('id, invoice_type, issue_date, due_date, total_amount, amount_paid, balance_due, paid_date, status')
    .eq('organization_id', orgId).eq('record_status', 'accepted').is('superseded_by', null).neq('status', 'void')
    .lte('issue_date', issuedBy).order('id').range(a, b));
  return rows.map((r) => ({
    invoiceType: r.invoice_type as InvoiceRow['invoiceType'], issueDate: r.issue_date as string, dueDate: (r.due_date as string | null) ?? null,
    totalAmount: String(r.total_amount), amountPaid: String(r.amount_paid ?? '0'), balanceDue: String(r.balance_due ?? '0'),
    paidDate: (r.paid_date as string | null) ?? null, status: r.status as InvoiceRow['status'],
  }));
}

export async function loadOrganisation(db: SupabaseClient, orgId: string): Promise<{ currency: string; enabled: boolean }> {
  const { data, error } = await db.from('organizations').select('base_currency, features').eq('id', orgId).maybeSingle();
  if (error) throw toMotionError(error);
  const row = data as { base_currency?: string; features?: Record<string, unknown> } | null;
  return { currency: row?.base_currency ?? 'GBP', enabled: row?.features?.funding_readiness === true };
}
