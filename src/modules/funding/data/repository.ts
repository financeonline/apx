import 'server-only';
import { readOrganization, readRows, readRowsIn } from '@/db/app/engine-reads';
import type { Db } from '@/db/types';
import type { MetricObservation } from '@/modules/alerts';
import type { BankAccountRef } from '@/modules/financial-engine';

/**
 * Reads for Funding Readiness (ADR-145). Called with the job's scoped service handle; every read names
 * the organisation's own collections (FIRESTORE_DATA_MODEL.md §3). Nothing here writes —
 * `api_server.finish_funding` does. PostgREST's 1,000-row pages are gone: a Firestore read returns
 * every row, and each list is put in the order the paged read used.
 */

const str = (v: unknown): string => String(v);
const asc = (key: string) => (a: Record<string, unknown>, b: Record<string, unknown>): number =>
  (str(a[key]) < str(b[key]) ? -1 : str(a[key]) > str(b[key]) ? 1 : 0);

export interface PeriodRow { readonly id: string; readonly periodStart: string; readonly periodEnd: string; readonly label: string; readonly isComplete: boolean }

export async function loadPeriods(db: Db, orgId: string): Promise<PeriodRow[]> {
  const rows = await readRows(db, orgId, 'fiscal_periods', (q) => q.orderBy('period_start'));
  return rows.map((r) => ({ id: str(r.id), periodStart: str(r.period_start), periodEnd: str(r.period_end), label: str(r.label), isComplete: r.is_complete === true }));
}

/** The run each period's CURRENT figures came from (the newest, when a period mixes runs). */
export async function currentRunByPeriod(db: Db, orgId: string): Promise<Map<string, string>> {
  const rows = await readRows(db, orgId, 'metric_current', (q) => q.where('dimension_type', '==', 'none'));
  // The old `calculation_runs!inner(finished_at)`: a pointer whose run is not readable is dropped.
  const runs = await readRowsIn(db, orgId, 'calculation_runs', 'id', rows.map((r) => r.calculation_run_id as string));
  const finishedAt = new Map(runs.map((r) => [str(r.id), (r.finished_at as string | null) ?? '']));
  const best = new Map<string, { run: string; at: string }>();
  for (const r of rows) {
    const run = str(r.calculation_run_id);
    if (!finishedAt.has(run)) continue;
    const at = finishedAt.get(run)!;
    const period = str(r.period_id);
    const seen = best.get(period);
    if (seen === undefined || at > seen.at || (at === seen.at && run > seen.run)) best.set(period, { run, at });
  }
  return new Map([...best.entries()].map(([p, v]) => [p, v.run]));
}

export async function currentAssessmentRuns(db: Db, orgId: string): Promise<Map<string, string>> {
  const rows = await readRows(db, orgId, 'funding_current');
  return new Map(rows.map((r) => [str(r.period_id), str(r.calculation_run_id)]));
}

/** The current snapshots of the periods, undimensioned, as MetricObservation (the shape Health reads). */
export async function loadObservations(db: Db, orgId: string, periodIds: readonly string[]): Promise<MetricObservation[]> {
  if (periodIds.length === 0) return [];
  const pointers = (await readRowsIn(db, orgId, 'metric_current', 'period_id', periodIds, (q) => q.where('dimension_type', '==', 'none')))
    .sort((a, b) => asc('period_id')(a, b) || asc('metric_key')(a, b));
  const snapshots = await readRowsIn(db, orgId, 'metric_snapshots', 'id', pointers.map((p) => p.snapshot_id as string));
  const byId = new Map(snapshots.map((x) => [str(x.id), x]));
  return pointers.flatMap((r) => {
    const s = byId.get(str(r.snapshot_id)) as { value: unknown; unit: string; basis: string; assurance_level: string; components: Record<string, unknown> | null; data_quality: MetricObservation['dataQuality'] | null } | undefined;
    if (s === undefined) return [];
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

export async function loadBankAccounts(db: Db, orgId: string): Promise<BankAccountRef[]> {
  const rows = (await readRows(db, orgId, 'bank_accounts')).sort(asc('id'));
  return rows.map((r) => ({
    id: str(r.id), name: str(r.name), accountType: r.account_type as BankAccountRef['accountType'],
    openingBalance: r.opening_balance === null || r.opening_balance === undefined ? null : String(r.opening_balance),
    openingBalanceDate: (r.opening_balance_date as string | null) ?? null, isActive: Boolean(r.is_active),
  }));
}

export interface StatementRow {
  readonly batchId: string; readonly bankAccountId: string; readonly periodStart: string; readonly periodEnd: string;
  readonly committedAt: string; readonly openingBalance: string | null; readonly closingBalance: string | null;
  readonly extractionMethod: string; readonly unreconciled: boolean;
}

/** The statements the run reads (`loadStatements` in the engine): committed, per bank account. */
export async function loadStatements(db: Db, orgId: string): Promise<StatementRow[]> {
  const rows = (await readRows(db, orgId, 'import_batches', (q) => q.where('status', '==', 'committed')
    .where('target_table', '==', 'bank_transactions')))
    .filter((r) => r.bank_account_id !== null && r.bank_account_id !== undefined)
    .sort(asc('id'));
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
export async function loadB3(db: Db, orgId: string, periodId: string): Promise<{ suppressed: boolean; reason: string | null; count: number } | null> {
  const pointer = (await readRows(db, orgId, 'health_current', (q) => q.where('period_id', '==', periodId)))[0];
  const score = pointer ? (await readRows(db, orgId, 'health_scores', (q) => q.where('id', '==', pointer.health_score_id)))[0] : undefined;
  const breakdown = score?.breakdown as Array<{ key: string; rules?: Array<{ rule: string; points: number; value: string | null; skipped_reason: string | null; result: string }> }> | undefined;
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
export async function loadInvoices(db: Db, orgId: string, issuedBy: string): Promise<InvoiceRow[]> {
  const rows = (await readRows(db, orgId, 'invoices', (q) => q.where('record_status', '==', 'accepted').where('superseded_by', '==', null)))
    .filter((r) => r.status !== 'void' && str(r.issue_date) <= issuedBy)
    .sort(asc('id'));
  return rows.map((r) => ({
    invoiceType: r.invoice_type as InvoiceRow['invoiceType'], issueDate: r.issue_date as string, dueDate: (r.due_date as string | null) ?? null,
    totalAmount: String(r.total_amount), amountPaid: String(r.amount_paid ?? '0'), balanceDue: String(r.balance_due ?? '0'),
    paidDate: (r.paid_date as string | null) ?? null, status: r.status as InvoiceRow['status'],
  }));
}

export async function loadOrganisation(db: Db, orgId: string): Promise<{ currency: string; enabled: boolean }> {
  const row = await readOrganization(db, orgId) as { base_currency?: string; features?: Record<string, unknown> } | null;
  return { currency: row?.base_currency ?? 'GBP', enabled: row?.features?.funding_readiness === true };
}
