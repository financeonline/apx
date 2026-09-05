import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  composePeriod, computeCoverage, computeFingerprint, ENGINE_VERSION,
  type AggregateCell, type EngineContext, type PeriodRef,
} from '@/modules/financial-engine';
import { adminSql, clientFor, createAuthUser, resetFixtures } from './setup';

/**
 * The engine end to end (FINANCIAL_ENGINE.md §1–§4): real records, through the SQL aggregation, the
 * composition and the metric modules, to figures.
 *
 * The guarantee under test is §1.1's: the same accepted records and the same engine version must
 * produce the same numbers, every time. And §1.5's: a figure that cannot be computed is NULL with a
 * reason, never zero.
 */

let ownerId: string;
let orgId: string;
let mayPeriod: PeriodRef;
let accounts: EngineContext['accounts'];

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function accountId(category: string): string {
  return one(`
    select id from public.accounts
     where organization_id = '${orgId}' and standard_category = '${category}' and is_system`);
}

/** Reads the aggregate exactly as the engine's repository does. */
function loadAggregate(from: string, to: string): AggregateCell[] {
  const raw = adminSql(`
    select coalesce(json_agg(json_build_object(
             'period_id', a.period_id, 'source', a.source,
             'standard_category', a.standard_category, 'account_id', a.account_id,
             'counterparty_id', a.counterparty_id, 'bank_account_id', a.bank_account_id,
             'balance_kind', a.balance_kind, 'balance_basis', a.balance_basis,
             'invoice_type', a.invoice_type, 'transfer_kind', a.transfer_kind,
             'unpaired_transfer', a.unpaired_transfer,
             -- Cast to text: JSON renders numeric unquoted and would drop the trailing zeros that
             -- make 20000.00 a money value rather than a float (ADR-006).
             'debit', a.debit::text, 'credit', a.credit::text, 'amount', a.amount::text,
             'row_count', a.row_count, 'min_date', a.min_date, 'max_date', a.max_date)
             order by a.source::text, a.standard_category::text), '[]')::text
      from app.aggregate_periods('${orgId}', '${from}', '${to}') a`);

  return (JSON.parse(raw) as Record<string, unknown>[]).map((r) => ({
    periodId: r.period_id as string,
    source: r.source as AggregateCell['source'],
    standardCategory: r.standard_category as AggregateCell['standardCategory'],
    accountId: r.account_id as string | null,
    counterpartyId: r.counterparty_id as string | null,
    bankAccountId: r.bank_account_id as string | null,
    balanceKind: r.balance_kind as AggregateCell['balanceKind'],
    balanceBasis: r.balance_basis as AggregateCell['balanceBasis'],
    invoiceType: r.invoice_type as string | null,
    transferKind: (r.transfer_kind as string | null) ?? null,
    unpairedTransferCandidate: r.unpaired_transfer === true,
    debit: String(r.debit ?? '0'),
    credit: String(r.credit ?? '0'),
    amount: String(r.amount ?? '0'),
    rowCount: Number(r.row_count ?? 0),
    minDate: r.min_date as string | null,
    maxDate: r.max_date as string | null,
  }));
}

beforeAll(async () => {
  resetFixtures();
  ownerId = createAuthUser('e2e-engine@itest.motion');
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: 'ITest Engine E2E',
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  const periodRow = adminSql(`
    select id || '|' || period_start::text || '|' || period_end::text || '|' || label
      from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '2026-05-01'`);
  const [id, periodStart, periodEnd, label] = periodRow.split('|') as [string, string, string, string];
  mayPeriod = {
    id, periodStart, periodEnd, fiscalYear: 2026, fiscalQuarter: 2, label, isComplete: false,
  };

  const raw = adminSql(`
    select coalesce(json_agg(json_build_object(
      'id', id, 'code', code, 'name', name,
      'standardCategory', standard_category, 'accountType', account_type, 'isSystem', is_system)), '[]')::text
      from public.accounts where organization_id = '${orgId}'`);
  accounts = JSON.parse(raw) as EngineContext['accounts'];

  // A month of trading: revenue 20,000; cost of sales 6,000; payroll 5,000; marketing 1,000.
  const post = (category: string, direction: string, amount: string, day: string) => adminSql(`
    insert into public.ledger_entries
           (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
    values ('${orgId}', '2026-05-${day}', '${accountId(category)}', '${direction}', ${amount},
            '00000000-0000-0000-0000-000000000000', 'accepted')`);

  post('revenue', 'credit', '20000.00', '10');
  post('cost_of_sales', 'debit', '6000.00', '12');
  post('payroll', 'debit', '5000.00', '25');
  post('marketing', 'debit', '1000.00', '20');

  // A general ledger batch declaring the whole month, so the period is covered (§2.2).
  const doc = one(`
    insert into public.source_documents
           (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgId}', '${orgId}/e2e/gl.csv', 'gl.csv', 'text/csv', 10, decode('e5','hex'),
            'ready', 'general_ledger')
    returning id`);
  adminSql(`
    insert into public.import_batches
           (organization_id, source_document_id, import_type, target_table, status,
            extraction_method, period_start, period_end, committed_at)
    values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committed',
            'csv', '2026-05-01', '2026-05-31', now())`);
});

afterAll(() => resetFixtures());

function contextFor(): EngineContext {
  return {
    organizationId: orgId,
    calculationRunId: 'run-e2e',
    aggregatedAt: '2026-06-01T00:00:00.000Z',
    asOf: '2026-06-15',
    engineVersion: ENGINE_VERSION,
    settings: {
      baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London',
      vatRegistered: false, defaultVatRate: null,
      taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
    },
    accounts,
    counterparties: [],
    bankAccounts: [],
    periods: [mayPeriod],
  };
}

function computeMay() {
  const cells = loadAggregate('2026-05-01', '2026-05-31');
  const rowCounts: Record<string, number> = {};
  for (const cell of cells) {
    if (cell.periodId !== mayPeriod.id) continue;
    rowCounts[cell.source] = (rowCounts[cell.source] ?? 0) + cell.rowCount;
  }
  const coverage = computeCoverage({
    period: mayPeriod,
    batches: [{
      id: 'b1', targetTable: 'ledger_entries', balanceKind: null, balanceBasis: null,
      bankAccountId: null, invoiceListKind: null,
      periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-01T00:00:00Z',
    }],
    bankAccounts: [], rowCounts, asOf: '2026-06-15',
  });

  return composePeriod({
    period: mayPeriod, coverage, cells, transferLegs: [], context: contextFor(),
  });
}

const valueOf = (results: ReturnType<typeof computeMay>, key: string): string | null =>
  results.find((r) => r.key === key && r.dimensionType === 'none')?.value ?? null;

describe('a month of real ledger entries becomes figures', () => {
  it('computes the P&L from the ledger, in the right signs', () => {
    const results = computeMay();

    // The account-type rule: revenue is a credit balance and reads positive (§3).
    expect(valueOf(results, 'revenue')).toBe('20000.00');
    expect(valueOf(results, 'cost_of_sales')).toBe('6000.00');
    expect(valueOf(results, 'gross_profit')).toBe('14000.00');
    // Payroll 5,000 + marketing 1,000.
    expect(valueOf(results, 'operating_expenses')).toBe('6000.00');
    expect(valueOf(results, 'operating_profit')).toBe('8000.00');
    expect(valueOf(results, 'net_profit')).toBe('8000.00');
  });

  it('records the basis and the assurance the source earns', () => {
    const revenue = computeMay().find((r) => r.key === 'revenue');
    expect(revenue?.basis).toBe('ledger');
    // A ledger aggregate is calculated, not verified: it is a sum, not a stated balance.
    expect(revenue?.assurance).toBe('calculated');
  });

  it('states the margins as ratios, not percentages', () => {
    const results = computeMay();
    // 14,000 / 20,000.
    expect(valueOf(results, 'gross_margin')).toBe('0.700000');
    expect(valueOf(results, 'net_margin')).toBe('0.400000');
  });

  it('carries components so a reader can redo the arithmetic (§1.7)', () => {
    const grossProfit = computeMay().find((r) => r.key === 'gross_profit');
    expect(grossProfit?.components).toHaveProperty('revenue');
    expect(grossProfit?.components).toHaveProperty('cost_of_sales');
  });

  it('carries an evidence descriptor naming account ids, never a category (ADR-034)', () => {
    const revenue = computeMay().find((r) => r.key === 'revenue');
    expect(revenue?.evidenceQuery?.kind).toBe('leaf');

    const descriptor = revenue?.evidenceQuery?.kind === 'leaf'
      ? revenue.evidenceQuery.descriptor : null;
    expect(descriptor?.table).toBe('ledger_entries');
    // A category is a mutable property of an account; storing one would make old evidence follow a
    // later remap.
    expect(descriptor?.filters.account_ids?.length).toBeGreaterThan(0);
    expect(JSON.stringify(descriptor)).not.toContain('standard_categories');
    expect(descriptor?.filters.account_ids).toContain(accountId('revenue'));
  });

  it('points a derived metric at the snapshots it came from', () => {
    const operatingProfit = computeMay().find((r) => r.key === 'operating_profit');
    expect(operatingProfit?.evidenceQuery?.kind).toBe('derived');
  });
});

describe('determinism (§1.1)', () => {
  it('produces byte-identical results from the same records', () => {
    const first = JSON.stringify(computeMay());
    const second = JSON.stringify(computeMay());
    expect(second).toBe(first);
  });

  it('produces the same fingerprint from the same metadata', () => {
    const inputs = {
      organizationId: orgId, engineVersion: ENGINE_VERSION,
      periodFrom: mayPeriod.id, periodTo: mayPeriod.id,
      maxRecordEventAt: null, rowCounts: { ledger_entries: 4 },
      accountCategories: Object.fromEntries(accounts.map((a) => [a.id, a.standardCategory])),
      categoryHistoryHeads: {}, counterpartyMerges: {},
      settings: { baseCurrency: 'GBP' }, detectorVersion: 'recurring.v1', asOfDate: null,
    };
    expect(computeFingerprint(inputs)).toBe(computeFingerprint(inputs));
  });

  it('is unaffected by the order the aggregate arrives in', () => {
    const cells = loadAggregate('2026-05-01', '2026-05-31');
    const coverage = computeCoverage({
      period: mayPeriod,
      batches: [{
        id: 'b1', targetTable: 'ledger_entries', balanceKind: null, balanceBasis: null,
        bankAccountId: null, invoiceListKind: null,
        periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-01T00:00:00Z',
      }],
      bankAccounts: [], rowCounts: { ledger: 4 }, asOf: '2026-06-15',
    });

    const forwards = composePeriod({
      period: mayPeriod, coverage, cells, transferLegs: [], context: contextFor(),
    });
    const backwards = composePeriod({
      period: mayPeriod, coverage, cells: [...cells].reverse(), transferLegs: [],
      context: contextFor(),
    });
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });
});

describe('a period nothing covers is NULL with a reason, never zero (§1.5)', () => {
  it('writes no_source_covers_period rather than a zero P&L', () => {
    const emptyPeriod: PeriodRef = {
      ...mayPeriod, id: mayPeriod.id, periodStart: '2026-01-01', periodEnd: '2026-01-31',
      label: 'Jan 2026',
    };
    const coverage = computeCoverage({
      period: emptyPeriod, batches: [], bankAccounts: [], rowCounts: {}, asOf: '2026-06-15',
    });

    const results = composePeriod({
      period: emptyPeriod, coverage, cells: [], transferLegs: [], context: contextFor(),
    });

    const revenue = results.find((r) => r.key === 'revenue');
    expect(revenue?.value, 'zero would say the business earned nothing').toBeNull();
    expect(revenue?.basis).toBe('none');
    expect(revenue?.dataQuality.missing).toContain('no_source_covers_period');
  });
});

describe('the aggregate reflects only what the engine may see', () => {
  it('drops a row the moment it is superseded', () => {
    const before = loadAggregate('2026-05-01', '2026-05-31')
      .filter((c) => c.source === 'ledger' && c.standardCategory === 'revenue')[0];
    expect(before?.amount).toBe('-20000.00');

    const kept = one(`
      select id from public.ledger_entries
       where organization_id = '${orgId}' and amount = 20000.00 limit 1`);
    const extra = one(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '2026-05-28', '${accountId('revenue')}', 'credit', 500.00,
              '00000000-0000-0000-0000-000000000000', 'accepted')
      returning id`);

    const withExtra = loadAggregate('2026-05-01', '2026-05-31')
      .filter((c) => c.source === 'ledger' && c.standardCategory === 'revenue')[0];
    expect(withExtra?.amount).toBe('-20500.00');

    adminSql(`update public.ledger_entries set superseded_by = '${kept}' where id = '${extra}'`);

    const after = loadAggregate('2026-05-01', '2026-05-31')
      .filter((c) => c.source === 'ledger' && c.standardCategory === 'revenue')[0];
    expect(after?.amount, 'a superseded row leaves the figures at once').toBe('-20000.00');
  });
});
