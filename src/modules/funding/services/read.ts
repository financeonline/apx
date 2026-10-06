import 'server-only';
import { NotFound, toMotionError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import type { FactorResult, ImprovementAction } from '../domain/types';

/**
 * Reading Funding Readiness for the page (PHASE_16_IMPLEMENTATION.md §10, §11).
 *
 * `reports.view` (D-4), then the flag — re-read on every request — then RLS, which itself hides every
 * row while the flag is off. Flag off is NOT FOUND, for every role (U-5).
 */

export interface FundingView {
  readonly state: 'preparing' | 'no_eligible_period' | 'ready';
  readonly months: readonly { readonly periodId: string; readonly label: string }[];
  readonly assessment: {
    readonly id: string;
    readonly periodId: string;
    readonly periodLabel: string;
    readonly status: 'scored' | 'insufficient_data';
    readonly score: number | null;
    readonly band: string | null;
    readonly dataCoveragePercent: number;
    readonly factorsUsed: number;
    readonly factors: readonly FactorResult[];
    readonly actions: readonly ImprovementAction[];
    readonly rulesVersion: string;
    readonly engineVersion: string;
    readonly calculationRunId: string;
    readonly createdAt: string;
    readonly disclaimer: string;
    readonly evidenceBundleId: string | null;
  } | null;
}

export async function fundingEnabled(ctx: AccessContext): Promise<boolean> {
  if (!ctx.orgId) return false;
  const { data, error } = await ctx.db.from('organizations').select('features').eq('id', ctx.orgId).maybeSingle();
  if (error) throw toMotionError(error, ctx.requestId);
  return (data as { features?: Record<string, unknown> } | null)?.features?.funding_readiness === true;
}

export async function getFundingView(ctx: AccessContext, periodId?: string): Promise<FundingView> {
  assertCan(ctx, 'reports.view');
  const orgId = ctx.orgId;
  if (!orgId || !(await fundingEnabled(ctx))) throw new NotFound();

  const { data: current, error } = await ctx.db.from('funding_current')
    .select('period_id, assessment_id, fiscal_periods!funding_current_period_fk!inner(label, period_start)')
    .eq('organization_id', orgId);
  if (error) throw toMotionError(error, ctx.requestId);
  const rows = ((current ?? []) as Array<{ period_id: string; assessment_id: string; fiscal_periods: { label: string; period_start: string } | { label: string; period_start: string }[] }>)
    .map((r) => {
      const p = Array.isArray(r.fiscal_periods) ? r.fiscal_periods[0]! : r.fiscal_periods;
      return { periodId: r.period_id, assessmentId: r.assessment_id, label: p.label, start: p.period_start };
    })
    .sort((a, b) => b.start.localeCompare(a.start));

  if (rows.length === 0) {
    const { count } = await ctx.db.from('fiscal_periods').select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId).eq('is_complete', true);
    return { state: (count ?? 0) > 0 ? 'preparing' : 'no_eligible_period', months: [], assessment: null };
  }

  const chosen = periodId === undefined ? rows[0]! : rows.find((r) => r.periodId === periodId);
  if (chosen === undefined) throw new NotFound();

  const [{ data: row, error: rowError }, { data: bundle }] = await Promise.all([
    ctx.db.from('funding_assessments')
      .select('id, period_id, overall_status, overall_score, band, data_coverage_percent, factors_used, breakdown, rules_version, engine_version, calculation_run_id, created_at, disclaimer')
      .eq('organization_id', orgId).eq('id', chosen.assessmentId).maybeSingle(),
    ctx.db.from('evidence_bundles').select('id').eq('organization_id', orgId)
      .eq('origin_table', 'funding_assessments').eq('origin_id', chosen.assessmentId).maybeSingle(),
  ]);
  if (rowError) throw toMotionError(rowError, ctx.requestId);
  if (row === null) throw new NotFound();
  const r = row as {
    id: string; period_id: string; overall_status: 'scored' | 'insufficient_data'; overall_score: number | null; band: string | null;
    data_coverage_percent: number; factors_used: number; breakdown: { factors: FactorResult[]; actions: ImprovementAction[] };
    rules_version: string; engine_version: string; calculation_run_id: string; created_at: string; disclaimer: string;
  };
  return {
    state: 'ready',
    months: rows.map((m) => ({ periodId: m.periodId, label: m.label })),
    assessment: {
      id: r.id, periodId: r.period_id, periodLabel: chosen.label, status: r.overall_status, score: r.overall_score, band: r.band,
      dataCoveragePercent: r.data_coverage_percent, factorsUsed: r.factors_used,
      factors: r.breakdown.factors, actions: r.breakdown.actions,
      rulesVersion: r.rules_version, engineVersion: r.engine_version, calculationRunId: r.calculation_run_id,
      createdAt: r.created_at, disclaimer: r.disclaimer,
      evidenceBundleId: (bundle as { id?: string } | null)?.id ?? null,
    },
  };
}
