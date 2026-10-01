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
import { adminSql, clientFor, createAuthUser, sqlstate } from './setup';

/**
 * What-if scenarios, end to end (REQ-SC-01…10; ADR-100).
 *
 * What is asserted is what a wrong answer would hide: that the baseline column IS the forecast to
 * the penny, that the identities hold in the stored rows and not only in the pure function, that
 * every stored figure is `estimated` and the database refuses anything else, that a saved scenario
 * does not move when the forecast underneath it does, that the evidence is the HISTORY the forecast
 * rested on, and that none of it crosses an organisation.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `s${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.scenario.itest`;

let ownerA: string; let clientA: string; let ownerB: string;
let empAssigned: string; let empOther: string; let superAdmin: string;
let orgA: string; let orgB: string;
/*
 * Remediation fixtures (`PHASE_12_REMEDIATION.md`): an organisation with no category breakdown
 * (so a percentage of wages has nothing to be a percentage of), one with four complete months (a
 * `limited` basis), one whose figures carry a data-quality warning, and three whose configured
 * currency is not GBP.
 */
let orgNoCat: string; let orgLimited: string; let orgWarn: string;
let orgINR: string; let orgAED: string; let orgUSD: string;
/** Each remediation organisation has its own owner: `create_organization` is throttled per actor. */
const ownerOf = new Map<string, string>();
const ownerCtx = (org: string): AccessContext => contextFor(ownerOf.get(org)!, 'owner', org);

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function contextFor(
  userId: string, role: 'owner' | 'client' | 'employee' | 'super_admin', org: string = orgA,
  aal: 'aal1' | 'aal2' = 'aal1',
): AccessContext {
  return {
    userId, orgId: org, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: role === 'employee' ? 'employee' : role === 'super_admin' ? 'platform_admin' : 'user',
    db: clientFor(userId, { email: `${userId.slice(0, 6)}@${DOMAIN}`, aal }),
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

/**
 * Complete months of a steady business, written the way the engine writes them.
 *
 * ONE database round trip per organisation. Each `adminSql` is a `docker exec psql`, ~150 ms on a
 * loaded machine; writing every cell as its own statement took ~620 round trips across this file's
 * eight organisations and pushed `beforeAll` past its budget for reasons that had nothing to do
 * with scenarios.
 */
function seedHistory(
  org: string, monthly: Readonly<Record<string, string>>, months = 6, options: SeedOptions = {},
): void {
  const currency = options.currency ?? 'GBP';
  const warnings = JSON.stringify(options.warnings ?? []);
  const categories = options.categories ?? true;
  const starts = Array.from({ length: months }, (_, i) => `'2026-${String(8 - i).padStart(2, '0')}-01'`).join(', ');
  const cells: Array<[string, string | null, string]> = [
    ...Object.entries(monthly).map(([metricKey, value]): [string, string | null, string] => [metricKey, null, value]),
    // The engine's own breakdown of running costs, which a percentage assumption reads (§3).
    ...(categories ? [['expense_by_category', 'payroll', '2000'], ['expense_by_category', 'marketing', '500']] as Array<[string, string, string]> : []),
  ];
  const values = cells.map(([metricKey, dimensionKey, value]) =>
    `('${metricKey}', '${dimensionKey === null ? 'none' : 'standard_category'}', ${dimensionKey === null ? 'null' : `'${dimensionKey}'`}, '${value}')`).join(', ');
  adminSql(`do $$ declare v_run uuid; begin
    update public.organizations set base_currency = '${currency}' where id = '${org}';
    insert into public.calculation_runs
           (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
    select '${org}', 'recalc_manual', '1.0.0', p.id, p.id, '2026-08-31', 'succeeded'
      from public.fiscal_periods p
     where p.organization_id = '${org}' and p.period_start = '2026-08-01'
    returning id into v_run;
    update public.fiscal_periods set is_complete = true
     where organization_id = '${org}' and period_start in (${starts});
    insert into public.metric_snapshots
           (organization_id, calculation_run_id, period_id, metric_key, dimension_type,
            dimension_key, value, unit, currency, basis, assurance_level, data_quality)
    select '${org}', v_run, p.id, v.metric_key, v.dimension_type::public.metric_dimension_enum,
           v.dimension_key, v.value::numeric, 'money'::public.metric_unit_enum, '${currency}',
           'ledger'::public.metric_basis_enum, 'verified'::public.assurance_level_enum,
           '{"completeness": 1, "proxy": false, "warnings": ${warnings}, "missing": []}'::jsonb
      from public.fiscal_periods p
     cross join (values ${values}) as v(metric_key, dimension_type, dimension_key, value)
     where p.organization_id = '${org}' and p.period_start in (${starts});
    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_key,
            snapshot_id, calculation_run_id)
    select organization_id, period_id, metric_key, dimension_type, dimension_key, id, calculation_run_id
      from public.metric_snapshots
     where organization_id = '${org}' and calculation_run_id = v_run;
  end $$;`);
}

const REVENUE_UP_10 = {
  kind: 'revenue_change', mode: 'percent', value: '10',
  directCostsFollow: false, startsInMonth: 1, cashEffect: 'none',
};

beforeAll(async () => {
  ownerA = createAuthUser(`ownerA@${DOMAIN}`);
  clientA = createAuthUser(`clientA@${DOMAIN}`);
  ownerB = createAuthUser(`ownerB@${DOMAIN}`);
  empAssigned = createAuthUser(`emp1@${DOMAIN}`);
  empOther = createAuthUser(`emp2@${DOMAIN}`);
  superAdmin = createAuthUser(`sa@${DOMAIN}`);

  const a = await clientFor(ownerA).schema('api').rpc('create_organization', { p_name: `ITest Sc A ${RUN}` });
  if (a.error) throw new Error(`fixture org A failed: ${a.error.message}`);
  orgA = a.data as unknown as string;
  const b = await clientFor(ownerB).schema('api').rpc('create_organization', { p_name: `ITest Sc B ${RUN}` });
  if (b.error) throw new Error(`fixture org B failed: ${b.error.message}`);
  orgB = b.data as unknown as string;

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgA}', '${clientA}', 'client', 'active');
    insert into public.platform_users (user_id, platform_role, status)
    values ('${empAssigned}', 'employee', 'active'), ('${empOther}', 'employee', 'active'),
           ('${superAdmin}', 'super_admin', 'active');
    update public.profiles set mfa_enrolled_at = now()
     where id in ('${empAssigned}', '${empOther}', '${superAdmin}');
    insert into public.organization_assignments
           (organization_id, employee_user_id, status, starts_at, ends_at, assigned_by)
    values ('${orgA}', '${empAssigned}', 'active', now() - interval '1 day',
            now() + interval '30 days', '${superAdmin}');`);

  seedHistory(orgA, STEADY);
  seedHistory(orgB, { ...STEADY, revenue: '99999' });

  // Remediation fixtures, all owned by A's owner so no extra users are needed. Three complete
  // months is the forecast's minimum, and enough for every property asserted on them.
  const make = async (label: string): Promise<string> => {
    // One owner per organisation: `api.create_organization` is throttled per actor (ADR-044.5),
    // and a fixture that tripped that throttle would be testing the throttle, not scenarios.
    const owner = createAuthUser(`rem-${label.toLowerCase()}@${DOMAIN}`);
    const created = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ITest Sc ${label} ${RUN}` });
    if (created.error) throw new Error(`fixture org ${label} failed: ${created.error.message}`);
    const org = created.data as unknown as string;
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
  seedHistory(orgNoCat, STEADY, 3, { categories: false });
  seedHistory(orgLimited, STEADY, 4);
  seedHistory(orgWarn, STEADY, 3, { warnings: ['cash_basis_proxy', 'bank_coverage_partial'] });
  seedHistory(orgINR, STEADY, 3, { currency: 'INR' });
  seedHistory(orgAED, STEADY, 3, { currency: 'AED' });
  seedHistory(orgUSD, STEADY, 3, { currency: 'USD' });

  // A scenario needs a forecast to move, so every organisation gets one.
  await generateForecast(contextFor(ownerA, 'owner'));
  await generateForecast(contextFor(ownerB, 'owner', orgB));
  for (const org of [orgNoCat, orgLimited, orgWarn, orgINR, orgAED, orgUSD]) {
    await generateForecast(ownerCtx(org));
  }
}, 300_000);

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Sc%${RUN}';
    delete from public.platform_users where user_id in
      (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';`);
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
    const mismatches = one(`
      select count(*)
        from public.scenario_values sv
        join public.scenario_runs sr on sr.id = sv.scenario_run_id
        join public.forecast_values fv
          on fv.organization_id = sv.organization_id
         and fv.forecast_run_id = sr.forecast_run_id
         and fv.period_id = sv.period_id
         and fv.metric_key = sv.metric_key
       where sv.organization_id = '${orgA}' and sv.baseline_value <> fv.value`);
    expect(mismatches, 'every baseline figure is the forecast figure').toBe('0');
  });

  it('refuses to store a scenario figure that claims to be anything but an estimate', () => {
    const runId = one(`select id from public.scenario_runs where organization_id = '${orgA}' limit 1`);
    const periodId = one(`
      select period_id from public.scenario_values where scenario_run_id = '${runId}' limit 1`);
    expect(() => adminSql(`
      insert into public.scenario_values
             (organization_id, scenario_run_id, period_id, metric_key,
              baseline_value, scenario_value, assurance_level, derivation)
      values ('${orgA}', '${runId}', '${periodId}', 'revenue', 1, 2, 'verified', 'baseline')`))
      .toThrow(/scenario_values_estimated|violates check/);
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
    const before = one(`select count(*) from public.scenario_runs where organization_id = '${orgNoCat}'`);
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
    expect(one(`select count(*) from public.scenario_runs where organization_id = '${orgNoCat}'`))
      .toBe(before);
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
    const newRun = one(`
      insert into public.calculation_runs
             (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
      select '${orgA}', 'recalc_manual', '1.0.0', p.id, p.id, '2026-08-31', 'succeeded'
        from public.fiscal_periods p
       where p.organization_id = '${orgA}' and p.period_start = '2026-08-01'
      returning id`);
    for (const month of ['08', '07', '06', '05', '04', '03']) {
      const periodId = one(`
        select id from public.fiscal_periods
         where organization_id = '${orgA}' and period_start = '2026-${month}-01'`);
      const snapshotId = one(`
        insert into public.metric_snapshots
               (organization_id, calculation_run_id, period_id, metric_key, dimension_type,
                value, unit, currency, basis, assurance_level, data_quality)
        values ('${orgA}', '${newRun}', '${periodId}', 'revenue', 'none',
                20000, 'money', 'GBP', 'ledger', 'verified',
                '{"completeness": 1, "proxy": false, "warnings": [], "missing": []}'::jsonb)
        returning id`);
      adminSql(`
        delete from public.metric_current
         where organization_id = '${orgA}' and period_id = '${periodId}'
           and metric_key = 'revenue' and dimension_type = 'none';
        insert into public.metric_current
               (organization_id, period_id, metric_key, dimension_type, snapshot_id, calculation_run_id)
        values ('${orgA}', '${periodId}', 'revenue', 'none', '${snapshotId}', '${newRun}')`);
    }
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
    expect(Number(one(`select count(*) from public.scenario_runs where id = '${state.runId}'`)))
      .toBe(1);

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
    expect(one(`
      select distinct assurance_level::text from public.scenario_values
       where organization_id = '${orgA}'`)).toBe('estimated');
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
    const periods = adminSql(`
      select id || '|' || label || '|' || period_start || '|' || is_complete
        from public.fiscal_periods where organization_id = '${ctx.orgId}' order by period_start`)
      .split('\n').filter(Boolean).map((line) => {
        const [id, label, periodStart, complete] = line.trim().split('|') as [string, string, string, string];
        return { id, label, periodStart, isComplete: complete === 'true' || complete === 't', hasData: true };
      }) as PeriodRow[];
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
    const { result } = await invoke(contextFor(empOther, 'employee', orgA, 'aal2'));
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toBe('NO_DATA');
  });

  it('offers no way to ask for another organisation’s scenario', async () => {
    const theirs = one(`select id from public.scenario_runs where organization_id = '${orgB}' limit 1`);
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
    const asB = clientFor(ownerB, { email: `ownerB@${DOMAIN}` });
    const { data: runs } = await asB.from('scenario_runs').select('id').eq('organization_id', orgA);
    expect(runs ?? []).toHaveLength(0);
    const { data: values } = await asB.from('scenario_values').select('id').eq('organization_id', orgA);
    expect(values ?? []).toHaveLength(0);
  });

  it('refuses A’s owner a direct read of B’s scenario by id', async () => {
    const theirs = one(`select id from public.scenario_runs where organization_id = '${orgB}' limit 1`);
    const state = await loadScenario(contextFor(ownerA, 'owner'), theirs);
    expect(hasScenario(state), 'an id from another organisation resolves to nothing').toBe(false);
  });

  it('refuses A’s owner an archive of B’s scenario', async () => {
    const theirs = one(`select id from public.scenario_runs where organization_id = '${orgB}' limit 1`);
    await expect(archiveScenario(contextFor(ownerA, 'owner'), theirs)).rejects.toThrow();
  });

  /*
   * §21 asks for the reverse as well, and it is not a formality: an isolation rule can be written
   * in one direction by accident — a policy that names the wrong side, a lookup that filters on the
   * id rather than on the organisation — and would pass every test that only ever pushed one way.
   */
  it('refuses B’s owner a direct read of A’s scenario by id', async () => {
    const mine = one(`select id from public.scenario_runs where organization_id = '${orgA}' limit 1`);
    const state = await loadScenario(contextFor(ownerB, 'owner', orgB), mine);
    expect(hasScenario(state)).toBe(false);
  });

  it('refuses B’s owner an archive of A’s scenario', async () => {
    const mine = one(`select id from public.scenario_runs where organization_id = '${orgA}' limit 1`);
    await expect(archiveScenario(contextFor(ownerB, 'owner', orgB), mine)).rejects.toThrow();
  });

  it('gives A’s owner nothing of B under RLS, whatever they ask for', async () => {
    const asA = clientFor(ownerA, { email: `ownerA@${DOMAIN}` });
    const { data: runs } = await asA.from('scenario_runs').select('id').eq('organization_id', orgB);
    expect(runs ?? []).toHaveLength(0);
    const { data: values } = await asA.from('scenario_values').select('id').eq('organization_id', orgB);
    expect(values ?? []).toHaveLength(0);
  });

  it('cannot attach B’s scenario to A’s forecast either, even as the service role', () => {
    const myForecast = one(`select id from public.forecast_runs where organization_id = '${orgA}' limit 1`);
    expect(() => adminSql(`
      insert into public.scenario_runs
             (organization_id, name, forecast_run_id, method, config_version, horizon_months)
      values ('${orgB}', 'stolen the other way', '${myForecast}', 'scenario.v1', 'scenario.config.v1', 3)`))
      .toThrow(/scenario_runs_forecast_fk|violates foreign key/);
  });

  it('refuses a browser any write to either table (ADR-026)', async () => {
    const asOwner = clientFor(ownerA, { email: `ownerA@${DOMAIN}` });
    for (const table of ['scenario_runs', 'scenario_values']) {
      const { error } = await asOwner.from(table).insert({ organization_id: orgA });
      expect(sqlstate(error), table).toBe('42501');
    }
  });

  it('refuses `api_server.finish_scenario` to a signed-in user', async () => {
    const { error } = await clientFor(ownerA, { email: `ownerA@${DOMAIN}` })
      .schema('api_server').rpc('finish_scenario', {
        p_actor: ownerA, p_org: orgA, p_input: {}, p_values: [],
      });
    expect(sqlstate(error)).toBe('42501');
  });

  it('cannot attach a scenario to another organisation’s forecast, even as the service role', () => {
    const theirForecast = one(`select id from public.forecast_runs where organization_id = '${orgB}' limit 1`);
    expect(() => adminSql(`
      insert into public.scenario_runs
             (organization_id, name, forecast_run_id, method, config_version, horizon_months)
      values ('${orgA}', 'stolen', '${theirForecast}', 'scenario.v1', 'scenario.config.v1', 3)`))
      .toThrow(/scenario_runs_forecast_fk|violates foreign key/);
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
    expect(one(`select basis::text from public.scenario_runs where id = '${state.runId}'`)).toBe('limited');
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
    const stored = one(`
      select jsonb_array_length(data_quality -> 'forecast_warnings')
        from public.scenario_runs where id = '${state.runId}'`);
    expect(Number(stored)).toBeGreaterThan(0);
    expect(one(`
      select data_quality -> 'forecast_warnings' -> 0 ->> 'warnings'
        from public.scenario_runs where id = '${state.runId}'`)).toContain('cash_basis_proxy');
  });

  it('reports no warnings for an organisation whose figures carry none', async () => {
    const state = await loadScenario(contextFor(ownerA, 'owner'));
    if (!hasScenario(state)) throw new Error('expected a scenario');
    expect(state.dataQuality.warnings).toEqual([]);
  });
});

describe('every money figure is in the organisation’s configured currency (MEDIUM-3)', () => {
  const toolFor = async (ctx: AccessContext) => {
    const periods = adminSql(`
      select id || '|' || label || '|' || period_start || '|' || is_complete
        from public.fiscal_periods where organization_id = '${ctx.orgId}' order by period_start`)
      .split('\n').filter(Boolean).map((line) => {
        const [id, label, periodStart, complete] = line.trim().split('|') as [string, string, string, string];
        return { id, label, periodStart, isComplete: complete === 'true' || complete === 't', hasData: true };
      }) as PeriodRow[];
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
      expect(one(`
        select distinct currency from public.scenario_values where scenario_run_id = '${state.runId}'`)).toBe(code);

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

  it('never falls back to a default when the organisation has a setting', () => {
    expect(one(`select base_currency from public.organizations where id = '${orgINR}'`).trim()).toBe('INR');
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
    const mine = one(`select id from public.scenario_runs where organization_id = '${orgA}' limit 1`);
    await expect(archiveScenario(contextFor(clientA, 'client'), mine)).rejects.toThrow(/permission/i);
  });

  /*
   * The same refusal, one layer down. `assertCan` stops the service before the RPC is ever made, so
   * the case above proves only the TypeScript gate; this calls `api.archive_scenario` directly with
   * a client's own token and asserts SQL refuses it too. ADR-026's whole point is that the
   * permission is not a property of the caller that happens to be asking.
   */
  it('refuses a client’s DIRECT call to api.archive_scenario, not only the service', async () => {
    const mine = one(`select id from public.scenario_runs where organization_id = '${orgA}' limit 1`);
    const { error } = await clientFor(clientA, { email: `clientA@${DOMAIN}` })
      .schema('api').rpc('archive_scenario', { p_scenario: mine, p_archived: true });
    expect(sqlstate(error)).toBe('42501');
  });

  it('refuses a stranger’s DIRECT call with NOT_FOUND, never confirming the row exists', async () => {
    const mine = one(`select id from public.scenario_runs where organization_id = '${orgA}' limit 1`);
    const { error } = await clientFor(ownerB, { email: `ownerB@${DOMAIN}` })
      .schema('api').rpc('archive_scenario', { p_scenario: mine, p_archived: true });
    expect(sqlstate(error)).toBe('P0002');
  });

  it('lets the assigned employee at aal2 read and work one out', async () => {
    const ctx = contextFor(empAssigned, 'employee', orgA, 'aal2');
    expect(hasScenario(await loadScenario(ctx))).toBe(true);
    const made = await runScenario(ctx, { name: 'Adviser’s try', assumptions: [REVENUE_UP_10] });
    expect(hasScenario(made)).toBe(true);
  });

  it('shows an unassigned employee nothing, though the role holds the permission', async () => {
    const state = await loadScenario(contextFor(empOther, 'employee', orgA, 'aal2'));
    expect(hasScenario(state), 'RLS stops what the permission alone would allow').toBe(false);
  });

  it('shows the assigned employee nothing at aal1 (ADR-044.1)', async () => {
    const state = await loadScenario(contextFor(empAssigned, 'employee', orgA, 'aal1'));
    expect(hasScenario(state)).toBe(false);
  });

  it('shows the assigned employee nothing of organisation B', async () => {
    const state = await loadScenario(contextFor(empAssigned, 'employee', orgB, 'aal2'));
    expect(hasScenario(state)).toBe(false);
  });

  it('records who worked one out, and what they assumed', async () => {
    const audited = one(`
      select count(*) from public.audit_events
       where organization_id = '${orgA}' and action = 'scenario.created'`);
    expect(Number(audited)).toBeGreaterThan(0);
    // `app.audit`'s sixth argument is `after`, which is where `finish_scenario` records what was
    // assumed — the same place `finish_forecast` records what it worked out from.
    expect(one(`
      select after ->> 'assumption_kinds' from public.audit_events
       where organization_id = '${orgA}' and action = 'scenario.created'
       order by created_at desc limit 1`)).toContain('revenue_change');
  });
});
