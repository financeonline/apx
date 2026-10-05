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

export type ReportScope = 'all_accounts' | 'income_and_expense';
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
    .select('import_type, target_table, status, confirmations')
    .eq('organization_id', orgId).eq('id', batchId).maybeSingle();
  if (error) throw toMotionError(error);
  const b = batch as { import_type: string; target_table: string; status: string; confirmations: Record<string, { at?: string; value?: { report_complete?: string } }> | null } | null;
  if (b === null || b.status !== 'committed' || b.target_table !== 'period_balances'
    || (b.import_type !== 'trial_balance' && b.import_type !== 'pnl_report')) return null;

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

  return { scope: b.import_type === 'trial_balance' ? 'all_accounts' : 'income_and_expense', importAnswer, months, history };
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
