import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Db } from '@/db/types';
import { globalRow, orgCollection, orgRow } from '@/db/schema';
import {
  aggregationInstant, applyBankingPass, enqueueServerJob, finishCalculationRun, finishChunk, finishHealth,
  setPeriodCompleteness, startCalculationRun,
} from '@/core/db';
import {
  composePeriod, runCalculation,
  type AccountPeriodState, type AggregateCell, type AssuranceLevel, type BalancePnlContext, type CalculationTrigger, type CashSeriesOptions,
  type EngineContext, type MetricResult,
  type PeriodCoverage, type PeriodRef, type ReceivablesComposeInput,
} from '@/modules/financial-engine';
import { healthStep } from '@/modules/health';
import { bankingStep } from '@/modules/banking';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `calculation.run` (FINANCIAL_ENGINE.md §2.4).
 *
 * The handler is deliberately thin: every decision — the affected range, the chunking, the
 * fingerprint, the health step, the failed-run restore — is in `runCalculation`, which is pure of
 * I/O except through the dependencies passed here. This file exists to supply those dependencies
 * and nothing else, so the thing under test stays the run loop rather than a route.
 *
 * **The organisation comes from the job row, never the payload** — `withOrgScope` already applied it
 * before this function was called, and `job.organizationId` is what is passed on. A payload naming
 * another organisation achieves nothing (§4 case 14/19).
 */
/** The identity of a snapshot within one period: its key and, when it has one, its dimension row. */
function snapshotKey(key: string, dimensionId: string | null, dimensionKey: string | null): string {
  return `${key}::${dimensionId ?? ''}::${dimensionKey ?? ''}`;
}

/**
 * Composes a period twice, so a derived metric can name the snapshots it was worked out from
 * (ADR-059; EVIDENCE_MODEL.md §2.3).
 *
 * `evidence_query` for a derived metric is `{name, snapshot_id}[]`, and it is built during
 * composition — before any row exists. With the database generating ids there was nothing to put
 * there, so every derived metric was written with nulls and the whole of drawer levels 2 and 3 was
 * unreadable. The ids are therefore minted here and sent with the insert.
 *
 * Twice rather than once because the set of snapshots a period produces is not known until it has
 * been composed: the P&L emits a metric per category present, concentration a metric per customer.
 * Composition is pure and deterministic — the same inputs give the same results, which the engine's
 * own idempotence tests assert — so the first pass is a description of the shape and the second is
 * the answer. It costs arithmetic over an aggregate already in memory; the alternative is a schema
 * that cannot express what it was designed to express.
 *
 * Exported for the test that pins the "same results" half of that claim: the second pass differs
 * from the first only in the ids it can name, and a regression there would show up as a metric
 * changing SHAPE between two compositions of one aggregate — which is unfalsifiable from the
 * outside, because both passes are internal to one run.
 */
export function composeWithIds(input: Parameters<typeof composePeriod>[0]): readonly MetricResult[] {
  const ids = new Map<string, string>();
  for (const result of composePeriod(input)) {
    ids.set(snapshotKey(result.key, result.dimensionId, result.dimensionKey ?? null), randomUUID());
  }

  return composePeriod({
    ...input,
    resolveSnapshotId: (key, dimensionId, dimensionKey) =>
      ids.get(snapshotKey(key, dimensionId, dimensionKey ?? null)) ?? null,
  }).map((result) => {
    const id = ids.get(snapshotKey(result.key, result.dimensionId, result.dimensionKey ?? null));
    return id === undefined ? result : { ...result, id };
  });
}

export async function runCalculationJob(
  job: ClaimedJob,
  scope: { db: unknown },
): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) {
    return { status: 'failed', error: 'calculation.run has no organization to scope to' };
  }

  const scoped = scope.db as Db;
  const payload = job.payload;

  const trigger = (typeof payload.trigger === 'string' ? payload.trigger : 'recalc_manual') as CalculationTrigger;

  /*
   * `app.enqueue_recalculation` writes `{trigger, triggerRefId}` and no period ids — for an import
   * that ref is the BATCH, and the periods it touched are a property of the batch rather than
   * something the trigger could know.
   *
   * Without resolving them, `affectedRange` had nothing to work from and every commit finished as
   * `nothing_to_do`: the job succeeded, wrote no snapshots, and Home stayed on its empty state
   * (ADR-058.6).
   */
  const triggerRefId = typeof payload.triggerRefId === 'string' ? payload.triggerRefId
    : typeof payload.trigger_ref === 'string' ? payload.trigger_ref
    : null;

  /*
   * FU-16 (ADR-132): a job other triggers coalesced into carries every one of them in `refs`; the
   * run recomputes the UNION of the periods they touched, so an earlier-period import that arrived
   * while a later one waited is never dropped.
   */
  const refs = Array.isArray(payload.refs)
    ? (payload.refs as unknown[]).map((r) => {
        const ref = (r ?? {}) as Record<string, unknown>;
        return typeof ref.triggerRefId === 'string' ? ref.triggerRefId : null;
      })
    : null;

  const changedPeriodIds = Array.isArray(payload.period_ids)
    ? (payload.period_ids as unknown[]).filter((id): id is string => typeof id === 'string')
    : refs !== null && refs.length > 0
      ? await periodsTouchedByAll(scoped, orgId, refs)
      : await periodsTouchedBy(scoped, orgId, triggerRefId);

  /*
   * "Today" in the organisation's timezone, resolved once and passed in (ADR-030.5). The engine
   * never reads a clock; aging and runway are functions of this value, so a run replayed with the
   * same `asOf` reproduces the same figures.
   */
  const asOf = typeof payload.as_of === 'string'
    ? payload.as_of
    : await organisationToday(scoped, orgId);

  const outcome = await runCalculation({
    scoped,
    computePeriod: (input) => {
      const aggregates = input.aggregates as {
        aggregates: readonly AggregateCell[];
        transferLegs: readonly { periodId: string; bankAccountId: string; transferKind: string; inflow: string; outflow: string }[];
        coverage: PeriodCoverage;
        // ADR-120: runway's burn window and the receivables family's inputs.
        cashOptions?: CashSeriesOptions;
        receivables?: ReceivablesComposeInput;
        // ADR-124: every cash-like account's state in the period, from the per-account history.
        cashAccounts?: readonly AccountPeriodState[];
        // ADR-130: the weakest assurance on the bank rows that can feed the period.
        bankRecordAssurance?: AssuranceLevel;
        // H-2: the prior-month facts a cumulative balance report's P&L needs (§3).
        balancePnl?: BalancePnlContext;
      };
      return composeWithIds({
        period: input.period as PeriodRef,
        coverage: aggregates.coverage,
        cells: aggregates.aggregates,
        transferLegs: aggregates.transferLegs,
        context: input.context as EngineContext,
        cashOptions: aggregates.cashOptions,
        receivables: aggregates.receivables,
        cashAccounts: aggregates.cashAccounts,
        bankRecordAssurance: aggregates.bankRecordAssurance,
        balancePnl: aggregates.balancePnl,
      });
    },
    startRun: startCalculationRun,
    // No human actor: the pin is a fact about the transaction, not an intention anybody expressed.
    aggregationInstant: () => aggregationInstant(null),
    finishChunk,
    finishRun: (runId, status, stats, error) =>
      finishCalculationRun(runId, orgId, status, stats, error),
    setCompleteness: (periods, complete) => setPeriodCompleteness(orgId, periods, complete),
    // The health step reads the snapshots this chunk just committed (§7.4 pins their ids), so it
    // takes the same scoped client and nothing else.
    scoreHealth: healthStep({ scoped, finishHealth }),
    // Phase 13 (ADR-101): the banking rules run first, through the same scoped client.
    bankingPass: bankingStep({ scoped, applyBankingPass }),
  }, {
    organizationId: orgId,
    trigger,
    // Only a reference `calculation_runs`' own rule accepts (`runTriggerRef`); the ref still decided
    // the periods above.
    triggerRefId: runTriggerRef(
      trigger, triggerRefId, triggerRefId !== null && await isImportBatch(scoped, orgId, triggerRefId)),
    asOf,
    jobId: job.jobId,
    changedPeriodIds,
  });

  /*
   * §8.1: alerts are evaluated after every SUCCESSFUL run, as a separate job.
   *
   * Separate rather than inline, for two reasons the queue already solves: the alert pass reads the
   * snapshots this run committed, so it must not share the run's transaction; and if it fails it
   * must retry without re-running the calculation, which is far more expensive.
   */
  if (outcome.status === 'succeeded' && outcome.runId !== null) {
    /*
     * A NULL actor, always.
     *
     * `api_server.enqueue_job` documents it — "system job types carry a null actor" — and the
     * `jobs.requested_by` foreign key enforces it: a placeholder uuid is not a profile, so a
     * synthetic system id fails the constraint. Passing the person who triggered the CALCULATION
     * would also be wrong: they did not ask for the alert pass, and attributing machine work to a
     * human is how an audit trail stops meaning anything.
     */
    await enqueueServerJob(
      null,
      {
        organizationId: orgId,
        jobType: 'alerts.evaluate',
        payload: { run_id: outcome.runId },
      },
    ).catch((cause: unknown) => {
      // The figures are committed and correct; only the alert pass is missing. Failing the whole
      // run here would roll nothing back and would hide a good calculation behind a queue problem.
      return { deferred: cause instanceof Error ? cause.message : String(cause) };
    });

    /*
     * Phase 16 (ADR-121, ADR-145): Funding Readiness is assessed after every SUCCESSFUL run while the
     * organisation has it switched on — a separate job, so an assessment always cites a run that
     * succeeded, and nothing at all happens while the flag is off.
     */
    const org = await globalRow(scoped.fs, 'organizations', orgId).get();
    if ((org.get('features') as Record<string, unknown> | undefined)?.funding_readiness === true) {
      await enqueueServerJob(null, {
        organizationId: orgId, jobType: 'funding.assess', payload: { trigger: 'calculation_run', run_id: outcome.runId },
      }).catch((cause: unknown) => ({ deferred: cause instanceof Error ? cause.message : String(cause) }));
    }
  }

  return {
    status: outcome.status === 'failed' ? 'failed' : 'succeeded',
    result: {
      run_id: outcome.runId,
      run_status: outcome.status,
      periods: outcome.periodsWritten,
      snapshots: outcome.snapshotsWritten,
      health_scores: outcome.healthScoresWritten,
    },
  };
}

/**
 * Today, in the organisation's own timezone.
 *
 * A UK business closing March on the 1st of April at 00:30 must not have its March run dated the
 * 31st; a business in Dubai must not have it dated the 2nd. The zone is a setting, so it is read
 * rather than assumed.
 */
async function organisationToday(db: Db, orgId: string): Promise<string> {
  const data = (await globalRow(db.fs, 'organizations', orgId).get()).data() ?? null;

  const timezone = (data as { timezone?: string } | null)?.timezone ?? 'UTC';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * The fiscal periods a batch's declared range covers.
 *
 * The batch declares what it covers (§2.2) rather than having it inferred from its rows, so this is
 * the honest answer to "what changed": a statement covering March changes March, even if its last
 * transaction is on the 20th.
 *
 * An empty result would leave the run with nothing to do, so a batch that cannot be resolved falls
 * back to every period the organisation has — a wider recompute is wasteful, and silently computing
 * nothing after somebody imported a file is not.
 */
/**
 * The reference a run may RECORD (ADR-132). `calculation_runs.trigger_ref_id` is checked by
 * `app.same_org_ref` (migration 20260911000002): `import_commit` / `import_rollback` name an import
 * batch, `account_remapped` an account, `counterparty_merged` a counterparty, and every other trigger
 * names nothing. Callers enqueue with the row that caused the change — a bank transaction for a
 * `banking_edit`, a superseded record, a ledger entry for the opening-balance flag (`import_commit`) —
 * so passing it through refused the run's insert and the job died after three attempts.
 */
export function runTriggerRef(trigger: CalculationTrigger, ref: string | null, refIsImportBatch: boolean): string | null {
  if (ref === null) return null;
  switch (trigger) {
    case 'import_commit':
    case 'import_rollback':
      return refIsImportBatch ? ref : null;
    case 'account_remapped':
    case 'counterparty_merged':
      return ref;
    default:
      return null;
  }
}

async function isImportBatch(db: Db, orgId: string, id: string): Promise<boolean> {
  return (await orgRow(db.fs, orgId, 'import_batches', id).get()).exists;
}

/** The union of the periods each coalesced trigger touched (FU-16). */
export async function periodsTouchedByAll(
  db: Db, orgId: string, refs: ReadonlyArray<string | null>,
): Promise<string[]> {
  const sets = await Promise.all([...new Set(refs)].map((ref) => periodsTouchedBy(db, orgId, ref)));
  return [...new Set(sets.flat())].sort();
}

async function periodsTouchedBy(
  db: Db, orgId: string, batchId: string | null,
): Promise<string[]> {
  // One read of the calendar (a few dozen months), filtered here: the overlap test is a range on
  // two fields, which a single Firestore query does not express without its own index.
  const periods = (await orgCollection(db.fs, orgId, 'fiscal_periods').select('period_start', 'period_end').get())
    .docs.map((d) => ({ id: d.id, start: String(d.get('period_start')), end: String(d.get('period_end')) }));

  if (batchId !== null) {
    const snap = batchId ? await orgRow(db.fs, orgId, 'import_batches', batchId).get() : null;
    const range = snap?.exists ? (snap.data() as { period_start?: string | null; period_end?: string | null }) : null;
    if (range?.period_start != null && range.period_end != null) {
      const ids = periods
        .filter((p) => p.start <= range.period_end! && p.end >= range.period_start!)
        .map((p) => p.id);
      if (ids.length > 0) return ids;
    }
  }

  return periods.map((p) => p.id);
}
