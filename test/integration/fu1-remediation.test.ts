import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEngineUpgrade } from '@/core/db';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolvePeriodContext, TOOLS } from '@/modules/ai';
import { loadHome, loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import { resolveDescriptor } from '@/modules/evidence';
import { choosePrecedence, computeCoverage, ENGINE_VERSION, type CoverageBatch } from '@/modules/financial-engine';
import type { AccessContext } from '@/modules/tenancy';
import { AS_OF, calculateAndAlert, headline, untilFinished, type Headline } from '../fixtures/adr120-orgs';
import { FU1_KEYS, seedFu1Orgs, type Fu1Key } from '../fixtures/fu1-orgs';
import { periodId } from '@/db/app/shared';
import { newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import {
  currentFigure, currentFigures, isComplete as periodComplete, latestVersion, ownerOf, plantStale, queuedCalculation, runsOf,
} from '../fixtures/engine-reads';
import { removeSeeded, seedBankAccount, seedCounterparty, seedDocument, seedImportRow, seedOrg } from '../fixtures/seed';
import { clientFor, createAuthUser, fs, rpc as callRpc } from './setup';

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
const start = (ym: string): string => `${ym}-01`;

const revenue = (k: Fu1Key, ym: string): Promise<Headline | undefined> => headline(o(k), start(ym), 'revenue');

/** A stated revenue figure: value and basis. */
async function expectRevenue(k: Fu1Key, ym: string, value: string, basis: string): Promise<Headline> {
  const h = await revenue(k, ym);
  expect(h, `${k} ${ym} revenue snapshot`).toBeDefined();
  expect(money(h!.value), `${k} ${ym} revenue`).toBe(value);
  expect(h!.basis, `${k} ${ym} basis`).toBe(basis);
  return h!;
}

/** No source covers the month: NULL, basis none, one honest reason — never 0.00 (§2.3). */
async function expectNoRevenue(k: Fu1Key, ym: string): Promise<void> {
  const h = await revenue(k, ym);
  expect(h, `${k} ${ym} revenue snapshot`).toBeDefined();
  expect(h!.value, `${k} ${ym} revenue must be NULL, not a manufactured zero`).toBeNull();
  expect(h!.basis, `${k} ${ym} basis`).toBe('none');
  expect(h!.missing, `${k} ${ym} missing`).toContain('no_source_covers_period');
  expect(h!.warnings, `${k} ${ym} warnings`).not.toContain('open_items_only');
}

const snapshotField = async (k: Fu1Key, ym: string, key: string, _column: 'assurance_level'): Promise<string> =>
  (await currentFigure(o(k), start(ym), key))?.assurance ?? '';
const isComplete = (k: Fu1Key, ym: string): Promise<string> => periodComplete(o(k), start(ym));
/** Every per-customer revenue row of a month ('NULL' for a row without a value). */
const customerRevenue = async (k: Fu1Key, ym: string): Promise<string[]> =>
  (await currentFigures(o(k), { start: start(ym), keys: ['customer_revenue'], dimension: 'any' })).map((f) => f.value ?? 'NULL');

const owners = new Map<string, string>();
const owner = (id: string): string => owners.get(id)!;
const ctxFor = (id: string, userId = owner(id)): AccessContext => ({
  userId, orgId: id, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(userId), requestId: TAG, now: () => new Date(`${AS_OF}T00:00:00Z`),
  organizationStatus: 'active',
});
const descriptorOf = async (k: Fu1Key, ym: string, key: string): Promise<unknown> =>
  ((await currentFigure(o(k), start(ym), key))!.evidenceQuery as { descriptor: unknown }).descriptor;

beforeAll(async () => {
  org = await seedFu1Orgs(TAG, KEYS);
  for (const k of KEYS) owners.set(o(k), await ownerOf(o(k)));
  for (const k of KEYS) await calculateAndAlert(o(k));
}, 3_600_000);

afterAll(async () => {
  if (!org) return;
  await removeSeeded(Object.values(org), `@${TAG}.`);
}, 600_000);

describe('a full sales list states the months it spans — including a genuine zero', () => {
  it('COVERED: June 1,000 · July 2,000 · August 1,500, on the invoice basis', async () => {
    await expectRevenue('COVERED', '2026-06', '1000.00', 'invoices');
    const jul = await expectRevenue('COVERED', '2026-07', '2000.00', 'invoices');
    expect(jul.missing).toEqual([]);
    expect(jul.warnings).not.toContain('open_items_only');
    expect(await snapshotField('COVERED', '2026-07', 'revenue', 'assurance_level')).toBe('calculated');
    await expectRevenue('COVERED', '2026-08', '1500.00', 'invoices');
    expect(await isComplete('COVERED', '2026-07')).toBe('true');
  });

  it('COVERED: September (current, which the list does not reach) and October are unknown — not 0.00', async () => {
    // 3.0.0 stated 0.00 with `open_items_only` for every month from September 2026 to August 2027.
    await expectNoRevenue('COVERED', '2026-09');
    await expectNoRevenue('COVERED', '2026-10');
    expect(await isComplete('COVERED', '2026-09')).toBe('false');
  });

  it('ZERO: a July the list spans with no sale in it is a STATED 0.00, complete, with nothing missing (R3)', async () => {
    const jul = await expectRevenue('ZERO', '2026-07', '0.00', 'invoices');
    expect(jul.missing).toEqual([]);
    expect(jul.warnings).not.toContain('open_items_only');
    expect(await isComplete('ZERO', '2026-07')).toBe('true');
    await expectRevenue('ZERO', '2026-06', '1000.00', 'invoices');
    await expectRevenue('ZERO', '2026-08', '1500.00', 'invoices');
  });
});

describe('a month no full sales list spans states no revenue (R1, R2)', () => {
  it('NOTCOVER: a June list says nothing about July or August', async () => {
    await expectRevenue('NOTCOVER', '2026-06', '1000.00', 'invoices');
    await expectNoRevenue('NOTCOVER', '2026-07');
    await expectNoRevenue('NOTCOVER', '2026-08');
    expect(await isComplete('NOTCOVER', '2026-07')).toBe('false');
  });

  it('LATERONLY: an August list says nothing about June or July', async () => {
    await expectNoRevenue('LATERONLY', '2026-06');
    await expectNoRevenue('LATERONLY', '2026-07');
    await expectRevenue('LATERONLY', '2026-08', '1500.00', 'invoices');
  });

  it('EARLIERONLY: a list committed BEFORE July does not cover July or August (the negative gap)', async () => {
    // Committed on 5 June, declared to 30 June: it saw 1–5 June only, so even June is not stated from
    // it — a list knows nothing after the day it was committed (review blocker; ADR-125).
    await expectNoRevenue('EARLIERONLY', '2026-06');
    await expectNoRevenue('EARLIERONLY', '2026-07');
    await expectNoRevenue('EARLIERONLY', '2026-08');
  });

  it('DURING: a list declared to 3 August states June and July, and not August — neither 300 nor 0.00', async () => {
    await expectRevenue('DURING', '2026-06', '1000.00', 'invoices');
    await expectRevenue('DURING', '2026-07', '2000.00', 'invoices');
    await expectNoRevenue('DURING', '2026-08');
  });

  it('GAPS: lists for June and August leave July unknown', async () => {
    await expectRevenue('GAPS', '2026-06', '1000.00', 'invoices');
    await expectNoRevenue('GAPS', '2026-07');
    await expectRevenue('GAPS', '2026-08', '1500.00', 'invoices');
  });

  it('HISTORYFIRST: a GL to March and a list from June leave April and May unknown', async () => {
    for (const ym of ['2026-01', '2026-02', '2026-03']) (await expectRevenue('HISTORYFIRST', ym, '1000.00', 'ledger'));
    await expectNoRevenue('HISTORYFIRST', '2026-04');
    await expectNoRevenue('HISTORYFIRST', '2026-05');
    await expectRevenue('HISTORYFIRST', '2026-06', '1000.00', 'invoices');
    await expectRevenue('HISTORYFIRST', '2026-07', '2000.00', 'invoices');
    await expectRevenue('HISTORYFIRST', '2026-08', '1500.00', 'invoices');
  });

  it('PURCHONLY: a purchase-only full list states no revenue — while its payables are unchanged (R4)', async () => {
    for (const ym of ['2026-06', '2026-07', '2026-08']) (await expectNoRevenue('PURCHONLY', ym));
    expect(money((await headline(o('PURCHONLY'), start('2026-08'), 'payables'))?.value)).toBe('600.00');
  });

  it('OPENITEMS: an aged-debtors list never defines revenue (ADR-047.10) — while its receivables are unchanged (R4)', async () => {
    await expectNoRevenue('OPENITEMS', '2026-06');
    await expectNoRevenue('OPENITEMS', '2026-07');
    expect(money((await headline(o('OPENITEMS'), start('2026-07'), 'receivables'))?.value)).toBe('2000.00');
  });

  it('EMPTY: an organisation with nothing states no revenue anywhere — never 0', async () => {
    for (const ym of ['2026-06', '2026-07', '2026-08', '2026-09']) {
      expect((await revenue('EMPTY', ym))?.value ?? null, `EMPTY ${ym}`).toBeNull();
    }
    const stated = (await currentFigures(o('EMPTY'), { keys: ['revenue', 'customer_revenue'], dimension: 'any' })).filter((f) => f.value !== null);
    expect(stated).toHaveLength(0);
  });
});

describe('precedence and fallthrough are unchanged (R2)', () => {
  it('PRECEDENCE: where a GL and a list both cover a month, the ledger answers; where only the list does, the list', async () => {
    await expectRevenue('PRECEDENCE', '2026-05', '800.00', 'invoices');
    await expectRevenue('PRECEDENCE', '2026-06', '5000.00', 'ledger');
    await expectRevenue('PRECEDENCE', '2026-07', '6000.00', 'ledger');
    await expectRevenue('PRECEDENCE', '2026-08', '7000.00', 'ledger');
  });

  it('BANKINV: August, which the list does not span, falls to the bank as a cash proxy — not an invoice 0.00', async () => {
    await expectRevenue('BANKINV', '2026-06', '1000.00', 'invoices');
    await expectRevenue('BANKINV', '2026-07', '2000.00', 'invoices');
    const aug = await expectRevenue('BANKINV', '2026-08', '3000.00', 'bank');
    expect(aug.warnings).toContain('cash_basis_proxy');
    expect(aug.warnings).not.toContain('open_items_only');
    expect(await snapshotField('BANKINV', '2026-08', 'revenue', 'assurance_level')).toBe('estimated');
  });
});

describe('the current month: a list reaching into it states revenue TO DATE (CURRENT)', () => {
  it('September is 700.00 to date, flagged partial_month, and the month is not complete; August is whole', async () => {
    const aug = await expectRevenue('CURRENT', '2026-08', '1500.00', 'invoices');
    expect(aug.warnings).not.toContain('partial_month');
    const sep = await expectRevenue('CURRENT', '2026-09', '700.00', 'invoices');
    expect(sep.warnings).toContain('partial_month');
    expect(sep.warnings).not.toContain('open_items_only');
    expect(await isComplete('CURRENT', '2026-09')).toBe('false');
    await expectNoRevenue('CURRENT', '2026-10');
  });

  it('the invoices source covers September for 10 of its 30 days, read from the committed batch itself', async () => {
    // The source's completeness is a coverage fact; it is checked here on the batch the queue-level
    // run read, because the P&L snapshot's own completeness is the uncategorised share (§3.1, §5).
    const b = (await orgCollection(fs(), o('CURRENT'), 'import_batches').where('target_table', '==', 'invoices').get()).docs[0]!.data();
    const row = {
      id: String(b.id), periodStart: String(b.period_start), periodEnd: String(b.period_end), committedAt: String(b.committed_at),
      invoiceListKind: b.invoice_list_kind as CoverageBatch['invoiceListKind'], importType: b.import_type as string | null,
    };
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
  it('July: Σ customer revenue = revenue 4,000, and the top customer holds 75%', async () => {
    await expectRevenue('CUSTOMER', '2026-07', '4000.00', 'invoices');
    const rows = (await customerRevenue('CUSTOMER', '2026-07')).filter((v) => v !== 'NULL');
    expect(rows.map(money)).toEqual(expect.arrayContaining(['3000.00', '1000.00']));
    const total = rows.reduce((acc, v) => acc.plus(v), new Decimal(0));
    expect(total.toFixed(2)).toBe('4000.00');
    const top1 = (await headline(o('CUSTOMER'), start('2026-07'), 'customer_concentration_top1'))?.value ?? null;
    expect(top1 === null ? null : new Decimal(top1).toFixed(6)).toBe('0.750000');
  });

  it('August, which no list covers: no customer revenue is stated, and the top customer share is NULL — not 100% of 0', async () => {
    await expectNoRevenue('CUSTOMER', '2026-08');
    expect((await customerRevenue('CUSTOMER', '2026-08')).filter((v) => v !== 'NULL')).toEqual([]);
    expect((await headline(o('CUSTOMER'), start('2026-08'), 'customer_concentration_top1'))?.value ?? null).toBeNull();
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
      const rows = (await currentFigures(o(k), { keys: ['revenue', 'customer_revenue'], dimension: 'any' }))
        .filter((f) => f.value !== null && f.evidenceQuery?.kind === 'leaf');
      for (const row of rows) {
        const selection = await resolveDescriptor(ctxFor(o(k)), (row.evidenceQuery as { descriptor: unknown }).descriptor);
        expect(money(selection.total), `${k} ${row.periodStart} ${row.metricKey}`).toBe(money(row.value));
        checked += 1;
      }
    }
    // At least the revenue months stated above (about forty), plus the attributed customer rows.
    expect(checked).toBeGreaterThan(30);
  }, 600_000);

  it('another organisation\'s owner resolves nothing from COVERED\'s July revenue', async () => {
    const mine = owner(o('COVERED'));
    const intruder = KEYS.map((k) => owner(o(k))).find((u) => u !== mine)!;
    const descriptor = await descriptorOf('COVERED', '2026-07', 'revenue');
    expect(money((await resolveDescriptor(ctxFor(o('COVERED')), descriptor)).total)).toBe('2000.00');
    const selection = await resolveDescriptor({ ...ctxFor(o('COVERED')), userId: intruder, db: clientFor(intruder) }, descriptor);
    expect(selection.count).toBe(0);
  });
});

describe('engine version and the stale-figure sweep', () => {
  it('every organisation\'s runs ran on the current engine', async () => {
    for (const k of KEYS) expect(await latestVersion(o(k)), k).toBe(ENGINE_VERSION);
    let stale = 0;
    for (const k of KEYS) stale += (await runsOf(o(k), 'succeeded')).filter((r) => r.engine_version !== ENGINE_VERSION).length;
    expect(stale).toBe(0);
  });

  it('STALE: a July 0.00 an older engine wrote is shown as updating, queued by the sweep, and recomputed to NULL', async () => {
    // FU-1 changes existing values, so FINANCIAL_ENGINE.md §6 requires a MAJOR bump past 3.0.0 — the
    // bump is what makes the sweep re-queue every organisation. Pinned here, not only in the golden
    // file, which re-records itself.
    expect(Number(ENGINE_VERSION.split('.')[0])).toBeGreaterThanOrEqual(4);
    const id = o('STALE');
    await expectNoRevenue('STALE', '2026-07');
    // Fixture only: the state a 3.0.0 run left (July 0.00), not an app write.
    await plantStale(id, { oldVersion: '3.0.0', start: '2026-07-01', key: 'revenue', value: '0.000000' });
    // What 3.0.0 also left: July complete on that manufactured revenue, and a Health score shown for it
    // (FU-14 — the upgrade must withdraw it; its history row stays).
    const july = periodId(id, '2026-07-01');
    const oldRun = String((await runsOf(id, 'succeeded'))[0]!.id);
    const planted = newId();
    const now = nowIso();
    await orgRow(fs(), id, 'health_scores', planted).set({
      id: planted, organization_id: id, calculation_run_id: oldRun, period_id: july, score: 55, dimensions_used: 3,
      dimensions_total: 6, breakdown: [], config_version: 'health.config.v1', created_at: now,
    });
    await orgRow(fs(), id, 'fiscal_periods', july).update({ is_complete: true, updated_at: now });
    await orgRow(fs(), id, 'health_current', july).set({
      organization_id: id, period_id: july, health_score_id: planted, calculation_run_id: oldRun,
      previous_health_score_id: null, updated_at: now,
    });
    expect(money((await revenue('STALE', '2026-07'))?.value)).toBe('0.00');
    const home = await loadHome(clientFor(owner(id)), id, 'x');
    expect('view' in home && home.view.recalculating).toBe(true);

    expect(await enqueueEngineUpgrade(ENGINE_VERSION)).toBeGreaterThanOrEqual(1);
    const job = await queuedCalculation(id);
    expect(job).not.toBe('');
    expect(await untilFinished(job)).toBe('succeeded');
    expect(await latestVersion(id)).toBe(ENGINE_VERSION);
    await expectNoRevenue('STALE', '2026-07');
    await expectRevenue('STALE', '2026-06', '1000.00', 'invoices');
    // FU-14: July is no longer complete, its Health score is no longer shown, and the history keeps it.
    expect(await periodComplete(id, '2026-07-01')).toBe('false');
    expect((await orgRow(fs(), id, 'health_current', july).get()).exists).toBe(false);
    expect((await orgRow(fs(), id, 'health_scores', planted).get()).exists).toBe(true);
    const after = await loadHome(clientFor(owner(id)), id, 'x');
    expect('view' in after && after.view.recalculating).toBe(false);
  }, 900_000);
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

  const rpc = (fn: string, args: Record<string, unknown>) => callRpc(clientFor(realOwner), fn, args);

  /** An invoice batch awaiting review, with valid mapped rows — the state the review screen commits from. */
  async function awaitingInvoiceBatch(ym: string, total: string, confirmations: readonly string[]): Promise<string> {
    docs += 1;
    const doc = await seedDocument(realOrg, `fu13-${docs}.csv`, 'invoice');
    const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
    const batch = newId();
    const now = nowIso();
    await orgRow(fs(), realOrg, 'import_batches', batch).set({
      id: batch, organization_id: realOrg, source_document_id: doc, import_type: 'sales_invoices', target_table: 'invoices',
      bank_account_id: null, mapping_id: null, mapping_snapshot: null, status: 'awaiting_review', row_counts: {},
      period_start: `${ym}-01`, period_end: `${ym}-${last}`, statement_opening_balance: null, statement_closing_balance: null,
      balance_sign: 'natural', fiscal_year_start_month_at_commit: null, invoice_list_kind: null, balance_basis: null,
      extraction_method: 'csv', pages_extracted: null, pages_failed: null, created_by: realOwner, reviewed_by: null,
      committed_at: null, rolled_back_at: null, rolled_back_reason: null, replaced_batch_id: null, error_summary: null,
      calculation_job_id: null, calculation_run_id: null, created_at: now, updated_at: now, batch_issues: [],
      confirmations: {}, required_confirmations: [...confirmations], page_confirmations: {}, review_token: newId(),
      extraction_stats: {},
    });
    const row = await seedImportRow(realOrg, batch);
    await orgRow(fs(), realOrg, 'import_rows', row).update({
      row_number: 1, source_ref: 'csv:row:1', raw_data: { source: 'line' }, status: 'valid',
      mapped_data: { invoice_type: 'sales', counterparty_id: customer, invoice_number: `R-${ym}`, issue_date: `${ym}-05`, due_date: `${ym}-20`, subtotal: total, tax_amount: '0', total_amount: total },
      dedupe_hash: Buffer.from(`${RTAG}row${ym}`).toString('hex'), reviewer_decision: 'none',
    });
    return batch;
  }

  beforeAll(async () => {
    realOwner = await createAuthUser(`real@${RTAG}.fu13.itest`);
    realOrg = (await seedOrg({ name: `FU13 ${RTAG}`, ownerId: realOwner })).orgId;
    customer = await seedCounterparty(realOrg, { name: 'Real Customer', kind: 'customer' });
  }, 120_000);

  afterAll(async () => {
    await removeSeeded([realOrg], `@${RTAG}.fu13.itest`);
  }, 600_000);

  it('a list the reviewer did not flag commits as FULL and states May\'s revenue', async () => {
    const batch = await awaitingInvoiceBatch('2026-05', '4200.00', []);
    const committed = await rpc('commit_import_batch', { p_batch: batch });
    expect(committed.error).toBeNull();
    expect((await orgRow(fs(), realOrg, 'import_batches', batch).get()).get('invoice_list_kind')).toBe('full');

    await calculateAndAlert(realOrg);
    const may = (await headline(realOrg, '2026-05-01', 'revenue'))!;
    expect([money(may.value), may.basis]).toEqual(['4200.00', 'invoices']);
  }, 900_000);

  it('a list confirmed as open items (IMP-INV-012) commits as OPEN ITEMS and states no revenue', async () => {
    const batch = await awaitingInvoiceBatch('2026-06', '900.00', ['IMP-INV-012']);
    // The review page confirms with {answer: 'yes'} — it never sends a list kind.
    expect((await rpc('record_batch_confirmation', { p_batch: batch, p_code: 'IMP-INV-012', p_value: { answer: 'yes' } })).error).toBeNull();
    expect((await rpc('commit_import_batch', { p_batch: batch })).error).toBeNull();
    expect((await orgRow(fs(), realOrg, 'import_batches', batch).get()).get('invoice_list_kind')).toBe('open_items');

    await calculateAndAlert(realOrg);
    const june = (await headline(realOrg, '2026-06-01', 'revenue'))!;
    expect(june.value).toBeNull();
    expect(june.missing).toContain('no_source_covers_period');
  }, 900_000);
});

/*
 * FU-14 — a month that stops being complete stops showing a Health score (ADR-030.4). Before, the
 * pointer an earlier run left in `health_current` survived: a score built on figures the engine no
 * longer states stayed on Home and in the history. Last in the file: it changes PRECEDENCE's data.
 */
describe('FU-14 · a month that is no longer complete shows no Health score', () => {
  const healthShown = async (id: string, ym: string): Promise<number> =>
    ((await orgRow(fs(), id, 'health_current', periodId(id, start(ym))).get()).exists ? 1 : 0);
  const healthRows = async (id: string, ym: string): Promise<number> =>
    (await orgCollection(fs(), id, 'health_scores').where('period_id', '==', periodId(id, start(ym))).get()).size;

  it('withdraws the pointer when the month turns incomplete, and keeps the score\'s history', async () => {
    const id = o('PRECEDENCE');
    expect(await isComplete('PRECEDENCE', '2026-07')).toBe('true');
    expect(await healthShown(id, '2026-07')).toBe(1);
    const history = await healthRows(id, '2026-07');

    // An active cash account about which nothing is stated: bank coverage can no longer be full, so
    // the month is not complete (§2.2, ADR-124 D-2).
    await seedBankAccount(id, { name: 'Unstated', accountType: 'current' });
    await calculateAndAlert(id);

    expect(await isComplete('PRECEDENCE', '2026-07')).toBe('false');
    expect(await healthShown(id, '2026-07')).toBe(0);
    expect(await healthRows(id, '2026-07')).toBe(history);
  }, 900_000);
});
