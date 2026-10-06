import type { SupabaseClient } from '@supabase/supabase-js';
import { callApi } from '@/core/db';
import { toMotionError } from '@/core/errors';
import { Decimal, parseDecimalOrNull } from '@/core/money';

/**
 * Step 0F follow-up: what a trial balance or P&L report COVERS, month by month, and the owner's
 * attestation for an import made before the question existed (ADR-139 amendment).
 *
 * Completeness is not accuracy. Nothing here touches a figure's assurance: an attestation says the
 * report lists every account in its scope, not that the amounts are right.
 */

export type ReportScope = 'all_accounts' | 'income_and_expense' | 'open_invoices' | 'assets_and_liabilities';
export type CompletenessAnswer = 'complete' | 'partial';

export interface CompletenessMonth {
  /** `YYYY-MM-01`. */
  readonly month: string;
  /** The answer in force: an owner's latest attestation for the month, else the import's answer. */
  readonly current: CompletenessAnswer | 'unconfirmed';
  readonly source: 'owner_review' | 'import_review' | null;
  /** The import's current lines for the month. */
  readonly lines: number;
  /** A trial balance only: whether the month's lines net to zero (it must, to count as complete). */
  readonly balances: boolean | null;
}

export interface CompletenessAttestationView {
  readonly id: string;
  readonly month: string;
  readonly coverage: CompletenessAnswer;
  readonly scope: ReportScope;
  readonly reason: string;
  readonly attestedBy: string;
  readonly attestedRole: 'owner' | 'admin';
  readonly attestedAt: string;
  readonly supersedesId: string | null;
}

export interface ReportCompletenessView {
  readonly scope: ReportScope;
  /** NF-6: a year-to-date report — each month also rests on the PREVIOUS month's report. */
  readonly cumulative?: boolean;
  readonly importAnswer: { readonly value: CompletenessAnswer; readonly at: string | null } | null;
  readonly months: readonly CompletenessMonth[];
  /** Every attestation, newest first: corrections never overwrite. */
  readonly history: readonly CompletenessAttestationView[];
}

/** For a committed trial balance or P&L report; `null` for anything else. */
export async function loadReportCompleteness(
  db: SupabaseClient, orgId: string, batchId: string,
): Promise<ReportCompletenessView | null> {
  const { data: batch, error } = await db.from('import_batches')
    .select('import_type, target_table, status, confirmations, invoice_list_kind, period_start, balance_basis')
    .eq('organization_id', orgId).eq('id', batchId).maybeSingle();
  if (error) throw toMotionError(error);
  const b = batch as {
    import_type: string; target_table: string; status: string; invoice_list_kind: string | null; period_start: string | null;
    balance_basis: string | null;
    confirmations: Record<string, { at?: string; value?: { report_complete?: string; opening?: string } }> | null;
  } | null;
  if (b === null || b.status !== 'committed') return null;
  // R-2: a FULL invoice list has one answer — whether it holds every invoice unpaid at its start.
  if (b.target_table === 'invoices' && (b.invoice_list_kind ?? 'full') === 'full' && b.period_start !== null) {
    return loadInvoiceListOpening(db, orgId, batchId, b.period_start, b.confirmations?.['IMP-INV-013']);
  }
  if (b.target_table !== 'period_balances'
    || (b.import_type !== 'trial_balance' && b.import_type !== 'pnl_report' && b.import_type !== 'balance_sheet')) return null;

  const [rows, attestations] = await Promise.all([
    db.from('period_balances').select('period_start, closing_balance')
      .eq('organization_id', orgId).eq('import_batch_id', batchId)
      .eq('record_status', 'accepted').is('superseded_by', null),
    db.from('report_completeness_attestations')
      .select('id, period_start, coverage, scope, reason, attested_by, attested_role, attested_at, supersedes_id')
      .eq('organization_id', orgId).eq('import_batch_id', batchId)
      .order('attested_at', { ascending: false }).order('id', { ascending: false }),
  ]);
  if (rows.error) throw toMotionError(rows.error);
  if (attestations.error) throw toMotionError(attestations.error);

  const people = new Map<string, string>();
  const ids = [...new Set((attestations.data ?? []).map((a) => String(a.attested_by)))];
  if (ids.length > 0) {
    const { data } = await db.from('profiles').select('id, full_name, email').in('id', ids);
    for (const p of (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
      people.set(p.id, p.full_name ?? p.email ?? 'A team member');
    }
  }

  const raw = b.confirmations?.['IMP-TB-016'];
  const answer = raw?.value?.report_complete;
  const importAnswer = answer === 'complete' || answer === 'partial' ? { value: answer, at: raw?.at ?? null } as const : null;

  const byMonth = new Map<string, Decimal[]>();
  for (const r of (rows.data ?? []) as Array<{ period_start: string; closing_balance: string | null }>) {
    const list = byMonth.get(r.period_start) ?? [];
    list.push(parseDecimalOrNull(r.closing_balance) ?? new Decimal(0));
    byMonth.set(r.period_start, list);
  }
  const history: CompletenessAttestationView[] = ((attestations.data ?? []) as Array<Record<string, unknown>>).map((a) => ({
    id: String(a.id),
    month: String(a.period_start),
    coverage: a.coverage as CompletenessAnswer,
    scope: a.scope as ReportScope,
    reason: String(a.reason),
    attestedBy: people.get(String(a.attested_by)) ?? 'A team member',
    attestedRole: a.attested_role as 'owner' | 'admin',
    attestedAt: String(a.attested_at),
    supersedesId: a.supersedes_id === null ? null : String(a.supersedes_id),
  }));

  const months = [...byMonth.keys()].sort().map((month): CompletenessMonth => {
    const latest = history.find((h) => h.month === month);
    const amounts = byMonth.get(month)!;
    return {
      month,
      current: latest?.coverage ?? importAnswer?.value ?? 'unconfirmed',
      source: latest ? 'owner_review' : importAnswer ? 'import_review' : null,
      lines: amounts.length,
      balances: b.import_type === 'trial_balance'
        ? amounts.reduce((t, x) => t.plus(x), new Decimal(0)).abs().lessThanOrEqualTo('0.01')
        : null,
    };
  });

  return {
    scope: b.import_type === 'trial_balance' ? 'all_accounts' : b.import_type === 'balance_sheet' ? 'assets_and_liabilities' : 'income_and_expense',
    cumulative: b.balance_basis === 'cumulative',
    importAnswer, months, history,
  };
}

/** R-2: the opening answer of a full invoice list, as one "month" — the month the list starts in. */
async function loadInvoiceListOpening(
  db: SupabaseClient, orgId: string, batchId: string, periodStart: string,
  imported: { at?: string; value?: { opening?: string } } | undefined,
): Promise<ReportCompletenessView> {
  const month = `${periodStart.slice(0, 7)}-01`;
  const [count, attestations] = await Promise.all([
    db.from('invoices').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('import_batch_id', batchId),
    db.from('report_completeness_attestations')
      .select('id, period_start, coverage, scope, reason, attested_by, attested_role, attested_at, supersedes_id')
      .eq('organization_id', orgId).eq('import_batch_id', batchId)
      .order('attested_at', { ascending: false }).order('id', { ascending: false }),
  ]);
  if (attestations.error) throw toMotionError(attestations.error);
  const people = new Map<string, string>();
  const ids = [...new Set((attestations.data ?? []).map((a) => String(a.attested_by)))];
  if (ids.length > 0) {
    const { data } = await db.from('profiles').select('id, full_name, email').in('id', ids);
    for (const p of (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
      people.set(p.id, p.full_name ?? p.email ?? 'A team member');
    }
  }
  const history: CompletenessAttestationView[] = ((attestations.data ?? []) as Array<Record<string, unknown>>).map((a) => ({
    id: String(a.id), month: String(a.period_start), coverage: a.coverage as CompletenessAnswer, scope: a.scope as ReportScope,
    reason: String(a.reason), attestedBy: people.get(String(a.attested_by)) ?? 'A team member',
    attestedRole: a.attested_role as 'owner' | 'admin', attestedAt: String(a.attested_at),
    supersedesId: a.supersedes_id === null ? null : String(a.supersedes_id),
  }));
  const answer = imported?.value?.opening;
  const importAnswer = answer === 'complete' || answer === 'partial' ? { value: answer, at: imported?.at ?? null } as const : null;
  const latest = history.find((h) => h.month === month);
  return {
    scope: 'open_invoices',
    importAnswer,
    months: [{
      month,
      current: latest?.coverage ?? importAnswer?.value ?? 'unconfirmed',
      source: latest ? 'owner_review' : importAnswer ? 'import_review' : null,
      lines: count.count ?? 0,
      balances: null,
    }],
    history,
  };
}

/**
 * Records an owner's or admin's answer for ONE import and ONE month — never several at once. The
 * database checks the role, the import, the month and the reason, appends the attestation, audits
 * it and queues the recalculation.
 */
export async function attestReportCompleteness(
  db: SupabaseClient,
  input: { readonly batchId: string; readonly month: string; readonly coverage: CompletenessAnswer; readonly reason: string },
  requestId?: string,
): Promise<string> {
  return callApi<string>(db, 'attest_report_completeness', {
    p_batch: input.batchId, p_period_start: input.month, p_coverage: input.coverage, p_reason: input.reason,
  }, requestId);
}
