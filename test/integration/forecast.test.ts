import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { generateForecast, hasForecast, loadForecast } from '@/modules/forecast';
import { getBundle } from '@/modules/evidence';
import { runTool, snapshotAccess, resolvePeriodContext, type PeriodRow } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, sqlstate } from './setup';

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
const DOMAIN = `${RUN}.forecast.itest`;

let ownerA: string; let clientA: string; let ownerB: string;
let empAssigned: string; let empOther: string; let superAdmin: string;
let orgA: string; let orgB: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

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

/** Six complete months of a steady business, written the way the engine writes them. */
function seedHistory(org: string, monthly: Readonly<Record<string, string>>, months = 6): void {
  const runId = one(`
    insert into public.calculation_runs
           (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
    select '${org}', 'recalc_manual', '1.0.0', p.id, p.id, '2026-08-31', 'succeeded'
      from public.fiscal_periods p
     where p.organization_id = '${org}' and p.period_start = '2026-08-01'
    returning id`);

  for (let i = 0; i < months; i += 1) {
    const month = 8 - i;
    const start = `2026-${String(month).padStart(2, '0')}-01`;
    const periodId = one(`
      select id from public.fiscal_periods
       where organization_id = '${org}' and period_start = '${start}'`);
    adminSql(`update public.fiscal_periods set is_complete = true where id = '${periodId}'`);

    for (const [metricKey, value] of Object.entries(monthly)) {
      const snapshotId = one(`
        insert into public.metric_snapshots
               (organization_id, calculation_run_id, period_id, metric_key, dimension_type,
                value, unit, currency, basis, assurance_level, data_quality)
        values ('${org}', '${runId}', '${periodId}', '${metricKey}', 'none',
                ${value}, 'money', 'GBP', 'ledger', 'verified', '{"completeness": 1, "proxy": false, "warnings": [], "missing": []}'::jsonb)
        returning id`);
      adminSql(`
        insert into public.metric_current
               (organization_id, period_id, metric_key, dimension_type, snapshot_id, calculation_run_id)
        values ('${org}', '${periodId}', '${metricKey}', 'none', '${snapshotId}', '${runId}')`);
    }
  }
}

const STEADY = {
  revenue: '10000', cost_of_sales: '4000', operating_expenses: '3000',
  cash_inflows: '9000', cash_outflows: '7000',
  receivables: '5000', payables: '2000', closing_cash: '20000',
};

beforeAll(async () => {
  ownerA = createAuthUser(`ownerA@${DOMAIN}`);
  clientA = createAuthUser(`clientA@${DOMAIN}`);
  ownerB = createAuthUser(`ownerB@${DOMAIN}`);
  empAssigned = createAuthUser(`emp1@${DOMAIN}`);
  empOther = createAuthUser(`emp2@${DOMAIN}`);
  superAdmin = createAuthUser(`sa@${DOMAIN}`);

  const a = await clientFor(ownerA).schema('api').rpc('create_organization', { p_name: `ITest Fc A ${RUN}` });
  if (a.error) throw new Error(`fixture org A failed: ${a.error.message}`);
  orgA = a.data as unknown as string;
  const b = await clientFor(ownerB).schema('api').rpc('create_organization', { p_name: `ITest Fc B ${RUN}` });
  if (b.error) throw new Error(`fixture org B failed: ${b.error.message}`);
  orgB = b.data as unknown as string;

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgA}', '${clientA}', 'client', 'active');
    insert into public.platform_users (user_id, platform_role, status)
    values ('${empAssigned}', 'employee', 'active'), ('${empOther}', 'employee', 'active'),
           ('${superAdmin}', 'super_admin', 'active');
    insert into public.organization_assignments
           (organization_id, employee_user_id, status, starts_at, ends_at, assigned_by)
    values ('${orgA}', '${empAssigned}', 'active', now() - interval '1 day',
            now() + interval '30 days', '${superAdmin}');`);

  seedHistory(orgA, STEADY);
  seedHistory(orgB, { ...STEADY, revenue: '99999' });
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Fc%${RUN}';
    delete from public.platform_users where user_id in
      (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';`);
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
    expect(one(`
      select count(*) from public.forecast_values
       where organization_id = '${orgA}' and assurance_level <> 'estimated'`)).toBe('0');
    // A count, compared as the string the driver returns: a non-zero count is not '0'.
    expect(one(`
      select count(*) from public.forecast_values where organization_id = '${orgA}'`))
      .not.toBe('0');
  });

  it('refuses to store a forecast that claims to be anything but estimated', () => {
    const runId = one(`select id from public.forecast_runs where organization_id = '${orgA}' limit 1`);
    const periodId = one(`
      select period_id from public.forecast_values where forecast_run_id = '${runId}' limit 1`);
    expect(() => adminSql(`
      insert into public.forecast_values
             (organization_id, forecast_run_id, period_id, metric_key, value, assurance_level, derivation)
      values ('${orgA}', '${runId}', '${periodId}', 'revenue', 1, 'verified', 'baseline')`))
      .toThrow(/forecast_values_estimated|violates check/);
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
      expect(one(`
        select count(*) from public.fiscal_periods
         where organization_id = '${orgA}' and id = '${period.periodId}'
           and period_start > '2026-08-01'`), period.periodLabel).toBe('1');
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
    expect(one(`
      select distinct assurance_level::text from public.forecast_values
       where organization_id = '${orgA}'`), 'the forecast is not').toBe('estimated');
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
    const periods = adminSql(`
      select id || '|' || label || '|' || period_start || '|' || is_complete
        from public.fiscal_periods where organization_id = '${ctx.orgId}' order by period_start`)
      .split('\n').filter(Boolean).map((line) => {
        const [id, label, periodStart, complete] = line.trim().split('|') as [string, string, string, string];
        return { id, label, periodStart, isComplete: complete === 'true' || complete === 't', hasData: true };
      }) as PeriodRow[];
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
    expect(revenue.forecast.value).toBe(
      one(`select value::text from public.forecast_values fv
             join public.forecast_runs fr on fr.id = fv.forecast_run_id
            where fv.organization_id = '${orgA}' and fv.metric_key = 'revenue'
              and fv.period_id = '${
                one(`select id from public.fiscal_periods where organization_id = '${orgA}' and period_start = '2026-09-01'`)
              }'
            order by fr.generated_at desc limit 1`).replace(/0+$/, '').replace(/\.$/, '.00'));
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
    const asB = clientFor(ownerB, { email: `ownerB@${DOMAIN}` });
    const { data: runs } = await asB.from('forecast_runs').select('id').eq('organization_id', orgA);
    expect(runs ?? []).toHaveLength(0);
    const { data: values } = await asB.from('forecast_values').select('id').eq('organization_id', orgA);
    expect(values ?? []).toHaveLength(0);
  });

  it('refuses a browser any write to either table (ADR-026)', async () => {
    const asOwner = clientFor(ownerA, { email: `ownerA@${DOMAIN}` });
    for (const table of ['forecast_runs', 'forecast_values']) {
      const { error } = await asOwner.from(table).insert({ organization_id: orgA });
      expect(sqlstate(error), table).toBe('42501');
    }
  });

  it('refuses `api_server.finish_forecast` to a signed-in user', async () => {
    const { error } = await clientFor(ownerA, { email: `ownerA@${DOMAIN}` })
      .schema('api_server').rpc('finish_forecast', {
        p_actor: ownerA, p_org: orgA, p_input: {}, p_values: [],
      });
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
