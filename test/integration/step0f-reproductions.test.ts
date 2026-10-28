import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { buildBundleForMetric, loadEvidenceDrawer } from '@/modules/evidence';
import { startImport } from '@/modules/imports';
import type { AccessContext } from '@/modules/tenancy';
import { orgRow } from '@/db/schema';
import { calculateAndAlert, currentSnapshots } from '../fixtures/adr120-orgs';
import { clientFor, createAuthUser, deleteOrg, fs, rpc as call } from './setup';
import { addMember, makeOrg } from './f-fixtures';
import { where } from './i-fixtures';

/**
 * Step 0F reproductions of the re-review's N-3, N-5 and N-6, through the real upload path
 * (`startImport` → confirmations → `commit_import_batch` → the queue), on the Firestore port.
 *
 * EVERY case seeds its own organisation inside its own test: nothing is shared in a `beforeAll`, so
 * each case fails on its own and an early failure cannot hide a later one. Expected figures are
 * worked from the files by hand. Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.step0f.itest.motion`;
let owner: string;
const ownerDb = () => clientFor(owner, { email: `owner@${DOMAIN}` });
let n = 0;
const made: string[] = [];

/** A new organisation; returns it and its creator (sole owner). The test's reviewer joins as admin. */
async function org(label: string): Promise<{ id: string; creator: string }> {
  const creator = await createAuthUser(`${label.toLowerCase()}-${n++}-creator@${DOMAIN}`);
  const id = await makeOrg(creator, `ITest Step0F ${label} ${RUN}`);
  made.push(id);
  await addMember(id, owner, 'admin');
  return { id, creator };
}

const END: Record<string, string> = { '2026-06': '2026-06-30', '2026-07': '2026-07-31', '2026-08': '2026-08-31' };

async function upload(o: string, importType: 'trial_balance' | 'pnl_report', ym: string, csv: string): Promise<string> {
  const res = await startImport({
    organizationId: o, userId: owner, requestId: `itest-${RUN}`, db: ownerDb(),
    file: new File([csv], `${importType}-${ym}-${n++}.csv`, { type: 'text/csv' }),
    importType, periodStart: `${ym}-01`, periodEnd: END[ym]!, bankAccountId: null,
  });
  return res.batchId;
}

const rpc = (fn: string, args: Record<string, unknown>) => call(ownerDb(), fn, args);

async function batchDoc(id: string): Promise<Record<string, unknown>> {
  // The batch's organisation is not known here; every org of this file is searched.
  for (const o of made) {
    const snap = await orgRow(fs(), o, 'import_batches', id).get();
    if (snap.exists) return snap.data()!;
  }
  throw new Error(`no batch ${id}`);
}

/** Answers every outstanding confirmation as a reviewer would. */
async function confirm(batchId: string, basis: 'movement' | 'cumulative', sign: 'natural' | 'reporting' = 'natural') {
  const b = await batchDoc(batchId);
  const answered = (b.confirmations as Record<string, unknown>) ?? {};
  const required = ((b.required_confirmations as string[]) ?? []).filter((c) => !(c in answered));
  for (const code of required) {
    const value = code === 'IMP-RANGE-015' ? { period_start: b.period_start, period_end: b.period_end }
      : code === 'IMP-TB-012' ? { balance_basis: basis }
      : code === 'IMP-TB-013' ? { balance_sign: sign }
      : code === 'IMP-TB-016' ? { report_complete: 'complete' }
      : { answer: 'yes' };
    const { error } = await rpc('record_batch_confirmation', { p_batch: batchId, p_code: code, p_value: value });
    expect(error, `${code}: ${error?.message}`).toBeNull();
  }
}

/** Commits; a replacement is confirmed (IMP-COV-013) when the commit asks, then committed. */
async function commit(batchId: string, basis: 'movement' | 'cumulative', sign: 'natural' | 'reporting' = 'natural') {
  await confirm(batchId, basis, sign);
  const first = await rpc('commit_import_batch', { p_batch: batchId });
  expect(first.error, first.error?.message).toBeNull();
  if ((first.data as { status?: string }).status !== 'needs_confirmation') return first.data as Record<string, unknown>;
  await confirm(batchId, basis, sign);
  const second = await rpc('commit_import_batch', { p_batch: batchId });
  expect(second.error, second.error?.message).toBeNull();
  return second.data as Record<string, unknown>;
}

async function value(o: string, ym: string, key: string): Promise<string> {
  const [s] = await currentSnapshots(o, `${ym}-01`, key);
  return s?.value === null || s?.value === undefined ? 'NULL' : new Decimal(String(s.value)).toFixed(2);
}
const snapshotOf = async (o: string, ym: string, key: string) => String((await currentSnapshots(o, `${ym}-01`, key))[0]?.id ?? '');
const ctxFor = (o: string): AccessContext => ({
  userId: owner, orgId: o, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'), actorType: 'user',
  db: clientFor(owner), requestId: RUN, now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});
async function accountNames(o: string): Promise<Map<string, string>> {
  return new Map((await where(o, 'accounts', {})).map((a) => [String(a.id), String(a.name)]));
}
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** `name=closing` of the CURRENT lines of a month, by account name. */
async function current(o: string, ym: string): Promise<string[]> {
  const names = await accountNames(o);
  return (await where(o, 'period_balances', { period_start: `${ym}-01`, record_status: 'accepted', superseded_by: null }))
    .map((b) => `${names.get(String(b.account_id))}=${b.closing_balance}`).sort(byName);
}
const balancesOf = (o: string, batch: string) => where(o, 'period_balances', { import_batch_id: batch });

const TB = (revenue: string, opex: string, cash: string) => `Account,Balance\nRevenue,${revenue}\nOperating Expenses,${opex}\nCash,${cash}\n`;

// A reviewer per test: every import answers several confirmations, and one shared reviewer would
// reach the 120-calls-a-minute throttle across the file (QUOTA), failing a test for its neighbours.
beforeEach(async () => { owner = await createAuthUser(`owner-${n++}@${DOMAIN}`); });
afterAll(async () => {
  for (const id of made) {
    const jobs = await fs().collection('jobs').where('organization_id', '==', id).get();
    await Promise.all(jobs.docs.map((d) => d.ref.delete()));
    await deleteOrg(id);
  }
});

describe('N-3 · a corrected report replaces the previous one', () => {
  it('REUPLOAD: a corrected July trial balance replaces the first through the upload path; July 1,100, August 1,210', async () => {
    const { id: o } = await org('REUPLOAD');
    await commit(await upload(o, 'trial_balance', '2026-06', TB('-6000.00', '1800.00', '4200.00')), 'cumulative');
    const wrong = await upload(o, 'trial_balance', '2026-07', TB('-9999.00', '2100.00', '7899.00'));
    await commit(wrong, 'cumulative');
    await calculateAndAlert(o);
    expect(await value(o, '2026-07', 'revenue')).toBe('3999.00'); // 9,999 − 6,000: the wrong July
    // An evidence bundle opened on the WRONG figure, before the correction.
    const oldSnapshot = await snapshotOf(o, '2026-07', 'revenue');
    const oldBundle = await buildBundleForMetric(ctxFor(o), oldSnapshot);

    const corrected = await upload(o, 'trial_balance', '2026-07', TB('-7100.00', '2100.00', '5000.00'));
    // ADR-139 C4: the replacement is asked while the file is reviewed (IMP-COV-013), before Import.
    const asked = await batchDoc(corrected);
    expect(`${(asked.required_confirmations as string[]).includes('IMP-COV-013')}|${asked.status}`).toBe('true|awaiting_review');
    // Unanswered, commit is refused (by the first missing confirmation) and writes nothing.
    const early = await rpc('commit_import_batch', { p_batch: corrected });
    expect(early.error?.code).toBe('VALIDATION');
    expect(early.error?.message ?? '').toContain('confirmation');
    expect(await balancesOf(o, corrected)).toHaveLength(0);

    const done = await commit(corrected, 'cumulative');
    expect(done).toMatchObject({ status: 'committed', committed: 3, superseded: 3 });
    await commit(await upload(o, 'trial_balance', '2026-08', TB('-8310.00', '2400.00', '5910.00')), 'cumulative');
    await calculateAndAlert(o);

    expect(await current(o, '2026-07')).toEqual(['Cash=5000.00', 'Operating Expenses=2100.00', 'Revenue=-7100.00']);
    expect([await value(o, '2026-07', 'revenue'), await value(o, '2026-08', 'revenue')]).toEqual(['1100.00', '1210.00']);

    // History: the first July report is kept, each line superseded by the same account's new line.
    const names = await accountNames(o);
    const olds = await balancesOf(o, wrong);
    const chain = await Promise.all(olds.map(async (old) => {
      const nw = (await orgRow(fs(), o, 'period_balances', String(old.superseded_by)).get()).data()!;
      return `${names.get(String(old.account_id))}=${old.closing_balance}>${nw.closing_balance}`;
    }));
    expect(chain.sort(byName)).toEqual(['Cash=7899.00>5000.00', 'Operating Expenses=2100.00>2100.00', 'Revenue=-9999.00>-7100.00']);
    const oldIds = new Set(olds.map((b) => String(b.id)));
    expect((await where(o, 'record_status_events', { event: 'superseded', import_batch_id: corrected }))
      .filter((e) => oldIds.has(String(e.record_id)))).toHaveLength(3);
    const actions = (await fs().collection('audit_events').where('organization_id', '==', o).where('target_id', '==', corrected).get())
      .docs.map((d) => String(d.get('action')));
    expect(actions).toEqual(expect.arrayContaining(['import.confirmed', 'import.committed']));

    // Evidence: the bundle opened on the wrong figure still shows what was shown THEN — 9,999 − 6,000.
    const view = await loadEvidenceDrawer(ctxFor(o), oldBundle);
    expect(view.metric!.isCurrent).toBe(false);
    expect(new Decimal(view.metric!.value!).toFixed(2)).toBe('3999.00');
    expect(view.metric!.difference!.terms.map((t) => new Decimal(t.total!).toFixed(2))).toEqual(['9999.00', '6000.00']);
    expect(view.metric!.difference!.reconciles).toBe(true);
  }, 300_000);

  it('rollback: a replacement that fails mid-commit leaves the previous report current and writes nothing', async () => {
    const { id: o } = await org('ROLLBACK');
    const first = await upload(o, 'trial_balance', '2026-07', TB('-1100.00', '300.00', '800.00'));
    await commit(first, 'movement');
    const corrected = await upload(o, 'trial_balance', '2026-07', TB('-1200.00', '300.00', '900.00'));
    // Every question answered (IMP-COV-013 is asked at validation, C4), so the commit gets as far as writing.
    await confirm(corrected, 'movement');
    // Sabotage the LAST row so the failure comes after earlier rows were written in the transaction.
    const live = (await where(o, 'import_rows', { batch_id: corrected })).filter((r) => r.status === 'valid' || r.status === 'warning')
      .sort((x, y) => Number(y.row_number) - Number(x.row_number))[0]!;
    await orgRow(fs(), o, 'import_rows', String(live.id)).update({ mapped_data: { ...live.mapped_data, closing_balance: 'not a number' } });
    const failed = await rpc('commit_import_batch', { p_batch: corrected });
    expect(failed.error).not.toBeNull();

    expect(await current(o, '2026-07')).toEqual(['Cash=800.00', 'Operating Expenses=300.00', 'Revenue=-1100.00']);
    expect(await balancesOf(o, corrected)).toHaveLength(0);
    const firstIds = new Set((await balancesOf(o, first)).map((b) => String(b.id)));
    expect((await where(o, 'record_status_events', { event: 'superseded' })).filter((e) => firstIds.has(String(e.record_id)))).toHaveLength(0);
    expect((await batchDoc(corrected)).status).toBe('awaiting_review');
    await calculateAndAlert(o);
    expect(await value(o, '2026-07', 'revenue')).toBe('1100.00');
  }, 300_000);

  it('concurrent: two corrections committed at once are applied one after the other; one report is current', async () => {
    const { id: o } = await org('CONCURRENT');
    await commit(await upload(o, 'trial_balance', '2026-07', TB('-1100.00', '300.00', '800.00')), 'movement');
    const a = await upload(o, 'trial_balance', '2026-07', TB('-1200.00', '300.00', '900.00'));
    const b = await upload(o, 'trial_balance', '2026-07', TB('-1300.00', '300.00', '1000.00'));
    for (const batch of [a, b]) {
      // Both are checked against July's report while it is current: both are asked IMP-COV-013.
      expect(((await batchDoc(batch)).required_confirmations as string[]).includes('IMP-COV-013')).toBe(true);
      await confirm(batch, 'movement');
    }
    const results = await Promise.all([a, b].map((batch) => rpc('commit_import_batch', { p_batch: batch })));
    for (const r of results) {
      expect(r.error, r.error?.message).toBeNull();
      expect(r.data).toMatchObject({ status: 'committed', committed: 3, superseded: 3 });
    }
    // Exactly one current line per account, all from ONE of the two corrections (the one that took the
    // lock second). Not judged by `committed_at`: that is the transaction's start, and the commit that
    // waited for the lock can start first.
    const julyCurrent = await where(o, 'period_balances', { period_start: '2026-07-01', record_status: 'accepted', superseded_by: null });
    const perAccount = new Map<string, number>();
    for (const l of julyCurrent) perAccount.set(String(l.account_id), (perAccount.get(String(l.account_id)) ?? 0) + 1);
    expect([...perAccount.values()].filter((c) => c > 1)).toHaveLength(0);
    const winners = [...new Set(julyCurrent.map((l) => String(l.import_batch_id)))];
    expect(winners).toHaveLength(1);
    const last = winners[0]!;
    expect([a, b]).toContain(last);
    const other = last === a ? b : a;
    // …and every line of the other correction was superseded by a line of that one.
    const otherLines = await balancesOf(o, other);
    const replacedBy = await Promise.all(otherLines.map(async (l) => (await orgRow(fs(), o, 'period_balances', String(l.superseded_by)).get()).get('import_batch_id')));
    expect(`${otherLines.length}|${replacedBy.filter((x) => x === last).length}`).toBe('3|3');
    await calculateAndAlert(o);
    expect(await value(o, '2026-07', 'revenue')).toBe(last === a ? '1200.00' : '1300.00');
  }, 300_000);

  it('tenant isolation: replacing July in one organisation leaves another\'s July untouched, and outsiders cannot act', async () => {
    const { id: a } = await org('ISOA');
    const { id: b, creator: bOwner } = await org('ISOB');
    await commit(await upload(a, 'trial_balance', '2026-07', TB('-1100.00', '300.00', '800.00')), 'movement');
    await commit(await upload(b, 'trial_balance', '2026-07', TB('-5000.00', '300.00', '4700.00')), 'movement');
    const corrected = await upload(a, 'trial_balance', '2026-07', TB('-1200.00', '300.00', '900.00'));
    // B's owner has no standing in A: A's batch does not exist for them.
    const asOutsider = clientFor(bOwner);
    expect((await call(asOutsider, 'record_batch_confirmation', { p_batch: corrected, p_code: 'IMP-TB-016', p_value: { report_complete: 'complete' } })).error?.code)
      .toBe('NOT_FOUND');
    expect((await call(asOutsider, 'commit_import_batch', { p_batch: corrected })).error?.code).toBe('NOT_FOUND');

    await commit(corrected, 'movement');
    expect(await current(a, '2026-07')).toEqual(['Cash=900.00', 'Operating Expenses=300.00', 'Revenue=-1200.00']);
    expect(await current(b, '2026-07')).toEqual(['Cash=4700.00', 'Operating Expenses=300.00', 'Revenue=-5000.00']);
    expect((await where(b, 'period_balances', {})).filter((l) => l.superseded_by !== null)).toHaveLength(0);
  }, 300_000);
});

describe('ADR-139 C4 · commit still re-checks: a report committed after this one was validated', () => {
  it('a correction validated BEFORE the original was committed is asked at commit, and nothing is written meanwhile', async () => {
    const { id: o } = await org('LATEASK');
    const original = await upload(o, 'trial_balance', '2026-07', TB('-1100.00', '300.00', '800.00'));
    const correction = await upload(o, 'trial_balance', '2026-07', TB('-1200.00', '300.00', '900.00'));
    // Neither saw the other when validated.
    expect(((await batchDoc(correction)).required_confirmations as string[]).includes('IMP-COV-013')).toBe(false);
    await commit(original, 'movement');
    await confirm(correction, 'movement');
    const ask = await rpc('commit_import_batch', { p_batch: correction });
    expect(ask.error, ask.error?.message).toBeNull();
    expect(ask.data).toMatchObject({ status: 'needs_confirmation', code: 'IMP-COV-013', replaces: 3 });
    expect(await balancesOf(o, correction)).toHaveLength(0);
    expect((await batchDoc(correction)).status).toBe('awaiting_review');
    expect(await commit(correction, 'movement')).toMatchObject({ status: 'committed', superseded: 3 });
  }, 300_000);
});

describe('NF-3 · a corrected report can be rolled back', () => {
  it('rolling back the correction restores the original: July 1,100 again, nothing lost, no duplicate-key error', async () => {
    const { id: o } = await org('UNDO');
    const original = await upload(o, 'trial_balance', '2026-07', TB('-1100.00', '300.00', '800.00'));
    await commit(original, 'movement');
    const correction = await upload(o, 'trial_balance', '2026-07', TB('-1200.00', '300.00', '900.00'));
    await commit(correction, 'movement');
    expect(await current(o, '2026-07')).toEqual(['Cash=900.00', 'Operating Expenses=300.00', 'Revenue=-1200.00']);
    const undo = await rpc('rollback_import_batch', { p_batch: correction, p_reason: 'the correction was wrong' });
    expect(undo.error, undo.error?.message).toBeNull();
    expect(undo.data).toMatchObject({ rejected: 3, restored: 3 });
    expect(await current(o, '2026-07')).toEqual(['Cash=800.00', 'Operating Expenses=300.00', 'Revenue=-1100.00']);
    const originalIds = new Set((await balancesOf(o, original)).map((l) => String(l.id)));
    expect((await where(o, 'record_status_events', { event: 'restored' })).filter((e) => originalIds.has(String(e.record_id)))).toHaveLength(3);
    await calculateAndAlert(o);
    expect(await value(o, '2026-07', 'revenue')).toBe('1100.00');
  }, 300_000);
});

describe('N-6 · a Debit / Credit report is never sign-flipped a second time', () => {
  it('a reporting sign saved on a Debit / Credit layout does not negate it: revenue stored −1,100, shown 1,100', async () => {
    const { id: o } = await org('DCSIGN');
    const batch = await upload(o, 'trial_balance', '2026-07', 'Account,Debit,Credit\nRevenue,,1100.00\nCost of Sales,440.00,\nCash,660.00,\n');
    // A saved mapping (or an API client) puts `reporting` on the batch; the review page never asks it here.
    const saved = await rpc('save_import_mapping', { p_batch: batch, p_mapping: {
      name: 'n6', header_signature: `n6-${RUN}`, balance_basis: 'movement', balance_sign: 'reporting' } });
    expect(saved.error, saved.error?.message).toBeNull();
    expect((await batchDoc(batch)).balance_sign).toBe('reporting');
    await commit(batch, 'movement', 'reporting');
    expect(await current(o, '2026-07')).toEqual(['Cash=660.00', 'Cost of Sales=440.00', 'Revenue=-1100.00']);
    await calculateAndAlert(o);
    expect(await value(o, '2026-07', 'revenue')).toBe('1100.00');
  }, 300_000);

  it('control: a one-column report in reporting sign is still converted (income negated once)', async () => {
    const { id: o } = await org('ONECOL');
    await commit(await upload(o, 'pnl_report', '2026-07', 'Account,Amount\nRevenue,1100.00\nCost of Sales,440.00\n'), 'movement', 'reporting');
    expect(await current(o, '2026-07')).toEqual(['Cost of Sales=440.00', 'Revenue=-1100.00']);
  }, 300_000);
});

describe('N-5 · a trial-balance expense spike cites the report, not the ledger', () => {
  it('marketing 6,000 → 9,000 on revenue 100,000: the alert pins period_balances rows of the winning report', async () => {
    const { id: o } = await org('TBSPIKE');
    // June differs from July only so the two files are not one upload (the duplicate-file guard).
    for (const [ym, mkt] of [['2026-06', '5900'], ['2026-07', '6000'], ['2026-08', '9000']] as const) {
      const cash = new Decimal(100000).minus(mkt).toFixed(2);
      await commit(await upload(o, 'trial_balance', ym, `Account,Debit,Credit\nRevenue,,100000.00\nMarketing,${mkt}.00,\nCash,${cash},\n`), 'movement');
    }
    await calculateAndAlert(o);
    const august = (await where(o, 'fiscal_periods', { period_start: '2026-08-01' }))[0]!;
    const alerts = (await where(o, 'alerts', { period_id: august.id })).filter((x) => String(x.rule_key).startsWith('expense.spike'));
    const pinned: string[] = [];
    for (const alert of alerts) {
      const rev = (await orgRow(fs(), o, 'alert_revisions', String(alert.current_revision_id)).get()).data();
      if (!rev?.evidence_bundle_id) continue;
      for (const ei of await where(o, 'evidence_items', { bundle_id: rev.evidence_bundle_id, item_type: 'query' })) {
        pinned.push(`${alert.rule_key}|${(ei.query_descriptor as { table?: string } | null)?.table ?? '-'}`);
      }
    }
    expect(pinned.length, 'an expense spike fired in August with a records pin').toBeGreaterThan(0);
    for (const row of pinned) expect(row).toMatch(/\|period_balances$/);
  }, 300_000);
});
