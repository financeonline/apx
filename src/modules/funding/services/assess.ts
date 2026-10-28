import 'server-only';
import type { Db } from '@/db/types';
import { finishFunding } from '@/core/db';
import { log } from '@/core/logging';
import { ENGINE_VERSION, bankCoverageFor, invoiceOutstandingAt } from '@/modules/financial-engine';
import { reconciliationFor } from '@/modules/dashboard';
import { assessFundingReadiness } from '../domain/assess';
import type { FundingAssessment, OpenInvoiceFact } from '../domain/types';
import * as repo from '../data/repository';

/**
 * The `funding.assess` job's work (PHASE_16_IMPLEMENTATION.md §3; ADR-121, ADR-145).
 *
 * Every complete month that has current figures and no current assessment citing THOSE figures' run is
 * assessed — whatever queued the job (enablement backfill, a successful calculation, the nightly
 * backstop): queued jobs of one organisation merge, and "catch up" is the one rule that is right for
 * all three. Each assessment pins the run whose snapshots it read. Nothing is written while the flag is
 * off (the writer refuses), and no model is involved (D-15).
 */

export type FundingTrigger = 'enablement_backfill' | 'calculation_run' | 'nightly_backstop';

const LOOKBACK = 12;

export async function runFundingAssessment(
  scoped: Db, orgId: string, trigger: FundingTrigger,
): Promise<{ written: number; assessed: number }> {
  const organisation = await repo.loadOrganisation(scoped, orgId);
  // ADR-121: nothing is calculated while the flag is off.
  if (!organisation.enabled) return { written: 0, assessed: 0 };

  const [periods, runs, assessed, accounts, statements] = await Promise.all([
    repo.loadPeriods(scoped, orgId),
    repo.currentRunByPeriod(scoped, orgId),
    repo.currentAssessmentRuns(scoped, orgId),
    repo.loadBankAccounts(scoped, orgId),
    repo.loadStatements(scoped, orgId),
  ]);

  const due = periods.filter((p) => p.isComplete && runs.has(p.id) && assessed.get(p.id) !== runs.get(p.id));
  if (due.length === 0) return { written: 0, assessed: 0 };

  const index = new Map(periods.map((p, i) => [p.id, i]));
  const windowIds = new Set<string>();
  for (const p of due) {
    const i = index.get(p.id)!;
    for (const q of periods.slice(Math.max(0, i - LOOKBACK), i + 1)) windowIds.add(q.id);
  }
  const snapshots = await repo.loadObservations(scoped, orgId, [...windowIds]);
  const statementRanges = statements.map((s) => ({ bankAccountId: s.bankAccountId, periodStart: s.periodStart, periodEnd: s.periodEnd }));
  const loanNames = accounts.filter((a) => a.isActive && a.accountType === 'loan').map((a) => a.name);
  const latestEnd = due[due.length - 1]!.periodEnd;
  const invoices = await repo.loadInvoices(scoped, orgId, latestEnd);

  const results: Array<{ assessment: FundingAssessment; runId: string; label: string }> = [];
  for (const period of due) {
    const i = index.get(period.id)!;
    const window = periods.slice(Math.max(0, i - LOOKBACK), i + 1);
    const bankEvidence = new Map(window.map((p) => {
      const scope = bankCoverageFor(accounts, statementRanges, p);
      return [p.id, scope.inScope.length === 0 ? null : scope.covered.length / scope.inScope.length] as const;
    }));
    const overlapping = statements.filter((s) => s.periodStart <= period.periodEnd && s.periodEnd >= period.periodStart);
    // F3.4: active cash-like accounts with a statement for P (§5.3).
    const reconciliation = accounts.filter((a) => a.isActive && (a.accountType === 'current' || a.accountType === 'savings')
      && overlapping.some((s) => s.bankAccountId === a.id)).map((a) => ({
      accountId: a.id, name: a.name,
      status: reconciliationFor(a.id, overlapping.map((s) => ({
        batch_id: s.batchId, bank_account_id: s.bankAccountId, period_start: s.periodStart, period_end: s.periodEnd,
        committed_at: s.committedAt, statement_opening_balance: s.openingBalance, statement_closing_balance: s.closingBalance,
        extraction_method: s.extractionMethod, unreconciled: s.unreconciled,
      }))).status as 'reconciled' | 'unreconciled' | 'balances_missing',
    }));
    const b3 = await repo.loadB3(scoped, orgId, period.id);
    const openInvoices: OpenInvoiceFact[] = invoices.filter((inv) => inv.issueDate <= period.periodEnd).map((inv) => ({
      invoiceType: inv.invoiceType, issueDate: inv.issueDate, dueDate: inv.dueDate,
      outstanding: invoiceOutstandingAt(inv, period.periodEnd).toString(),
    }));

    const assessment = assessFundingReadiness({
      periodId: period.id,
      periodEnd: period.periodEnd,
      periodIds: window.map((p) => p.id),
      currency: organisation.currency,
      snapshots,
      bankEvidence,
      anomalies: b3 ?? { suppressed: true, reason: 'no_health_score', count: 0 },
      reconciliation,
      loanBankAccountNames: loanNames,
      openInvoices,
    });
    results.push({ assessment, runId: runs.get(period.id)!, label: period.label });
  }

  const written = await finishFunding(orgId, results.map(({ assessment, runId, label }) => ({
    period_id: assessment.periodId,
    calculation_run_id: runId,
    overall_score: assessment.score,
    overall_status: assessment.status,
    band: assessment.band,
    factors_used: assessment.factorsUsed,
    substantive_weight_scored: assessment.substantiveWeightScored,
    data_coverage_percent: assessment.dataCoveragePercent,
    breakdown: { factors: assessment.factors, actions: assessment.actions },
    rules_version: assessment.rulesVersion,
    engine_version: ENGINE_VERSION,
    disclaimer: assessment.disclaimer,
    evidence: evidenceFor(assessment, runId, label),
  })), trigger);

  log.info('funding readiness assessed', { organizationId: orgId, trigger, periods: results.length, written });
  return { written, assessed: results.length };
}

/** The bundle (§8): the run, the month, and every snapshot a factor read. */
function evidenceFor(assessment: FundingAssessment, runId: string, periodLabel: string): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [
    { item_type: 'calculation_run', ref_id: runId, label: 'The calculation this assessment read', assurance_level: 'calculated' },
    { item_type: 'fiscal_period', ref_id: assessment.periodId, label: periodLabel, assurance_level: 'calculated' },
  ];
  const seen = new Set<string>();
  for (const factor of assessment.factors) {
    for (const metric of factor.metrics) {
      if (metric.snapshotId === null || seen.has(metric.snapshotId)) continue;
      seen.add(metric.snapshotId);
      items.push({ item_type: 'metric_snapshot', ref_id: metric.snapshotId, label: `${factor.name}: ${metric.key.replace(/_/g, ' ')}`, assurance_level: 'calculated' });
    }
  }
  return items;
}
