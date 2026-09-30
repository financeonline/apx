import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEngineUpgrade } from '@/core/db';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolvePeriodContext, TOOLS } from '@/modules/ai';
import { loadHome, loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import { resolveDescriptor } from '@/modules/evidence';
import { choosePrecedence, computeCoverage, ENGINE_VERSION, type CoverageBatch } from '@/modules/financial-engine';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { AS_OF, calculateAndAlert, headline, type Headline } from '../fixtures/adr120-orgs';
import { FU1_KEYS, seedFu1Orgs, type Fu1Key } from '../fixtures/fu1-orgs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * ADR-122 FU-1 — an invoice list must never state revenue 0.00 for a month it does not cover.
 *
 * Sixteen organisations (test/fixtures/fu1-orgs.ts, seeded from nothing) computed through the real
 * queue at as-of 2026-09-15. The invoices source covers a month's P&L and customer figures only when
 * a FULL SALES list establishes it: its declared range spans the month, or — in the current month —
 * reaches into it from the 1st (revenue to date, `partial_month`). Anything else falls through §2.3
 * unchanged: to the bank as a cash proxy, else NULL with `no_source_covers_period`. A full list that
 * spans a month with no sale in it still states a genuine 0.00. Then the stale-engine sweep: figures
 * a 3.0.0 engine wrote (July 0.00) are found, flagged and recomputed to NULL.
 */

const TAG = `f${Date.now().toString(36)}`;
const KEYS: readonly Fu1Key[] = FU1_KEYS;
let org: Partial<Record<Fu1Key, string>>;
const o = (k: Fu1Key): string => org[k]!;

const money = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Decimal(value).toFixed(2);
const one = (sql: string): string => adminSql(sql).split('\n')[0]!.trim();
const start = (ym: string): string => `${ym}-01`;

const revenue = (k: Fu1Key, ym: string): Headline | undefined => headline(o(k), start(ym), 'revenue');

/** A stated revenue figure: value and basis. */
function expectRevenue(k: Fu1Key, ym: string, value: string, basis: string): Headline {
  const h = revenue(k, ym);
  expect(h, `${k} ${ym} revenue snapshot`).toBeDefined();
  expect(money(h!.value), `${k} ${ym} revenue`).toBe(value);
  expect(h!.basis, `${k} ${ym} basis`).toBe(basis);
  return h!;
}

/** No source covers the month: NULL, basis none, one honest reason — never 0.00 (§2.3). */
function expectNoRevenue(k: Fu1Key, ym: string): void {
  const h = revenue(k, ym);
  expect(h, `${k} ${ym} revenue snapshot`).toBeDefined();
  expect(h!.value, `${k} ${ym} revenue must be NULL, not a manufactured zero`).toBeNull();
  expect(h!.basis, `${k} ${ym} basis`).toBe('none');
  expect(h!.missing, `${k} ${ym} missing`).toContain('no_source_covers_period');
  expect(h!.warnings, `${k} ${ym} warnings`).not.toContain('open_items_only');
}

const snapshotField = (k: Fu1Key, ym: string, key: string, column: 'assurance_level' | 'data_quality'): string =>
  one(`select s.${column}::text
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o(k)}' and p.period_start = '${start(ym)}' and c.metric_key = '${key}' and c.dimension_type = 'none'`);
const isComplete = (k: Fu1Key, ym: string): string =>
  one(`select is_complete::text from public.fiscal_periods where organization_id = '${o(k)}' and period_start = '${start(ym)}'`);
/** Every per-customer revenue row of a month ('NULL' for a row without a value). */
const customerRevenue = (k: Fu1Key, ym: string): string[] => adminSql(`select coalesce(s.value::text, 'NULL')
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o(k)}' and p.period_start = '${start(ym)}' and c.metric_key = 'customer_revenue'`)
  .split('\n').map((l) => l.trim()).filter(Boolean);

const owner = (id: string): string =>
  one(`select user_id from public.organization_memberships where organization_id = '${id}' and role = 'owner' limit 1`);
const ctxFor = (id: string, userId = owner(id)): AccessContext => ({
  userId, orgId: id, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(userId), requestId: TAG, now: () => new Date(`${AS_OF}T00:00:00Z`),
  organizationStatus: 'active',
});
const descriptorOf = (k: Fu1Key, ym: string, key: string): unknown => {
  const snapshot = headline(o(k), start(ym), key)!;
  return (JSON.parse(one(`select evidence_query::text from public.metric_snapshots where id = '${snapshot.snapshotId}'`)) as { descriptor: unknown }).descriptor;
};
const latestVersion = (id: string): string => one(`select engine_version from public.calculation_runs
  where organization_id = '${id}' and status = 'succeeded' order by finished_at desc nulls last limit 1`);

beforeAll(async () => {
  org = await seedFu1Orgs(TAG, KEYS);
  for (const k of KEYS) await calculateAndAlert(o(k));
}, 1_500_000);

afterAll(() => {
  if (!org) return;
  adminSql(`delete from public.organizations where id in (${Object.values(org).map((id) => `'${id}'`).join(',')});
            delete from auth.users where email like '%@${TAG}.%';`);
});

describe('a full sales list states the months it spans — including a genuine zero', () => {
  it('COVERED: June 1,000 · July 2,000 · August 1,500, on the invoice basis', () => {
    expectRevenue('COVERED', '2026-06', '1000.00', 'invoices');
    const jul = expectRevenue('COVERED', '2026-07', '2000.00', 'invoices');
    expect(jul.missing).toEqual([]);
    expect(jul.warnings).not.toContain('open_items_only');
    expect(snapshotField('COVERED', '2026-07', 'revenue', 'assurance_level')).toBe('calculated');
    expectRevenue('COVERED', '2026-08', '1500.00', 'invoices');
    expect(isComplete('COVERED', '2026-07')).toBe('true');
  });

  it('COVERED: September (current, which the list does not reach) and October are unknown — not 0.00', () => {
    // 3.0.0 stated 0.00 with `open_items_only` for every month from September 2026 to August 2027.
    expectNoRevenue('COVERED', '2026-09');
    expectNoRevenue('COVERED', '2026-10');
    expect(isComplete('COVERED', '2026-09')).toBe('false');
  });

  it('ZERO: a July the list spans with no sale in it is a STATED 0.00, complete, with nothing missing (R3)', () => {
    const jul = expectRevenue('ZERO', '2026-07', '0.00', 'invoices');
    expect(jul.missing).toEqual([]);
    expect(jul.warnings).not.toContain('open_items_only');
    expect(isComplete('ZERO', '2026-07')).toBe('true');
    expectRevenue('ZERO', '2026-06', '1000.00', 'invoices');
    expectRevenue('ZERO', '2026-08', '1500.00', 'invoices');
  });
});

describe('a month no full sales list spans states no revenue (R1, R2)', () => {
  it('NOTCOVER: a June list says nothing about July or August', () => {
    expectRevenue('NOTCOVER', '2026-06', '1000.00', 'invoices');
    expectNoRevenue('NOTCOVER', '2026-07');
    expectNoRevenue('NOTCOVER', '2026-08');
    expect(isComplete('NOTCOVER', '2026-07')).toBe('false');
  });

  it('LATERONLY: an August list says nothing about June or July', () => {
    expectNoRevenue('LATERONLY', '2026-06');
    expectNoRevenue('LATERONLY', '2026-07');
    expectRevenue('LATERONLY', '2026-08', '1500.00', 'invoices');
  });

  it('EARLIERONLY: a list committed BEFORE July does not cover July or August (the negative gap)', () => {
    // Committed on 5 June, declared to 30 June: it saw 1–5 June only, so even June is not stated from
    // it — a list knows nothing after the day it was committed (review blocker; ADR-125).
    expectNoRevenue('EARLIERONLY', '2026-06');
    expectNoRevenue('EARLIERONLY', '2026-07');
    expectNoRevenue('EARLIERONLY', '2026-08');
  });

  it('DURING: a list declared to 3 August states June and July, and not August — neither 300 nor 0.00', () => {
    expectRevenue('DURING', '2026-06', '1000.00', 'invoices');
    expectRevenue('DURING', '2026-07', '2000.00', 'invoices');
    expectNoRevenue('DURING', '2026-08');
  });

  it('GAPS: lists for June and August leave July unknown', () => {
    expectRevenue('GAPS', '2026-06', '1000.00', 'invoices');
    expectNoRevenue('GAPS', '2026-07');
    expectRevenue('GAPS', '2026-08', '1500.00', 'invoices');
  });

  it('HISTORYFIRST: a GL to March and a list from June leave April and May unknown', () => {
    for (const ym of ['2026-01', '2026-02', '2026-03']) expectRevenue('HISTORYFIRST', ym, '1000.00', 'ledger');
    expectNoRevenue('HISTORYFIRST', '2026-04');
    expectNoRevenue('HISTORYFIRST', '2026-05');
    expectRevenue('HISTORYFIRST', '2026-06', '1000.00', 'invoices');
    expectRevenue('HISTORYFIRST', '2026-07', '2000.00', 'invoices');
    expectRevenue('HISTORYFIRST', '2026-08', '1500.00', 'invoices');
  });

  it('PURCHONLY: a purchase-only full list states no revenue — while its payables are unchanged (R4)', () => {
    for (const ym of ['2026-06', '2026-07', '2026-08']) expectNoRevenue('PURCHONLY', ym);
    expect(money(headline(o('PURCHONLY'), start('2026-08'), 'payables')?.value)).toBe('600.00');
  });

  it('OPENITEMS: an aged-debtors list never defines revenue (ADR-047.10) — while its receivables are unchanged (R4)', () => {
    expectNoRevenue('OPENITEMS', '2026-06');
    expectNoRevenue('OPENITEMS', '2026-07');
    expect(money(headline(o('OPENITEMS'), start('2026-07'), 'receivables')?.value)).toBe('2000.00');
  });

  it('EMPTY: an organisation with nothing states no revenue anywhere — never 0', () => {
    for (const ym of ['2026-06', '2026-07', '2026-08', '2026-09']) {
      expect(revenue('EMPTY', ym)?.value ?? null, `EMPTY ${ym}`).toBeNull();
    }
    expect(one(`select count(*) from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
      where c.organization_id = '${o('EMPTY')}' and c.metric_key in ('revenue', 'customer_revenue') and s.value is not null`)).toBe('0');
  });
});

describe('precedence and fallthrough are unchanged (R2)', () => {
  it('PRECEDENCE: where a GL and a list both cover a month, the ledger answers; where only the list does, the list', () => {
    expectRevenue('PRECEDENCE', '2026-05', '800.00', 'invoices');
    expectRevenue('PRECEDENCE', '2026-06', '5000.00', 'ledger');
    expectRevenue('PRECEDENCE', '2026-07', '6000.00', 'ledger');
    expectRevenue('PRECEDENCE', '2026-08', '7000.00', 'ledger');
  });

  it('BANKINV: August, which the list does not span, falls to the bank as a cash proxy — not an invoice 0.00', () => {
    expectRevenue('BANKINV', '2026-06', '1000.00', 'invoices');
    expectRevenue('BANKINV', '2026-07', '2000.00', 'invoices');
    const aug = expectRevenue('BANKINV', '2026-08', '3000.00', 'bank');
    expect(aug.warnings).toContain('cash_basis_proxy');
    expect(aug.warnings).not.toContain('open_items_only');
    expect(snapshotField('BANKINV', '2026-08', 'revenue', 'assurance_level')).toBe('estimated');
  });
});

describe('the current month: a list reaching into it states revenue TO DATE (CURRENT)', () => {
  it('September is 700.00 to date, flagged partial_month, and the month is not complete; August is whole', () => {
    const aug = expectRevenue('CURRENT', '2026-08', '1500.00', 'invoices');
    expect(aug.warnings).not.toContain('partial_month');
    const sep = expectRevenue('CURRENT', '2026-09', '700.00', 'invoices');
    expect(sep.warnings).toContain('partial_month');
    expect(sep.warnings).not.toContain('open_items_only');
    expect(isComplete('CURRENT', '2026-09')).toBe('false');
    expectNoRevenue('CURRENT', '2026-10');
  });

  it('the invoices source covers September for 10 of its 30 days, read from the committed batch itself', () => {
    // The source's completeness is a coverage fact; it is checked here on the batch the queue-level
    // run read, because the P&L snapshot's own completeness is the uncategorised share (§3.1, §5).
    const row = JSON.parse(one(`select json_build_object('id', id, 'periodStart', period_start, 'periodEnd', period_end,
        'committedAt', committed_at, 'invoiceListKind', invoice_list_kind, 'importType', import_type)::text
      from public.import_batches where organization_id = '${o('CURRENT')}' and target_table = 'invoices'`)) as
      Pick<CoverageBatch, 'id' | 'periodStart' | 'periodEnd' | 'committedAt' | 'invoiceListKind' | 'importType'>;
    const batch: CoverageBatch = { ...row, targetTable: 'invoices', balanceKind: null, balanceBasis: null, bankAccountId: null };
    const coverage = computeCoverage({
      period: { id: 'sep', periodStart: '2026-09-01', periodEnd: '2026-09-30', fiscalYear: 2026, fiscalQuarter: 3, label: 'Sep 2026', isComplete: false },
      batches: [batch], bankAccounts: [], rowCounts: {}, asOf: AS_OF,
    });
    expect(coverage.bySource.invoices.covers).toBe(true);
    expect(coverage.bySource.invoices.warnings).toEqual(['partial_month']);
    expect(coverage.bySource.invoices.completeness).toBeCloseTo(10 / 30, 6);
    expect(choosePrecedence(coverage, 'pnl').basis).toBe('invoices');
  });
});

describe('the customer family follows the same coverage (CUSTOMER)', () => {
  it('July: Σ customer revenue = revenue 4,000, and the top customer holds 75%', () => {
    expectRevenue('CUSTOMER', '2026-07', '4000.00', 'invoices');
    const rows = customerRevenue('CUSTOMER', '2026-07').filter((v) => v !== 'NULL');
    expect(rows.map(money)).toEqual(expect.arrayContaining(['3000.00', '1000.00']));
    const total = rows.reduce((acc, v) => acc.plus(v), new Decimal(0));
    expect(total.toFixed(2)).toBe('4000.00');
    const top1 = headline(o('CUSTOMER'), start('2026-07'), 'customer_concentration_top1')?.value ?? null;
    expect(top1 === null ? null : new Decimal(top1).toFixed(6)).toBe('0.750000');
  });

  it('August, which no list covers: no customer revenue is stated, and the top customer share is NULL — not 100% of 0', () => {
    expectNoRevenue('CUSTOMER', '2026-08');
    expect(customerRevenue('CUSTOMER', '2026-08').filter((v) => v !== 'NULL')).toEqual([]);
    expect(headline(o('CUSTOMER'), start('2026-08'), 'customer_concentration_top1')?.value ?? null).toBeNull();
  });
});

describe('the analyst is handed no number for an uncovered month (AI tool layer)', () => {
  interface ToolMetric {
    readonly metric_key: string;
    readonly value: { readonly display: string } | null;
    readonly availability: { readonly state: string; readonly reason?: string };
    readonly data_quality: { readonly missing: readonly string[]; readonly warnings: readonly string[] };
  }

  async function callContext(id: string, question: string) {
    const db = clientFor(owner(id));
    const rows = await loadPeriods(db, id, TAG);
    const withData = await loadPeriodsWithData(db, id, TAG);
    const periodContext = resolvePeriodContext({
      question,
      fiscalYearStartMonth: 1,
      periods: rows.map((p) => ({ id: p.id, label: p.label, periodStart: p.periodStart, isComplete: p.isComplete, hasData: withData.has(p.id) })),
    });
    return { ctx: ctxFor(id), periodContext, knownPeriods: [], now: new Date(`${AS_OF}T00:00:00Z`) };
  }

  const getMetric = async (id: string, period: string) => TOOLS.find((t) => t.name === 'get_metric')!.run(
    { metric_key: 'revenue', period }, await callContext(id, 'what was revenue in june 2026, july 2026 and august 2026?'),
  );

  it('NOTCOVER: July and August revenue come back as no value, with the reason — never 0 or "£0"', async () => {
    for (const period of ['Jul 2026', 'Aug 2026']) {
      const outcome = await getMetric(o('NOTCOVER'), period) as { ok: boolean; data?: ToolMetric; error?: { code: string } };
      const text = JSON.stringify(outcome);
      // "£0" never starts a real non-zero amount ("£1,000", "£10"), so any occurrence is a stated zero.
      expect(text, period).not.toContain('£0');
      if (!outcome.ok) {
        // No snapshot at all is also an honest answer: the tool says there is no figure.
        expect(outcome.error?.code, period).toBe('NO_DATA');
        continue;
      }
      expect(outcome.data!.value, period).toBeNull();
      expect(outcome.data!.data_quality.missing, period).toContain('no_source_covers_period');
    }
  });

  it('NOTCOVER: June, which the list spans, is still the list\'s 1,000', async () => {
    const outcome = await getMetric(o('NOTCOVER'), 'Jun 2026') as { ok: boolean; data: ToolMetric };
    expect(outcome.ok).toBe(true);
    expect(outcome.data.value?.display).toBe('£1,000');
  });
});

describe('evidence and tenancy', () => {
  it('every leaf descriptor of revenue and customer revenue in these organisations totals to its figure', async () => {
    let checked = 0;
    for (const k of KEYS) {
      const rows = adminSql(`select p.period_start || '|' || c.metric_key || '|' || s.value::text || '|' || s.evidence_query::text
        from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
        join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
       where c.organization_id = '${o(k)}' and s.value is not null and s.evidence_query->>'kind' = 'leaf'
         and c.metric_key in ('revenue', 'customer_revenue')`)
        .split('\n').map((l) => l.trim()).filter(Boolean);
      for (const row of rows) {
        const [period, metric, value, ...rest] = row.split('|');
        const selection = await resolveDescriptor(ctxFor(o(k)), (JSON.parse(rest.join('|')) as { descriptor: unknown }).descriptor);
        expect(money(selection.total), `${k} ${period} ${metric}`).toBe(money(value));
        checked += 1;
      }
    }
    // At least the revenue months stated above (about forty), plus the attributed customer rows.
    expect(checked).toBeGreaterThan(30);
  });

  it('another organisation\'s owner resolves nothing from COVERED\'s July revenue', async () => {
    const mine = owner(o('COVERED'));
    const intruder = KEYS.map((k) => owner(o(k))).find((u) => u !== mine)!;
    const descriptor = descriptorOf('COVERED', '2026-07', 'revenue');
    expect(money((await resolveDescriptor(ctxFor(o('COVERED')), descriptor)).total)).toBe('2000.00');
    const selection = await resolveDescriptor({ ...ctxFor(o('COVERED')), userId: intruder, db: clientFor(intruder) }, descriptor);
    expect(selection.count).toBe(0);
  });
});

describe('engine version and the stale-figure sweep', () => {
  it('every organisation\'s runs ran on the current engine', () => {
    for (const k of KEYS) expect(latestVersion(o(k)), k).toBe(ENGINE_VERSION);
    expect(one(`select count(*) from public.calculation_runs where organization_id in (${KEYS.map((k) => `'${o(k)}'`).join(',')})
      and status = 'succeeded' and engine_version <> '${ENGINE_VERSION}'`)).toBe('0');
  });

  it('STALE: a July 0.00 an older engine wrote is shown as updating, queued by the sweep, and recomputed to NULL', async () => {
    // FU-1 changes existing values, so FINANCIAL_ENGINE.md §6 requires a MAJOR bump past 3.0.0 — the
    // bump is what makes the sweep re-queue every organisation. Pinned here, not only in the golden
    // file, which re-records itself.
    expect(Number(ENGINE_VERSION.split('.')[0])).toBeGreaterThanOrEqual(4);
    const id = o('STALE');
    expectNoRevenue('STALE', '2026-07');
    adminSql(`update public.calculation_runs set engine_version = '3.0.0' where organization_id = '${id}';
      -- Fixture only: snapshots are append-only (a trigger), so the stale figure is planted with the
      -- triggers off for this one session — the state a 3.0.0 run left (July 0.00), not an app write.
      set session_replication_role = replica;
      update public.metric_snapshots s set value = 0 from public.metric_current c join public.fiscal_periods p on p.id = c.period_id
       where c.organization_id = '${id}' and c.metric_key = 'revenue' and c.dimension_type = 'none'
         and p.period_start = '2026-07-01' and s.id = c.snapshot_id;
      set session_replication_role = origin;
      delete from public.jobs where organization_id = '${id}' and status = 'queued';`);
    // What 3.0.0 also left: July complete on that manufactured revenue, and a Health score shown for it
    // (FU-14 — the upgrade must withdraw it; its history row stays).
    const july = one(`select id from public.fiscal_periods where organization_id = '${id}' and period_start = '2026-07-01'`);
    const oldRun = one(`select id from public.calculation_runs where organization_id = '${id}' and status = 'succeeded' order by finished_at desc limit 1`);
    const planted = one(`insert into public.health_scores (organization_id, calculation_run_id, period_id, score, dimensions_used, dimensions_total, config_version)
      values ('${id}', '${oldRun}', '${july}', 55, 3, 6, 'health.config.v1') returning id`);
    adminSql(`update public.fiscal_periods set is_complete = true where id = '${july}';
      insert into public.health_current (organization_id, period_id, health_score_id, calculation_run_id)
      values ('${id}', '${july}', '${planted}', '${oldRun}')
      on conflict (organization_id, period_id) do update set health_score_id = excluded.health_score_id, calculation_run_id = excluded.calculation_run_id;`);
    expect(money(revenue('STALE', '2026-07')?.value)).toBe('0.00');
    const home = await loadHome(clientFor(owner(id)), id, 'x');
    expect('view' in home && home.view.recalculating).toBe(true);

    expect(await enqueueEngineUpgrade(ENGINE_VERSION)).toBeGreaterThanOrEqual(1);
    const job = one(`select id from public.jobs where organization_id = '${id}' and job_type = 'calculation.run' and status = 'queued'`);
    expect(job).not.toBe('');
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    expect(latestVersion(id)).toBe(ENGINE_VERSION);
    expectNoRevenue('STALE', '2026-07');
    expectRevenue('STALE', '2026-06', '1000.00', 'invoices');
    // FU-14: July is no longer complete, its Health score is no longer shown, and the history keeps it.
    expect(one(`select is_complete::text from public.fiscal_periods where id = '${july}'`)).toBe('false');
    expect(one(`select count(*) from public.health_current where organization_id = '${id}' and period_id = '${july}'`)).toBe('0');
    expect(one(`select count(*) from public.health_scores where id = '${planted}'`)).toBe('1');
    const after = await loadHome(clientFor(owner(id)), id, 'x');
    expect('view' in after && after.view.recalculating).toBe(false);
  });
});

/*
 * FU-13 — through the REAL import path, not a hand-seeded batch. The review found that nothing in the
 * pipeline ever wrote `invoice_list_kind = 'full'`: every fixture above sets it, and every list
 * imported through the app arrived with NULL, which under FU-1 would state no revenue at all. The
 * migration `20260930000004` writes the kind when an invoice batch commits: open items if the
 * reviewer confirmed IMP-INV-012, full otherwise.
 */
describe('FU-13 · a sales list committed through the app states its month\'s revenue', () => {
  const RTAG = `${TAG}r`;
  let realOrg = '';
  let realOwner = '';
  let customer = '';
  let docs = 0;

  const rpc = (fn: string, args: Record<string, unknown>) => clientFor(realOwner).schema('api').rpc(fn, args);

  /** An invoice batch awaiting review, with valid mapped rows — the state the review screen commits from. */
  function awaitingInvoiceBatch(ym: string, total: string, confirmations: readonly string[]): string {
    docs += 1;
    const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${realOrg}', '${realOrg}/fu13/${docs}.csv', 'sales.csv', 'text/csv', 10, digest('${RTAG}${docs}', 'sha256'), 'ready', 'invoice') returning id`);
    const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
    const batch = one(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status,
        extraction_method, required_confirmations, period_start, period_end, batch_issues)
      values ('${realOrg}', '${doc}', 'sales_invoices', 'invoices', 'awaiting_review', 'csv',
        array[${confirmations.map((c) => `'${c}'`).join(',')}]::text[], '${ym}-01', '${ym}-${last}', '[]'::jsonb) returning id`);
    adminSql(`insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status, dedupe_hash, reviewer_decision)
      values ('${realOrg}', '${batch}', 1, 'csv:row:1', '{"source":"line"}'::jsonb,
        '${JSON.stringify({ invoice_type: 'sales', counterparty_id: customer, invoice_number: `R-${ym}`, issue_date: `${ym}-05`, due_date: `${ym}-20`, subtotal: total, tax_amount: '0', total_amount: total })}'::jsonb,
        'valid', digest('${RTAG}row${ym}', 'sha256'), 'none')`);
    return batch;
  }

  beforeAll(async () => {
    realOwner = createAuthUser(`real@${RTAG}.fu13.itest`);
    const r = await clientFor(realOwner).schema('api').rpc('create_organization', { p_name: `FU13 ${RTAG}` });
    if (r.error) throw new Error(r.error.message);
    realOrg = r.data as unknown as string;
    customer = one(`insert into public.counterparties (organization_id, name, kind) values ('${realOrg}', 'Real Customer', 'customer') returning id`);
  }, 120_000);

  afterAll(() => {
    adminSql(`delete from public.organizations where id = '${realOrg}'; delete from auth.users where email like '%@${RTAG}.fu13.itest';`);
  });

  it('a list the reviewer did not flag commits as FULL and states May\'s revenue', async () => {
    const batch = awaitingInvoiceBatch('2026-05', '4200.00', []);
    const committed = await rpc('commit_import_batch', { p_batch: batch });
    expect(committed.error).toBeNull();
    expect(one(`select invoice_list_kind::text from public.import_batches where id = '${batch}'`)).toBe('full');

    await calculateAndAlert(realOrg);
    const may = headline(realOrg, '2026-05-01', 'revenue')!;
    expect([money(may.value), may.basis]).toEqual(['4200.00', 'invoices']);
  });

  it('a list confirmed as open items (IMP-INV-012) commits as OPEN ITEMS and states no revenue', async () => {
    const batch = awaitingInvoiceBatch('2026-06', '900.00', ['IMP-INV-012']);
    // The review page confirms with {answer: 'yes'} — it never sends a list kind.
    expect((await rpc('record_batch_confirmation', { p_batch: batch, p_code: 'IMP-INV-012', p_value: { answer: 'yes' } })).error).toBeNull();
    expect((await rpc('commit_import_batch', { p_batch: batch })).error).toBeNull();
    expect(one(`select invoice_list_kind::text from public.import_batches where id = '${batch}'`)).toBe('open_items');

    await calculateAndAlert(realOrg);
    const june = headline(realOrg, '2026-06-01', 'revenue')!;
    expect(june.value).toBeNull();
    expect(june.missing).toContain('no_source_covers_period');
  });
});

/*
 * FU-14 — a month that stops being complete stops showing a Health score (ADR-030.4). Before, the
 * pointer an earlier run left in `health_current` survived: a score built on figures the engine no
 * longer states stayed on Home and in the history. Last in the file: it changes PRECEDENCE's data.
 */
describe('FU-14 · a month that is no longer complete shows no Health score', () => {
  const healthShown = (id: string, ym: string): number => Number(one(`select count(*) from public.health_current c
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${id}' and p.period_start = '${start(ym)}'`));
  const healthRows = (id: string, ym: string): number => Number(one(`select count(*) from public.health_scores h
    join public.fiscal_periods p on p.id = h.period_id and p.organization_id = h.organization_id
   where h.organization_id = '${id}' and p.period_start = '${start(ym)}'`));

  it('withdraws the pointer when the month turns incomplete, and keeps the score\'s history', async () => {
    const id = o('PRECEDENCE');
    expect(isComplete('PRECEDENCE', '2026-07')).toBe('true');
    expect(healthShown(id, '2026-07')).toBe(1);
    const history = healthRows(id, '2026-07');

    // An active cash account about which nothing is stated: bank coverage can no longer be full, so
    // the month is not complete (§2.2, ADR-124 D-2).
    adminSql(`insert into public.bank_accounts (organization_id, name, bank_name, account_type, is_active)
      values ('${id}', 'Unstated', 'Test Bank', 'current', true)`);
    await calculateAndAlert(id);

    expect(isComplete('PRECEDENCE', '2026-07')).toBe('false');
    expect(healthShown(id, '2026-07')).toBe(0);
    expect(healthRows(id, '2026-07')).toBe(history);
  });
});
