
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withOrgScope } from '@/core/db';
/*
 * Relative imports: `motion/no-deep-module-import` (correctly) refuses
 * `@/modules/investment/services/figures`, and the suite should not need the whole barrel (render,
 * the AI writer) to test one reader.
 */
import type { InvestmentBase } from '../../src/modules/investment/domain/types';
import { loadInvestmentBase } from '../../src/modules/investment/services/figures';
import { clientFor, createAuthUser, deleteOrg, fs } from './setup';
import { assignEmployee, createOrgFixture, addMember, deletePlatformUser } from './r-fixtures';
import { ensureMonths, setComplete, writeRun, writeSnapshot } from './r-metrics';
import { auth } from '@/db/firestore';

/**
 * The Investment Pack's base year (ADR-171) against the database: what `loadInvestmentBase` reads —
 * Marketing's Section 03 years (ADR-170) — on the two handles it is called with:
 *
 *   - the `investment.generate` job's scoped service handle (`withOrgScope`);
 *   - the Investment page's member handle, through the read policies (`src/db/rls.ts`), for every
 *     kind of `reports.view` holder (the owner, a client member, an assigned adviser) — and nothing
 *     for somebody who is not one.
 *
 * The organisation's year starts in OCTOBER. It holds twenty-one complete months (Oct 2024 – Jun 2026:
 * the year ended 30 September 2025 and nine months of the next) and one month in progress whose
 * figures must not be counted, so the base year is the nine months, annualised. A second
 * organisation carries enormous figures for the same months, so a read that forgot to name the
 * organisation would show at once. Fixtures are run-unique and only they are removed.
 */

const RUN = `if${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.invfig.itest.motion`;
const NAME = `ITest Invfig ${RUN}`;

let orgId: string;
let otherOrgId: string;
let lossOrgId: string;
let ownerId: string;
let clientMemberId: string;
let adviserId: string;
let strangerId: string;
const orgs: string[] = [];
const users: string[] = [];

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

/** One calculation run and its snapshots and pointers, as the engine writes them. */
async function writeRunOf(org: string, periods: ReadonlyMap<string, string>, snaps: readonly Snap[]): Promise<void> {
  const first = periods.get(snaps[0]!.ym)!;
  const runId = await writeRun(org, { periodFrom: first, asOf: '2026-10-01' });
  for (const s of snaps) {
    await writeSnapshot(org, {
      runId, periodId: periods.get(s.ym)!, key: s.key, value: s.value, basis: 'bank', currency: 'GBP',
    });
  }
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

async function user(label: string): Promise<string> {
  const id = await createAuthUser(`${label}@${DOMAIN}`);
  users.push(id);
  return id;
}

async function createOrg(owner: string, name: string): Promise<string> {
  const org = await createOrgFixture({ name, ownerId: owner, fiscalYearStartMonth: 10 });
  orgs.push(org.id);
  const months = await ensureMonths(org.id, '2024-10-01', `${IN_PROGRESS}-01`);
  for (const [ym, id] of months) await setComplete(org.id, id, ym < IN_PROGRESS);
  return org.id;
}

async function periodsOf(org: string): Promise<Map<string, string>> {
  return ensureMonths(org, '2024-10-01', `${IN_PROGRESS}-01`);
}

beforeAll(async () => {
  ownerId = await user('owner');
  clientMemberId = await user('client');
  adviserId = await user('adviser');
  strangerId = await user('stranger');

  orgId = await createOrg(ownerId, NAME);
  otherOrgId = await createOrg(ownerId, `${NAME} other`);
  lossOrgId = await createOrg(ownerId, `${NAME} loss`);

  await addMember(orgId, clientMemberId, 'client');
  await assignEmployee(orgId, adviserId);

  // July is in progress: its figures exist and must not be counted.
  await writeRunOf(orgId, await periodsOf(orgId), [
    ...COMPLETE.flatMap((ym) => statement(ym, inLatestYear(ym) ? ['12000', '1800'] : ['10000', '1500'])),
    { ym: IN_PROGRESS, key: 'revenue', value: '999999' }, { ym: IN_PROGRESS, key: 'net_profit', value: '999999' },
  ]);
  // Another organisation, the same months, figures nobody could mistake.
  await writeRunOf(otherOrgId, await periodsOf(otherOrgId), COMPLETE.flatMap((ym) => statement(ym, ['7777777', '7777777'])));
  // A loss-making organisation: a base year, but nothing to allocate by default.
  await writeRunOf(lossOrgId, await periodsOf(lossOrgId), COMPLETE.flatMap((ym) => statement(ym, ['5000', '-400'])));
}, 120_000);

afterAll(async () => {
  for (const id of orgs) await deleteOrg(id);
  await deletePlatformUser(adviserId);
  for (const id of users) {
    await fs().collection('profiles').doc(id).delete();
    await auth().deleteUser(id).catch(() => undefined);
  }
});

/** The base year the fixture produces, whoever reads it. */
const EXPECTED: Omit<InvestmentBase, 'sourceNote'> = {
  currency: 'GBP',
  yearLabel: '2026 (9 months, annualised)',
  revenue: '144000.00',
  netProfit: '21600.00',
  netMarginPct: '15.0',
  annualised: true,
};

describe('loadInvestmentBase, on the job\'s scoped service handle', () => {
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
    const empty = await createOrg(await user('empty'), `${NAME} empty`);
    expect(await withOrgScope(empty, (scope) => loadInvestmentBase(scope.db, empty))).toBeNull();
  });
});

describe('loadInvestmentBase, on the Investment page\'s member handle (read policies)', () => {
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
