import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withOrgScope } from '@/core/db';
/*
 * Relative imports: `motion/no-deep-module-import` (correctly) refuses
 * `@/modules/investment/services/figures`, and the suite should not need the whole barrel (render,
 * the AI writer) to test one reader.
 */
import type { InvestmentBase } from '../../src/modules/investment/domain/types';
import { loadInvestmentBase } from '../../src/modules/investment/services/figures';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * The Investment Pack's base year (ADR-171) against the database: what `loadInvestmentBase` reads —
 * Marketing's Section 03 years (ADR-170) — on the two clients it is called with:
 *
 *   - the `investment.generate` job's scoped service client (`withOrgScope`);
 *   - the Investment page's member client, under RLS, for every kind of `reports.view` holder (the
 *     owner, a client member, an assigned adviser) — and nothing for somebody who is not one.
 *
 * The organisation's year starts in OCTOBER. It holds twenty-one complete months (Oct 2024 – Jun 2026:
 * the year ended 30 September 2025 and nine months of the next) and one month in progress whose
 * figures must not be counted, so the base year is the nine months, annualised. A second
 * organisation carries enormous figures for the same months, so a read that forgot to name the
 * organisation would show at once. Fixtures are run-unique and only they are removed.
 */

const SUITE = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = 'invfig.test';
const NAME = `Invfig ${SUITE}`;

let orgId: string;
let otherOrgId: string;
let lossOrgId: string;
let ownerId: string;
let clientMemberId: string;
let adviserId: string;
let strangerId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

/** Twenty-one complete months, Oct 2024 – Jun 2026, then July 2026 in progress. */
const COMPLETE: string[] = [];
for (let i = 0; i < 21; i += 1) {
  const y = 2024 + Math.floor((9 + i) / 12);
  const m = ((9 + i) % 12) + 1;
  COMPLETE.push(`${y}-${String(m).padStart(2, '0')}`);
}
const IN_PROGRESS = '2026-07';
const inLatestYear = (ym: string) => ym >= '2025-10';

interface Snap { readonly ym: string; readonly key: string; readonly value: string }

/** One calculation run and its snapshots and pointers, as the engine writes them (as marketing-financials.test.ts). */
function writeRun(org: string, periods: ReadonlyMap<string, string>, snaps: readonly Snap[]): void {
  const first = periods.get(snaps[0]!.ym)!;
  const quality = JSON.stringify({ completeness: 1, proxy: false, warnings: [], missing: [] });
  const rows = snaps.map((s) => `('${periods.get(s.ym)}'::uuid, '${s.key}', ${s.value}::numeric)`).join(',\n');
  adminSql(`
    with run as (
      insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
      values ('${org}', 'recalc_manual', '1.0.0', '${first}', '${first}', '2026-10-01', 'succeeded') returning id
    ), v (period_id, metric_key, value) as (values ${rows}),
    snaps as (
      insert into public.metric_snapshots (organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id,
                                           dimension_key, value, unit, currency, basis, assurance_level, data_quality, components)
      select '${org}', run.id, v.period_id, v.metric_key, 'none', null, null, v.value,
             'money', 'GBP', 'bank', 'verified', '${quality}'::jsonb, '{}'::jsonb
        from run, v
      returning id, period_id, metric_key, dimension_type, dimension_id, dimension_key, calculation_run_id
    )
    insert into public.metric_current (organization_id, period_id, metric_key, dimension_type, dimension_id, dimension_key, snapshot_id, calculation_run_id)
    select '${org}', period_id, metric_key, dimension_type, dimension_id, dimension_key, id, calculation_run_id from snaps`);
}

/**
 * One month's statement. The year ended Sep 2025: revenue 10,000, net profit 1,500 a month (120,000 /
 * 18,000 for the year). The nine months since: revenue 12,000, net profit 1,800 a month — 108,000 /
 * 16,200, annualised × 12 ÷ 9 to 144,000 / 21,600, a 15.0% margin.
 */
function statement(ym: string, [rev, np]: readonly [string, string]): Snap[] {
  return [
    { ym, key: 'revenue', value: rev }, { ym, key: 'cost_of_sales', value: '0' }, { ym, key: 'operating_expenses', value: '1000' },
    { ym, key: 'net_profit', value: np }, { ym, key: 'tax_expense', value: '0' },
  ];
}

function cleanup(): void {
  adminSql(`
    select set_config('app.purge', 'on', false);
    delete from public.organizations where name like '${NAME}%';
    delete from public.organizations where name like 'Invfig %' and created_at < now() - interval '1 hour';
    delete from public.platform_users where user_id in (select id from auth.users where email like '%-${SUITE}@${EMAIL_DOMAIN}');
    delete from auth.users where email like '%-${SUITE}@${EMAIL_DOMAIN}';
    delete from public.platform_users where user_id in
      (select id from auth.users where email like '%@${EMAIL_DOMAIN}' and created_at < now() - interval '1 hour');
    delete from auth.users where email like '%@${EMAIL_DOMAIN}' and created_at < now() - interval '1 hour';`);
}

async function createOrg(owner: string, name: string): Promise<string> {
  const created = await clientFor(owner).schema('api').rpc('create_organization', { p_name: name, p_fiscal_year_start_month: 10 });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  const id = created.data as unknown as string;
  adminSql(`select app.ensure_periods('${id}', '2024-10-01', '${IN_PROGRESS}-01')`);
  adminSql(`update public.fiscal_periods set is_complete = (period_start < '${IN_PROGRESS}-01') where organization_id = '${id}'`);
  return id;
}

function periodsOf(org: string): Map<string, string> {
  return new Map([...COMPLETE, IN_PROGRESS].map((ym) => [
    ym, one(`select id from public.fiscal_periods where organization_id = '${org}' and period_start = '${ym}-01'`),
  ]));
}

beforeAll(async () => {
  cleanup();
  ownerId = createAuthUser(`owner-${SUITE}@${EMAIL_DOMAIN}`);
  clientMemberId = createAuthUser(`client-${SUITE}@${EMAIL_DOMAIN}`);
  adviserId = createAuthUser(`adviser-${SUITE}@${EMAIL_DOMAIN}`);
  strangerId = createAuthUser(`stranger-${SUITE}@${EMAIL_DOMAIN}`);

  orgId = await createOrg(ownerId, NAME);
  otherOrgId = await createOrg(ownerId, `${NAME} other`);
  lossOrgId = await createOrg(ownerId, `${NAME} loss`);

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgId}', '${clientMemberId}', 'client', 'active');
    insert into public.platform_users (user_id, platform_role, status) values ('${adviserId}', 'employee', 'active');
    insert into public.organization_assignments (organization_id, employee_user_id, status) values ('${orgId}', '${adviserId}', 'active');`);

  // July is in progress: its figures exist and must not be counted.
  writeRun(orgId, periodsOf(orgId), [
    ...COMPLETE.flatMap((ym) => statement(ym, inLatestYear(ym) ? ['12000', '1800'] : ['10000', '1500'])),
    { ym: IN_PROGRESS, key: 'revenue', value: '999999' }, { ym: IN_PROGRESS, key: 'net_profit', value: '999999' },
  ]);
  // Another organisation, the same months, figures nobody could mistake.
  writeRun(otherOrgId, periodsOf(otherOrgId), COMPLETE.flatMap((ym) => statement(ym, ['7777777', '7777777'])));
  // A loss-making organisation: a base year, but nothing to allocate by default.
  writeRun(lossOrgId, periodsOf(lossOrgId), COMPLETE.flatMap((ym) => statement(ym, ['5000', '-400'])));
});

afterAll(() => cleanup());

/** The base year the fixture produces, whoever reads it. */
const EXPECTED: Omit<InvestmentBase, 'sourceNote'> = {
  currency: 'GBP',
  yearLabel: '2026 (9 months, annualised)',
  revenue: '144000.00',
  netProfit: '21600.00',
  netMarginPct: '15.0',
  annualised: true,
};

describe('loadInvestmentBase, on the job\'s scoped service client', () => {
  it('starts from the latest year, nine months annualised, leaving out the month in progress', async () => {
    const base = await withOrgScope(orgId, (scope) => loadInvestmentBase(scope.db, orgId));
    expect(base).toMatchObject(EXPECTED);
  });

  it('writes a source note naming the months, the currency and the source', async () => {
    const base = await withOrgScope(orgId, (scope) => loadInvestmentBase(scope.db, orgId));
    expect(base!.sourceNote).toBe(
      '2026 (9 months, annualised to twelve): the nine months of figures from 1 October 2025 to 30 June 2026, with turnover '
      + 'and net profit scaled up to a full year. All figures GBP. Source: the company\'s own records in APX — the monthly '
      + 'profit and loss figures APX calculated from its bank statements, added together for each financial year. '
      + 'Net profit is after interest and any tax recorded in the accounts.',
    );
  });

  it('states a loss-making year as it is (the default surplus is then null)', async () => {
    const base = await withOrgScope(lossOrgId, (scope) => loadInvestmentBase(scope.db, lossOrgId));
    // 9 × −400 = −3,600 → −4,800 annualised; 9 × 5,000 = 45,000 → 60,000; −8.0%.
    expect(base).toMatchObject({ revenue: '60000.00', netProfit: '-4800.00', netMarginPct: '-8.0', annualised: true });
  });

  it('is null for an organisation with no figures', async () => {
    // A second owner: `create_organization` limits how many organisations one user creates at a time.
    const empty = await createOrg(createAuthUser(`empty-${SUITE}@${EMAIL_DOMAIN}`), `${NAME} empty`);
    expect(await withOrgScope(empty, (scope) => loadInvestmentBase(scope.db, empty))).toBeNull();
  });
});

describe('loadInvestmentBase, on the Investment page\'s member client (RLS)', () => {
  it('gives every reports.view holder the same base year as the job', async () => {
    const job = await withOrgScope(orgId, (scope) => loadInvestmentBase(scope.db, orgId));
    for (const userId of [ownerId, clientMemberId, adviserId]) {
      const base = await loadInvestmentBase(clientFor(userId), orgId);
      expect(base).toMatchObject(EXPECTED);
      expect(base).toEqual(job);
    }
  });

  it('gives somebody outside the organisation nothing', async () => {
    expect(await loadInvestmentBase(clientFor(strangerId), orgId)).toBeNull();
  });
});
