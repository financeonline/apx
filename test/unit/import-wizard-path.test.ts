import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The upload → register → parse → reference creation → validation path, through the real
 * `startImport` (IMPORT_ENGINE.md §2–§8).
 *
 * Every line of the wizard, the pipeline and validation runs for real. Only the edges are replaced:
 * the service-role RPCs, the storage signer and the caller's Supabase client — by a recording fake
 * that applies the database's own rules, read from the migrations rather than restated here:
 *   - `register_document` casts `document_kind` to `document_kind_enum` (and fails as Postgres does);
 *   - `api.start_import_batch` chooses the target with its CASE and requires a bank account for a
 *     statement;
 *   - `api.create_import_counterparties` / `create_import_accounts` insert by `app.normalize_name`.
 * The rows the wizard writes are then held to what `app.commit_import_batch` will insert: every NOT
 * NULL column it reads from `mapped_data`, and every enum it casts.
 *
 * The integration suite (`test/integration/import-wizard-types.test.ts`) runs the same journeys,
 * through commit, against a real database.
 */

const MIGRATIONS = path.resolve(process.cwd(), 'supabase/migrations');
const migrationSql = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'));

function enumValues(name: string): Set<string> {
  for (const sql of migrationSql) {
    const match = new RegExp(`create type public\\.${name} as enum\\s*\\(([^)]*)\\)`).exec(sql);
    if (match) return new Set([...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
  }
  throw new Error(`${name} is not defined`);
}

/** `api.start_import_batch`'s CASE, from its newest definition. */
function sqlTargetFor(importType: string): string {
  let body = '';
  for (const sql of migrationSql) {
    const at = sql.search(/create (or replace )?function api\.start_import_batch\(/);
    if (at >= 0) body = sql.slice(at);
  }
  const block = /v_target := case p_import_type([\s\S]*?)end::public\.import_target_enum/.exec(body)![1]!;
  const hit = new RegExp(`when '${importType}' then '([a-z_]+)'`).exec(block);
  return hit ? hit[1]! : /else '([a-z_]+)'/.exec(block)![1]!;
}

const DOCUMENT_KINDS = enumValues('document_kind_enum');
const IMPORT_TYPE_ENUM = enumValues('import_type_enum');
const INVOICE_TYPES = enumValues('invoice_type_enum');
const INVOICE_STATUSES = enumValues('invoice_status_enum');
const ENTRY_DIRECTIONS = enumValues('entry_direction_enum');

/** `app.normalize_name`: lower, every run of non-alphanumerics to one space, trimmed. */
// The database's key (app.normalize_name); its parity with Postgres is tested in
// test/integration/unicode-names.test.ts.
const normalize = (name: string) => storedNameKey(name);

// -----------------------------------------------------------------------------------------------
// The fake database
// -----------------------------------------------------------------------------------------------

const ORG = '0f000000-0000-4000-8000-000000000001';
const BANK = '0b000000-0000-4000-8000-000000000001';

interface Row { [column: string]: unknown }
interface Batch { id: string; importType: string; target: string; bankAccountId: string | null }

const state = {
  tables: {} as Record<string, Row[]>,
  documents: [] as Row[],
  batches: [] as Batch[],
  log: [] as string[],
  counterpartyCalls: [] as string[][],
  rows: [] as Array<{ mapped_data: Record<string, string | null>; status: string; issues: Array<{ code: string }> }>,
  failed: null as null | { stage: string; message: string },
  refuseCounterparties: false,
};

function reset(): void {
  state.tables = {
    organizations: [{ id: ORG, base_currency: 'GBP', timezone: 'Europe/London' }],
    source_documents: [],
    bank_accounts: [{
      id: BANK, organization_id: ORG, account_type: 'current', bank_name: 'Test Bank',
      sort_code_masked: null, account_number_masked: '****1234',
    }],
    accounts: [],
    counterparties: [],
    invoices: [], ledger_entries: [], bank_transactions: [], period_balances: [],
  };
  state.documents = [];
  state.batches = [];
  state.log = [];
  state.counterpartyCalls = [];
  state.rows = [];
  state.failed = null;
  state.refuseCounterparties = false;
}

/** Just enough of PostgREST's query builder for the reads on this path. */
class Query implements PromiseLike<{ data: Row[]; error: null }> {
  private filters: Array<(row: Row) => boolean> = [];
  private window: [number, number] | null = null;
  constructor(private readonly table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  eq(column: string, value: unknown) { this.filters.push((r) => r[column] === value); return this; }
  is(column: string, value: unknown) { this.filters.push((r) => (r[column] ?? null) === value); return this; }
  range(from: number, to: number) { this.window = [from, to]; return this; }
  private result(): Row[] {
    const rows = (state.tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    return this.window === null ? rows : rows.slice(this.window[0], this.window[1] + 1);
  }
  maybeSingle() { return Promise.resolve({ data: this.result()[0] ?? null, error: null }); }
  then<A, B>(ok?: ((v: { data: Row[]; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve({ data: this.result(), error: null }).then(ok, bad);
  }
}

function pgError(message: string, code: string) {
  return { data: null, error: { message, code, details: null, hint: null } };
}

async function apiRpc(fn: string, args: Record<string, unknown>) {
  state.log.push(fn);
  if (fn === 'start_import_batch') {
    const type = String(args.p_import_type);
    if (!IMPORT_TYPE_ENUM.has(type)) return pgError(`invalid input value for enum import_type_enum: "${type}"`, '22P02');
    const opts = args.p_opts as Record<string, unknown>;
    const target = sqlTargetFor(type);
    if (target === 'bank_transactions' && (opts.bank_account_id ?? null) === null) {
      return pgError('VALIDATION: a bank statement import needs a bank account', '22023');
    }
    const batch = { id: `0c000000-0000-4000-8000-${String(state.batches.length + 1).padStart(12, '0')}`, importType: type, target, bankAccountId: (opts.bank_account_id as string) ?? null };
    state.batches.push(batch);
    return { data: batch.id, error: null };
  }
  if (fn === 'create_import_counterparties') {
    if (state.refuseCounterparties) return pgError('VALIDATION: names cannot contain amounts', '22023');
    const batch = state.batches.find((b) => b.id === args.p_batch)!;
    if (batch.target !== 'invoices') return pgError('VALIDATION: only an invoice list adds customers or suppliers', '22023');
    const kind = batch.importType.startsWith('sales') ? 'customer' : 'supplier';
    const names = args.p_names as string[];
    state.counterpartyCalls.push(names);
    let created = 0;
    for (const name of names) {
      const existing = state.tables.counterparties!.find((c) => c.normalized_name === normalize(name));
      if (existing) {
        if (existing.merged_into_id === null && existing.kind !== kind && existing.kind !== 'both') {
          existing.kind = existing.kind === 'unknown' ? kind : 'both';
        }
        continue;
      }
      state.tables.counterparties!.push({
        id: `cp-${state.tables.counterparties!.length + 1}`, organization_id: ORG, name,
        normalized_name: normalize(name), kind, merged_into_id: null,
      });
      created += 1;
    }
    return { data: created, error: null };
  }
  if (fn === 'create_import_accounts') {
    let created = 0;
    for (const account of args.p_accounts as Array<{ name: string; code: string | null }>) {
      if (state.tables.accounts!.some((a) => a.normalized_name === normalize(account.name))) continue;
      state.tables.accounts!.push({
        id: `acct-${state.tables.accounts!.length + 1}`, organization_id: ORG, code: account.code,
        normalized_name: normalize(account.name),
      });
      created += 1;
    }
    return { data: created, error: null };
  }
  throw new Error(`the fake has no api.${fn}`);
}

const fakeDb = {
  from: (table: string) => new Query(table),
  schema: () => ({ rpc: apiRpc }),
};

vi.mock('@/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/db')>();
  return {
    ...actual,
    // `api_server.register_document`: the `::document_kind_enum` cast is where an invoice upload died.
    registerDocument: vi.fn(async (_actor: unknown, _org: string, meta: Record<string, unknown>) => {
      state.log.push('register_document');
      const kind = String(meta.document_kind);
      if (!DOCUMENT_KINDS.has(kind)) {
        throw Object.assign(new Error(`invalid input value for enum document_kind_enum: "${kind}"`), { code: '22P02' });
      }
      state.documents.push(meta);
      return `0d000000-0000-4000-8000-${String(state.documents.length).padStart(12, '0')}`;
    }),
    finalizeUpload: vi.fn(async () => { state.log.push('finalize_upload'); }),
    writeImportRows: vi.fn(async (_actor: unknown, _org: string, _batch: string, rows: typeof state.rows) => {
      state.log.push('write_import_rows');
      state.rows = rows;
      return rows.length;
    }),
    setBatchValidation: vi.fn(async () => { state.log.push('set_batch_validation'); }),
    failImportBatch: vi.fn(async (_actor: unknown, _org: string, _batch: string, stage: string, message: string) => {
      state.failed = { stage, message };
    }),
  };
});

vi.mock('@/core/storage/signer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/signer')>();
  return {
    ...actual,
    putObject: vi.fn(async () => { state.log.push('put_object'); }),
    removeObject: vi.fn(async () => ({ removed: true })),
  };
});

const { startImport, IMPORT_TYPE_SPECS, storedNameKey } = await import('@/modules/imports');

function fixture(name: string, mime = 'text/csv'): File {
  return new File([new Uint8Array(readFileSync(path.resolve(process.cwd(), 'fixtures/imports', name)))], name, { type: mime });
}

async function run(
  name: string, importType: string, bankAccountId: string | null = null, mime?: string,
  period: { start: string; end: string } = { start: '2026-08-01', end: '2026-08-31' },
) {
  return startImport({
    organizationId: ORG,
    userId: '0a000000-0000-4000-8000-000000000001',
    requestId: 'unit-wizard-path',
    db: fakeDb as never,
    file: fixture(name, mime),
    importType: importType as never,
    periodStart: period.start,
    periodEnd: period.end,
    bankAccountId,
  });
}

/** The data rows, in file order — the header line is a row too, kept and skipped (SOW §23). */
const dataRows = () => state.rows.filter((r) => !r.issues.some((i) => i.code === 'IMP-ROW-005'));

/**
 * What `app.commit_import_batch` reads from `mapped_data` into NOT NULL columns, and the enums it
 * casts — the commit fails on any row missing one, so the wizard must never leave a committable row
 * without it.
 */
function expectCommittable(row: (typeof state.rows)[number], target: string) {
  const m = row.mapped_data;
  if (target === 'invoices') {
    for (const field of ['invoice_type', 'counterparty_id', 'invoice_number', 'issue_date', 'total_amount']) {
      expect(m[field], field).toBeTruthy();
    }
    expect(INVOICE_TYPES.has(m.invoice_type!)).toBe(true);
    if (m.status) expect(INVOICE_STATUSES.has(m.status)).toBe(true);
  }
  if (target === 'ledger_entries') {
    for (const field of ['entry_date', 'account_id', 'direction', 'amount']) expect(m[field], field).toBeTruthy();
    expect(ENTRY_DIRECTIONS.has(m.direction!)).toBe(true);
  }
}

beforeEach(reset);

describe('sales invoices through the wizard', () => {
  it('registers the file as an invoice, batches it to invoices, and creates the customers first', async () => {
    const result = await run('sales_invoices.csv', 'sales_invoices');

    expect(state.documents[0]!.document_kind).toBe('invoice');
    expect(state.batches[0]).toMatchObject({ importType: 'sales_invoices', target: 'invoices', bankAccountId: null });
    // The customers exist BEFORE the rows are validated and written, so every row resolves.
    expect(state.log.indexOf('create_import_counterparties')).toBeLessThan(state.log.indexOf('write_import_rows'));
    expect(state.counterpartyCalls).toEqual([['Acme Ltd', 'Beta Trading', 'Gamma Stores']]);
    expect(state.tables.counterparties!.map((c) => c.kind)).toEqual(['customer', 'customer', 'customer']);
    expect(result.counterpartiesCreated).toBe(3);
  });

  it('writes rows that commit: a type, a customer, an enum status — and a credit note stored positive', async () => {
    await run('sales_invoices.csv', 'sales_invoices');
    const rows = dataRows();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(['valid', 'warning'], JSON.stringify(row.issues)).toContain(row.status);
      expectCommittable(row, 'invoices');
    }
    const [paid, open, credit, partial] = rows.map((r) => r.mapped_data);
    expect(paid).toMatchObject({ invoice_type: 'sales', status: 'paid', total_amount: '1200.00' });
    expect(open).toMatchObject({ invoice_type: 'sales', status: 'open' });
    // CD-28: −250 / −50 / −300 / −300 becomes a credit note of 250 / 50 / 300 / 300.
    expect(credit).toMatchObject({
      invoice_type: 'sales_credit_note', subtotal: '250.00', tax_amount: '50.00', total_amount: '300.00', amount_paid: '300.00', status: 'paid',
    });
    expect(partial).toMatchObject({ invoice_type: 'sales', status: 'partially_paid', total_amount: '2400.00' });
    // The same customer on two rows is one counterparty.
    expect(paid!.counterparty_id).toBe(credit!.counterparty_id);
  });

  it('surfaces an unknown status and a name carrying an amount as row errors, and never creates that name', async () => {
    await run('sales_invoices_problems.csv', 'sales_invoices');
    const [figure, draft] = dataRows();
    expect(figure!.status).toBe('error');
    expect(figure!.issues.map((i) => i.code)).toContain('IMP-NAME-015');
    expect(draft!.status).toBe('error');
    expect(draft!.issues.map((i) => i.code)).toContain('IMP-INV-013');
    expect(state.counterpartyCalls).toEqual([['Zeta Ltd']]);
    expect(state.tables.counterparties!.some((c) => String(c.name).includes('45000'))).toBe(false);
  });
});

describe('purchase invoices and both reports', () => {
  it('creates suppliers, and turns an existing customer met as a supplier into both', async () => {
    state.tables.counterparties!.push({
      id: 'cp-acme', organization_id: ORG, name: 'Acme Ltd', normalized_name: 'acme ltd', kind: 'customer', merged_into_id: null,
    });
    const result = await run('purchase_invoices.csv', 'purchase_invoices');

    expect(state.documents[0]!.document_kind).toBe('invoice');
    expect(state.batches[0]!.target).toBe('invoices');
    // Acme already exists: it is resolved, not re-created — and it is SENT, so the database makes it
    // `both` (§6.6). Found by the first real-database run: only new names were sent, so the upgrade
    // in SQL never ran for a matched customer.
    expect(state.counterpartyCalls).toEqual([['Office Supplies Co', 'Acme Ltd']]);
    expect(result.counterpartiesCreated).toBe(1);
    expect(state.tables.counterparties!.find((c) => c.id === 'cp-acme')!.kind).toBe('both');
    const rows = dataRows();
    for (const row of rows) expectCommittable(row, 'invoices');
    expect(rows.map((r) => r.mapped_data.invoice_type)).toEqual(['purchase', 'purchase']);
    expect(rows[1]!.mapped_data).toMatchObject({ counterparty_id: 'cp-acme', status: 'open' });
  });

  it('a sales report lands where a sales list does, under its own document kind', async () => {
    await run('sales_report.csv', 'sales_report');
    expect(state.documents[0]!.document_kind).toBe('sales_report');
    // Before: the wizard validated this as `period_balances` while the batch said `invoices`.
    expect(state.batches[0]!.target).toBe('invoices');
    expect(state.counterpartyCalls).toEqual([['Delta Partners']]);
    for (const row of dataRows()) {
      expect(row.status).not.toBe('error');
      expectCommittable(row, 'invoices');
      expect(row.mapped_data.invoice_type).toBe('sales');
    }
  });

  it('a purchase report lands where a purchase list does', async () => {
    await run('purchase_report.csv', 'purchase_report');
    expect(state.documents[0]!.document_kind).toBe('purchase_report');
    expect(state.batches[0]!.target).toBe('invoices');
    const [row] = dataRows();
    expectCommittable(row!, 'invoices');
    expect(row!.mapped_data.invoice_type).toBe('purchase');
    expect(state.tables.counterparties!.map((c) => c.kind)).toEqual(['supplier']);
  });
});

describe('receipts', () => {
  it('needs no bank account, registers as a receipt and writes ledger rows against expense accounts', async () => {
    const result = await run('receipts.csv', 'receipts');
    expect(state.documents[0]!.document_kind).toBe('receipt');
    // Before: validated as bank transactions while `api.start_import_batch` recorded ledger_entries.
    expect(state.batches[0]).toMatchObject({ target: 'ledger_entries', bankAccountId: null });
    expect(result.accountsCreated).toBe(2);
    // A receipt list names no customers to create.
    expect(state.log).not.toContain('create_import_counterparties');
    const rows = dataRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).not.toBe('error');
      expectCommittable(row, 'ledger_entries');
      expect(row.mapped_data.direction).toBe('debit');
    }
    expect(rows[0]!.mapped_data.amount).toBe('42.50');
  });
});

describe('balance sheets', () => {
  it('upload as a balance sheet into period balances, against the accounts they name', async () => {
    const result = await run('balance_sheet.csv', 'balance_sheet');
    expect(state.documents[0]!.document_kind).toBe('balance_sheet');
    expect(state.batches[0]).toMatchObject({ target: 'period_balances', bankAccountId: null });
    expect(result.accountsCreated).toBe(4);
    const rows = dataRows();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status, JSON.stringify(row.issues)).not.toBe('error');
      expect(row.mapped_data.account_id).toBeTruthy();
      expect(row.mapped_data.closing_balance).toBeTruthy();
      // No date column: the one-month declared range is the period. Without it the commit failed on
      // `period_assign` ("period_start is required"), found by the Step 0C validation run.
      expect(row.mapped_data).toMatchObject({ period_start: '2026-08-01', period_end: '2026-08-31' });
    }
    // A single signed column must be confirmed as reporting or natural sign before commit (IMP-TB-013).
    expect(result.requiredConfirmations).toEqual(expect.arrayContaining(['IMP-RANGE-015', 'IMP-TB-012', 'IMP-TB-013']));
  });
});

describe('a balance report with no period column', () => {
  it('declared over more than one month: every row asks for its period (IMP-PERIOD-005), none is guessed', async () => {
    await run('balance_sheet.csv', 'balance_sheet', null, undefined, { start: '2026-07-01', end: '2026-08-31' });
    const rows = dataRows();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toBe('error');
      expect(row.issues.map((i) => i.code)).toContain('IMP-PERIOD-005');
      expect(row.mapped_data.period_start ?? null).toBeNull();
    }
  });
});

describe('legitimate business names with numbers in them', () => {
  it('are created as customers, not refused', async () => {
    const names = ['3M', '7-Eleven', 'Studio 54', 'Forever 21', 'A1 Plumbing', '1-800-Flowers', 'No. 10 Bistro',
      '21st Century Ltd', '99 Ranch Market', '24/7 Logistics', 'Route 66 Diner', 'B2B Supplies 2026 Ltd', 'Hotel 1000'];
    const csv = ['Invoice Number,Customer,Invoice Date,Total',
      ...names.map((n, i) => `N-${i},"${n}",2026-08-0${(i % 9) + 1},10.00`)].join('\n');
    const file = new File([csv], 'numbered_names.csv', { type: 'text/csv' });
    await startImport({
      organizationId: ORG, userId: '0a000000-0000-4000-8000-000000000001', requestId: 'unit', db: fakeDb as never,
      file, importType: 'sales_invoices', periodStart: '2026-08-01', periodEnd: '2026-08-31', bankAccountId: null,
    });
    expect(state.counterpartyCalls[0]).toEqual(names);
    for (const row of dataRows()) expect(row.status, JSON.stringify(row.issues)).not.toBe('error');
  });
});

describe('the bank statement path is unchanged', () => {
  it('still registers a statement, needs its account, and creates no counterparties', async () => {
    await run('csv-with-preamble.csv', 'bank_statement', BANK);
    expect(state.documents[0]!.document_kind).toBe('bank_statement');
    expect(state.batches[0]).toMatchObject({ target: 'bank_transactions', bankAccountId: BANK });
    expect(state.log).not.toContain('create_import_counterparties');
  });
});

describe('a PDF of any other type is stored, not read', () => {
  it.each(['sales_invoices', 'purchase_invoices', 'receipts', 'trial_balance', 'balance_sheet'])(
    'a %s PDF is kept as a source document under its kind, with no batch and no rows', async (type) => {
      await expect(run('bank_text.pdf', type, null, 'application/pdf'))
        .rejects.toThrow(/stored as a source document.*bank statements only/);
      // Stored: registered under its kind, written to storage, finalised — traceable like any file.
      expect(state.log).toEqual(['register_document', 'put_object', 'finalize_upload']);
      expect(state.documents[0]!.document_kind).toBe(IMPORT_TYPE_SPECS[type as keyof typeof IMPORT_TYPE_SPECS].documentKind);
      // Not read: no batch, so no statement-shaped "Read with AI" path and no rows.
      expect(state.batches).toHaveLength(0);
      expect(state.rows).toHaveLength(0);
    });

  it('a bank statement PDF is still read', async () => {
    const result = await run('bank_text.pdf', 'bank_statement', BANK, 'application/pdf');
    expect(state.batches[0]).toMatchObject({ importType: 'bank_statement', target: 'bank_transactions' });
    expect(result.parseFailure).toBeUndefined();
    expect(dataRows().length).toBeGreaterThan(0);
  });
});

describe('a refusal while the references are created', () => {
  it('fails the batch with a reason and tells the reader in a sentence, not a SQLSTATE', async () => {
    state.refuseCounterparties = true;
    await expect(run('sales_invoices.csv', 'sales_invoices')).rejects.toThrow(/could not add the accounts or customers/);
    expect(state.failed).toMatchObject({ stage: 'mapping' });
    expect(state.log).not.toContain('write_import_rows');
  });
});

describe('unsupported combinations leave nothing behind', () => {
  const nothingStored = () => {
    expect(state.log).not.toContain('register_document');
    expect(state.log).not.toContain('put_object');
    expect(state.batches).toHaveLength(0);
  };

  it('refuses a bank account on a receipts import', async () => {
    await expect(run('receipts.csv', 'receipts', BANK)).rejects.toThrow('not imported into a bank account');
    nothingStored();
  });

  it('refuses a type that is not an import type', async () => {
    await expect(run('receipts.csv', 'expenses')).rejects.toThrow('Choose what kind of file');
    nothingStored();
  });

  it('refuses a statement with no account', async () => {
    await expect(run('csv-with-preamble.csv', 'bank_statement')).rejects.toThrow('bank account');
    nothingStored();
  });
});

/**
 * Unicode identity (ADR-136; the Step 0C release blocker). The key keeps every letter in every
 * script: distinct names stay distinct, the same name in another case is one, and records the
 * migration HELD for a decision are never booked to. These run the real wizard.
 */
describe('names outside ASCII (ADR-136)', () => {
  const upload = (rows: string[]) => startImport({
    organizationId: ORG, userId: '0a000000-0000-4000-8000-000000000001', requestId: 'unit', db: fakeDb as never,
    file: new File([['Invoice Number,Customer,Invoice Date,Total', ...rows].join('\n')], 'names.csv', { type: 'text/csv' }),
    importType: 'sales_invoices', periodStart: '2026-08-01', periodEnd: '2026-08-31', bankAccountId: null,
  });
  const customer = (id: string, name: string, normalized = normalize(name), merged: string | null = null) =>
    state.tables.counterparties!.push({ id, organization_id: ORG, name, normalized_name: normalized, kind: 'customer', merged_into_id: merged });

  it('two customers who differ only by an accented letter become two customers', async () => {
    await upload(['M-1,Müller GmbH,2026-08-03,100.00', 'M-2,Möller GmbH,2026-08-04,200.00']);
    expect(state.counterpartyCalls.flat()).toEqual(['Müller GmbH', 'Möller GmbH']);
    expect(state.tables.counterparties!.map((c) => [c.name, c.normalized_name]))
      .toEqual([['Müller GmbH', 'müller gmbh'], ['Möller GmbH', 'möller gmbh']]);
    const [muller, moller] = dataRows();
    expect(muller!.status).not.toBe('error');
    expect(moller!.status).not.toBe('error');
    expect(muller!.mapped_data.counterparty_id).not.toBe(moller!.mapped_data.counterparty_id);
  });

  it('an existing customer matches in any case, and never by a different accented name', async () => {
    customer('cp-muller', 'Müller GmbH');
    await upload(['M-3,Möller GmbH,2026-08-05,300.00', 'M-4,MÜLLER GMBH,2026-08-06,50.00', 'M-5,Muller GmbH,2026-08-07,60.00']);
    const [moller, mullerUpper, unaccented] = dataRows();
    expect(mullerUpper!.mapped_data.counterparty_id).toBe('cp-muller');
    expect(moller!.mapped_data.counterparty_id).not.toBe('cp-muller');
    expect(unaccented!.mapped_data.counterparty_id).not.toBe('cp-muller');
    expect(state.tables.counterparties!.find((c) => c.id === 'cp-muller')!.name).toBe('Müller GmbH');
  });

  it('names in Japanese, Arabic, Greek and Cyrillic are created with their own keys, display names kept', async () => {
    await upload([
      'J-1,株式会社トヨタ,2026-08-07,400.00', 'A-1,شركة الأمل,2026-08-08,500.00',
      'G-1,ΟΔΟΣ Α.Ε.,2026-08-09,600.00', 'G-2,οδος α.ε.,2026-08-10,700.00', 'C-1,ООО «Ромашка»,2026-08-11,800.00',
    ]);
    for (const row of dataRows()) expect(row.status, JSON.stringify(row.issues)).not.toBe('error');
    expect(state.tables.counterparties!.map((c) => [c.name, c.normalized_name])).toEqual([
      ['株式会社トヨタ', '株式会社トヨタ'], ['شركة الأمل', 'شركة الأمل'], ['ΟΔΟΣ Α.Ε.', 'οδοσ α ε'], ['ООО «Ромашка»', 'ооо ромашка'],
    ]);
    // The Greek name in capitals and in lower case (with its final sigma) is one customer.
    const [, , upper, lower] = dataRows();
    expect(upper!.mapped_data.counterparty_id).toBe(lower!.mapped_data.counterparty_id);
  });

  it('a name whose records are HELD for a decision is refused (IMP-CP-019), booked to neither, never created again', async () => {
    customer('cp-izmir-dotted', 'İzmir Ltd', 'izmir ltd [held 0b000000-0000-4000-8000-000000000001]');
    customer('cp-izmir', 'Izmir Ltd', 'izmir ltd [held 0b000000-0000-4000-8000-000000000002]');
    await upload(['I-1,IZMIR LTD,2026-08-12,90.00', 'O-1,Other Ltd,2026-08-12,10.00']);
    const [izmir, other] = dataRows();
    expect(izmir!.status).toBe('error');
    expect(izmir!.issues.map((i) => i.code)).toContain('IMP-CP-019');
    expect((izmir!.issues.find((i) => i.code === 'IMP-CP-019') as { message?: string }).message).toContain('"İzmir Ltd" and "Izmir Ltd"');
    expect(izmir!.mapped_data.counterparty_id ?? null).toBeNull();
    expect(other!.status).not.toBe('error');
    expect(state.counterpartyCalls.flat()).toEqual(['Other Ltd']);
  });

  it('a held record that was since merged away no longer blocks the name', async () => {
    customer('cp-izmir', 'Izmir Ltd');
    customer('cp-izmir-dotted', 'İzmir Ltd', 'izmir ltd [held 0b000000-0000-4000-8000-000000000001]', 'cp-izmir');
    await upload(['I-2,Izmir Ltd,2026-08-13,90.00']);
    expect(dataRows()[0]!.mapped_data.counterparty_id).toBe('cp-izmir');
  });
});
