import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { generateForecast, hasForecast, loadForecast } from '@/modules/forecast';
import { getBundle } from '@/modules/evidence';
import { runTool, snapshotAccess, resolvePeriodContext, type PeriodRow } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { readRows } from '@/db/app/engine-reads';
import { periodId } from '@/db/app/shared';
import { orgRows } from '@/db/rls';
import { orgCollection } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc, serviceClientScoped, sqlstate } from './setup';
import {
  removeSeeded, seedAssignment, seedCurrentFigures, seedMember, seedOrg, seedPlatformUser,
} from '../fixtures/seed';

/**
 * The forecast, end to end (REQ-FC-01/02/05; ADR-099).
 *
 * What is asserted is what a wrong answer would hide: that the figures come from the engine's own
 * snapshots, that the identities hold in the stored rows and not only in the pure function, that
 * every stored value is `estimated` and the database will not accept anything else, that the
 * evidence cites HISTORY rather than the future, and that none of it crosses an organisation.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `f${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.forecast.itest.motion`;

let ownerA: string; let clientA: string; let ownerB: string;
let empAssigned: string; let empOther: string;
let orgA: string; let orgB: string;

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

const MONTHS = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'];

/** Six complete months of a steady business, written the way the engine writes them. */
async function seedHistory(org: string, monthly: Readonly<Record<string, string>>): Promise<void> {
  await seedCurrentFigures(org, { periodStarts: MONTHS, values: monthly, asOf: '2026-08-31' });
}

/** Every stored forecast value of an organisation (fixture read, as the server). */
const forecastValues = async (org: string) => (await orgCollection(fs(), org, 'forecast_values').get()).docs.map((d) => d.data());

const STEADY = {
  revenue: '10000', cost_of_sales: '4000', operating_expenses: '3000',
  cash_inflows: '9000', cash_outflows: '7000',
  receivables: '5000', payables: '2000', closing_cash: '20000',
};

beforeAll(async () => {
  ownerA = await createAuthUser(`ownera@${DOMAIN}`);
  clientA = await createAuthUser(`clienta@${DOMAIN}`);
  ownerB = await createAuthUser(`ownerb@${DOMAIN}`);
  empAssigned = await createAuthUser(`emp1@${DOMAIN}`);
  empOther = await createAuthUser(`emp2@${DOMAIN}`);

  orgA = (await seedOrg({ name: `ITest Fc A ${RUN}`, ownerId: ownerA, around: '2026-09-15' })).orgId;
  orgB = (await seedOrg({ name: `ITest Fc B ${RUN}`, ownerId: ownerB, around: '2026-09-15' })).orgId;

  await seedMember(orgA, clientA, 'client');
  await seedPlatformUser(empAssigned);
  await seedPlatformUser(empOther);
  await seedAssignment(orgA, empAssigned, ownerA);

  await seedHistory(orgA, STEADY);
  await seedHistory(orgB, { ...STEADY, revenue: '99999' });
});

afterAll(async () => {
  for (const uid of [empAssigned, empOther]) if (uid) await fs().collection('platform_users').doc(uid).delete();
  await removeSeeded([orgA, orgB], `@${DOMAIN}`);
});

describe('a forecast is made from the engine’s own figures (REQ-FC-01)', () => {
  it('forecasts the six metrics, derives the rest, and stores every figure as estimated', async () => {
    const state = await generateForecast(contextFor(ownerA, 'owner'));
    expect(hasForecast(state), JSON.stringify(state)).toBe(true);
    if (!hasForecast(state)) return;

    expect(state.method).toBe('baseline.v1');
    expect(state.periodsUsed, 'six complete months were available').toBe(6);
    expect(state.basis).toBe('strong');
    expect(state.periods).toHaveLength(3);

    const first = state.periods[0]!;
    const value = (key: string) => first.metrics.find((m) => m.metricKey === key)?.value;

    expect(value('revenue')).toBe('10000.00');
    expect(value('operating_expenses')).toBe('3000.00');
    expect(value('gross_profit'), 'revenue − cost of sales').toBe('6000.00');
    expect(value('operating_profit'), 'gross profit − operating expenses').toBe('3000.00');
    expect(value('net_cash_movement')).toBe('2000.00');
    expect(value('closing_cash'), 'opened on the last ACTUAL balance, not an average').toBe('22000.00');
    expect(value('receivables')).toBe('5000.00');
    expect(value('payables')).toBe('2000.00');

    // REQ-FC-05, read back from the database rather than from the object.
    const stored = await forecastValues(orgA);
    expect(stored.filter((v) => v.assurance_level !== 'estimated')).toHaveLength(0);
    expect(stored.length).toBeGreaterThan(0);
  });

  it('stores a forecast as estimated whatever the payload claims, and refuses an unknown derivation', async () => {
    // The writer sets `assurance_level` itself (forecast_values_estimated); a payload has no say.
    const period = periodId(orgA, '2026-09-01');
    const { data: runId, error } = await rpc(serviceClientScoped(orgA), 'finish_forecast', {
        p_actor: ownerA, p_org: orgA,
        p_input: { method: 'baseline.v1', config_version: 'forecast.config.v1', horizon_months: 1, periods_used: 0 },
        p_values: [{ period_id: period, metric_key: 'revenue', value: '1', derivation: 'baseline', assurance_level: 'verified' }],
      }, { server: true });
    expect(error).toBeNull();
    const values = (await orgCollection(fs(), orgA, 'forecast_values').where('forecast_run_id', '==', runId).get()).docs;
    expect(values.map((d) => d.get('assurance_level'))).toEqual(['estimated']);
    expect(values.map((d) => d.get('value'))).toEqual(['1.000000']);
    await fs().recursiveDelete(orgCollection(fs(), orgA, 'forecast_runs').doc(String(runId)));
    for (const d of values) await d.ref.delete();
    for (const b of (await orgCollection(fs(), orgA, 'evidence_bundles').where('origin_id', '==', runId).get()).docs) await b.ref.delete();

    const bad = await rpc(serviceClientScoped(orgA), 'finish_forecast', {
      p_actor: ownerA, p_org: orgA,
      p_input: { method: 'baseline.v1', config_version: 'forecast.config.v1', horizon_months: 1 },
      p_values: [{ period_id: period, metric_key: 'revenue', value: '1', derivation: 'guess' }],
    }, { server: true });
    expect(sqlstate(bad.error)).toBe('23505');
  });

  it('carries the actual beside the forecast, and the change between them (§14)', async () => {
    const state = await loadForecast(contextFor(ownerA, 'owner'));
    expect(hasForecast(state)).toBe(true);
    if (!hasForecast(state)) return;

    const revenue = state.periods[0]!.metrics.find((m) => m.metricKey === 'revenue')!;
    expect(revenue.lastActual?.value, 'the actual, in the same shape as the forecast').toBe('10000.00');
    expect(revenue.lastActual?.periodLabel).toBe('Aug 2026');
    expect(revenue.change, 'a steady business forecasts its own level').toBe('0.00');
  });

  it('returns the months in date order, not in alphabetical order of their names', async () => {
    const state = await loadForecast(contextFor(ownerA, 'owner'));
    if (!hasForecast(state)) throw new Error('expected a forecast');

    /*
     * "Nov 2026" sorts before "Oct 2026" before "Sep 2026" alphabetically. Sorting by label put the
     * three months on the page backwards and made a rising cash chain read as a falling one.
     */
    expect(state.periods.map((p) => p.periodLabel)).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026']);

    const closing = state.periods.map(
      (p) => p.metrics.find((m) => m.metricKey === 'closing_cash')?.value);
    expect(closing, 'and the chain compounds forward').toEqual(['22000.00', '24000.00', '26000.00']);
  });

  it('speaks only about real future periods', async () => {
    const state = await loadForecast(contextFor(ownerA, 'owner'));
    if (!hasForecast(state)) throw new Error('expected a forecast');
    for (const period of state.periods) {
      const row = (await orgCollection(fs(), orgA, 'fiscal_periods').doc(period.periodId).get()).data();
      expect(row !== undefined && String(row.period_start) > '2026-08-01', period.periodLabel).toBe(true);
    }
  });
});

describe('the forecast’s evidence is its history, never its future (§13)', () => {
  it('builds a forecast bundle whose items are the snapshots the baselines read', async () => {
    const state = await loadForecast(contextFor(ownerA, 'owner'));
    if (!hasForecast(state)) throw new Error('expected a forecast');
    expect(state.evidenceBundleId).not.toBeNull();

    const bundle = await getBundle(contextFor(ownerA, 'owner'), state.evidenceBundleId!);
    expect(bundle.kind).toBe('forecast');
    expect(bundle.origin.table).toBe('forecast_runs');

    const types = new Set(bundle.items.map((i) => i.itemType));
    expect(types.has('metric_snapshot'), 'the actual figures it rests on').toBe(true);
    expect(types.has('calculation_run'), 'and the run that produced them').toBe(true);

    // Nothing about the future may be cited as evidence: every item must be a real historical row.
    for (const item of bundle.items) {
      expect(['metric_snapshot', 'calculation_run'], item.label).toContain(item.itemType);
    }
  });

  it('keeps the history’s own assurance on the items while the figures stay estimated', async () => {
    const state = await loadForecast(contextFor(ownerA, 'owner'));
    if (!hasForecast(state)) throw new Error('expected a forecast');
    const bundle = await getBundle(contextFor(ownerA, 'owner'), state.evidenceBundleId!);
    const snapshot = bundle.items.find((i) => i.itemType === 'metric_snapshot');
    expect(snapshot?.assurance, 'the past was verified').toBe('verified');
    expect([...new Set((await forecastValues(orgA)).map((v) => v.assurance_level))], 'the forecast is not').toEqual(['estimated']);
  });
});

/**
 * §17/§18: the analyst reads the forecast; it never works one out.
 *
 * The tool is the only path by which a forecast figure can reach an answer, and what it returns is
 * what `forecast_values` holds. A model that produced its own number would have nothing to ground
 * it against and the sentence would be removed (§7.8) — so the property worth asserting here is
 * that the tool's figures ARE the stored ones, to the penny.
 */
describe('the analyst reads the forecast rather than computing one (§18)', () => {
  const invoke = async (ctx: AccessContext, input: Record<string, unknown> = {}) => {
    const periods = (await orgCollection(fs(), ctx.orgId!, 'fiscal_periods').orderBy('period_start').get()).docs
      .map((d) => ({
        id: d.id, label: String(d.get('label')), periodStart: String(d.get('period_start')),
        isComplete: d.get('is_complete') === true, hasData: true,
      })) as PeriodRow[];
    const periodContext = resolvePeriodContext({
      question: 'what is the forecast?', periods, fiscalYearStartMonth: 1,
    });
    return runTool({
      seq: 1, name: 'get_forecast', rawInput: input,
      resolveAccess: async () => ctx,
      started: snapshotAccess(ctx),
      call: { periodContext, knownPeriods: periods, now: new Date('2026-09-15T00:00:00Z') },
    });
  };

  it('returns exactly the figures the forecast engine stored', async () => {
    const { result, persisted } = await invoke(contextFor(ownerA, 'owner'));
    expect(persisted.authorized).toBe(true);
    expect(result.ok, JSON.stringify(result.data)).toBe(true);

    const data = result.data as {
      method: string; basis: string; stale: boolean;
      periods: Array<{ period: string; metrics: Array<{ metric_key: string; forecast: { value: string; unit: string } }> }>;
    };
    expect(data.method).toBe('baseline.v1');
    expect(data.basis, 'in words, never a percentage (§19)').toBe('strong');

    const first = data.periods[0]!;
    const revenue = first.metrics.find((m) => m.metric_key === 'revenue')!;
    expect(revenue.forecast.unit, 'a branded money envelope the model cannot restate').toBe('money');
    const latest = (await readRows(clientFor(ownerA), orgA, 'forecast_runs', (q) => q.orderBy('generated_at', 'desc').limit(1)))[0]!;
    const storedRevenue = (await forecastValues(orgA)).find((v) => v.forecast_run_id === latest.id
      && v.metric_key === 'revenue' && v.period_id === periodId(orgA, '2026-09-01'))!;
    expect(revenue.forecast.value).toBe(String(storedRevenue.value).replace(/0+$/, '').replace(/\.$/, '.00'));
  });

  it('offers no way to ask for another organisation’s forecast', async () => {
    // The tool's whole input is an optional metric key: there is no organisation argument to forge,
    // and the organisation comes from the AccessContext the loop resolves per call (§21).
    const { result } = await invoke(contextFor(ownerA, 'owner'), { metric_key: 'revenue' });
    expect(result.ok).toBe(true);
    const data = result.data as { periods: Array<{ metrics: Array<{ metric_key: string }> }> };
    for (const period of data.periods) {
      expect(period.metrics.every((m) => m.metric_key === 'revenue')).toBe(true);
    }
  });

  it('says NO_DATA for an organisation with no forecast rather than inventing one', async () => {
    const ctx = contextFor(empOther, 'employee', orgA);
    const { result } = await invoke(ctx);
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toBe('NO_DATA');
  });
});

describe('a forecast belongs to exactly one organisation (§21)', () => {
  it('shows A’s owner A’s forecast and none of B’s figures', async () => {
    await generateForecast(contextFor(ownerB, 'owner', orgB));
    const a = await loadForecast(contextFor(ownerA, 'owner'));
    if (!hasForecast(a)) throw new Error('expected a forecast');
    const revenue = a.periods[0]!.metrics.find((m) => m.metricKey === 'revenue');
    expect(revenue?.value, 'B forecasts 99,999; A must not see it').toBe('10000.00');
  });

  it('gives B’s owner nothing of A under RLS, whatever they ask for', async () => {
    const asB = clientFor(ownerB, { email: `ownerb@${DOMAIN}` });
    expect(await orgRows(asB, orgA, 'forecast_runs')).toHaveLength(0);
    expect(await orgRows(asB, orgA, 'forecast_values')).toHaveLength(0);
  });

  it('offers a browser no function that writes either table (ADR-026)', async () => {
    const { API_FUNCTIONS } = await import('@/db/api');
    expect(Object.keys(API_FUNCTIONS).filter((n) => /forecast/.test(n))).toEqual([]);
  });

  it('refuses `api_server.finish_forecast` to a signed-in user', async () => {
    const { error } = await rpc(clientFor(ownerA, { email: `ownera@${DOMAIN}` }), 'finish_forecast', {
      p_actor: ownerA, p_org: orgA, p_input: {}, p_values: [],
    }, { server: true });
    expect(sqlstate(error)).toBe('42501');
  });
});

describe('who may see a forecast (§22)', () => {
  it('lets a client read the figures — a forecast is a figure', async () => {
    const state = await loadForecast(contextFor(clientA, 'client'));
    expect(hasForecast(state)).toBe(true);
  });

  it('lets the assigned employee read A’s forecast', async () => {
    const state = await loadForecast(contextFor(empAssigned, 'employee', orgA));
    expect(hasForecast(state)).toBe(true);
  });

  it('shows an unassigned employee nothing, though the role holds the permission', async () => {
    const state = await loadForecast(contextFor(empOther, 'employee', orgA));
    expect(hasForecast(state), 'RLS stops what the permission alone would allow').toBe(false);
  });

  it('shows the assigned employee nothing of organisation B', async () => {
    const state = await loadForecast(contextFor(empAssigned, 'employee', orgB));
    expect(hasForecast(state)).toBe(false);
  });
});
