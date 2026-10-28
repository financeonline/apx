import 'server-only';
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import { globalCollection, newId, nowIso, orgCollection, orgRow, uniqueGuard } from '../schema';
import { runTx } from '../tx';
import { readerOf, type Db } from '../types';
import { hasPermissionOf } from './access';
import { prepareAudit } from './audit';
import { intOrNull, numericText, textOrNull, writeBundle, type ItemInput } from './engine-evidence';
import { prepareEnqueue } from './jobs';
import { requireScope, requireServer } from './scope';

/**
 * The engine's other outputs, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8): a forecast
 * (`api_server.finish_forecast`, ADR-099), a what-if scenario (`finish_scenario`, ADR-100), Funding
 * Readiness assessments (`finish_funding`, ADR-145) and the nightly Funding backstop
 * (`enqueue_funding_backstop`).
 *
 * Each writes its run, its figures, its evidence bundle and its audit event together, as the SQL
 * function did in one transaction. Firestore's transaction holds a bounded number of writes, so a
 * run with more figures than `TX_WRITES` writes its VALUES first in batches and then the run row,
 * the bundle and the audit event in one transaction: every reader finds values through their run
 * (`forecast_values.forecast_run_id`, `scenario_values.scenario_run_id`), so values whose run row
 * does not exist yet are unreachable — the run becomes visible whole or not at all.
 *
 * The cell uniqueness of the values (`forecast_values_cell_unique`, `scenario_values_cell_unique`:
 * run × period × metric) is checked in memory: the run is created by this very call, so the only
 * rows that could collide are the ones in its own payload.
 */

type Row = Record<string, unknown>;

/** Writes per Firestore transaction or batch, with headroom under the commit limit. */
const TX_WRITES = 400;

const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** `coalesce(x -> 'k', default)`: a jsonb value as stored, the default when absent or JSON null. */
const json = (v: unknown, fallback: unknown): unknown => (v === undefined || v === null ? fallback : v);
/** `jsonb_array_elements_text`: each element as text (a string as itself, anything else as JSON). */
const textArray = (v: unknown): string[] => list(v).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));

/** Every referenced row exists in this organisation (the composite foreign keys), or VALIDATION. */
async function requireRefs(
  fs: Firestore, tx: Transaction, orgId: string, table: Parameters<typeof orgRow>[2], ids: Iterable<string | null>,
  column: string,
): Promise<void> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return;
  const refs: DocumentReference[] = unique.map((id) => orgRow(fs, orgId, table, id));
  const snaps = await tx.getAll(...refs);
  if (snaps.some((s) => !s.exists)) raise.invalid(`${column} references a row that does not exist`);
}

function assertCellsUnique(values: readonly Row[], runColumn: string): void {
  const seen = new Set<string>();
  for (const v of values) {
    const key = JSON.stringify([v.period_id, v.metric_key]);
    if (seen.has(key)) raise.conflict(`${runColumn}: a value for that period and metric already exists`);
    seen.add(key);
  }
}

/** Writes value rows outside the run's transaction, in batches, when they would not fit in it. */
async function writeValuesAhead(fs: Firestore, orgId: string, table: 'forecast_values' | 'scenario_values', rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += TX_WRITES) {
    const batch = fs.batch();
    for (const row of rows.slice(i, i + TX_WRITES)) batch.set(orgRow(fs, orgId, table, String(row.id)), row);
    await batch.commit();
  }
}

/** `app.funding_enabled(org)`: the organisation's `funding_readiness` switch. */
async function fundingEnabled(fs: Firestore, orgId: string, tx?: Transaction): Promise<boolean> {
  const snap = await readerOf(tx).get(globalCollection(fs, 'organizations').doc(orgId));
  const features = obj(snap.exists ? snap.get('features') : null);
  return features.funding_readiness === true || features.funding_readiness === 'true';
}

// ── finish_forecast ─────────────────────────────────────────────────────────────────────────────

async function finishForecast(db: Db, args: Row): Promise<string> {
  requireServer(db);
  const actor = arg.str(args, 'p_actor');
  if (!actor) raise.denied('an actor is required');
  const orgId = arg.req(args, 'p_org');
  // The actor must be able to read what a forecast is made of and what it writes (ADR-172 hardening):
  // NOT FOUND, as the page would be.
  if (!(await hasPermissionOf(db.fs, actor, orgId, 'financials.view'))) raise.notFound();

  const input = arg.obj(args, 'p_input');
  const fs = db.fs;
  const runId = newId();
  const now = nowIso();
  const calc = textOrNull(input.calculation_run_id);
  const horizon = intOrNull(input.horizon_months);
  if (horizon === null) raise.invalid('horizon_months is required');
  if (horizon < 1 || horizon > 12) raise.conflict('forecast_runs_horizon: a forecast looks 1 to 12 months ahead');

  const run = {
    id: runId, organization_id: orgId, method: textOrNull(input.method), config_version: textOrNull(input.config_version),
    calculation_run_id: calc, basis_from_period: textOrNull(input.basis_from_period),
    basis_to_period: textOrNull(input.basis_to_period), periods_used: intOrNull(input.periods_used) ?? 0,
    horizon_months: horizon, basis: textOrNull(input.basis), breakdown: json(input.breakdown, []),
    unavailable: json(input.unavailable, []), generated_at: now, generated_by: actor,
  };
  if (!run.method || !run.config_version) raise.invalid('a forecast needs its method and config version');

  const values: Row[] = list(args.p_values).map((raw) => {
    const v = obj(raw);
    const value = numericText(v.value, 6);
    if (value === null) raise.invalid('a forecast value needs a value');
    const derivation = textOrNull(v.derivation);
    if (derivation !== 'baseline' && derivation !== 'identity') raise.conflict('forecast_values_derivation: unknown derivation');
    return {
      id: newId(), organization_id: orgId, forecast_run_id: runId, period_id: textOrNull(v.period_id),
      metric_key: textOrNull(v.metric_key), value, currency: textOrNull(v.currency), assurance_level: 'estimated',
      derivation, derived_from: textArray(v.derived_from), created_at: now,
    };
  });
  assertCellsUnique(values, 'forecast_values_cell_unique');

  // The evidence bundle (§5, ADR-099): the calculation run, then each distinct basis snapshot once,
  // in the order the payload first names it, with the HISTORY's own assurance.
  const basis = list(input.basis_snapshots).map(obj);
  const items: ItemInput[] = [];
  if (calc) {
    items.push({
      item_type: 'calculation_run', ref_id: calc,
      label: textOrNull(input.run_label) ?? 'The calculation this rests on', assurance_level: 'verified',
    });
  }
  const seen = new Set<string>();
  for (const x of basis) {
    const id = textOrNull(x.snapshot_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const first = basis.find((y) => textOrNull(y.snapshot_id) === id)!;
    items.push({
      item_type: 'metric_snapshot', ref_id: id,
      label: (typeof first.label === 'string' ? first.label : null) ?? 'A figure this rests on',
      assurance_level: textOrNull(first.assurance) ?? 'calculated',
    });
  }

  // Too many figures for one transaction: the values go first, unreachable until their run row exists.
  const inline = values.length + items.length + 3 <= TX_WRITES;
  if (!inline) await writeValuesAhead(fs, orgId, 'forecast_values', values);
  return runTx(db, async (tx) => {
    await requireRefs(fs, tx, orgId, 'calculation_runs', [calc], 'forecast_runs.calculation_run_id');
    await requireRefs(fs, tx, orgId, 'fiscal_periods',
      [run.basis_from_period, run.basis_to_period, ...values.map((v) => v.period_id as string | null)], 'forecast period');
    const bundleId = newId();
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'forecast.generated', targetTable: 'forecast_runs', targetId: runId,
      after: {
        method: textOrNull(input.method), periods_used: textOrNull(input.periods_used),
        basis: textOrNull(input.basis), evidence_bundle_id: bundleId,
      },
      metadata: {}, actorId: actor,
    }, tx);

    tx.set(orgRow(fs, orgId, 'forecast_runs', runId), run);
    if (inline) for (const v of values) tx.set(orgRow(fs, orgId, 'forecast_values', String(v.id)), v);
    writeBundleWithId(tx, fs, bundleId, {
      orgId, kind: 'forecast', originTable: 'forecast_runs', originId: runId, calculationRunId: calc, createdBy: actor,
    }, items);
    audit.write(tx);
    return runId;
  });
}

/** `writeBundle`, with the bundle id decided before the transaction's reads (the audit names it). */
function writeBundleWithId(
  tx: Transaction, fs: Firestore, id: string, bundle: Parameters<typeof writeBundle>[2], items: readonly ItemInput[],
): void {
  const now = nowIso();
  tx.set(orgRow(fs, bundle.orgId, 'evidence_bundles', id), {
    id, organization_id: bundle.orgId, kind: bundle.kind, origin_table: bundle.originTable,
    origin_id: bundle.originId, calculation_run_id: bundle.calculationRunId,
    created_by_type: bundle.createdByType ?? 'system', created_by: bundle.createdBy, created_at: now, origin_message_id: null,
  });
  items.forEach((item, sort) => {
    const itemId = newId();
    tx.set(orgRow(fs, bundle.orgId, 'evidence_items', itemId), {
      id: itemId, organization_id: bundle.orgId, bundle_id: id, sort_order: sort, item_type: item.item_type,
      ref_id: item.ref_id ?? null, ref_revision_no: item.ref_revision_no ?? null,
      query_descriptor: item.query_descriptor ?? null, descriptor_hash: item.descriptor_hash ?? null,
      label: item.label, claim: item.claim ?? null, assurance_level: item.assurance_level, created_at: now,
    });
  });
}

// ── finish_scenario ─────────────────────────────────────────────────────────────────────────────

async function finishScenario(db: Db, args: Row): Promise<string> {
  requireServer(db);
  const actor = arg.str(args, 'p_actor');
  if (!actor) raise.denied('an actor is required');
  const orgId = arg.req(args, 'p_org');
  // Working out a scenario is a deterministic recalculation over the organisation's own figures,
  // which `intelligence.recompute` names (ADR-100).
  if (!(await hasPermissionOf(db.fs, actor, orgId, 'intelligence.recompute'))) raise.notFound();

  const input = arg.obj(args, 'p_input');
  const fs = db.fs;
  const runId = newId();
  const now = nowIso();
  const calc = textOrNull(input.calculation_run_id);
  const forecastRunId = textOrNull(input.forecast_run_id);
  const name = textOrNull(input.name);
  const horizon = intOrNull(input.horizon_months);
  if (!forecastRunId || !name || horizon === null) raise.invalid('a scenario needs its name, forecast and horizon');
  if (name.length < 1 || [...name].length > 120) raise.conflict('scenario_runs_name_length: a scenario name is 1 to 120 characters');
  if (horizon < 1 || horizon > 12) raise.conflict('scenario_runs_horizon: a scenario looks 1 to 12 months ahead');
  const assumptions = json(input.assumptions, []);

  const run = {
    id: runId, organization_id: orgId, name, forecast_run_id: forecastRunId, method: textOrNull(input.method),
    config_version: textOrNull(input.config_version), assumptions, horizon_months: horizon,
    basis: textOrNull(input.basis), data_quality: json(input.data_quality, {}), unavailable: json(input.unavailable, []),
    archived_at: null, created_at: now, created_by: actor,
  };
  if (!run.method || !run.config_version) raise.invalid('a scenario needs its method and config version');

  const values: Row[] = list(args.p_values).map((raw) => {
    const v = obj(raw);
    const baseline = numericText(v.baseline_value, 6);
    const scenario = numericText(v.scenario_value, 6);
    if (baseline === null || scenario === null) raise.invalid('a scenario value needs its baseline and scenario figures');
    const derivation = textOrNull(v.derivation);
    if (derivation !== 'baseline' && derivation !== 'identity') raise.conflict('scenario_values_derivation: unknown derivation');
    return {
      id: newId(), organization_id: orgId, scenario_run_id: runId, period_id: textOrNull(v.period_id),
      metric_key: textOrNull(v.metric_key), baseline_value: baseline, scenario_value: scenario,
      currency: textOrNull(v.currency), assurance_level: 'estimated', derivation,
      derived_from: textArray(v.derived_from), created_at: now,
    };
  });
  assertCellsUnique(values, 'scenario_values_cell_unique');

  const source = textOrNull(input.forecast_bundle_id);
  const kinds = list(assumptions).map((a) => {
    const k = obj(a).kind;
    return k === undefined ? null : k;
  });

  // The copied items are few (the forecast's own bundle); the values decide whether they fit.
  const inline = values.length + 64 <= TX_WRITES;
  if (!inline) await writeValuesAhead(fs, orgId, 'scenario_values', values);
  return runTx(db, async (tx) => {
    await requireRefs(fs, tx, orgId, 'forecast_runs', [forecastRunId], 'scenario_runs.forecast_run_id');
    await requireRefs(fs, tx, orgId, 'fiscal_periods', values.map((v) => v.period_id as string | null), 'scenario_values.period_id');
    // The forecast's own items, copied (the bundle must be this organisation's, as the join required).
    let copied: ItemInput[] = [];
    if (source) {
      const bundle = await tx.get(orgRow(fs, orgId, 'evidence_bundles', source));
      if (bundle.exists) {
        const items = await tx.get(orgCollection(fs, orgId, 'evidence_items').where('bundle_id', '==', source));
        copied = items.docs.map((d) => d.data())
          .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
          .map((ei) => ({
            item_type: String(ei.item_type), ref_id: (ei.ref_id as string | null) ?? null,
            ref_revision_no: (ei.ref_revision_no as number | null) ?? null,
            query_descriptor: ei.query_descriptor ?? null, descriptor_hash: (ei.descriptor_hash as string | null) ?? null,
            label: String(ei.label), assurance_level: String(ei.assurance_level),
          }));
      }
    }
    const bundleId = newId();
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'scenario.created', targetTable: 'scenario_runs', targetId: runId,
      after: {
        method: textOrNull(input.method), forecast_run_id: forecastRunId, assumption_kinds: kinds,
        evidence_bundle_id: bundleId,
      },
      metadata: {}, actorId: actor,
    }, tx);

    tx.set(orgRow(fs, orgId, 'scenario_runs', runId), run);
    if (inline) for (const v of values) tx.set(orgRow(fs, orgId, 'scenario_values', String(v.id)), v);
    writeBundleWithId(tx, fs, bundleId, {
      orgId, kind: 'scenario', originTable: 'scenario_runs', originId: runId, calculationRunId: calc, createdBy: actor,
    }, copied);
    audit.write(tx);
    return runId;
  });
}

// ── finish_funding ──────────────────────────────────────────────────────────────────────────────

const FUNDING_TRIGGERS = new Set(['enablement_backfill', 'calculation_run', 'nightly_backstop']);

function fundingRow(orgId: string, id: string, a: Row, trigger: string, now: string): Row {
  const score = intOrNull(a.overall_score);
  const status = textOrNull(a.overall_status);
  const band = textOrNull(a.band);
  const coverage = intOrNull(a.data_coverage_percent);
  const weight = intOrNull(a.substantive_weight_scored);
  const used = intOrNull(a.factors_used);
  const rules = textOrNull(a.rules_version);
  const engine = textOrNull(a.engine_version);
  const disclaimer = textOrNull(a.disclaimer);
  if (!status || used === null || weight === null || coverage === null || a.breakdown == null || !rules || !engine || !disclaimer) {
    raise.invalid('a funding assessment is missing a required field');
  }
  if (status !== 'scored' && status !== 'insufficient_data') raise.conflict('funding_status: unknown status');
  if ((band === null) !== (score === null)) raise.conflict('funding_band_iff_score: a band goes with a score');
  if ((score === null) !== (status === 'insufficient_data')) raise.conflict('funding_score_iff_scored: a score goes with scored');
  if (score !== null && (score < 0 || score > 100)) raise.conflict('funding_score_range: a score is 0 to 100');
  if (coverage < 0 || coverage > 100) raise.conflict('funding_coverage_range: coverage is 0 to 100');
  if (weight < 0 || weight > 90) raise.conflict('funding_weight_range: the scored weight is 0 to 90');
  if (!FUNDING_TRIGGERS.has(trigger)) raise.conflict('funding_trigger: unknown trigger');
  return {
    id, organization_id: orgId, calculation_run_id: textOrNull(a.calculation_run_id), period_id: textOrNull(a.period_id),
    overall_score: score, overall_status: status, band, factors_used: used, factors_total: 7,
    substantive_weight_scored: weight, data_coverage_percent: coverage, breakdown: a.breakdown,
    rules_version: rules, engine_version: engine, trigger, disclaimer, created_at: now,
  };
}

/**
 * Each assessment is its own transaction: the SQL advisory lock serialised writers per
 * organisation, and here the transaction's reads (the assessment's uniqueness guard, the pointer)
 * make a concurrent writer of the same month and run retry and find the first one standing.
 */
async function finishFunding(db: Db, args: Row): Promise<number> {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  // ADR-121: nothing is calculated, or written, while the flag is off.
  if (!(await fundingEnabled(db.fs, orgId))) return 0;
  const trigger = arg.req(args, 'p_trigger');
  const fs = db.fs;
  let written = 0;

  for (const raw of list(args.p_assessments)) {
    const a = obj(raw);
    const period = textOrNull(a.period_id);
    const runId = textOrNull(a.calculation_run_id);
    written += await runTx(db, async (tx) => {
      const p = period ? await tx.get(orgRow(fs, orgId, 'fiscal_periods', period)) : null;
      if (!p?.exists || p.get('is_complete') !== true) {
        raise.conflict('funding readiness is assessed for complete months only (ADR-030.4)');
      }
      const r = runId ? await tx.get(orgRow(fs, orgId, 'calculation_runs', runId)) : null;
      if (!r?.exists || !['succeeded', 'running'].includes(String(r.get('status')))) {
        raise.notFound(); // "that calculation run is not this organisation's, or did not succeed"
      }
      const guard = await uniqueGuard(fs, { orgId }, 'funding_assessments_once', [period, runId]).read(tx);
      const now = nowIso();
      const pointer = orgRow(fs, orgId, 'funding_current', period!);
      // The same month and run, assessed again: identical by construction, so the first stands — but
      // the pointer is put back on it if it was lost (the backstop's case).
      if (guard.owner) {
        tx.set(pointer, { organization_id: orgId, period_id: period, assessment_id: guard.owner, calculation_run_id: runId, updated_at: now });
        return 0;
      }
      const id = newId();
      const row = fundingRow(orgId, id, a, trigger, now);
      const evidence = list(a.evidence).map(obj);
      guard.take(tx, id);
      tx.set(orgRow(fs, orgId, 'funding_assessments', id), row);
      if (evidence.length > 0) {
        writeBundle(tx, fs, {
          orgId, kind: 'funding_assessment', originTable: 'funding_assessments', originId: id, calculationRunId: runId, createdBy: null,
        }, evidence.map((item) => ({
          item_type: String(item.item_type), ref_id: textOrNull(item.ref_id),
          label: String(item.label), assurance_level: String(item.assurance_level),
        })));
      }
      tx.set(pointer, { organization_id: orgId, period_id: period, assessment_id: id, calculation_run_id: runId, updated_at: now });
      return 1;
    });
  }

  if (written > 0) {
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'funding.assessed', targetTable: 'funding_assessments', targetId: null,
      after: { written, trigger }, metadata: {}, actorId: null,
    });
    await db.fs.runTransaction(async (tx) => { audit.write(tx); });
  }
  return written;
}

// ── enqueue_funding_backstop ────────────────────────────────────────────────────────────────────

/**
 * One `funding.assess` (trigger `nightly_backstop`) per active, enabled organisation whose latest
 * complete month with current figures has no assessment citing those figures' run. The
 * `on conflict do nothing` of the SQL: a job already queued for the organisation is left as it is.
 */
async function enqueueFundingBackstop(db: Db): Promise<number> {
  requireServer(db);
  const fs = db.fs;
  const orgs = await globalCollection(fs, 'organizations').where('status', '==', 'active').get();
  let count = 0;
  for (const o of orgs.docs) {
    const features = obj(o.get('features'));
    if (!(features.funding_readiness === true || features.funding_readiness === 'true')) continue;
    const orgId = o.id;
    const [complete, current] = await Promise.all([
      orgCollection(fs, orgId, 'fiscal_periods').where('is_complete', '==', true).get(),
      orgCollection(fs, orgId, 'metric_current').select('period_id', 'calculation_run_id').get(),
    ]);
    const startOf = new Map(complete.docs.map((d) => [d.id, String(d.get('period_start'))]));
    // max(calculation_run_id::text) per complete period that has current figures; the latest such period.
    const maxRun = new Map<string, string>();
    for (const d of current.docs) {
      const p = String(d.get('period_id'));
      if (!startOf.has(p)) continue;
      const run = String(d.get('calculation_run_id'));
      const prev = maxRun.get(p);
      if (prev === undefined || run > prev) maxRun.set(p, run);
    }
    if (maxRun.size === 0) continue;
    const latest = [...maxRun.keys()].sort((a, b) => (startOf.get(b)! < startOf.get(a)! ? -1 : startOf.get(b)! > startOf.get(a)! ? 1 : 0))[0]!;
    const fc = await orgRow(fs, orgId, 'funding_current', latest).get();
    if (fc.exists && String(fc.get('calculation_run_id')) === maxRun.get(latest)) continue;

    const created = await runTx(db, async (tx) => {
      const job = await prepareEnqueue(fs, {
        organizationId: orgId, jobType: 'funding.assess', payload: { trigger: 'nightly_backstop' },
        requestedBy: null, idempotencyKey: `funding.assess:${orgId}`,
      }, tx);
      if (job.merged) return false;
      job.write(tx);
      return true;
    });
    if (created) count += 1;
  }
  return count;
}

export const resultFunctions: DbFunctions = {
  finish_forecast: finishForecast,
  finish_scenario: finishScenario,
  finish_funding: finishFunding,
  enqueue_funding_backstop: enqueueFundingBackstop,
};
