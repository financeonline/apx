import 'server-only';
import { NotFound } from '@/core/errors';
import { readOrganization, readRows, readRowsIn } from '@/db/app/engine-reads';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import type { FactorResult, ImprovementAction } from '../domain/types';
import { FACTOR_NAMES } from '../domain/config';

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
  // ADR-173: Funding Readiness is a department. For a team member whose departments leave it out it
  // is absent exactly as if the company had it switched off — the page, its menu entries and its
  // links — however the company is set (`ctx.modules` is the company's systems narrowed to them).
  if (ctx.modules && !ctx.modules.has('funding')) return false;
  const org = await readOrganization(ctx.db, ctx.orgId);
  return (org?.features as Record<string, unknown> | undefined)?.funding_readiness === true;
}

export async function getFundingView(ctx: AccessContext, periodId?: string): Promise<FundingView> {
  assertCan(ctx, 'reports.view');
  const orgId = ctx.orgId;
  if (!orgId || !(await fundingEnabled(ctx))) throw new NotFound();

  // `fiscal_periods!inner`: a pointer whose period the caller cannot read is dropped.
  const current = await readRows(ctx.db, orgId, 'funding_current');
  const periods = await readRowsIn(ctx.db, orgId, 'fiscal_periods', 'id', current.map((r) => r.period_id as string));
  const periodById = new Map(periods.map((p) => [String(p.id), p]));
  const rows = current.flatMap((r) => {
    const p = periodById.get(String(r.period_id));
    return p ? [{ periodId: String(r.period_id), assessmentId: String(r.assessment_id), label: String(p.label), start: String(p.period_start) }] : [];
  }).sort((a, b) => b.start.localeCompare(a.start));

  if (rows.length === 0) {
    const complete = await readRows(ctx.db, orgId, 'fiscal_periods', (q) => q.where('is_complete', '==', true).limit(1));
    return { state: complete.length > 0 ? 'preparing' : 'no_eligible_period', months: [], assessment: null };
  }

  const chosen = periodId === undefined ? rows[0]! : rows.find((r) => r.periodId === periodId);
  if (chosen === undefined) throw new NotFound();

  const [assessments, bundles] = await Promise.all([
    readRows(ctx.db, orgId, 'funding_assessments', (q) => q.where('id', '==', chosen.assessmentId)),
    readRows(ctx.db, orgId, 'evidence_bundles', (q) => q.where('origin_id', '==', chosen.assessmentId)),
  ]);
  const row = assessments[0] ?? null;
  const bundle = bundles.find((b) => b.origin_table === 'funding_assessments') ?? null;
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
      // Each area under its current plain name, not the name stored with an older assessment (ADR-176).
      factors: r.breakdown.factors.map((f) => ({ ...f, name: FACTOR_NAMES[f.key] ?? f.name })), actions: r.breakdown.actions,
      rulesVersion: r.rules_version, engineVersion: r.engine_version, calculationRunId: r.calculation_run_id,
      createdAt: r.created_at, disclaimer: r.disclaimer,
      evidenceBundleId: (bundle as { id?: string } | null)?.id ?? null,
    },
  };
}
