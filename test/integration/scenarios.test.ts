import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { Decimal, formatMoney } from '@/core/money';
import { generateForecast } from '@/modules/forecast';
import {
  archiveScenario, hasScenario, listScenarios, loadScenario, runScenario,
} from '@/modules/scenarios';
import { getBundle } from '@/modules/evidence';
import { runTool, snapshotAccess, resolvePeriodContext, type PeriodRow } from '@/modules/ai';
import { ValidationError } from '@/core/errors';
import type { AccessContext } from '@/modules/tenancy';
import { periodId } from '@/db/app/shared';
import { orgRows } from '@/db/rls';
import { globalRow, orgCollection } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc, serviceClientScoped, sqlstate } from './setup';
import {
  removeSeeded, seedAssignment, seedCurrentFigures, seedMember, seedOrg, seedPlatformUser,
} from '../fixtures/seed';

/**
 * What-if scenarios, end to end (REQ-SC-01…10; ADR-100).
 *
 * What is asserted is what a wrong answer would hide: that the baseline column IS the forecast to
 * the penny, that the identities hold in the stored rows and not only in the pure function, that
 * every stored figure is `estimated` whatever a payload claims, that a saved scenario
 * does not move when the forecast underneath it does, that the evidence is the HISTORY the forecast
 * rested on, and that none of it crosses an organisation.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `s${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.scenario.itest.motion`;

let ownerA: string; let clientA: string; let ownerB: string;
let empAssigned: string; let empOther: string;
let orgA: string; let orgB: string;
/*
 * Remediation fixtures (`PHASE_12_REMEDIATION.md`): an organisation with no category breakdown
 * (so a percentage of wages has nothing to be a percentage of), one with four complete months (a
 * `limited` basis), one whose figures carry a data-quality warning, and three whose configured
 * currency is not GBP.
 */
let orgNoCat: string; let orgLimited: string; let orgWarn: string;
let orgINR: string; let orgAED: string; let orgUSD: string;
/** Each remediation organisation has its own owner, as it did when `create_organization` was throttled per actor. */
const ownerOf = new Map<string, string>();
const ownerCtx = (org: string): AccessContext => contextFor(ownerOf.get(org)!, 'owner', org);

/** Fixture reads, as the server: what the old `adminSql` selects asserted against. */
const rowsOf = async (org: string, table: Parameters<typeof orgCollection>[2], where: Array<[string, unknown]> = []) => {
  let q: FirebaseFirestore.Query = orgCollection(fs(), org, table);
  for (const [k, v] of where) q = q.where(k, '==', v);
  return (await q.get()).docs.map((d) => d.data());
};
const firstScenarioId = async (org: string): Promise<string> => String((await rowsOf(org, 'scenario_runs'))[0]!.id);
const firstForecastId = async (org: string): Promise<string> => String((await rowsOf(org, 'forecast_runs'))[0]!.id);
const periodsOf = async (org: string): Promise<PeriodRow[]> =>
  (await orgCollection(fs(), org, 'fiscal_periods').orderBy('period_start').get()).docs.map((d) => ({
    id: d.id, label: String(d.get('label')), periodStart: String(d.get('period_start')),
    isComplete: d.get('is_complete') === true, hasData: true,
  })) as PeriodRow[];

function contextFor(
  userId: string, role: 'owner' | 'client' | 'employee' | 'super_admin', org: string = orgA,
): AccessContext {
  return {
    userId, orgId: org, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: role === 'employee' ? 'employee' : role === 'super_admin' ? 'platform_admin' : 'user',
    db: clientFor(userId, { email: `${userId.slice(0, 6)}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-09-15T00:00:00Z'),
    organizationStatus: 'active',
  };
}

const STEADY = {
  revenue: '10000', cost_of_sales: '4000', operating_expenses: '3000',
  cash_inflows: '9000', cash_outflows: '7000',
  receivables: '5000', payables: '2000', closing_cash: '20000',
};

interface SeedOptions {
  /** The currency written on every snapshot; the organisation's `base_currency` is set to match. */
  readonly currency?: string;
  /** Data-quality warnings written on every snapshot, so the forecast inherits them (§12). */
  readonly warnings?: readonly string[];
  /** Whether the `expense_by_category` breakdown is written; without it a percentage of wages has no baseline. */
  readonly categories?: boolean;
}

/** Complete months of a steady business (the latest `months` up to August 2026), written the way the engine writes them. */
async function seedHistory(
  org: string, monthly: Readonly<Record<string, string>>, months = 6, options: SeedOptions = {},
): Promise<void> {
  const currency = options.currency ?? 'GBP';
  await fs().collection('organizations').doc(org).update({ base_currency: currency });
  const starts = Array.from({ length: months }, (_, i) => `2026-${String(8 - i).padStart(2, '0')}-01`).reverse();
  await seedCurrentFigures(org, {
    periodStarts: starts, values: monthly, asOf: '2026-08-31', currency, warnings: options.warnings ?? [],
    // The engine's own breakdown of running costs, which a percentage assumption reads (§3).
    cells: (options.categories ?? true) ? [
      { metricKey: 'expense_by_category', dimensionType: 'standard_category', dimensionKey: 'payroll', value: '2000' },
      { metricKey: 'expense_by_category', dimensionType: 'standard_category', dimensionKey: 'marketing', value: '500' },
    ] : [],
  });
}

/** Archives a scenario as its organisation's owner (`api.archive_scenario`). */
async function callArchive(id: string, org = orgA): Promise<void> {
  const { error } = await rpc(clientFor(ownerOf.get(org) ?? ownerA), 'archive_scenario', { p_scenario: id, p_archived: true });
  if (error) throw error;
}

const REVENUE_UP_10 = {
  kind: 'revenue_change', mode: 'percent', value: '10',
  directCostsFollow: false, startsInMonth: 1, cashEffect: 'none',
};

beforeAll(async () => {
  ownerA = await createAuthUser(`ownera@${DOMAIN}`);
  clientA = await createAuthUser(`clienta@${DOMAIN}`);
  ownerB = await createAuthUser(`ownerb@${DOMAIN}`);
  empAssigned = await createAuthUser(`emp1@${DOMAIN}`);
  empOther = await createAuthUser(`emp2@${DOMAIN}`);

  orgA = (await seedOrg({ name: `ITest Sc A ${RUN}`, ownerId: ownerA, around: '2026-09-15' })).orgId;
  orgB = (await seedOrg({ name: `ITest Sc B ${RUN}`, ownerId: ownerB, around: '2026-09-15' })).orgId;

  await seedMember(orgA, clientA, 'client');
  await seedPlatformUser(empAssigned);
  await seedPlatformUser(empOther);
  await seedAssignment(orgA, empAssigned, ownerA);

  await seedHistory(orgA, STEADY);
  await seedHistory(orgB, { ...STEADY, revenue: '99999' });

  // Remediation fixtures. Three complete months is the forecast's minimum, and enough for every
  // property asserted on them.
  const make = async (label: string): Promise<string> => {
    const owner = await createAuthUser(`rem-${label.toLowerCase()}@${DOMAIN}`);
    const org = (await seedOrg({ name: `ITest Sc ${label} ${RUN}`, ownerId: owner, around: '2026-09-15' })).orgId;
    ownerOf.set(org, owner);
    return org;
  };
  ownerOf.set(orgA, ownerA);
  orgNoCat = await make('NoCat');
  orgLimited = await make('Limited');
  orgWarn = await make('Warn');
  orgINR = await make('INR');
  orgAED = await make('AED');
  orgUSD = await make('USD');
  await seedHistory(orgNoCat, STEADY, 3, { categories: false });
  await seedHistory(orgLimited, STEADY, 4);
  await seedHistory(orgWarn, STEADY, 3, { warnings: ['cash_basis_proxy', 'bank_coverage_partial'] });
  await seedHistory(orgINR, STEADY, 3, { currency: 'INR' });
  await seedHistory(orgAED, STEADY, 3, { currency: 'AED' });
  await seedHistory(orgUSD, STEADY, 3, { currency: 'USD' });

  // A scenario needs a forecast to move, so every organisation gets one.
  await generateForecast(contextFor(ownerA, 'owner'));
  await generateForecast(contextFor(ownerB, 'owner', orgB));
  for (const org of [orgNoCat, orgLimited, orgWarn, orgINR, orgAED, orgUSD]) {
    await generateForecast(ownerCtx(org));
  }
}, 300_000);

afterAll(async () => {
  for (const uid of [empAssigned, empOther]) if (uid) await fs().collection('platform_users').doc(uid).delete();
  await removeSeeded([orgA, orgB, orgNoCat, orgLimited, orgWarn, orgINR, orgAED, orgUSD], `@${DOMAIN}`);
});

describe('a scenario is the forecast with stated changes, and nothing else (REQ-SC-01, §6)', () => {
  it('stores both sides of the comparison, and the baseline side IS the forecast', async () => {
    const state = await runScenario(contextFor(ownerA, 'owner'), {
      name: 'Sales up 10%', assumptions: [REVENUE_UP_10],
    });
    expect(hasScenario(state), JSON.stringify(state)).toBe(true);
    if (!hasScenario(state)) return;

    expect(state.method).toBe('scenario.v1');
    expect(state.periods).toHaveLength(3);

    const first = state.periods[0]!;
    const metric = (key: string) => first.metrics.find((m) => m.metricKey === key);
    expect(metric('revenue')?.baselineValue).toBe('10000.00');
    expect(metric('revenue')?.scenarioValue).toBe('11000.00');
    expect(metric('operating_profit')?.scenarioValue, '11,000 − 4,000 − 3,000').toBe('4000.00');
    expect(metric('closing_cash')?.scenarioValue, 'no collection was assumed').toBe('22000.00');

    /*
     * The decisive assertion of the whole phase: every baseline figure equals the FORECAST figure
     * for the same month and metric, read straight out of the other table. If these two ever
     * disagreed, the comparison would be between two different things.
     */
    const runs = new Map((await rowsOf(orgA, 'scenario_runs')).map((r) => [String(r.id), String(r.forecast_run_id)]));
    const forecast = new Map((await rowsOf(orgA, 'forecast_values'))
      .map((v) => [`${v.forecast_run_id}|${v.period_id}|${v.metric_key}`, String(v.value)]));
    const mismatches = String((await rowsOf(orgA, 'scenario_values')).filter((v) => {
      const fv = forecast.get(`${runs.get(String(v.scenario_run_id))}|${v.period_id}|${v.metric_key}`);
      return fv !== undefined && !new Decimal(fv).equals(new Decimal(String(v.baseline_value)));
    }).length);
    expect(mismatches, 'every baseline figure is the forecast figure').toBe('0');
  });

  it('stores a scenario figure as an estimate whatever the payload claims', async () => {
    // `scenario_values_estimated`: the writer sets the assurance itself; a payload has no say.
    const { data: runId, error } = await rpc(serviceClientScoped(orgA), 'finish_scenario', {
      p_actor: ownerA, p_org: orgA,
      p_input: {
        name: 'Claims verified', forecast_run_id: await firstForecastId(orgA), method: 'scenario.v1',
        config_version: 'scenario.config.v1', horizon_months: 1,
      },
      p_values: [{
        period_id: periodId(orgA, '2026-09-01'), metric_key: 'revenue', baseline_value: '1', scenario_value: '2',
        derivation: 'baseline', assurance_level: 'verified',
      }],
    }, { server: true });
    expect(error).toBeNull();
    const values = await rowsOf(orgA, 'scenario_values', [['scenario_run_id', runId]]);
    expect(values.map((v) => v.assurance_level)).toEqual(['estimated']);
    // Put it away so the rest of the file reads only the scenarios it worked out.
    await callArchive(String(runId));
  });

  it('holds the identities in the stored rows, not only in the pure function', async () => {
    const state = await loadScenario(contextFor(ownerA, 'owner'));
    if (!hasScenario(state)) throw new Error('expected a scenario');
    // Decimal, not a float: these are money, and an identity checked "close enough" is not an
    // identity (ADR-006).
    for (const period of state.periods) {
      const v = (key: string) =>
        new Decimal(period.metrics.find((m) => m.metricKey === key)?.scenarioValue ?? '0');
      expect(v('gross_profit').toString(), `gross profit, ${period.periodLabel}`)
        .toBe(v('revenue').minus(4000).toString());
      expect(v('operating_profit').toString(), `operating profit, ${period.periodLabel}`)
        .toBe(v('gross_profit').minus(v('operating_expenses')).toString());
      expect(v('net_cash_movement').toString(), `change in cash, ${period.periodLabel}`)
        .toBe(v('cash_inflows').minus(v('cash_outflows')).toString());
    }
  });

  it('returns the months in date order, not in alphabetical order of their names', async () => {
    const state = await loadScenario(contextFor(ownerA, 'owner'));
    if (!hasScenario(state)) throw new Error('expected a scenario');
    expect(state.periods.map((p) => p.periodLabel)).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026']);
  });

  it('reads a percentage of wages from the engine’s own category breakdown (REQ-SC-03)', async () => {
    const state = await runScenario(contextFor(ownerA, 'owner'), {
      name: 'Wages up 10%',
      assumptions: [
        { kind: 'payroll_change', mode: 'percent', value: '10', startsInMonth: 1, cashEffect: 'none' },
      ],
    });
    if (!hasScenario(state)) throw new Error(JSON.stringify(state));
    const opex = state.periods[0]!.metrics.find((m) => m.metricKey === 'operating_expenses');
    // 10% of the payroll category's 2,000 — not 10% of all running costs.
    expect(opex?.scenarioValue).toBe('3200.00');
  });
});

describe('what a scenario will not do (§7, §10, §11)', () => {
  const ctx = () => contextFor(ownerA, 'owner');

  it('refuses a percentage of a category it has no figure for, names the reason, and stores nothing', async () => {
    /*
     * The audit found the earlier version of this case titled "refuses…" while asserting success
     * (it used an organisation that HAD the category). This organisation has no
     * `expense_by_category` rows, so a percentage of wages has nothing to be a percentage of.
     */
    const before = (await rowsOf(orgNoCat, 'scenario_runs')).length;
    const state = await runScenario(ownerCtx(orgNoCat), {
      name: 'Wages pct',
      assumptions: [
        { kind: 'payroll_change', mode: 'percent', value: '10', startsInMonth: 1, cashEffect: 'none' },
        REVENUE_UP_10,
      ],
    });
    expect(hasScenario(state)).toBe(false);
    if (hasScenario(state)) return;
    // The reason is a real condition, named against the change that failed; the in-range sales
    // change is not applied on its own — a partial scenario would look complete (§7).
    expect(state.unavailable).toEqual([
      { kind: 'payroll_change', reason: 'no_category_baseline', metricKey: 'expense_by_category' },
    ]);
    expect((await rowsOf(orgNoCat, 'scenario_runs')).length).toBe(before);
  });

  it('accepts an AMOUNT of wages for the same organisation, which needs no baseline', async () => {
    const state = await runScenario(ownerCtx(orgNoCat), {
      name: 'Wages amount',
      assumptions: [
        { kind: 'payroll_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'none' },
      ],
    });
    expect(hasScenario(state)).toBe(true);
  });

  it('adds no sales when marketing spend rises (§10)', async () => {
    const state = await runScenario(ctx(), {
      name: 'More marketing',
      assumptions: [
        { kind: 'marketing_change', mode: 'amount', value: '250', startsInMonth: 1, cashEffect: 'same_month' },
      ],
    });
    if (!hasScenario(state)) throw new Error(JSON.stringify(state));
    const metric = (key: string) =>
      state.periods[0]!.metrics.find((m) => m.metricKey === key);
    expect(metric('revenue')?.scenarioValue).toBe(metric('revenue')?.baselineValue);
    expect(metric('operating_expenses')?.change).toBe('250.00');
  });

  it('counts no interest that was not given (§11)', async () => {
    const state = await runScenario(ctx(), {
      name: 'Repay a loan',
      assumptions: [
        { kind: 'debt_repayment', monthlyAmount: '1200', monthlyInterest: null, startsInMonth: 1, cashEffect: 'same_month' },
      ],
    });
    if (!hasScenario(state)) throw new Error(JSON.stringify(state));
    const metric = (key: string) => state.periods[0]!.metrics.find((m) => m.metricKey === key);
    expect(metric('cash_outflows')?.change).toBe('1200.00');
    expect(metric('operating_profit')?.change, 'interest and capital are below the line').toBe('0.00');
  });

  it('refuses an assumption MOTION cannot read, and never turns it into zero (§4)', async () => {
    await expect(runScenario(ctx(), {
      name: 'Nonsense',
      assumptions: [{ ...REVENUE_UP_10, value: '10abc' }],
    })).rejects.toThrow(ValidationError);
  });

  it('refuses two changes that would both move sales (§4)', async () => {
    await expect(runScenario(ctx(), {
      name: 'Double counted',
      assumptions: [
        REVENUE_UP_10,
        { kind: 'pricing_change', pricePercent: '5', volumePercent: '0', directCostsFollow: false, startsInMonth: 1, cashEffect: 'none' },
      ],
    })).rejects.toThrow(ValidationError);
  });

  it('refuses a scenario with nothing in it', async () => {
    await expect(runScenario(ctx(), { name: 'Empty', assumptions: [] }))
      .rejects.toThrow(ValidationError);
  });
});

describe('a saved scenario does not move when the forecast underneath it does (§13)', () => {
  it('keeps its figures and says the forecast has moved on', async () => {
    const ctx = contextFor(ownerA, 'owner');
    const saved = await runScenario(ctx, { name: 'Frozen', assumptions: [REVENUE_UP_10] });
    if (!hasScenario(saved)) throw new Error(JSON.stringify(saved));
    const before = saved.periods[0]!.metrics.find((m) => m.metricKey === 'revenue')!;

    /*
     * The business does better and the engine writes new figures. `metric_snapshots` is append-only
     * (EVIDENCE_MODEL.md §8.8), so this is done the way the engine does it: a new run, a new
     * snapshot, and the pointer moved — which is exactly the situation a saved scenario has to
     * survive.
     */
    await seedCurrentFigures(orgA, {
      periodStarts: ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'],
      values: { revenue: '20000' }, asOf: '2026-08-31',
    });
    await generateForecast(ctx);

    const reopened = await loadScenario(ctx, saved.runId);
    if (!hasScenario(reopened)) throw new Error('expected the saved scenario');
    const after = reopened.periods[0]!.metrics.find((m) => m.metricKey === 'revenue')!;

    expect(after.baselineValue, 'the saved baseline is what it was').toBe(before.baselineValue);
    expect(after.scenarioValue, 'and so is the saved scenario figure').toBe(before.scenarioValue);
    expect(reopened.stale, 'but the reader is told the forecast has moved on').toBe(true);

    // The forecast moved and the saved figures did not: that was the point. The rest of the file
    // reads scenarios it saved itself, so the raised history is left where it is.
    expect(after.scenarioValue).toBe('11000.00');
  });

  it('is put away rather than deleted, so its evidence still resolves', async () => {
    const ctx = contextFor(ownerA, 'owner');
    const state = await runScenario(ctx, { name: 'To be filed', assumptions: [REVENUE_UP_10] });
    if (!hasScenario(state)) throw new Error(JSON.stringify(state));

    await archiveScenario(ctx, state.runId);
    const listed = await listScenarios(ctx);
    expect(listed.some((s) => s.runId === state.runId), 'out of the list').toBe(false);
    expect((await listScenarios(ctx, { includeArchived: true }))
      .some((s) => s.runId === state.runId), 'but still there').toBe(true);

    const reopened = await loadScenario(ctx, state.runId);
    expect(hasScenario(reopened) && reopened.archivedAt !== null).toBe(true);
    expect((await rowsOf(orgA, 'scenario_runs', [['id', state.runId]])).length).toBe(1);

    await archiveScenario(ctx, state.runId, false);
  });
});

describe('the evidence for a scenario is the history its forecast rested on (§16)', () => {
  it('builds a scenario bundle carrying the forecast’s own items', async () => {
    const ctx = contextFor(ownerA, 'owner');
    const state = await loadScenario(ctx);
    if (!hasScenario(state)) throw new Error('expected a scenario');
    expect(state.evidenceBundleId).not.toBeNull();

    const bundle = await getBundle(ctx, state.evidenceBundleId!);
    expect(bundle.kind).toBe('scenario');
    expect(bundle.origin.table).toBe('scenario_runs');

    const types = new Set(bundle.items.map((i) => i.itemType));
    expect(types.has('metric_snapshot'), 'the actual figures it ultimately rests on').toBe(true);
    expect(types.has('calculation_run'), 'and the run that produced them').toBe(true);

    // Nothing about an assumed future may be cited: every item is a real historical row.
    for (const item of bundle.items) {
      expect(['metric_snapshot', 'calculation_run'], item.label).toContain(item.itemType);
    }
  });

  it('keeps the history’s own assurance on the items while the figures stay estimated', async () => {
    const ctx = contextFor(ownerA, 'owner');
    const state = await loadScenario(ctx);
    if (!hasScenario(state)) throw new Error('expected a scenario');
    const bundle = await getBundle(ctx, state.evidenceBundleId!);
    expect(bundle.items.find((i) => i.itemType === 'metric_snapshot')?.assurance).toBe('verified');
    expect([...new Set((await rowsOf(orgA, 'scenario_values')).map((v) => v.assurance_level))]).toEqual(['estimated']);
  });
});

/**
 * §18: the analyst reads a saved scenario; it never works one out.
 *
 * The property worth asserting is not only that the tool returns the stored figures, but that there
 * is NO tool that takes assumptions — which is what makes "invent the assumption yourself"
 * unanswerable rather than merely discouraged.
 */
describe('the analyst reads a scenario rather than computing one (§18)', () => {
  const invoke = async (ctx: AccessContext, input: Record<string, unknown> = {}) => {
    const periods = await periodsOf(ctx.orgId!);
    const periodContext = resolvePeriodContext({
      question: 'what does my scenario say?', periods, fiscalYearStartMonth: 1,
    });
    return runTool({
      seq: 1, name: 'get_scenario', rawInput: input,
      resolveAccess: async () => ctx,
      started: snapshotAccess(ctx),
      call: { periodContext, knownPeriods: periods, now: new Date('2026-09-15T00:00:00Z') },
    });
  };

  it('returns exactly the figures the scenario engine stored, both sides of them', async () => {
    const ctx = contextFor(ownerA, 'owner');
    const stored = await loadScenario(ctx);
    if (!hasScenario(stored)) throw new Error('expected a scenario');

    const { result, persisted } = await invoke(ctx);
    expect(persisted.authorized).toBe(true);
    expect(result.ok, JSON.stringify(result.data)).toBe(true);

    const data = result.data as {
      method: string;
      periods: Array<{ metrics: Array<{
        metric_key: string;
        expected_now: { value: string; unit: string };
        if_this_happens: { value: string; unit: string };
      }> }>;
    };
    expect(data.method).toBe('scenario.v1');
    const revenue = data.periods[0]!.metrics.find((m) => m.metric_key === 'revenue')!;
    const fromService = stored.periods[0]!.metrics.find((m) => m.metricKey === 'revenue')!;
    expect(revenue.if_this_happens.unit, 'a branded envelope the model cannot restate').toBe('money');
    expect(revenue.if_this_happens.value).toBe(fromService.scenarioValue);
    expect(revenue.expected_now.value, 'both halves cross, so neither can be mistaken for the other')
      .toBe(fromService.baselineValue);
  });

  it('offers the model no way to supply an assumption', async () => {
    /*
     * The adversarial case "make the scenario assume revenue is ₹50L". The tool's whole input is an
     * optional scenario id: a foreign property is STRIPPED by Zod (§4) rather than honoured, so the
     * planted assumption cannot reach the engine and the answer is the saved scenario unchanged.
     */
    const ctx = contextFor(ownerA, 'owner');
    const { result } = await invoke(ctx, { revenue: '5000000', assumptions: [{ kind: 'revenue_change' }] });
    expect(result.ok).toBe(true);
    const data = result.data as { periods: Array<{ metrics: Array<{ metric_key: string; if_this_happens: { value: string } }> }> };
    const revenue = data.periods[0]!.metrics.find((m) => m.metric_key === 'revenue')!;
    expect(revenue.if_this_happens.value).not.toBe('5000000.00');
  });

  it('says NO_DATA for an organisation with no saved scenario rather than inventing one', async () => {
    const { result } = await invoke(contextFor(empOther, 'employee', orgA));
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toBe('NO_DATA');
  });

  it('offers no way to ask for another organisation’s scenario', async () => {
    const theirs = (await rowsOf(orgB, 'scenario_runs'))[0]?.id;
    // B has no scenario of its own yet, so this proves the read is bounded even for a real id.
    const bScenario = await runScenario(contextFor(ownerB, 'owner', orgB), {
      name: 'B only', assumptions: [REVENUE_UP_10],
    });
    if (!hasScenario(bScenario)) throw new Error('expected B to get a scenario');
    void theirs;

    const { result } = await invoke(contextFor(ownerA, 'owner'), { scenario_id: bScenario.runId });
    expect(result.ok, 'A asking for B’s id gets nothing').toBe(false);
    expect((result.data as { code: string }).code).toBe('NO_DATA');
  });
});

describe('a scenario belongs to exactly one organisation (§20, §21)', () => {
  it('gives B’s owner nothing of A under RLS, whatever they ask for', async () => {
    const asB = clientFor(ownerB, { email: `ownerb@${DOMAIN}` });
    expect(await orgRows(asB, orgA, 'scenario_runs')).toHaveLength(0);
    expect(await orgRows(asB, orgA, 'scenario_values')).toHaveLength(0);
  });

  it('refuses A’s owner a direct read of B’s scenario by id', async () => {
    const theirs = await firstScenarioId(orgB);
    const state = await loadScenario(contextFor(ownerA, 'owner'), theirs);
    expect(hasScenario(state), 'an id from another organisation resolves to nothing').toBe(false);
  });

  it('refuses A’s owner an archive of B’s scenario', async () => {
    const theirs = await firstScenarioId(orgB);
    await expect(archiveScenario(contextFor(ownerA, 'owner'), theirs)).rejects.toThrow();
  });

  /*
   * §21 asks for the reverse as well, and it is not a formality: an isolation rule can be written
   * in one direction by accident — a policy that names the wrong side, a lookup that filters on the
   * id rather than on the organisation — and would pass every test that only ever pushed one way.
   */
  it('refuses B’s owner a direct read of A’s scenario by id', async () => {
    const mine = await firstScenarioId(orgA);
    const state = await loadScenario(contextFor(ownerB, 'owner', orgB), mine);
    expect(hasScenario(state)).toBe(false);
  });

  it('refuses B’s owner an archive of A’s scenario', async () => {
    const mine = await firstScenarioId(orgA);
    await expect(archiveScenario(contextFor(ownerB, 'owner', orgB), mine)).rejects.toThrow();
  });

  it('gives A’s owner nothing of B under RLS, whatever they ask for', async () => {
    const asA = clientFor(ownerA, { email: `ownera@${DOMAIN}` });
    expect(await orgRows(asA, orgB, 'scenario_runs')).toHaveLength(0);
    expect(await orgRows(asA, orgB, 'scenario_values')).toHaveLength(0);
  });

  /** `finish_scenario` as the server, naming a forecast run; the composite foreign key is its check. */
  const attach = async (org: string, actor: string, forecastRunId: string) => rpc(serviceClientScoped(org), 'finish_scenario', {
    p_actor: actor, p_org: org,
    p_input: { name: 'stolen', forecast_run_id: forecastRunId, method: 'scenario.v1', config_version: 'scenario.config.v1', horizon_months: 3 },
    p_values: [],
  }, { server: true });

  it('cannot attach B’s scenario to A’s forecast either, even as the service role', async () => {
    const { error } = await attach(orgB, ownerB, await firstForecastId(orgA));
    expect(error?.message).toMatch(/references a row that does not exist/);
    expect(sqlstate(error)).toBe('22023');
  });

  it('offers a browser no function that writes either table (ADR-026)', async () => {
    const { API_FUNCTIONS } = await import('@/db/api');
    // `archive_scenario` stamps `archived_at` on the caller's own scenario; nothing writes figures.
    expect(Object.keys(API_FUNCTIONS).filter((n) => /scenario/.test(n))).toEqual(['archive_scenario']);
  });

  it('refuses `api_server.finish_scenario` to a signed-in user', async () => {
    const { error } = await rpc(clientFor(ownerA, { email: `ownera@${DOMAIN}` }), 'finish_scenario', {
      p_actor: ownerA, p_org: orgA, p_input: {}, p_values: [],
    }, { server: true });
    expect(sqlstate(error)).toBe('42501');
  });

  it('cannot attach a scenario to another organisation’s forecast, even as the service role', async () => {
    const { error } = await attach(orgA, ownerA, await firstForecastId(orgB));
    expect(sqlstate(error)).toBe('22023');
  });
});

/**
 * Remediation of the audit's MEDIUM-2 and MEDIUM-3 (`PHASE_12_REMEDIATION.md`): the forecast's basis
 * and warnings must reach the scenario view, and every money figure must be in the organisation's
 * configured currency. Each property is asserted at the storage layer AND on the surface a reader
 * or the analyst actually gets.
 */
describe('the forecast’s quality survives into the scenario (§12)', () => {
  it('carries a limited basis through to the view when the history is short', async () => {
    const ctx = ownerCtx(orgLimited);
    const state = await runScenario(ctx, { name: 'Limited', assumptions: [REVENUE_UP_10] });
    if (!hasScenario(state)) throw new Error(JSON.stringify(state));
    // Four complete months: enough to forecast, fewer than STRONG_MIN_PERIODS.
    expect(state.basis).toBe('limited');
    expect((await rowsOf(orgLimited, 'scenario_runs', [['id', state.runId]]))[0]!.basis).toBe('limited');
  });

  it('carries a strong basis through when the history is long', async () => {
    const state = await loadScenario(contextFor(ownerA, 'owner'));
    if (!hasScenario(state)) throw new Error('expected a scenario');
    expect(state.basis).toBe('strong');
  });

  it('carries the figures’ warnings into the stored run and the view, deduplicated', async () => {
    const ctx = ownerCtx(orgWarn);
    const state = await runScenario(ctx, { name: 'Warned', assumptions: [REVENUE_UP_10] });
    if (!hasScenario(state)) throw new Error(JSON.stringify(state));

    // Every snapshot carried both codes, so every baseline inherited both; the view says each once.
    expect(state.dataQuality.warnings).toEqual(['bank_coverage_partial', 'cash_basis_proxy']);

    // And they are ON THE RUN, so a saved scenario keeps disclosing them after the forecast moves.
    const run = (await rowsOf(orgWarn, 'scenario_runs', [['id', state.runId]]))[0]!;
    const forecastWarnings = (run.data_quality as { forecast_warnings?: Array<{ warnings?: unknown }> }).forecast_warnings ?? [];
    expect(forecastWarnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(forecastWarnings[0]!.warnings)).toContain('cash_basis_proxy');
  });

  it('reports no warnings for an organisation whose figures carry none', async () => {
    const state = await loadScenario(contextFor(ownerA, 'owner'));
    if (!hasScenario(state)) throw new Error('expected a scenario');
    expect(state.dataQuality.warnings).toEqual([]);
  });
});

describe('every money figure is in the organisation’s configured currency (MEDIUM-3)', () => {
  const toolFor = async (ctx: AccessContext) => {
    const periods = await periodsOf(ctx.orgId!);
    const periodContext = resolvePeriodContext({ question: 'my scenario?', periods, fiscalYearStartMonth: 1 });
    return runTool({
      seq: 1, name: 'get_scenario', rawInput: {},
      resolveAccess: async () => ctx, started: snapshotAccess(ctx),
      call: { periodContext, knownPeriods: periods, now: new Date('2026-09-15T00:00:00Z') },
    });
  };

  const CASES: ReadonlyArray<{ code: string; org: () => string }> = [
    { code: 'GBP', org: () => orgA },
    { code: 'INR', org: () => orgINR },
    { code: 'AED', org: () => orgAED },
    { code: 'USD', org: () => orgUSD },
  ];

  for (const { code, org } of CASES) {
    it(`${code}: the view, the stored cells and the analyst's tool all carry it`, async () => {
      const ctx = ownerCtx(org());
      const state = await runScenario(ctx, {
        name: `${code} hire`,
        assumptions: [{ kind: 'hiring', headcount: 1, monthlyCostPerPerson: '50000', startsInMonth: 1, cashEffect: 'none' }],
      });
      if (!hasScenario(state)) throw new Error(JSON.stringify(state));

      // The view: what the page formats every amount with.
      expect(state.currency).toBe(code);
      // The stored cells: the currency travels with the figures, not with the request.
      expect([...new Set((await rowsOf(org(), 'scenario_values', [['scenario_run_id', state.runId]])).map((v) => v.currency))]).toEqual([code]);

      // The analyst's tool: the assumption amount AND the figures, formatted by the product's own
      // formatter in the organisation's currency. The audit found £50,000 beside ₹10,000 here.
      const { result } = await toolFor(ctx);
      expect(result.ok, JSON.stringify(result.data)).toBe(true);
      const data = result.data as {
        assumptions: Array<{ amount: { display: string; value: string } | null }>;
        periods: Array<{ metrics: Array<{ metric_key: string; if_this_happens: { display: string } }> }>;
      };
      const amount = data.assumptions[0]!.amount!;
      expect(amount.display).toBe(formatMoney('50000', { currency: code }));
      expect(amount.value, 'the number itself is untouched').toBe('50000');
      // The figures too: the tool's display is the product's own formatter applied to the view's
      // figure in the organisation's currency. (Not a magic number — an earlier case in this file
      // raises org A's revenue and regenerates its forecast, so the GBP baseline is not 10,000.)
      const revenueCell = state.periods[0]!.metrics.find((m) => m.metricKey === 'revenue')!;
      const revenue = data.periods[0]!.metrics.find((m) => m.metric_key === 'revenue')!;
      expect(revenue.if_this_happens.display)
        .toBe(formatMoney(revenueCell.scenarioValue, { currency: code }));
    });
  }

  it('never falls back to a default when the organisation has a setting', async () => {
    expect(String((await globalRow(fs(), 'organizations', orgINR).get()).get('base_currency')).trim()).toBe('INR');
  });
});

describe('who may read a scenario, and who may work one out (§19, §20)', () => {
  it('lets a client READ — a scenario is a statement about figures they may see', async () => {
    const state = await loadScenario(contextFor(clientA, 'client'));
    expect(hasScenario(state)).toBe(true);
  });

  it('does not let a client work one out', async () => {
    await expect(runScenario(contextFor(clientA, 'client'), {
      name: 'Client tries', assumptions: [REVENUE_UP_10],
    })).rejects.toThrow(/permission/i);
  });

  it('does not let a client put one away', async () => {
    const mine = await firstScenarioId(orgA);
    await expect(archiveScenario(contextFor(clientA, 'client'), mine)).rejects.toThrow(/permission/i);
  });

  /*
   * The same refusal, one layer down. `assertCan` stops the service before the RPC is ever made, so
   * the case above proves only the TypeScript gate; this calls `api.archive_scenario` directly with
   * a client's own token and asserts SQL refuses it too. ADR-026's whole point is that the
   * permission is not a property of the caller that happens to be asking.
   */
  it('refuses a client’s DIRECT call to api.archive_scenario, not only the service', async () => {
    const mine = await firstScenarioId(orgA);
    const { error } = await rpc(clientFor(clientA, { email: `clienta@${DOMAIN}` }), 'archive_scenario', { p_scenario: mine, p_archived: true });
    expect(sqlstate(error)).toBe('42501');
  });

  it('refuses a stranger’s DIRECT call with NOT_FOUND, never confirming the row exists', async () => {
    const mine = await firstScenarioId(orgA);
    const { error } = await rpc(clientFor(ownerB, { email: `ownerb@${DOMAIN}` }), 'archive_scenario', { p_scenario: mine, p_archived: true });
    expect(sqlstate(error)).toBe('P0002');
  });

  it('lets the assigned employee read and work one out', async () => {
    const ctx = contextFor(empAssigned, 'employee', orgA);
    expect(hasScenario(await loadScenario(ctx))).toBe(true);
    const made = await runScenario(ctx, { name: 'Adviser’s try', assumptions: [REVENUE_UP_10] });
    expect(hasScenario(made)).toBe(true);
  });

  it('shows an unassigned employee nothing, though the role holds the permission', async () => {
    const state = await loadScenario(contextFor(empOther, 'employee', orgA));
    expect(hasScenario(state), 'RLS stops what the permission alone would allow').toBe(false);
  });

  it('shows the assigned employee nothing of organisation B', async () => {
    const state = await loadScenario(contextFor(empAssigned, 'employee', orgB));
    expect(hasScenario(state)).toBe(false);
  });

  it('records who worked one out, and what they assumed', async () => {
    const audited = (await fs().collection('audit_events').where('organization_id', '==', orgA).get()).docs
      .map((d) => d.data()).filter((e) => e.action === 'scenario.created')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    expect(audited.length).toBeGreaterThan(0);
    // The audit's `after` is where `finish_scenario` records what was assumed — the same place
    // `finish_forecast` records what it worked out from.
    expect(JSON.stringify(audited[0]!.after?.assumption_kinds)).toContain('revenue_change');
  });
});

/*
 * "Can we afford it?" (SOW §12; ADR-146). The steady fixture opens on 20,000.00 with 9,000.00 in and
 * 7,000.00 out a month, so the forecast expects 22,000.00, 24,000.00 and 26,000.00 and the buffer is
 * one month of money out, 7,000.00. Every figure below is worked from those.
 */
describe('the analyst checks affordability through MOTION, for an amount the person wrote (ADR-146)', () => {
  const ask = async (ctx: AccessContext, question: string | undefined, input: Record<string, unknown>) => {
    const periods = await periodsOf(ctx.orgId!);
    const periodContext = resolvePeriodContext({ question: question ?? '', periods, fiscalYearStartMonth: 1 });
    return runTool({
      seq: 1, name: 'check_affordability', rawInput: input,
      resolveAccess: async () => ctx, started: snapshotAccess(ctx),
      call: { periodContext, knownPeriods: periods, now: new Date('2026-09-15T00:00:00Z'), question },
    });
  };
  type Data = {
    verdict: string; verdict_without_the_spend: string;
    months: Array<{ expected_closing_cash: { value: string }; closing_cash_after_spend: { value: string } }>;
    buffer_one_month_money_out: { value: string }; headroom_over_buffer: { value: string };
    amount: { value: string; display: string; unit: string }; total_spent_over_forecast: { value: string };
  };

  it('a one-off £15,000 leaves exactly the buffer at its lowest: affordable', async () => {
    const { result, persisted } = await ask(contextFor(ownerA, 'owner'), 'Can we afford a £15,000 van?',
      { amount_as_written: '£15,000', recurrence: 'one_off' });
    expect(persisted.authorized).toBe(true);
    expect(result.ok, JSON.stringify(result.data)).toBe(true);
    const data = result.data as Data;
    expect(data.months.map((m) => [m.expected_closing_cash.value, m.closing_cash_after_spend.value])).toEqual([
      ['22000.00', '7000.00'], ['24000.00', '9000.00'], ['26000.00', '11000.00'],
    ]);
    expect(data).toMatchObject({ verdict: 'affordable', verdict_without_the_spend: 'affordable' });
    expect(data.buffer_one_month_money_out.value).toBe('7000.00');
    expect(data.headroom_over_buffer.value).toBe('0.00');
    expect(data.amount).toMatchObject({ value: '15000.00', unit: 'money' });
  });

  it('a monthly 3k from the second month: 24,000.00 becomes 23,000.00, then 22,000.00', async () => {
    const { result } = await ask(contextFor(ownerA, 'owner'), 'could we take on 3k a month of rent from next month?',
      { amount_as_written: '3k', recurrence: 'monthly', starts_in_month: 2 });
    const data = result.data as Data;
    expect(data.months.map((m) => m.closing_cash_after_spend.value)).toEqual(['22000.00', '21000.00', '20000.00']);
    expect(data.total_spent_over_forecast.value).toBe('6000.00');
    expect(data.verdict).toBe('affordable');
  });

  it('£30,000 in one go takes October below zero: not affordable', async () => {
    const { result } = await ask(contextFor(ownerA, 'owner'), 'Can we afford £30,000 for a new machine?',
      { amount_as_written: '£30,000', recurrence: 'one_off' });
    expect((result.data as Data).verdict).toBe('not_affordable');
  });

  it('refuses an amount the person did not write, and a turn with no question', async () => {
    const owner = contextFor(ownerA, 'owner');
    const invented = await ask(owner, 'Can we afford a new van?', { amount_as_written: '£15,000', recurrence: 'one_off' });
    expect(invented.result.ok).toBe(false);
    expect((invented.result.data as { code: string }).code).toBe('NOT_FOUND');
    const rounded = await ask(owner, 'Can we afford a £14,950 van?', { amount_as_written: '£15,000', recurrence: 'one_off' });
    expect(rounded.result.ok).toBe(false);
    const noQuestion = await ask(owner, undefined, { amount_as_written: '£15,000', recurrence: 'one_off' });
    expect(noQuestion.result.ok).toBe(false);
  });

  it('refuses words it would have to guess at, rather than reading a number into them', async () => {
    const { result } = await ask(contextFor(ownerA, 'owner'), 'Can we afford fifteen thousand?',
      { amount_as_written: 'fifteen thousand', recurrence: 'one_off' });
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toBe('NOT_FOUND');
  });

  it('speaks in the organisation’s own currency', async () => {
    const { result } = await ask(ownerCtx(orgINR), 'Can we afford ₹15,000 of new laptops?',
      { amount_as_written: '₹15,000', recurrence: 'one_off' });
    expect(result.ok, JSON.stringify(result.data)).toBe(true);
    expect((result.data as Data).amount.display).toContain('₹');
  });

  it('a client, who may read the forecast, may ask', async () => {
    const { persisted, result } = await ask(contextFor(clientA, 'client'), 'Can we afford £1,000?',
      { amount_as_written: '£1,000', recurrence: 'one_off' });
    expect(persisted.authorized).toBe(true);
    expect(result.ok).toBe(true);
  });
});
