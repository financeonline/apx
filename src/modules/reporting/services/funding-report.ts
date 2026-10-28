import 'server-only';
import type { Db } from '@/db/types';
import type { FactorResult, ImprovementAction } from '@/modules/funding';
import { FUNDING_REPORT_VERSION, type FundingReportContent } from '../domain/funding-report';
import { loadOrganisationBasics } from '../data/brief-sources';
import { readOrganization, readRowById, readRows, readRowsByIds } from '@/db/app/caller-reads';

/**
 * Composing the Funding Readiness Report for the `report.compose` job (REQ-RP-05). Reads the month's
 * CURRENT assessment — the latest month unless one is named — and refuses (NULL) while the feature is
 * off or when no assessment exists: a report says a month was assessed, and an empty one would lie.
 */
export async function composeFundingReport(input: {
  readonly db: Db; readonly orgId: string; readonly periodId: string | null; readonly now: Date;
}): Promise<{ content: FundingReportContent; periodId: string; window: { start: string; end: string } } | null> {
  const { db, orgId } = input;
  const org = await readOrganization(db, orgId);
  if ((org?.features as Record<string, unknown> | undefined)?.funding_readiness !== true) return null;

  // `funding_current` is keyed by the period id; its month is a second read (the old embedded
  // `fiscal_periods!inner`), so a month the caller cannot read drops out as the inner join did.
  const current = await readRows<{ period_id: string; assessment_id: string }>(db, orgId, 'funding_current',
    input.periodId === null ? undefined : (q) => q.where('period_id', '==', input.periodId));
  const periods = new Map((await readRowsByIds<{ id: string; label: string; period_start: string; period_end: string }>(
    db, orgId, 'fiscal_periods', current.map((r) => r.period_id),
  )).map((p) => [p.id, p]));
  const rows = current
    .filter((r) => periods.has(r.period_id))
    .map((r) => ({ ...r, p: periods.get(r.period_id)! }))
    .sort((a, b) => b.p.period_start.localeCompare(a.p.period_start));
  const chosen = rows[0];
  if (chosen === undefined) return null;

  const row = await readRowById(db, orgId, 'funding_assessments', chosen.assessment_id);
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
