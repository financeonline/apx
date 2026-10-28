import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { isMotionError } from '@/core/errors';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { runTool, snapshotAccess, resolvePeriodContext, type PeriodRow } from '@/modules/ai';
import { getRecordProvenance } from '@/modules/evidence';
import { exportCsv } from '@/modules/exports';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { orgRows } from '@/db/rls';
import { orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc, sqlstate } from './setup';
import {
  addMember, addPlatformUser, assign, auditsOf, calculate, dropFixtures, makeOrg, periodFor, rowOf, rowsOf,
  seedBankAccount, seedBankTxn, seedBatch, seedDocument, systemAccount,
} from './f-fixtures';

/**
 * Phase 13 — Banking Intelligence (ADR-101).
 *
 * The banking pass ran for the first time in Phase 13: the rules existed since Phase 6, nothing
 * applied them. This suite proves, against the real functions and the real calculation job:
 *
 *   * the pass categorises, pairs and groups what the rules say it should — and writes ONLY that;
 *   * it is idempotent: a second run over unchanged rows is `no_change` and writes no history;
 *   * a person's decision survives every later run;
 *   * `api.bank_period_summary` agrees with the engine's own cash figures to the penny, and is
 *     fenced by organisation and by permission like everything else;
 *   * currency is the organisation's, never a literal.
 */

// Every calculation here drains the queue the other suites share, so a run can wait behind theirs.
vi.setConfig({ testTimeout: 300_000 });

const RUN = `b${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.banking.itest.motion`;

let ownerA: string; let ownerB: string; let clientA: string; let empAssigned: string; let empOther: string;
let orgA: string; let orgB: string;
let current: string; let savings: string; let card: string; let currentB: string;
let august: string;
const wageIds: string[] = [];
let userDecided: string;
let transferOut: string; let transferIn: string; let cardOut: string; let cardIn: string;

const account = (org: string, category: string): Promise<string> => systemAccount(org, category);
const api = (u: string) => ({ rpc: (fn: string, args: Record<string, unknown>) => rpc(clientFor(u), fn, args) });
const txn = async (id: string) => (await rowOf(orgA, 'bank_transactions', id))!;

function bankAccount(org: string, name: string, type: string, last4: string): Promise<string> {
  return seedBankAccount(org, {
    name, bankName: 'Test Bank', sortCode: '**-**-01', accountNumber: `****${last4}`, type,
    openingBalance: '10000.00', openingBalanceDate: '2026-02-01',
  });
}

function post(org: string, acct: string, date: string, amount: string, description: string,
  extra: { categoryAccountId?: string; categorySource?: string } = {}): Promise<string> {
  return seedBankTxn(org, { bankAccountId: acct, date, amount, description, ...extra });
}

/**
 * `recalc_manual` is the one trigger that never short-circuits on an equal fingerprint (§2.4), so
 * the runs here are `banking_edit` from the earliest month — the same range as a full run, and the
 * trigger a real categorisation would raise — which lets the idempotence test see `no_change`.
 */
async function runCalculation(org: string, asOf = '2026-09-15'): Promise<string> {
  return calculate(org, drainJobs, asOf);
}

async function latestRun(org: string): Promise<{ status: string; noChange: boolean }> {
  const runs = (await rowsOf(org, 'calculation_runs'))
    .sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')) || String(b.created_at).localeCompare(String(a.created_at)));
  const r = runs[0]!;
  return { status: String(r.status), noChange: (r.stats as Record<string, unknown> | null)?.no_change === true };
}

async function historyCount(org: string): Promise<number> {
  return (await orgCollection(fs(), org, 'category_history').count().get()).data().count;
}

/** The engine's current value of a headline figure. */
async function engine(org: string, period: string, key: string): Promise<Decimal> {
  const cells = await orgCollection(fs(), org, 'metric_current').where('period_id', '==', period)
    .where('metric_key', '==', key).where('dimension_type', '==', 'none').get();
  const snap = await orgRow(fs(), org, 'metric_snapshots', String(cells.docs[0]!.get('snapshot_id'))).get();
  return new Decimal(String(snap.get('value')));
}

beforeAll(async () => {
  ownerA = await createAuthUser(`owner-a@${DOMAIN}`);
  ownerB = await createAuthUser(`owner-b@${DOMAIN}`);
  clientA = await createAuthUser(`client-a@${DOMAIN}`);
  empAssigned = await createAuthUser(`emp-assigned@${DOMAIN}`);
  empOther = await createAuthUser(`emp-other@${DOMAIN}`);
  await addPlatformUser(empAssigned, 'employee');
  await addPlatformUser(empOther, 'employee');

  // Organisation A reports in rupees: nothing about banking may assume pounds.
  orgA = await makeOrg(ownerA, `ITest Bank A ${RUN}`, { baseCurrency: 'INR', countryCode: 'IN', timezone: 'Asia/Kolkata' });
  orgB = await makeOrg(ownerB, `ITest Bank B ${RUN}`);
  await addMember(orgA, clientA, 'client');
  await assign(orgA, empAssigned);

  current = await bankAccount(orgA, 'Main current', 'current', '1111');
  savings = await bankAccount(orgA, 'Savings pot', 'savings', '2222');
  card = await bankAccount(orgA, 'Company card', 'credit_card', '3333');
  currentB = await bankAccount(orgB, 'B current', 'current', '4444');

  // Seven months of the same wage run and the same customer receipt (Feb–Aug 2026).
  for (const month of ['02', '03', '04', '05', '06', '07', '08']) {
    wageIds.push(await post(orgA, current, `2026-${month}-28`, '-2500.00', 'PAYROLL ACME LTD'));
    await post(orgA, current, `2026-${month}-05`, '9000.00', 'FPS CREDIT NORTHWIND');
  }
  // A wage run somebody has already decided about: it goes to operating expenses, and stays there.
  userDecided = await post(orgA, current, '2026-08-29', '-2500.00', 'PAYROLL ACME LTD BONUS',
    { categoryAccountId: await account(orgA, 'operating_expense'), categorySource: 'user' });
  // A sweep to savings with transfer wording on both legs, and a card repayment.
  transferOut = await post(orgA, current, '2026-08-10', '-1000.00', 'TRANSFER TO SAVINGS');
  transferIn = await post(orgA, savings, '2026-08-10', '1000.00', 'TRANSFER FROM CURRENT');
  cardOut = await post(orgA, current, '2026-08-15', '-420.00', 'CARD PAYMENT TO COMPANY CARD');
  cardIn = await post(orgA, card, '2026-08-16', '420.00', 'PAYMENT RECEIVED THANK YOU TRANSFER');
  // Card purchases (the expenses), a one-off, and a same-amount pair with NO transfer wording.
  await post(orgA, card, '2026-08-03', '-120.00', 'AMAZON MARKETPLACE');
  await post(orgA, current, '2026-08-20', '-89.99', 'SOME SHOP 1234');
  await post(orgA, current, '2026-08-11', '4800.00', 'ACME INVOICE 1001');
  await post(orgA, savings, '2026-08-12', '-4800.00', 'BETA SUPPLIES');
  // Organisation B: one month, one row, so it has figures of its own to NOT leak.
  await post(orgB, currentB, '2026-08-07', '-300.00', 'PAYROLL B LTD');

  august = await periodFor(orgA, '2026-08-01');

  // Statements covering August: the current account's reconciled, the savings one without balances.
  const doc = await seedDocument(orgA, { filename: 'aug-statement.csv', kind: 'bank_statement' });
  await seedBatch(orgA, {
    documentId: doc, importType: 'bank_statement', targetTable: 'bank_transactions', bankAccountId: current,
    status: 'committed', periodStart: '2026-08-01', periodEnd: '2026-08-31',
    committedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), openingBalance: '10000.00', closingBalance: '8000.00', issues: [],
  });
  await seedBatch(orgA, {
    documentId: doc, importType: 'bank_statement', targetTable: 'bank_transactions', bankAccountId: savings,
    status: 'committed', periodStart: '2026-08-01', periodEnd: '2026-08-31',
    committedAt: new Date(Date.now() - 86_400_000).toISOString(), openingBalance: null, closingBalance: null,
    issues: [{ code: 'IMP-BAL-007', severity: 'warning', message: 'Statement balances could not be captured' }],
  });

  await runCalculation(orgA);
  await runCalculation(orgB);
}, 240_000);

afterAll(async () => {
  await dropFixtures([orgA, orgB], DOMAIN);
}, 120_000);

describe('the banking pass runs inside the calculation and writes what the rules say', () => {
  it('categorises every keyword match by rule, and nothing else', async () => {
    const payroll = await account(orgA, 'payroll');
    const got = await Promise.all(wageIds.map(async (id) => { const t = await txn(id); return `${t.category_account_id}|${t.category_source}`; }));
    expect(got).toHaveLength(7);
    expect(new Set(got)).toEqual(new Set([`${payroll}|rule`]));
    // The customer receipt matches no keyword and stays uncategorised — never guessed as revenue.
    const northwind = (await rowsOf(orgA, 'bank_transactions', { description_normalized: 'FPS CREDIT NORTHWIND' }))
      .map((t) => `${t.category_account_id ?? 'null'}|${t.category_source}`);
    expect(new Set(northwind)).toEqual(new Set(['null|none']));
  });

  it('pairs the sweep as a cash transfer and the card payment as a repayment, deriving the kind in the writer', async () => {
    const leg = async (id: string) => {
      const t = await txn(id);
      return `${t.is_transfer}|${t.transfer_kind}|${t.transfer_pair_id ?? ''}|${t.category_account_id ?? ''}|${t.category_source}`;
    };
    const transfer = await account(orgA, 'transfer');
    const creditCard = await account(orgA, 'credit_card');
    expect(await leg(transferOut)).toBe(`true|cash_transfer|${transferIn}|${transfer}|rule`);
    expect(await leg(transferIn)).toBe(`true|cash_transfer|${transferOut}|${transfer}|rule`);
    expect(await leg(cardOut)).toBe(`true|card_repayment|${cardIn}|${creditCard}|rule`);
    expect(await leg(cardIn)).toBe(`true|card_repayment|${cardOut}|${creditCard}|rule`);
  });

  it('does not pair a same-amount receipt and payment that carry no transfer wording', async () => {
    const got = (await rowsOf(orgA, 'bank_transactions')).filter((t) => ['ACME INVOICE 1001', 'BETA SUPPLIES'].includes(String(t.description_normalized)))
      .map((t) => t.is_transfer);
    expect(got).toEqual([false, false]);
  });

  it('writes the recurring groups and points their members at them', async () => {
    const all = await rowsOf(orgA, 'recurring_payment_groups');
    const groups = all.sort((a, b) => String(a.direction).localeCompare(String(b.direction)))
      .map((g) => `${g.direction}|${g.cadence}|${g.occurrence_count}|${g.status}|${new Decimal(String(g.expected_amount)).toFixed(2)}`);
    expect(groups).toEqual(['inflow|monthly|7|active|9000.00', 'outflow|monthly|7|active|2500.00']);
    const ids = new Set(all.map((g) => String(g.id)));
    const members = (await rowsOf(orgA, 'bank_transactions')).filter((t) => t.recurring_group_id && ids.has(String(t.recurring_group_id)));
    expect(members).toHaveLength(14);
    // Transfer legs are never recurring "payments".
    expect((await txn(transferOut)).recurring_group_id ?? 'none').toBe('none');
  });

  it('appends one history row per change, from a rule, and none for rows it left alone', async () => {
    const open = await rowsOf(orgA, 'category_history', { valid_to: null });
    const bySource = new Map<string, number>();
    for (const h of open) bySource.set(String(h.source), (bySource.get(String(h.source)) ?? 0) + 1);
    const heads = [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}|${n}`);
    // History opens at creation (ADR-034): every row has one head. The pass moved 12 of the 22 to
    // `rule` — 7 wage runs, 4 transfer legs, and `ACME INVOICE 1001`, which the `invoice` inflow
    // keyword sends to revenue — and left the seeded decision (`user`) and the other 10 alone.
    expect(heads).toEqual(['none|10', 'rule|12', 'user|1']);
    // Never two open heads for one row.
    const perRow = new Map<string, number>();
    for (const h of open) perRow.set(String(h.bank_transaction_id), (perRow.get(String(h.bank_transaction_id)) ?? 0) + 1);
    expect([...perRow.values()].filter((n) => n > 1)).toHaveLength(0);
    expect((await auditsOf(orgA, 'banking.pass_applied')).length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: a second run is no_change and writes no history', async () => {
    const before = await historyCount(orgA);
    await runCalculation(orgA);
    expect(await latestRun(orgA)).toEqual({ status: 'succeeded', noChange: true });
    expect(await historyCount(orgA)).toBe(before);
  });

  it('never overrides a person, before or after they decide', async () => {
    const opex = await account(orgA, 'operating_expense');
    const decided = await txn(userDecided);
    expect(`${decided.category_account_id}|${decided.category_source}`).toBe(`${opex}|user`);
    // The owner moves a wage run to marketing by hand; the next run must leave it there.
    const marketing = await account(orgA, 'marketing');
    const moved = await api(ownerA).rpc('override_bank_category', { p_txn: wageIds[0], p_account: marketing });
    expect(moved.error).toBeNull();
    await runCalculation(orgA);
    const after = await txn(wageIds[0]!);
    expect(`${after.category_account_id}|${after.category_source}`).toBe(`${marketing}|user`);
    expect((await rowsOf(orgA, 'category_history', { bank_transaction_id: wageIds[0], valid_to: null })).map((h) => h.source)).toEqual(['user']);
  });
});

describe('api.bank_period_summary agrees with the engine and is fenced like everything else', () => {
  it('per-account money in and out sum to the engine’s cash_inflows and cash_outflows, to the penny', async () => {
    const { data, error } = await api(ownerA).rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(error).toBeNull();
    const summary = data as { accounts: Array<{ bank_account_id: string; inflow: string; outflow: string; transfers_in: string; transfers_out: string }>; source: string };
    expect(summary.source).toBe('imported_statements');
    const cashLike = summary.accounts.filter((a) => a.bank_account_id === current || a.bank_account_id === savings);
    const sumIn = cashLike.reduce((acc, a) => acc.plus(a.inflow), new Decimal(0));
    const sumOut = cashLike.reduce((acc, a) => acc.plus(a.outflow), new Decimal(0));
    expect(sumIn.toFixed(2)).toBe((await engine(orgA, august, 'cash_inflows')).toFixed(2));
    expect(sumOut.toFixed(2)).toBe((await engine(orgA, august, 'cash_outflows')).toFixed(2));
    // The sweep is reported as a transfer between own accounts, not as money in or out.
    const sav = summary.accounts.find((a) => a.bank_account_id === savings)!;
    expect(sav.transfers_in).toBe('1000.00');
  });

  it('reports where money went by category, third parties only, and the statements behind the month', async () => {
    const { data } = await api(ownerA).rpc('bank_period_summary', { p_org: orgA, p_period: august });
    const summary = data as { categories: Array<{ standard_category: string; outflow: string }>; statements: Array<{ bank_account_id: string; unreconciled: boolean; statement_closing_balance: string | null }>; latest_statement: { bank_account_id: string } };
    const byCat = Object.fromEntries(summary.categories.map((c) => [c.standard_category, c.outflow]));
    expect(byCat.payroll).toBe('2500.00');
    expect(byCat.transfer).toBeUndefined();
    expect(byCat.credit_card).toBeUndefined();
    const statements = Object.fromEntries(summary.statements.map((s) => [s.bank_account_id, s]));
    expect(statements[current]).toMatchObject({ unreconciled: false, statement_closing_balance: '8000.00' });
    expect(statements[savings]).toMatchObject({ unreconciled: true, statement_closing_balance: null });
    expect(summary.latest_statement.bank_account_id).toBe(savings);
  });

  it('a client may read it; another organisation’s owner and an unassigned employee are told not found', async () => {
    const asClient = await api(clientA).rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(asClient.error).toBeNull();
    const asAssigned = await api(empAssigned).rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(asAssigned.error).toBeNull();
    const asB = await api(ownerB).rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(sqlstate(asB.error)).toBe('P0002');
    const asOther = await api(empOther).rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(sqlstate(asOther.error)).toBe('P0002');
    // A period id from organisation B, with organisation A: not found, never B's month.
    const augustB = await periodFor(orgB, '2026-08-01');
    const crossed = await api(ownerA).rpc('bank_period_summary', { p_org: orgA, p_period: augustB });
    expect(sqlstate(crossed.error)).toBe('P0002');
  });

  it('the pass writer cannot be reached by a user session', async () => {
    const attempt = await rpc(clientFor(ownerA), 'apply_banking_pass', { p_org: orgA, p_run: null, p_plan: {} }, { server: true });
    expect(attempt.error).not.toBeNull();
  });
});

describe('currency is the organisation’s, never a literal', () => {
  it('every seeded row and account in the rupee organisation carries INR, and a new account inherits it', async () => {
    expect([...new Set((await rowsOf(orgA, 'bank_transactions')).map((t) => t.currency))]).toEqual(['INR']);
    const created = await api(ownerA).rpc('create_bank_account', {
      p_org: orgA, p_input: { name: 'Second current', bank_name: 'Other Bank', account_number_masked: '****9999', sort_code_masked: '**-**-02' },
    });
    expect(created.error).toBeNull();
    expect((await rowOf(orgA, 'bank_accounts', created.data as string))?.currency).toBe('INR');
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial: the AI tools, cross-organisation ids, roles, documents and exports (brief §16–20, §28)
// ---------------------------------------------------------------------------------------------

function contextFor(
  userId: string, role: 'owner' | 'client' | 'employee', org: string,
): AccessContext {
  return {
    userId, orgId: org, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: role === 'employee' ? 'employee' : 'user',
    db: clientFor(userId, { email: `${userId.slice(0, 6)}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-09-15T00:00:00Z'),
    organizationStatus: 'active',
  };
}

async function invoke(ctx: AccessContext, name: string, rawInput: unknown) {
  const periods = (await rowsOf(ctx.orgId!, 'fiscal_periods'))
    .sort((a, b) => String(a.period_start).localeCompare(String(b.period_start)))
    .map((p) => ({ id: String(p.id), label: String(p.label), periodStart: String(p.period_start), isComplete: p.is_complete === true, hasData: true })) as PeriodRow[];
  const periodContext = resolvePeriodContext({ question: 'how is our banking?', periods, fiscalYearStartMonth: 1 });
  return runTool({
    seq: 1, name, rawInput,
    resolveAccess: async () => ctx, started: snapshotAccess(ctx),
    call: { periodContext, knownPeriods: periods, now: new Date('2026-09-15T00:00:00Z') },
  });
}

describe('the banking tools read only through the services, only for the caller’s organisation', () => {
  it('an owner reads accounts, regular payments, unusual items and categories — all imported, none connected, all in rupees', async () => {
    const ctx = contextFor(ownerA, 'owner', orgA);
    const accounts = await invoke(ctx, 'get_bank_accounts', { period: 'Aug 2026' });
    expect(accounts.result.ok).toBe(true);
    const data = accounts.result.data as { source: string; connected: boolean; accounts: Array<{ account: { name: string }; money_in: { display: string } | null; currency: string }> };
    expect(data.source).toBe('imported_statements');
    expect(data.connected).toBe(false);
    // Names are wrapped as untrusted text (§9), so they are matched by content, not equality.
    for (const name of ['Main current', 'Savings pot', 'Company card']) {
      expect(data.accounts.some((a) => a.account.name.includes(name)), name).toBe(true);
    }
    const main = data.accounts.find((a) => a.account.name.includes('Main current'))!;
    expect(main.currency).toBe('INR');
    expect(main.money_in?.display).toContain('₹');
    expect(JSON.stringify(data)).not.toMatch(/"connected":true|live|synced/i);

    const recurring = await invoke(ctx, 'get_recurring_payments', {});
    expect(recurring.result.ok).toBe(true);
    const groups = (recurring.result.data as { recurring: Array<{ direction: string; cadence: string; usually: { display: string } }> }).recurring;
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.cadence)).toEqual(['every month', 'every month']);
    expect(groups.find((g) => g.direction === 'outflow')!.usually.display).toContain('2,500');

    const unusual = await invoke(ctx, 'get_unusual_transactions', { period: 'Aug 2026' });
    expect(unusual.result.ok).toBe(true);
    expect((unusual.result.data as { connected: boolean }).connected).toBe(false);

    const categories = await invoke(ctx, 'get_bank_categories', { period: 'Aug 2026' });
    expect(categories.result.ok).toBe(true);
    const cats = (categories.result.data as { categories: Array<{ category: string; money_out: { display: string } }> }).categories;
    expect(cats.find((c) => c.category === 'payroll')!.money_out.display).toContain('2,500');
    expect(cats.some((c) => c.category === 'transfer' || c.category === 'credit_card')).toBe(false);
  });

  it('a client and an assigned employee may read them; the tools carry no organisation input', async () => {
    const asClient = await invoke(contextFor(clientA, 'client', orgA), 'get_bank_accounts', { period: 'Aug 2026' });
    expect(asClient.result.ok).toBe(true);
    expect(asClient.persisted.authorized).toBe(true);
    const asEmployee = await invoke(contextFor(empAssigned, 'employee', orgA), 'get_recurring_payments', {});
    expect(asEmployee.result.ok).toBe(true);
    // A caller who smuggles another organisation into the input gets nothing for it: the input
    // schema has no such field, and the organisation is the session's.
    const smuggled = await invoke(contextFor(ownerB, 'owner', orgB), 'get_bank_accounts', { period: 'Aug 2026', organization_id: orgA, bank_account_id: current });
    if (smuggled.result.ok) {
      const names = (smuggled.result.data as { accounts: Array<{ account: { name: string } }> }).accounts.map((a) => a.account.name);
      expect(names).toHaveLength(1);
      expect(names[0]).toContain('B current');
      expect(names.join(' ')).not.toContain('Main current');
    } else {
      expect(['NO_DATA', 'VALIDATION', 'INVALID_INPUT']).toContain((smuggled.result.data as { code: string }).code);
    }
  });

  it('another organisation’s owner, resolved against A, reads nothing of A', async () => {
    const crossed = await invoke(contextFor(ownerB, 'owner', orgA), 'get_bank_accounts', { period: 'Aug 2026' });
    if (crossed.result.ok) {
      expect((crossed.result.data as { accounts: unknown[] }).accounts).toEqual([]);
    } else {
      expect(['NO_DATA', 'NOT_FOUND', 'PERMISSION_DENIED']).toContain((crossed.result.data as { code: string }).code);
    }
  });
});

describe('cross-organisation ids fail safely on every banking write', () => {
  it('B’s owner cannot categorise, pair or un-pair A’s transactions', async () => {
    const b = api(ownerB);
    const cat = await b.rpc('override_bank_category', { p_txn: wageIds[2], p_account: await account(orgA, 'marketing') });
    expect(sqlstate(cat.error)).toBe('P0002');
    const pair = await b.rpc('mark_transfer', { p_txn: wageIds[2], p_pair: wageIds[3] });
    expect(sqlstate(pair.error)).toBe('P0002');
    const unpair = await b.rpc('mark_transfer', { p_txn: transferOut, p_pair: null });
    expect(sqlstate(unpair.error)).toBe('P0002');
    expect((await txn(transferOut)).is_transfer).toBe(true);
  });

  it('A’s owner cannot pair one of their rows with a row from B, and an unassigned employee can touch neither', async () => {
    const bRow = String((await rowsOf(orgB, 'bank_transactions'))[0]!.id);
    const crossPair = await api(ownerA).rpc('mark_transfer', { p_txn: wageIds[2], p_pair: bRow });
    expect(sqlstate(crossPair.error)).toBe('P0002');
    const other = api(empOther);
    expect(sqlstate((await other.rpc('override_bank_category', { p_txn: wageIds[2], p_account: await account(orgA, 'marketing') })).error)).toBe('P0002');
    expect(sqlstate((await other.rpc('create_bank_account', { p_org: orgA, p_input: { name: 'X', bank_name: 'Y' } })).error)).toBeDefined();
  });

  it('a client may look but not touch: no categorising, no pairing, no new accounts, no export, no file', async () => {
    const c = api(clientA);
    const cat = await c.rpc('override_bank_category', { p_txn: wageIds[2], p_account: await account(orgA, 'marketing') });
    expect(cat.error).not.toBeNull();
    const pair = await c.rpc('mark_transfer', { p_txn: wageIds[2], p_pair: wageIds[3] });
    expect(pair.error).not.toBeNull();
    const created = await c.rpc('create_bank_account', { p_org: orgA, p_input: { name: 'Sneaky', bank_name: 'Bank' } });
    expect(created.error).not.toBeNull();
    expect((await txn(wageIds[2]!)).category_source).toBe('rule');

    const ctx = contextFor(clientA, 'client', orgA);
    let denied: unknown = null;
    try { for await (const _chunk of exportCsv(ctx, 'bank_transactions')) { void _chunk; } } catch (e) { denied = e; }
    expect(isMotionError(denied) && denied.code === 'PERMISSION_DENIED').toBe(true);

    const provenance = await getRecordProvenance(ctx, 'bank', wageIds[2]!);
    expect(provenance.recordId).toBe(wageIds[2]);
    expect(provenance.document?.filename ?? null).toBeNull();
  });

  it('a transaction id from A is not found for B’s owner, in provenance and in the transaction page’s loader', async () => {
    await expect(getRecordProvenance(contextFor(ownerB, 'owner', orgB), 'bank', wageIds[2]!)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await orgRows(clientFor(ownerB), orgA, 'bank_transactions', (q) => q.where('id', '==', wageIds[2]))).toEqual([]);
  });

  it('an owner’s export carries masked descriptions only, in the organisation’s currency', async () => {
    let csv = '';
    for await (const chunk of exportCsv(contextFor(ownerA, 'owner', orgA), 'bank_transactions')) csv += chunk;
    expect(csv).toContain('PAYROLL ACME LTD');
    expect(csv).toContain('INR');
    expect(csv).not.toMatch(/description_raw/);
  });
});
