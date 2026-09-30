import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/core/logging';
import { ALERT_RULE_VERSION } from '@/modules/financial-engine';
import { descriptorHash, parseQueryDescriptor } from '@/modules/evidence';
import { EVALUATORS } from '../domain/rules';
import { planEvaluation, type PeriodPlanInput, type PlannedChange } from '../domain/evaluate';
import type {
  AccountObservation, MetricObservation, RecordObservation,
} from '../domain/types';
import type { RecurringGroupObservation } from '../domain/context';
import * as repo from '../data/repository';

/**
 * The `alerts.evaluate` job (FINANCIAL_ENGINE.md §8.3).
 *
 * Runs after every successful calculation run. It loads what the rules need, asks the pure planner
 * what should change, and hands the whole plan to one database call. Nothing is decided here: this
 * file is the seam between the rules — which are testable without a database — and the write, which
 * is atomic.
 *
 * The `now` it passes is the one clock read in the whole alert engine, and it exists solely for the
 * ninety-day dismissal cooldown (§8.1). Everything else is a function of the data.
 */

export interface AlertEvaluationRequest {
  readonly organizationId: string;
  readonly calculationRunId: string;
  /** The periods the run wrote, oldest first. */
  readonly periods: ReadonlyArray<{
    readonly id: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly isComplete: boolean;
  }>;
  /** The window the run loaded — the periods plus their lookback, oldest first. */
  readonly windowPeriodIds: readonly string[];
  readonly aggregatedAt: string;
  readonly currency: string;
  readonly firstPeriodWithDataId: string | null;
  /** The run's as-of date, where the overflow summary is dated (ADR-124, audit N-11). */
  readonly asOf?: string;
  /** Now, in ISO. Supplied by the caller so the cooldown is reproducible in a test. */
  readonly now: string;
}

export interface AlertEvaluationDeps {
  readonly scoped: SupabaseClient;
  /** `api_server.persist_alerts`, injected so the lint boundary holds and the loop stays testable. */
  readonly persistAlerts: (input: Record<string, unknown>) => Promise<Record<string, number>>;
  /*
   * The inputs the health step already reads (§7.3), injected rather than re-read here.
   *
   * Two modules reading the same rows through two repositories is two chances for them to disagree
   * about what "accepted" or "as of" means — and the whole point of §8.3 is that the score and the
   * alerts see the same data.
   */
  readonly loadObservations: (periodIds: readonly string[]) => Promise<readonly MetricObservation[]>;
  readonly loadBankRecords: (
    periodIds: readonly string[], aggregatedAt: string,
  ) => Promise<readonly RecordObservation[]>;
  readonly loadRecurringGroups: () => Promise<readonly RecurringGroupObservation[]>;
  readonly loadAccounts: () => Promise<readonly AccountObservation[]>;
  readonly loadCounterparties: () => Promise<ReadonlyArray<{ id: string; name: string }>>;
}

export interface AlertEvaluationOutcome {
  readonly inserted: number;
  readonly revised: number;
  readonly touched: number;
  readonly resolved: number;
  readonly overflow: number;
  readonly outcomes: number;
}

/**
 * The counterparties first seen in a period, within the loaded window.
 *
 * Shared shape with the health step's version, and the same honest limit: "new" means new within the
 * twelve months the run loaded, which is all the data in hand can support.
 */
function newCounterpartyIdsIn(
  records: ReadonlyArray<{ counterpartyId: string | null; periodId: string }>,
  periodId: string,
  windowPeriodIds: readonly string[],
): string[] {
  const index = windowPeriodIds.indexOf(periodId);
  if (index < 0) return [];
  const earlier = new Set(windowPeriodIds.slice(0, index));

  const seenEarlier = new Set<string>();
  const seenNow = new Set<string>();
  for (const record of records) {
    if (record.counterpartyId === null) continue;
    if (earlier.has(record.periodId)) seenEarlier.add(record.counterpartyId);
    else if (record.periodId === periodId) seenNow.add(record.counterpartyId);
  }
  return [...seenNow].filter((id) => !seenEarlier.has(id)).sort();
}

export async function evaluateAlerts(
  deps: AlertEvaluationDeps,
  request: AlertEvaluationRequest,
): Promise<AlertEvaluationOutcome> {
  const { scoped } = deps;
  const orgId = request.organizationId;

  // The as-of date of the current period's aging is at most today; the latest period end covers both.
  const issuedBy = request.periods.map((p) => p.periodEnd).sort().at(-1) ?? request.aggregatedAt.slice(0, 10);
  const [snapshots, bankRecords, ledgerRecords, invoiceRecords, groups, accounts, counterparties, existing, openInvoices] =
    await Promise.all([
      deps.loadObservations(request.windowPeriodIds),
      deps.loadBankRecords(request.windowPeriodIds, request.aggregatedAt),
      repo.loadLedgerRecords(scoped, orgId, request.windowPeriodIds, request.aggregatedAt),
      repo.loadInvoiceRecords(scoped, orgId, request.windowPeriodIds, request.aggregatedAt),
      deps.loadRecurringGroups(),
      deps.loadAccounts(),
      deps.loadCounterparties(),
      repo.loadExistingAlerts(scoped, orgId),
      repo.loadOpenInvoices(scoped, orgId, issuedBy, request.aggregatedAt),
    ]);

  const allRecords = [...bankRecords, ...ledgerRecords, ...invoiceRecords];
  const counterpartyNames = new Map(counterparties.map((c) => [c.id, c.name]));

  const completeById = new Map(request.periods.map((p) => [p.id, p.isComplete]));

  const periods: PeriodPlanInput[] = request.periods.map((period) => {
    const trailingComplete = request.windowPeriodIds
      .slice(0, request.windowPeriodIds.indexOf(period.id))
      .filter((id) => completeById.get(id) !== false)
      .slice(-6);

    return {
      periodStart: period.periodStart,
      ctx: {
        organizationId: orgId,
        calculationRunId: request.calculationRunId,
        aggregatedAt: request.aggregatedAt,
        periodId: period.id,
        periodEnd: period.periodEnd,
        isComplete: period.isComplete,
        isFirstPeriodWithData: request.firstPeriodWithDataId === period.id,
        snapshots,
        records: allRecords.filter((r) => r.periodId === period.id),
        trailingRecords: allRecords.filter((r) => trailingComplete.includes(r.periodId)),
        recurringGroups: groups,
        trailingCompletePeriodIds: trailingComplete,
        newCounterpartyIds: newCounterpartyIdsIn(allRecords, period.id, request.windowPeriodIds),
        accounts,
        counterpartyNames,
        openInvoices,
      },
    };
  });

  const plan = planEvaluation({
    organizationId: orgId,
    calculationRunId: request.calculationRunId,
    currency: request.currency,
    ruleVersion: ALERT_RULE_VERSION,
    periods,
    existing,
    now: request.now,
    evaluators: EVALUATORS,
    ...(request.asOf !== undefined ? { asOf: request.asOf } : {}),
  });

  const counts = await deps.persistAlerts({
    p_org: orgId,
    p_run: request.calculationRunId,
    p_changes: plan.changes.map(serialiseChange),
  });

  log.info('alerts evaluated', {
    organizationId: orgId,
    runId: request.calculationRunId,
    outcomes: plan.outcomeCount,
    overflow: plan.overflow,
    ...counts,
  });

  return {
    inserted: counts.inserted ?? 0,
    revised: counts.revised ?? 0,
    touched: counts.touched ?? 0,
    resolved: counts.resolved ?? 0,
    overflow: plan.overflow,
    outcomes: plan.outcomeCount,
  };
}

/** The plan, in the shape `api_server.persist_alerts` reads. */
function serialiseChange(change: PlannedChange): Record<string, unknown> {
  switch (change.kind) {
    case 'insert':
      return {
        kind: 'insert',
        dedupe_key: change.dedupeKey,
        rule_key: change.ruleKey,
        rule_version: ALERT_RULE_VERSION,
        key_kind: change.klass,
        severity: change.severity,
        period_id: change.periodId,
        subject_type: change.subject.type,
        subject_id: change.subject.id,
        metric_key: change.metricKey,
        title: change.rendered.title,
        explanation: change.rendered.whatHappened,
        recommended_next_step: change.rendered.whatYouCanDo,
        threshold_summary: change.thresholdSummary,
        evidence: change.evidence.map(serialiseEvidence),
      };
    case 'revision':
      return {
        kind: 'revision',
        alert_id: change.alertId,
        rule_version: ALERT_RULE_VERSION,
        severity: change.severity,
        period_id: change.periodId,
        title: change.rendered.title,
        explanation: change.rendered.whatHappened,
        recommended_next_step: change.rendered.whatYouCanDo,
        threshold_summary: change.thresholdSummary,
        status: change.status,
        status_reason_code: change.statusReasonCode,
        reopened: change.reopened,
        evidence: change.evidence.map(serialiseEvidence),
      };
    case 'touch':
      return { kind: 'touch', alert_id: change.alertId, period_id: change.periodId };
    case 'resolve':
      return {
        kind: 'resolve',
        alert_id: change.alertId,
        status_reason_code: change.statusReasonCode,
      };
  }
}

/**
 * One evidence pin, ready for the database.
 *
 * A `query` item carries its `descriptor_hash`, which `evidence_items_query_needs_hash` requires and
 * which the AI contract checks a citation against (ADR-032.6). The hash is computed HERE, through
 * the one RFC 8785 implementation in `modules/evidence` — a second hashing routine would be a second
 * answer to "is this the descriptor a tool returned", and the two would eventually disagree.
 *
 * `parseQueryDescriptor` also validates the descriptor against the closed v1 vocabulary, so a rule
 * that invents a filter fails here rather than writing evidence nobody can resolve.
 */
function serialiseEvidence(pin: {
  itemType: string; refId: string | null;
  queryDescriptor: Readonly<Record<string, unknown>> | null;
  label: string; claim: string | null; assuranceLevel: string;
}): Record<string, unknown> {
  const descriptor = pin.queryDescriptor === null
    ? null : parseQueryDescriptor(pin.queryDescriptor);
  return {
    item_type: pin.itemType,
    ref_id: pin.refId,
    query_descriptor: descriptor,
    descriptor_hash: descriptor === null ? null : descriptorHash(descriptor),
    label: pin.label,
    claim: pin.claim,
    assurance_level: pin.assuranceLevel,
  };
}
