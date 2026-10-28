import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainJobs } from '@/modules/jobs';
import { permissionsFor } from '@/core/permissions';
import { buildBundleForMetric, loadEvidenceDrawer } from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { calculateAndAlert, currentSnapshots } from '../fixtures/adr120-orgs';
import { balanceBatch, counterparty, glBatch, invoiceBatch } from '../fixtures/audit-orgs';
import { Decimal } from '@/core/money';
import { orgRow } from '@/db/schema';
import { orgRows } from '@/db/rls';
import { API_FUNCTIONS } from '@/db/api';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs, rpc as call } from './setup';
import { addMember, addPlatformUser, assign, makeOrg } from './f-fixtures';
import { where } from './i-fixtures';

/**
 * Step 0F follow-up — an owner confirms what an EXISTING report covers (owner decision after the
 * N-1 re-review). The reports here are committed the way an import made before the question existed
 * is stored: no IMP-TB-016 answer. Each case seeds its own organisation inside its own test.
 *
 * Expected figures, by hand. July: a ledger stating revenue 1,100 (and its cash), and a trial balance
 * stating revenue 5,000, operating expenses 800 and cash 4,200 — it balances (−5,000 + 800 + 4,200).
 *   unconfirmed → the ledger states July (1,100, calculated), warning balance_report_incomplete;
 *   confirmed complete → the report states July: revenue 5,000, operating expenses 800, every other
 *     category zero, net profit 4,200, verified;
 *   corrected to partial → the ledger again (1,100).
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.attest.itest.motion`;
let n = 0;
const made: string[] = [];

interface Org { id: string; owner: string; admin: string; employee: string; client: string }

async function member(org: string, role: 'admin' | 'client'): Promise<string> {
  const user = await createAuthUser(`${role}-${n++}@${DOMAIN}`);
  await addMember(org, user, role);
  return user;
}

/** A platform employee ASSIGNED to the organisation: holds imports.review there, but is no owner or admin. */
async function employee(org: string): Promise<string> {
  const user = await createAuthUser(`employee-${n++}@${DOMAIN}`);
  await addPlatformUser(user, 'employee');
  await assign(org, user);
  return user;
}

async function org(label: string): Promise<Org> {
  const owner = await createAuthUser(`owner-${n++}@${DOMAIN}`);
  const id = await makeOrg(owner, `ITest Attest ${label} ${RUN}`);
  made.push(id);
  return { id, owner, admin: await member(id, 'admin'), employee: await employee(id), client: await member(id, 'client') };
}

const attest = (user: string, batch: string, month: string, coverage: string, reason = 'Compared with the full trial balance in our accounts') =>
  call(clientFor(user), 'attest_report_completeness', { p_batch: batch, p_period_start: month, p_coverage: coverage, p_reason: reason });

/** Drains the recalculation the attestation itself queued (not a test-made one). */
async function drainQueuedRecalculation(o: string, batch: string): Promise<void> {
  const jobs = (await fs().collection('jobs').where('organization_id', '==', o).where('job_type', '==', 'calculation.run').get()).docs
    .map((d) => d.data())
    .filter((j) => j.payload?.triggerRefId === batch || (Array.isArray(j.payload?.refs) && j.payload.refs.some((r: { triggerRefId?: string }) => r.triggerRefId === batch)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const job = String(jobs[0]?.id ?? '');
  expect(job, 'the attestation queued a recalculation').not.toBe('');
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
}

async function metric(o: string, ym: string, key: string): Promise<string> {
  const [s] = await currentSnapshots(o, `${ym}-01`, key);
  if (!s) return '';
  const dq = (s.data_quality as { missing?: unknown; warnings?: unknown } | null) ?? {};
  const value = s.value === null || s.value === undefined ? 'NULL' : new Decimal(String(s.value)).toFixed(2);
  return `${value}|${s.assurance_level}|${s.basis}|${JSON.stringify(dq.missing ?? [])}|${JSON.stringify(dq.warnings ?? [])}`;
}
const head = async (o: string, ym: string, key: string) => (await metric(o, ym, key)).split('|').slice(0, 3);
const snapshotOf = async (o: string, ym: string, key: string) => String((await currentSnapshots(o, `${ym}-01`, key))[0]?.id ?? '');

/** A July ledger (revenue 1,100) and a July trial balance with no completeness answer. */
async function mixed(o: string, extraction: 'csv' | 'pdf_claude' = 'csv'): Promise<string> {
  await glBatch(o, { start: '2026-07-01', end: '2026-07-31', tag: `gl-${n++}`, lines: [
    { date: '2026-07-05', category: 'cash', direction: 'debit', amount: '1100' },
    { date: '2026-07-05', category: 'revenue', direction: 'credit', amount: '1100' },
  ] });
  return balanceBatch(o, { importType: 'trial_balance', basis: 'movement', start: '2026-07-01', end: '2026-07-31', tag: `tb-${n++}`,
    extraction, rows: [['revenue', '-5000'], ['operating_expense', '800'], ['cash', '4200']] });
}

afterAll(async () => {
  for (const id of made) {
    const jobs = await fs().collection('jobs').where('organization_id', '==', id).get();
    await Promise.all(jobs.docs.map((d) => d.ref.delete()));
    await deleteOrg(id);
  }
});

describe('confirming an existing import', () => {
  it('unconfirmed → the ledger; owner confirms complete → the report, recalculated; admin corrects → the ledger again', async () => {
    const o = await org('FLOW');
    const tb = await mixed(o.id);
    await calculateAndAlert(o.id);

    // Unconfirmed: the report is passed over for the ledger that covers July. Never a zero.
    expect(await head(o.id, '2026-07', 'revenue')).toEqual(['1100.00', 'calculated', 'ledger']);
    expect(await metric(o.id, '2026-07', 'revenue')).toContain('balance_report_incomplete');
    const before = await snapshotOf(o.id, '2026-07', 'revenue');

    // The owner reviews the stored file and confirms July — no re-upload.
    const first = await attest(o.owner, tb, '2026-07-01', 'complete');
    expect(first.error, first.error?.message).toBeNull();
    await drainQueuedRecalculation(o.id, tb);
    expect(await head(o.id, '2026-07', 'revenue')).toEqual(['5000.00', 'verified', 'period_balances']);
    expect(await head(o.id, '2026-07', 'operating_expenses')).toEqual(['800.00', 'verified', 'period_balances']);
    expect(await head(o.id, '2026-07', 'net_profit')).toEqual(['4200.00', 'verified', 'period_balances']);

    // The earlier snapshot is kept, with its own basis and assurance.
    const old = (await orgRow(fs(), o.id, 'metric_snapshots', before).get()).data()!;
    expect(`${new Decimal(String(old.value)).toFixed(2)}|${old.assurance_level}|${old.basis}`).toBe('1100.00|calculated|ledger');

    // Evidence of the recalculated figure reconciles to the report's own rows.
    const ctx: AccessContext = { userId: o.owner, orgId: o.id, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
      actorType: 'user', db: clientFor(o.owner), requestId: RUN, now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active' };
    const snap = await snapshotOf(o.id, '2026-07', 'revenue');
    const view = await loadEvidenceDrawer(ctx, await buildBundleForMetric(ctx, snap));
    expect(view.records.map((b) => b.reconciles)).toEqual([true]);

    // An admin corrects it: the report was an extract after all.
    const second = await attest(o.admin, tb, '2026-07-01', 'partial', 'The file omits the payroll section');
    expect(second.error, second.error?.message).toBeNull();
    await drainQueuedRecalculation(o.id, tb);
    expect(await head(o.id, '2026-07', 'revenue')).toEqual(['1100.00', 'calculated', 'ledger']);

    // History: both answers kept, the correction naming the one it replaces; audited with before/after.
    const answers = (await where(o.id, 'report_completeness_attestations', { import_batch_id: tb }))
      .sort((a, b) => String(a.attested_at).localeCompare(String(b.attested_at)));
    expect(answers.map((a) => `${a.coverage}|${a.attested_role}|${a.supersedes_id !== null}|${a.scope}`))
      .toEqual(['complete|owner|false|all_accounts', 'partial|admin|true|all_accounts']);
    expect((await orgRow(fs(), o.id, 'report_completeness_attestations', second.data as string).get()).get('supersedes_id'))
      .toBe(first.data as string);
    const audits = (await fs().collection('audit_events').where('organization_id', '==', o.id)
      .where('action', '==', 'report.completeness_attested').get()).docs.map((d) => d.data())
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    expect(audits.map((a) => `${a.before?.coverage}>${a.after?.coverage}|${a.actor_user_id !== null}`))
      .toEqual(['unconfirmed>complete|true', 'complete>partial|true']);
  }, 300_000);

  it('a report confirmed PARTIAL with no other source: what it lacks is NULL category_not_in_report, never zero', async () => {
    const o = await org('PARTIAL');
    const tb = await balanceBatch(o.id, { importType: 'trial_balance', basis: 'movement', start: '2026-07-01', end: '2026-07-31', tag: `p-${n++}`,
      rows: [['revenue', '-5000'], ['operating_expense', '800'], ['cash', '4200']] });
    await calculateAndAlert(o.id);
    // Never answered: the reason says a confirmation is still possible.
    expect(await metric(o.id, '2026-07', 'net_profit')).toContain('report_completeness_unconfirmed');
    expect((await attest(o.owner, tb, '2026-07-01', 'partial', 'Only the sales and overheads pages')).error).toBeNull();
    await drainQueuedRecalculation(o.id, tb);
    expect(await head(o.id, '2026-07', 'revenue')).toEqual(['5000.00', 'verified', 'period_balances']);
    const net = await metric(o.id, '2026-07', 'net_profit');
    expect(net.startsWith('NULL|')).toBe(true);
    expect(net).toContain('category_not_in_report');
    expect(net).not.toContain('report_completeness_unconfirmed');
  }, 300_000);

  it('a balancing total proves nothing by itself, and a confirmed trial balance that does not balance is still not complete', async () => {
    const o = await org('BALANCE');
    // Balances, unanswered: unknown, never zero.
    await balanceBatch(o.id, { importType: 'trial_balance', basis: 'movement', start: '2026-07-01', end: '2026-07-31', tag: `b-${n++}`,
      rows: [['revenue', '-5000'], ['operating_expense', '800'], ['cash', '4200']] });
    // Does not balance, confirmed complete: the file contradicts the answer.
    const unbalanced = await balanceBatch(o.id, { importType: 'trial_balance', basis: 'movement', start: '2026-08-01', end: '2026-08-31', tag: `u-${n++}`,
      rows: [['revenue', '-5000'], ['operating_expense', '800']] });
    expect((await attest(o.owner, unbalanced, '2026-08-01', 'complete')).error).toBeNull();
    await calculateAndAlert(o.id);
    expect((await metric(o.id, '2026-07', 'net_profit')).startsWith('NULL|')).toBe(true);
    expect(await metric(o.id, '2026-07', 'net_profit')).toContain('report_completeness_unconfirmed');
    expect((await metric(o.id, '2026-08', 'net_profit')).startsWith('NULL|')).toBe(true);
    expect(await metric(o.id, '2026-08', 'net_profit')).toContain('trial_balance_not_balanced'); // NF-6: says why
  }, 300_000);

  it('completeness is not accuracy: an AI-read report confirmed complete stays inferred — its zeros too', async () => {
    const o = await org('AIREAD');
    const tb = await balanceBatch(o.id, { importType: 'trial_balance', basis: 'movement', start: '2026-07-01', end: '2026-07-31', tag: `ai-${n++}`,
      extraction: 'pdf_claude', rows: [['revenue', '-5000'], ['operating_expense', '800'], ['cash', '4200']] });
    expect((await attest(o.owner, tb, '2026-07-01', 'complete')).error).toBeNull();
    await drainQueuedRecalculation(o.id, tb);
    expect(await head(o.id, '2026-07', 'revenue')).toEqual(['5000.00', 'inferred', 'period_balances']);
    // Marketing has no line: a zero by completeness, at the report's own assurance — never verified.
    const marketing = (await currentSnapshots(o.id, '2026-07-01', 'expense_by_category', null))
      .filter((x) => x.dimension_key === 'marketing');
    for (const m of marketing) expect(m.assurance_level).toBe('inferred');
    expect(await head(o.id, '2026-07', 'net_profit')).toEqual(['4200.00', 'inferred', 'period_balances']);
  }, 300_000);
});

describe('who may confirm, and what', () => {
  let o: Org; let tb: string; let bank: string; let other: Org;
  beforeAll(async () => {
    o = await org('PERMS');
    tb = await mixed(o.id);
    other = await org('OUTSIDER');
    bank = String((await where(o.id, 'import_batches', { target_table: 'ledger_entries' }))[0]!.id);
  }, 300_000);

  it('an assigned employee, who may review imports there, cannot: PERMISSION_DENIED', async () => {
    // The employee does reach the organisation's imports (so the refusal is about the role, not access).
    const visible = await orgRows(clientFor(o.employee), o.id, 'import_batches', (q) => q.where('id', '==', tb));
    expect(visible).toHaveLength(1);
    expect((await attest(o.employee, tb, '2026-07-01', 'complete')).error?.code).toBe('PERMISSION_DENIED');
  });

  it('a client cannot', async () => {
    const code = (await attest(o.client, tb, '2026-07-01', 'complete')).error?.code ?? '';
    expect(code).toMatch(/PERMISSION_DENIED|NOT_FOUND/);
  });

  it('another organisation\'s owner sees nothing: NOT_FOUND', async () => {
    expect((await attest(other.owner, tb, '2026-07-01', 'complete')).error?.code).toBe('NOT_FOUND');
  });

  it('one import, one month it states, a reason, an answer of two — or it is refused', async () => {
    for (const [batch, month, coverage, reason] of [
      [tb, '2026-08-01', 'complete', 'checked'],          // a month this import does not state
      [tb, '2026-07-15', 'complete', 'checked'],          // not a month
      [tb, '2026-07-01', 'yes', 'checked'],               // not an answer
      [tb, '2026-07-01', 'complete', '   '],              // no reason
      [bank, '2026-07-01', 'complete', 'checked'],        // not a balance report
    ] as const) {
      expect((await attest(o.owner, batch, month, coverage, reason)).error?.code, `${month} ${coverage} '${reason}'`).toBe('VALIDATION');
    }
    expect(await where(o.id, 'report_completeness_attestations', {})).toHaveLength(0);
  });

  it('no client can write the table directly, and no one can rewrite an answer', async () => {
    // There is no write surface but `api.attest_report_completeness` (the browser never reaches
    // Firestore), and no function updates or deletes an answer: a correction is a new row.
    expect(Object.keys(API_FUNCTIONS).filter((f) => /completeness/.test(f))).toEqual(['attest_report_completeness']);
    expect((await attest(o.owner, tb, '2026-07-01', 'complete')).error).toBeNull();
    expect((await attest(o.owner, tb, '2026-07-01', 'partial', 'second look')).error).toBeNull();
    const answers = await where(o.id, 'report_completeness_attestations', { import_batch_id: tb });
    expect(answers.map((a) => a.coverage).sort()).toEqual(['complete', 'partial']);
  });

  it('the owner of another organisation cannot read this one\'s answers', async () => {
    expect(await orgRows(clientFor(other.owner), o.id, 'report_completeness_attestations')).toEqual([]);
  });
});

/**
 * R-2 (owner decision): a full invoice list states what is owed only once someone confirmed it holds
 * every invoice still unpaid at its start. July sales list (declared 1 Jul–31 Aug, committed 10 Sep):
 * one invoice of 2,000 issued 5 Jul, due 4 Aug, unpaid. By hand, once confirmed: receivables 31 Jul
 * 2,000; 31 Aug 2,000, all overdue.
 */
describe('R-2 · confirming an invoice list\'s opening', () => {
  it('unconfirmed: receivables NULL opening_invoices_unconfirmed, never 0 or a partial total; confirmed by the owner: 2,000', async () => {
    const o = await org('OPENING');
    const acme = await counterparty(o.id, 'Acme Ltd', 'customer');
    const list = await invoiceBatch(o.id, { importType: 'sales_invoices', start: '2026-07-01', end: '2026-08-31', listKind: 'full',
      committedAt: '2026-09-10T10:00:00Z', tag: `inv-${n++}`, openingConfirmed: false,
      invoices: [{ type: 'sales', party: acme, number: 'A-1', issue: '2026-07-05', due: '2026-08-04', subtotal: '2000', tax: '0', total: '2000', paid: '0', paidDate: null, status: 'open' }] });
    await calculateAndAlert(o.id);
    const before = await metric(o.id, '2026-07', 'receivables');
    expect(before.startsWith('NULL|')).toBe(true);
    expect(before).toContain('opening_invoices_unconfirmed');
    // Revenue is unaffected: the list still states July's sales.
    expect((await head(o.id, '2026-07', 'revenue'))[0]).toBe('2000.00');

    // The opening is confirmed for the month the list STARTS in, and only that one.
    expect((await attest(o.owner, list, '2026-08-01', 'complete', 'checked')).error?.code).toBe('VALIDATION');
    const ok = await attest(o.owner, list, '2026-07-01', 'complete', 'Compared with the aged debtors report at 1 July');
    expect(ok.error, ok.error?.message).toBeNull();
    expect((await orgRow(fs(), o.id, 'report_completeness_attestations', ok.data as string).get()).get('scope')).toBe('open_invoices');
    await drainQueuedRecalculation(o.id, list);
    expect(await head(o.id, '2026-07', 'receivables')).toEqual(['2000.00', 'verified', 'invoices']);
    expect((await head(o.id, '2026-08', 'receivables_overdue'))[0]).toBe('2000.00');
  }, 300_000);
});
