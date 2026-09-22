import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isMotionError } from '@/core/errors';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { runTool, snapshotAccess, resolvePeriodContext, type PeriodRow } from '@/modules/ai';
import { getRecordProvenance } from '@/modules/evidence';
import { exportCsv } from '@/modules/exports';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished, sqlstate } from './setup';

/**
 * Phase 13 — Banking Intelligence (ADR-101).
 *
 * The banking pass ran for the first time in Phase 13: the rules existed since Phase 6, nothing
 * applied them. This suite proves, against the real database and the real calculation job:
 *
 *   * the pass categorises, pairs and groups what the rules say it should — and writes ONLY that;
 *   * it is idempotent: a second run over unchanged rows is `no_change` and writes no history;
 *   * a person's decision survives every later run;
 *   * `api.bank_period_summary` agrees with the engine's own cash figures to the penny, and is
 *     fenced by organisation and by permission like everything else;
 *   * currency is the organisation's, never a literal.
 */

const RUN = `b${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.banking.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const rows = (sql: string): string[] => adminSql(sql).split('\n').map((l) => l.trim()).filter(Boolean);

let ownerA: string; let ownerB: string; let clientA: string; let empAssigned: string; let empOther: string;
let orgA: string; let orgB: string;
let current: string; let savings: string; let card: string; let currentB: string;
let august: string;
const wageIds: string[] = [];
let userDecided: string;
let transferOut: string; let transferIn: string; let cardOut: string; let cardIn: string;

function account(org: string, category: string): string {
  return one(`select id from public.accounts where organization_id = '${org}' and standard_category = '${category}' and is_system`);
}

function bankAccount(org: string, name: string, type: string, last4: string): string {
  return one(`
    insert into public.bank_accounts (organization_id, name, bank_name, sort_code_masked, account_number_masked, account_type, currency, opening_balance, opening_balance_date)
    values ('${org}', '${name}', 'Test Bank', '**-**-01', '****${last4}', '${type}', (select base_currency from public.organizations where id = '${org}'), 10000, '2026-02-01')
    returning id`);
}

function post(org: string, acct: string, date: string, amount: string, description: string, extra = ''): string {
  return one(`
    insert into public.bank_transactions
           (organization_id, bank_account_id, transaction_date, amount, period_id, currency,
            description_raw, description_normalized, record_status, assurance_level ${extra ? ', ' + extra.split('=')[0] : ''})
    values ('${org}', '${acct}', '${date}', ${amount}, '00000000-0000-0000-0000-000000000000',
            (select base_currency from public.organizations where id = '${org}'),
            '${description}', '${description}', 'accepted', 'verified' ${extra ? ', ' + extra.split('=')[1] : ''})
    returning id`);
}

/**
 * `recalc_manual` is the one trigger that never short-circuits on an equal fingerprint (§2.4), so
 * the runs here are `banking_edit` from the earliest month — the same range as a full run, and the
 * trigger a real categorisation would raise — which lets the idempotence test see `no_change`.
 */
async function runCalculation(org: string, asOf = '2026-09-15'): Promise<string> {
  const earliest = one(`select id from public.fiscal_periods where organization_id = '${org}' order by period_start limit 1`);
  const jobId = adminSql(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${org}', 'calculation.run', '{"trigger":"banking_edit","period_ids":["${earliest}"],"as_of":"${asOf}"}'::jsonb, 3)
    returning id`).split('\n')[0]!.trim();
  const status = await drainUntilFinished(drainJobs, jobId);
  expect(status, 'the calculation job must succeed').toBe('succeeded');
  return jobId;
}

function latestRun(org: string): { status: string; noChange: boolean } {
  const line = one(`
    select r.status::text || '|' || coalesce(r.stats ->> 'no_change', 'false')
      from public.calculation_runs r where r.organization_id = '${org}'
     order by r.started_at desc, r.created_at desc limit 1`);
  const [status, noChange] = line.split('|');
  return { status: status!, noChange: noChange === 'true' };
}

function historyCount(org: string): number {
  return Number(one(`select count(*) from public.category_history where organization_id = '${org}'`));
}

beforeAll(async () => {
  ownerA = createAuthUser(`owner-a@${DOMAIN}`);
  ownerB = createAuthUser(`owner-b@${DOMAIN}`);
  clientA = createAuthUser(`client-a@${DOMAIN}`);
  empAssigned = createAuthUser(`emp-assigned@${DOMAIN}`);
  empOther = createAuthUser(`emp-other@${DOMAIN}`);
  adminSql(`
    insert into public.platform_users (user_id, platform_role, status)
    values ('${empAssigned}', 'employee', 'active'), ('${empOther}', 'employee', 'active')`);

  // Organisation A reports in rupees: nothing about banking may assume pounds.
  const a = await clientFor(ownerA).schema('api').rpc('create_organization', { p_name: `ITest Bank A ${RUN}`, p_base_currency: 'INR', p_country_code: 'IN', p_timezone: 'Asia/Kolkata' });
  if (a.error) throw new Error(`org A: ${a.error.message}`);
  orgA = a.data as unknown as string;
  const b = await clientFor(ownerB).schema('api').rpc('create_organization', { p_name: `ITest Bank B ${RUN}` });
  if (b.error) throw new Error(`org B: ${b.error.message}`);
  orgB = b.data as unknown as string;
  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgA}', '${clientA}', 'client', 'active');
    insert into public.organization_assignments (organization_id, employee_user_id, status)
    values ('${orgA}', '${empAssigned}', 'active');`);

  current = bankAccount(orgA, 'Main current', 'current', '1111');
  savings = bankAccount(orgA, 'Savings pot', 'savings', '2222');
  card = bankAccount(orgA, 'Company card', 'credit_card', '3333');
  currentB = bankAccount(orgB, 'B current', 'current', '4444');

  // Seven months of the same wage run and the same customer receipt (Feb–Aug 2026).
  for (const month of ['02', '03', '04', '05', '06', '07', '08']) {
    wageIds.push(post(orgA, current, `2026-${month}-28`, '-2500.00', 'PAYROLL ACME LTD'));
    post(orgA, current, `2026-${month}-05`, '9000.00', 'FPS CREDIT NORTHWIND');
  }
  // A wage run somebody has already decided about: it goes to operating expenses, and stays there.
  userDecided = post(orgA, current, '2026-08-29', '-2500.00', 'PAYROLL ACME LTD BONUS',
    `category_account_id, category_source='${account(orgA, 'operating_expense')}', 'user'`);
  // A sweep to savings with transfer wording on both legs, and a card repayment.
  transferOut = post(orgA, current, '2026-08-10', '-1000.00', 'TRANSFER TO SAVINGS');
  transferIn = post(orgA, savings, '2026-08-10', '1000.00', 'TRANSFER FROM CURRENT');
  cardOut = post(orgA, current, '2026-08-15', '-420.00', 'CARD PAYMENT TO COMPANY CARD');
  cardIn = post(orgA, card, '2026-08-16', '420.00', 'PAYMENT RECEIVED THANK YOU TRANSFER');
  // Card purchases (the expenses), a one-off, and a same-amount pair with NO transfer wording.
  post(orgA, card, '2026-08-03', '-120.00', 'AMAZON MARKETPLACE');
  post(orgA, current, '2026-08-20', '-89.99', 'SOME SHOP 1234');
  post(orgA, current, '2026-08-11', '4800.00', 'ACME INVOICE 1001');
  post(orgA, savings, '2026-08-12', '-4800.00', 'BETA SUPPLIES');
  // Organisation B: one month, one row, so it has figures of its own to NOT leak.
  post(orgB, currentB, '2026-08-07', '-300.00', 'PAYROLL B LTD');

  august = one(`select id from public.fiscal_periods where organization_id = '${orgA}' and period_start = '2026-08-01'`);

  // Statements covering August: the current account's reconciled, the savings one without balances.
  const doc = one(`
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgA}', '${orgA}/bank/aug.csv', 'aug-statement.csv', 'text/csv', 10, decode('a1','hex'), 'ready', 'bank_statement') returning id`);
  adminSql(`
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, bank_account_id, status, extraction_method, period_start, period_end, committed_at, statement_opening_balance, statement_closing_balance, batch_issues)
    values ('${orgA}', '${doc}', 'bank_statement', 'bank_transactions', '${current}', 'committed', 'csv', '2026-08-01', '2026-08-31', now() - interval '2 days', 10000.00, 8000.00, '[]'::jsonb),
           ('${orgA}', '${doc}', 'bank_statement', 'bank_transactions', '${savings}', 'committed', 'csv', '2026-08-01', '2026-08-31', now() - interval '1 day', null, null,
            '[{"code":"IMP-BAL-007","severity":"warning","message":"Statement balances could not be captured"}]'::jsonb)`);

  await runCalculation(orgA);
  await runCalculation(orgB);
}, 240_000);

afterAll(() => {
  adminSql(`
    delete from public.organizations where id in ('${orgA}', '${orgB}');
    delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('the banking pass runs inside the calculation and writes what the rules say', () => {
  it('categorises every keyword match by rule, and nothing else', () => {
    const payroll = account(orgA, 'payroll');
    const got = rows(`
      select category_account_id::text || '|' || category_source::text
        from public.bank_transactions where organization_id = '${orgA}' and id in (${wageIds.map((id) => `'${id}'`).join(',')})`);
    expect(got).toHaveLength(7);
    expect(new Set(got)).toEqual(new Set([`${payroll}|rule`]));
    // The customer receipt matches no keyword and stays uncategorised — never guessed as revenue.
    const northwind = rows(`
      select coalesce(category_account_id::text, 'null') || '|' || category_source::text
        from public.bank_transactions where organization_id = '${orgA}' and description_normalized = 'FPS CREDIT NORTHWIND'`);
    expect(new Set(northwind)).toEqual(new Set(['null|none']));
  });

  it('pairs the sweep as a cash transfer and the card payment as a repayment, deriving the kind in SQL', () => {
    const leg = (id: string) => one(`
      select is_transfer::text || '|' || transfer_kind::text || '|' || coalesce(transfer_pair_id::text, '') || '|' || coalesce(category_account_id::text, '') || '|' || category_source::text
        from public.bank_transactions where id = '${id}'`);
    expect(leg(transferOut)).toBe(`true|cash_transfer|${transferIn}|${account(orgA, 'transfer')}|rule`);
    expect(leg(transferIn)).toBe(`true|cash_transfer|${transferOut}|${account(orgA, 'transfer')}|rule`);
    expect(leg(cardOut)).toBe(`true|card_repayment|${cardIn}|${account(orgA, 'credit_card')}|rule`);
    expect(leg(cardIn)).toBe(`true|card_repayment|${cardOut}|${account(orgA, 'credit_card')}|rule`);
  });

  it('does not pair a same-amount receipt and payment that carry no transfer wording', () => {
    const got = rows(`
      select is_transfer::text from public.bank_transactions
       where organization_id = '${orgA}' and description_normalized in ('ACME INVOICE 1001', 'BETA SUPPLIES')`);
    expect(got).toEqual(['false', 'false']);
  });

  it('writes the recurring groups and points their members at them', () => {
    const groups = rows(`
      select direction::text || '|' || cadence::text || '|' || occurrence_count || '|' || status::text || '|' || expected_amount
        from public.recurring_payment_groups where organization_id = '${orgA}' order by direction`);
    expect(groups).toEqual(['inflow|monthly|7|active|9000.00', 'outflow|monthly|7|active|2500.00']);
    const members = Number(one(`
      select count(*) from public.bank_transactions t
        join public.recurring_payment_groups g on g.organization_id = t.organization_id and g.id = t.recurring_group_id
       where t.organization_id = '${orgA}'`));
    expect(members).toBe(14);
    // Transfer legs are never recurring "payments".
    expect(one(`select coalesce(recurring_group_id::text, 'none') from public.bank_transactions where id = '${transferOut}'`)).toBe('none');
  });

  it('appends one history row per change, from a rule, and none for rows it left alone', () => {
    const heads = rows(`
      select source::text || '|' || count(*) from public.category_history
       where organization_id = '${orgA}' and valid_to is null group by source order by source::text`);
    // History opens at creation (ADR-034): every row has one head. The pass moved 12 of the 22 to
    // `rule` — 7 wage runs, 4 transfer legs, and `ACME INVOICE 1001`, which the `invoice` inflow
    // keyword sends to revenue — and left the seeded decision (`user`) and the other 10 alone.
    expect(heads).toEqual(['none|10', 'rule|12', 'user|1']);
    // Never two open heads for one row.
    expect(one(`
      select count(*) from (select bank_transaction_id from public.category_history
        where organization_id = '${orgA}' and valid_to is null group by 1 having count(*) > 1) d`)).toBe('0');
    expect(Number(one(`select count(*) from public.audit_events where organization_id = '${orgA}' and action = 'banking.pass_applied'`))).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: a second run is no_change and writes no history', async () => {
    const before = historyCount(orgA);
    await runCalculation(orgA);
    expect(latestRun(orgA)).toEqual({ status: 'succeeded', noChange: true });
    expect(historyCount(orgA)).toBe(before);
  });

  it('never overrides a person, before or after they decide', async () => {
    const opex = account(orgA, 'operating_expense');
    expect(one(`select category_account_id::text || '|' || category_source::text from public.bank_transactions where id = '${userDecided}'`)).toBe(`${opex}|user`);
    // The owner moves a wage run to marketing by hand; the next run must leave it there.
    const marketing = account(orgA, 'marketing');
    const moved = await clientFor(ownerA).schema('api').rpc('override_bank_category', { p_txn: wageIds[0], p_account: marketing });
    expect(moved.error).toBeNull();
    await runCalculation(orgA);
    expect(one(`select category_account_id::text || '|' || category_source::text from public.bank_transactions where id = '${wageIds[0]}'`)).toBe(`${marketing}|user`);
    expect(one(`select source::text from public.category_history where bank_transaction_id = '${wageIds[0]}' and valid_to is null`)).toBe('user');
  });
});

describe('api.bank_period_summary agrees with the engine and is fenced like everything else', () => {
  it('per-account money in and out sum to the engine’s cash_inflows and cash_outflows, to the penny', async () => {
    const { data, error } = await clientFor(ownerA).schema('api').rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(error).toBeNull();
    const summary = data as { accounts: Array<{ bank_account_id: string; inflow: string; outflow: string; transfers_in: string; transfers_out: string }>; source: string };
    expect(summary.source).toBe('imported_statements');
    const cashLike = summary.accounts.filter((a) => a.bank_account_id === current || a.bank_account_id === savings);
    const sumIn = cashLike.reduce((acc, a) => acc.plus(a.inflow), new Decimal(0));
    const sumOut = cashLike.reduce((acc, a) => acc.plus(a.outflow), new Decimal(0));
    const engine = (key: string) => one(`
      select s.value::text from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
       where c.organization_id = '${orgA}' and c.period_id = '${august}' and c.metric_key = '${key}' and c.dimension_type = 'none'`);
    expect(sumIn.toFixed(2)).toBe(new Decimal(engine('cash_inflows')).toFixed(2));
    expect(sumOut.toFixed(2)).toBe(new Decimal(engine('cash_outflows')).toFixed(2));
    // The sweep is reported as a transfer between own accounts, not as money in or out.
    const sav = summary.accounts.find((a) => a.bank_account_id === savings)!;
    expect(sav.transfers_in).toBe('1000.00');
  });

  it('reports where money went by category, third parties only, and the statements behind the month', async () => {
    const { data } = await clientFor(ownerA).schema('api').rpc('bank_period_summary', { p_org: orgA, p_period: august });
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
    const asClient = await clientFor(clientA).schema('api').rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(asClient.error).toBeNull();
    const asAssigned = await clientFor(empAssigned, { aal: 'aal2' }).schema('api').rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(asAssigned.error).toBeNull();
    const asB = await clientFor(ownerB).schema('api').rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(sqlstate(asB.error)).toBe('P0002');
    const asOther = await clientFor(empOther, { aal: 'aal2' }).schema('api').rpc('bank_period_summary', { p_org: orgA, p_period: august });
    expect(sqlstate(asOther.error)).toBe('P0002');
    // A period id from organisation B, with organisation A: not found, never B's month.
    const augustB = one(`select id from public.fiscal_periods where organization_id = '${orgB}' and period_start = '2026-08-01'`);
    const crossed = await clientFor(ownerA).schema('api').rpc('bank_period_summary', { p_org: orgA, p_period: augustB });
    expect(sqlstate(crossed.error)).toBe('P0002');
  });

  it('the pass writer cannot be reached by a user session', async () => {
    const attempt = await clientFor(ownerA).schema('api_server').rpc('apply_banking_pass', { p_org: orgA, p_run: null, p_plan: {} });
    expect(attempt.error).not.toBeNull();
  });
});

describe('currency is the organisation’s, never a literal', () => {
  it('every seeded row and account in the rupee organisation carries INR, and a new account inherits it', async () => {
    expect(rows(`select distinct currency from public.bank_transactions where organization_id = '${orgA}'`)).toEqual(['INR']);
    const created = await clientFor(ownerA).schema('api').rpc('create_bank_account', {
      p_org: orgA, p_input: { name: 'Second current', bank_name: 'Other Bank', account_number_masked: '****9999', sort_code_masked: '**-**-02' },
    });
    expect(created.error).toBeNull();
    expect(one(`select currency from public.bank_accounts where id = '${created.data as string}'`)).toBe('INR');
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial: the AI tools, cross-organisation ids, roles, documents and exports (brief §16–20, §28)
// ---------------------------------------------------------------------------------------------

function contextFor(
  userId: string, role: 'owner' | 'client' | 'employee', org: string, aal: 'aal1' | 'aal2' = 'aal1',
): AccessContext {
  return {
    userId, orgId: org, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: role === 'employee' ? 'employee' : 'user',
    db: clientFor(userId, { email: `${userId.slice(0, 6)}@${DOMAIN}`, aal }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-09-15T00:00:00Z'),
    organizationStatus: 'active',
  };
}

async function invoke(ctx: AccessContext, name: string, rawInput: unknown) {
  const periods = adminSql(`
    select id || '|' || label || '|' || period_start || '|' || is_complete
      from public.fiscal_periods where organization_id = '${ctx.orgId}' order by period_start`)
    .split('\n').filter(Boolean).map((line) => {
      const [id, label, periodStart, complete] = line.trim().split('|') as [string, string, string, string];
      return { id, label, periodStart, isComplete: complete === 'true' || complete === 't', hasData: true };
    }) as PeriodRow[];
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
    const asEmployee = await invoke(contextFor(empAssigned, 'employee', orgA, 'aal2'), 'get_recurring_payments', {});
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
    const b = clientFor(ownerB);
    const cat = await b.schema('api').rpc('override_bank_category', { p_txn: wageIds[2], p_account: account(orgA, 'marketing') });
    expect(sqlstate(cat.error)).toBe('P0002');
    const pair = await b.schema('api').rpc('mark_transfer', { p_txn: wageIds[2], p_pair: wageIds[3] });
    expect(sqlstate(pair.error)).toBe('P0002');
    const unpair = await b.schema('api').rpc('mark_transfer', { p_txn: transferOut, p_pair: null });
    expect(sqlstate(unpair.error)).toBe('P0002');
    expect(one(`select is_transfer::text from public.bank_transactions where id = '${transferOut}'`)).toBe('true');
  });

  it('A’s owner cannot pair one of their rows with a row from B, and an unassigned employee can touch neither', async () => {
    const bRow = one(`select id from public.bank_transactions where organization_id = '${orgB}' limit 1`);
    const crossPair = await clientFor(ownerA).schema('api').rpc('mark_transfer', { p_txn: wageIds[2], p_pair: bRow });
    expect(sqlstate(crossPair.error)).toBe('P0002');
    const other = clientFor(empOther, { aal: 'aal2' });
    expect(sqlstate((await other.schema('api').rpc('override_bank_category', { p_txn: wageIds[2], p_account: account(orgA, 'marketing') })).error)).toBe('P0002');
    expect(sqlstate((await other.schema('api').rpc('create_bank_account', { p_org: orgA, p_input: { name: 'X', bank_name: 'Y' } })).error)).toBeDefined();
  });

  it('a client may look but not touch: no categorising, no pairing, no new accounts, no export, no file', async () => {
    const c = clientFor(clientA);
    const cat = await c.schema('api').rpc('override_bank_category', { p_txn: wageIds[2], p_account: account(orgA, 'marketing') });
    expect(cat.error).not.toBeNull();
    const pair = await c.schema('api').rpc('mark_transfer', { p_txn: wageIds[2], p_pair: wageIds[3] });
    expect(pair.error).not.toBeNull();
    const created = await c.schema('api').rpc('create_bank_account', { p_org: orgA, p_input: { name: 'Sneaky', bank_name: 'Bank' } });
    expect(created.error).not.toBeNull();
    expect(one(`select category_source::text from public.bank_transactions where id = '${wageIds[2]}'`)).toBe('rule');

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
    const { data } = await clientFor(ownerB).from('bank_transactions').select('id').eq('id', wageIds[2]);
    expect(data).toEqual([]);
  });

  it('an owner’s export carries masked descriptions only, in the organisation’s currency', async () => {
    let csv = '';
    for await (const chunk of exportCsv(contextFor(ownerA, 'owner', orgA), 'bank_transactions')) csv += chunk;
    expect(csv).toContain('PAYROLL ACME LTD');
    expect(csv).toContain('INR');
    expect(csv).not.toMatch(/description_raw/);
  });
});
