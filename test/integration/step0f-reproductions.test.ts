import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { buildBundleForMetric, loadEvidenceDrawer } from '@/modules/evidence';
import { startImport } from '@/modules/imports';
import type { AccessContext } from '@/modules/tenancy';
import { calculateAndAlert } from '../fixtures/adr120-orgs';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * Step 0F reproductions of the re-review's N-3, N-5 and N-6 on a real database, through the real
 * upload path (`startImport` → confirmations → `commit_import_batch` → the queue).
 *
 * EVERY case seeds its own organisation inside its own test: nothing is shared in a `beforeAll`, so
 * on the code before the fix each case fails on its own and an early failure cannot hide a later one.
 * Expected figures are worked from the files by hand. Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.step0f.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]?.trim() ?? '';
const lines = (sql: string): string[] => adminSql(sql).split('\n').map((l) => l.trim()).filter(Boolean);
let owner: string;
const ownerDb = () => clientFor(owner, { email: `owner@${DOMAIN}` });
let n = 0;

/** A new organisation; returns it and its creator (sole owner). The shared reviewer joins as admin. */
async function org(label: string): Promise<{ id: string; creator: string }> {
  const creator = createAuthUser(`${label.toLowerCase()}-${n++}-creator@${DOMAIN}`);
  const r = await clientFor(creator).schema('api').rpc('create_organization', { p_name: `ITest Step0F ${label} ${RUN}` });
  if (r.error) throw new Error(r.error.message);
  const id = r.data as unknown as string;
  adminSql(`set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role) values ('${id}', '${owner}', 'admin');`);
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

const rpc = (fn: string, args: Record<string, unknown>) => ownerDb().schema('api').rpc(fn, args);

/** Answers every outstanding confirmation as a reviewer would. */
async function confirm(batchId: string, basis: 'movement' | 'cumulative', sign: 'natural' | 'reporting' = 'natural') {
  const required = one(`select coalesce(string_agg(c, ','), '') from public.import_batches b, unnest(b.required_confirmations) c
     where b.id = '${batchId}' and not (b.confirmations ? c)`).split(',').filter(Boolean);
  for (const code of required) {
    const [start, end] = one(`select period_start || ',' || period_end from public.import_batches where id = '${batchId}'`).split(',');
    const value = code === 'IMP-RANGE-015' ? { period_start: start, period_end: end }
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

function value(o: string, ym: string, key: string): string {
  return one(`select coalesce(s.value::numeric(16, 2)::text, 'NULL')
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o}' and c.metric_key = '${key}' and c.dimension_type = 'none' and p.period_start = '${ym}-01'`);
}
const snapshotOf = (o: string, ym: string, key: string) => one(`select c.snapshot_id from public.metric_current c
  join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
 where c.organization_id = '${o}' and c.metric_key = '${key}' and c.dimension_type = 'none' and p.period_start = '${ym}-01'`);
const ctxFor = (o: string): AccessContext => ({
  userId: owner, orgId: o, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'), actorType: 'user',
  db: clientFor(owner), requestId: RUN, now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});
/** `name=closing` of the CURRENT lines of a month, by account name. */
const current = (o: string, ym: string) => lines(`select a.name || '=' || b.closing_balance from public.period_balances b
  join public.accounts a on a.id = b.account_id and a.organization_id = b.organization_id
 where b.organization_id = '${o}' and b.period_start = '${ym}-01' and b.record_status = 'accepted' and b.superseded_by is null
 order by a.name collate "C"`);

const TB = (revenue: string, opex: string, cash: string) => `Account,Balance\nRevenue,${revenue}\nOperating Expenses,${opex}\nCash,${cash}\n`;

beforeAll(() => { owner = createAuthUser(`owner@${DOMAIN}`); });
afterAll(() => {
  adminSql(`delete from public.organizations where name like 'ITest Step0F %${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('N-3 · a corrected report replaces the previous one', () => {
  it('REUPLOAD: a corrected July trial balance replaces the first through the upload path; July 1,100, August 1,210', async () => {
    const { id: o } = await org('REUPLOAD');
    await commit(await upload(o, 'trial_balance', '2026-06', TB('-6000.00', '1800.00', '4200.00')), 'cumulative');
    const wrong = await upload(o, 'trial_balance', '2026-07', TB('-9999.00', '2100.00', '7899.00'));
    await commit(wrong, 'cumulative');
    await calculateAndAlert(o);
    expect(value(o, '2026-07', 'revenue')).toBe('3999.00'); // 9,999 − 6,000: the wrong July
    // An evidence bundle opened on the WRONG figure, before the correction.
    const oldSnapshot = snapshotOf(o, '2026-07', 'revenue');
    const oldBundle = await buildBundleForMetric(ctxFor(o), oldSnapshot);

    const corrected = await upload(o, 'trial_balance', '2026-07', TB('-7100.00', '2100.00', '5000.00'));
    await confirm(corrected, 'cumulative');
    // The first attempt writes nothing and asks: this replaces July's report (IMP-COV-013).
    const ask = await rpc('commit_import_batch', { p_batch: corrected });
    expect(ask.error, ask.error?.message).toBeNull();
    expect(ask.data).toMatchObject({ status: 'needs_confirmation', code: 'IMP-COV-013', replaces: 3 });
    expect(one(`select ('IMP-COV-013' = any (required_confirmations))::text || '|' || status from public.import_batches where id = '${corrected}'`))
      .toBe('true|awaiting_review');
    expect(one(`select count(*) from public.period_balances where import_batch_id = '${corrected}'`)).toBe('0');

    const done = await commit(corrected, 'cumulative');
    expect(done).toMatchObject({ status: 'committed', committed: 3, superseded: 3 });
    await commit(await upload(o, 'trial_balance', '2026-08', TB('-8310.00', '2400.00', '5910.00')), 'cumulative');
    await calculateAndAlert(o);

    expect(current(o, '2026-07')).toEqual(['Cash=5000.00', 'Operating Expenses=2100.00', 'Revenue=-7100.00']);
    expect([value(o, '2026-07', 'revenue'), value(o, '2026-08', 'revenue')]).toEqual(['1100.00', '1210.00']);

    // History: the first July report is kept, each line superseded by the same account's new line.
    expect(lines(`select a.name || '=' || old.closing_balance || '>' || nw.closing_balance
        from public.period_balances old join public.period_balances nw on nw.id = old.superseded_by and nw.organization_id = old.organization_id
        join public.accounts a on a.id = old.account_id and a.organization_id = old.organization_id
       where old.import_batch_id = '${wrong}' order by a.name collate "C"`))
      .toEqual(['Cash=7899.00>5000.00', 'Operating Expenses=2100.00>2100.00', 'Revenue=-9999.00>-7100.00']);
    expect(one(`select count(*) from public.record_status_events e join public.period_balances b on b.id = e.record_id
       where b.import_batch_id = '${wrong}' and e.event = 'superseded' and e.import_batch_id = '${corrected}'`)).toBe('3');
    expect(lines(`select action from public.audit_events where organization_id = '${o}' and target_id = '${corrected}'
       and action in ('import.replacement_unconfirmed', 'import.confirmed', 'import.committed') order by id`))
      .toEqual(expect.arrayContaining(['import.replacement_unconfirmed', 'import.committed']));

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
    await confirm(corrected, 'movement');
    // Ask, and answer, the replacement question so the commit gets as far as writing.
    await rpc('commit_import_batch', { p_batch: corrected });
    await confirm(corrected, 'movement');
    // Sabotage the LAST row so the failure comes after earlier rows were written in the transaction.
    adminSql(`update public.import_rows set mapped_data = jsonb_set(mapped_data, '{closing_balance}', '"not a number"')
      where batch_id = '${corrected}' and row_number = (select max(row_number) from public.import_rows where batch_id = '${corrected}'
        and status in ('valid', 'warning'))`);
    const failed = await rpc('commit_import_batch', { p_batch: corrected });
    expect(failed.error).not.toBeNull();

    expect(current(o, '2026-07')).toEqual(['Cash=800.00', 'Operating Expenses=300.00', 'Revenue=-1100.00']);
    expect(one(`select count(*) from public.period_balances where import_batch_id = '${corrected}'`)).toBe('0');
    expect(one(`select count(*) from public.record_status_events e join public.period_balances b on b.id = e.record_id
      where b.import_batch_id = '${first}' and e.event = 'superseded'`)).toBe('0');
    expect(one(`select status from public.import_batches where id = '${corrected}'`)).toBe('awaiting_review');
    await calculateAndAlert(o);
    expect(value(o, '2026-07', 'revenue')).toBe('1100.00');
  }, 300_000);

  it('concurrent: two corrections committed at once are applied one after the other; one report is current', async () => {
    const { id: o } = await org('CONCURRENT');
    await commit(await upload(o, 'trial_balance', '2026-07', TB('-1100.00', '300.00', '800.00')), 'movement');
    const a = await upload(o, 'trial_balance', '2026-07', TB('-1200.00', '300.00', '900.00'));
    const b = await upload(o, 'trial_balance', '2026-07', TB('-1300.00', '300.00', '1000.00'));
    for (const batch of [a, b]) {
      await confirm(batch, 'movement');
      expect((await rpc('commit_import_batch', { p_batch: batch })).data).toMatchObject({ status: 'needs_confirmation' });
      await confirm(batch, 'movement');
    }
    const results = await Promise.all([a, b].map((batch) => rpc('commit_import_batch', { p_batch: batch })));
    for (const r of results) {
      expect(r.error, r.error?.message).toBeNull();
      expect(r.data).toMatchObject({ status: 'committed', committed: 3, superseded: 3 });
    }
    // Exactly one current line per account, all from the batch committed last.
    expect(one(`select count(*) from (select account_id from public.period_balances where organization_id = '${o}'
      and period_start = '2026-07-01' and record_status = 'accepted' and superseded_by is null group by account_id having count(*) > 1) d`)).toBe('0');
    const last = one(`select id from public.import_batches where id in ('${a}', '${b}') order by committed_at desc limit 1`);
    expect(one(`select string_agg(distinct import_batch_id::text, ',') from public.period_balances where organization_id = '${o}'
      and period_start = '2026-07-01' and record_status = 'accepted' and superseded_by is null`)).toBe(last);
    await calculateAndAlert(o);
    expect(value(o, '2026-07', 'revenue')).toBe(last === a ? '1200.00' : '1300.00');
  }, 300_000);

  it('tenant isolation: replacing July in one organisation leaves another\'s July untouched, and outsiders cannot act', async () => {
    const { id: a } = await org('ISOA');
    const { id: b, creator: bOwner } = await org('ISOB');
    await commit(await upload(a, 'trial_balance', '2026-07', TB('-1100.00', '300.00', '800.00')), 'movement');
    await commit(await upload(b, 'trial_balance', '2026-07', TB('-5000.00', '300.00', '4700.00')), 'movement');
    const corrected = await upload(a, 'trial_balance', '2026-07', TB('-1200.00', '300.00', '900.00'));
    // B's owner has no standing in A: A's batch does not exist for them.
    const asOutsider = clientFor(bOwner).schema('api');
    expect((await asOutsider.rpc('record_batch_confirmation', { p_batch: corrected, p_code: 'IMP-TB-016', p_value: { report_complete: 'complete' } })).error?.message)
      .toContain('NOT_FOUND');
    expect((await asOutsider.rpc('commit_import_batch', { p_batch: corrected })).error?.message).toContain('NOT_FOUND');

    await commit(corrected, 'movement');
    expect(current(a, '2026-07')).toEqual(['Cash=900.00', 'Operating Expenses=300.00', 'Revenue=-1200.00']);
    expect(current(b, '2026-07')).toEqual(['Cash=4700.00', 'Operating Expenses=300.00', 'Revenue=-5000.00']);
    expect(one(`select count(*) from public.period_balances where organization_id = '${b}' and superseded_by is not null`)).toBe('0');
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
    expect(one(`select balance_sign from public.import_batches where id = '${batch}'`)).toBe('reporting');
    await commit(batch, 'movement', 'reporting');
    expect(current(o, '2026-07')).toEqual(['Cash=660.00', 'Cost of Sales=440.00', 'Revenue=-1100.00']);
    await calculateAndAlert(o);
    expect(value(o, '2026-07', 'revenue')).toBe('1100.00');
  }, 300_000);

  it('control: a one-column report in reporting sign is still converted (income negated once)', async () => {
    const { id: o } = await org('ONECOL');
    await commit(await upload(o, 'pnl_report', '2026-07', 'Account,Amount\nRevenue,1100.00\nCost of Sales,440.00\n'), 'movement', 'reporting');
    expect(current(o, '2026-07')).toEqual(['Cost of Sales=440.00', 'Revenue=-1100.00']);
  }, 300_000);
});

describe('N-5 · a trial-balance expense spike cites the report, not the ledger', () => {
  it('marketing 6,000 → 9,000 on revenue 100,000: the alert pins period_balances rows of the winning report', async () => {
    const { id: o } = await org('TBSPIKE');
    for (const [ym, mkt] of [['2026-06', '6000'], ['2026-07', '6000'], ['2026-08', '9000']] as const) {
      const cash = new Decimal(100000).minus(mkt).toFixed(2);
      await commit(await upload(o, 'trial_balance', ym, `Account,Debit,Credit\nRevenue,,100000.00\nMarketing,${mkt}.00,\nCash,${cash},\n`), 'movement');
    }
    await calculateAndAlert(o);
    const pinned = lines(`select a.rule_key || '|' || coalesce(ei.query_descriptor ->> 'table', '-')
        from public.alerts a join public.fiscal_periods p on p.id = a.period_id and p.organization_id = a.organization_id
        join public.alert_revisions r on r.id = a.current_revision_id and r.organization_id = a.organization_id
        join public.evidence_items ei on ei.bundle_id = r.evidence_bundle_id and ei.organization_id = a.organization_id
       where a.organization_id = '${o}' and a.rule_key like 'expense.spike%' and p.period_start = '2026-08-01' and ei.item_type = 'query'`);
    expect(pinned.length, 'an expense spike fired in August with a records pin').toBeGreaterThan(0);
    for (const row of pinned) expect(row).toMatch(/\|period_balances$/);
  }, 300_000);
});
