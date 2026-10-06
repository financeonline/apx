import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { FactorResult, ImprovementAction } from '@/modules/funding';
import { FUNDING_REPORT_VERSION, type FundingReportContent } from '../domain/funding-report';
import { loadOrganisationBasics } from '../data/brief-sources';

/**
 * Composing the Funding Readiness Report for the `report.compose` job (REQ-RP-05). Reads the month's
 * CURRENT assessment — the latest month unless one is named — and refuses (NULL) while the feature is
 * off or when no assessment exists: a report says a month was assessed, and an empty one would lie.
 */
export async function composeFundingReport(input: {
  readonly db: SupabaseClient; readonly orgId: string; readonly periodId: string | null; readonly now: Date;
}): Promise<{ content: FundingReportContent; periodId: string; window: { start: string; end: string } } | null> {
  const { db, orgId } = input;
  const { data: org, error: orgError } = await db.from('organizations').select('features').eq('id', orgId).maybeSingle();
  if (orgError) throw toMotionError(orgError);
  if ((org as { features?: Record<string, unknown> } | null)?.features?.funding_readiness !== true) return null;

  let query = db.from('funding_current')
    .select('period_id, assessment_id, fiscal_periods!funding_current_period_fk!inner(label, period_start, period_end)')
    .eq('organization_id', orgId);
  if (input.periodId !== null) query = query.eq('period_id', input.periodId);
  const { data: current, error } = await query;
  if (error) throw toMotionError(error);
  const rows = ((current ?? []) as Array<{ period_id: string; assessment_id: string; fiscal_periods: { label: string; period_start: string; period_end: string } | Array<{ label: string; period_start: string; period_end: string }> }>)
    .map((r) => ({ ...r, p: Array.isArray(r.fiscal_periods) ? r.fiscal_periods[0]! : r.fiscal_periods }))
    .sort((a, b) => b.p.period_start.localeCompare(a.p.period_start));
  const chosen = rows[0];
  if (chosen === undefined) return null;

  const { data: row, error: rowError } = await db.from('funding_assessments')
    .select('id, overall_status, overall_score, band, data_coverage_percent, factors_used, breakdown, rules_version, engine_version, calculation_run_id, created_at, disclaimer')
    .eq('organization_id', orgId).eq('id', chosen.assessment_id).maybeSingle();
  if (rowError) throw toMotionError(rowError);
  if (row === null) return null;
  const a = row as {
    id: string; overall_status: 'scored' | 'insufficient_data'; overall_score: number | null; band: string | null;
    data_coverage_percent: number; factors_used: number; breakdown: { factors: FactorResult[]; actions: ImprovementAction[] };
    rules_version: string; engine_version: string; calculation_run_id: string; created_at: string; disclaimer: string;
  };
  const organisation = await loadOrganisationBasics(db, orgId);
  return {
    periodId: chosen.period_id,
    window: { start: chosen.p.period_start, end: chosen.p.period_end },
    content: {
      version: FUNDING_REPORT_VERSION,
      organisationName: organisation.name,
      period: { id: chosen.period_id, label: chosen.p.label, start: chosen.p.period_start, end: chosen.p.period_end },
      assessment: {
        id: a.id, status: a.overall_status, score: a.overall_score, band: a.band, dataCoveragePercent: a.data_coverage_percent,
        factorsUsed: a.factors_used, factors: a.breakdown.factors, actions: a.breakdown.actions, rulesVersion: a.rules_version,
        engineVersion: a.engine_version, calculationRunId: a.calculation_run_id, assessedAt: a.created_at, disclaimer: a.disclaimer,
      },
      composedAt: input.now.toISOString(),
    },
  };
}
