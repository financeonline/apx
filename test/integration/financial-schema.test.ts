import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { CATEGORY_ACCOUNT_TYPE, STANDARD_CATEGORIES } from '@/modules/financials';
import { transferKindFor, type BankAccountType } from '@/modules/banking';
import { IMPORT_TARGET, type ImportType } from '@/modules/imports';
import { adminSql, clientFor, createAuthUser, resetFixtures, sqlstate } from './setup';

/**
 * Phase 2 (plan Phase 4) schema, over the real wire.
 *
 * Two things are proven here that neither the unit tests nor pgTAP can prove alone:
 *   1. PARITY. Several rules exist twice — once in SQL because the database must enforce them, and
 *      once in TypeScript because the UI must anticipate them. A divergence would let the interface
 *      offer something the database refuses, or worse, describe a transfer as cash-neutral when SQL
 *      classed it otherwise. These tests fail on any drift.
 *   2. RLS under a real JWT, per role, on the new tables.
 */

let ownerId: string;
let clientUserId: string;
let orgId: string;
let orgSlug: string;

const NOT_FOUND = 'P0002';
const PERMISSION_DENIED = '42501';

const rpc = (userId: string, fn: string, args: Record<string, unknown> = {}) =>
  clientFor(userId).schema('api').rpc(fn, args);

beforeAll(async () => {
  resetFixtures();
  ownerId = createAuthUser('fin-owner@itest.motion');
  clientUserId = createAuthUser('fin-client@itest.motion');

  const created = await rpc(ownerId, 'create_organization', {
    p_name: 'ITest Financials',
    p_fiscal_year_start_month: 4,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  orgSlug = adminSql(`select slug from public.organizations where id = '${orgId}'`);

  adminSql(`
    set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role)
    values ('${orgId}', '${clientUserId}', 'client');
  `);
});

afterAll(() => {
  resetFixtures();
});

describe('organization creation seeds the standard chart (ADR-004)', () => {
  it('creates one system account per standard category', () => {
    const count = adminSql(
      `select count(*) from public.accounts where organization_id = '${orgId}' and is_system`,
    );
    expect(Number(count)).toBe(STANDARD_CATEGORIES.length);
  });

  it('covers every category exactly once', () => {
    const distinct = adminSql(`
      select count(distinct standard_category) from public.accounts
       where organization_id = '${orgId}' and is_system`);
    expect(Number(distinct)).toBe(26);
  });

  it('materialises a fiscal calendar to render before any data exists', () => {
    const periods = adminSql(
      `select count(*) from public.fiscal_periods where organization_id = '${orgId}'`,
    );
    expect(Number(periods)).toBe(24);
  });
});

describe('parity: the category to account-type map', () => {
  it('agrees with public.standard_category_account_type for all 26 categories', () => {
    const rows = adminSql(`
      select string_agg(c::text || '=' || public.standard_category_account_type(c)::text, ',' order by c::text)
        from unnest(enum_range(null::public.standard_category_enum)) c`);
    const fromSql = Object.fromEntries(rows.split(',').map((pair) => pair.split('=')));

    for (const category of STANDARD_CATEGORIES) {
      expect(fromSql[category], `${category} disagrees between SQL and TypeScript`)
        .toBe(CATEGORY_ACCOUNT_TYPE[category]);
    }
    expect(Object.keys(fromSql)).toHaveLength(26);
  });
});

describe('parity: the fiscal calendar', () => {
  it('agrees with app.fiscal_position on the seeded periods of an April-start organization', () => {
    // The seeded rows were computed by SQL; core/periods computes them independently in TypeScript.
    const rows = adminSql(`
      select string_agg(period_start::text || '=' || fiscal_year || 'Q' || fiscal_quarter, ',' order by period_start)
        from public.fiscal_periods where organization_id = '${orgId}'`);

    for (const entry of rows.split(',')) {
      const [start, position] = entry.split('=') as [string, string];
      const [year, quarter] = position.split('Q').map(Number) as [number, number];
      const month = Number(start.slice(5, 7));
      const calendarYear = Number(start.slice(0, 4));

      // Fiscal year is named by the calendar year it starts in; April start.
      const expectedYear = month >= 4 ? calendarYear : calendarYear - 1;
      const expectedQuarter = Math.floor(((month - 4 + 12) % 12) / 3) + 1;

      expect(year, `${start} fiscal year`).toBe(expectedYear);
      expect(quarter, `${start} fiscal quarter`).toBe(expectedQuarter);
    }
  });
});

describe('parity: import type to target table', () => {
  it('agrees with api.start_import_batch for every import type', async () => {
    const documentId = adminSql(`
      with inserted as (
        insert into public.source_documents
               (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status)
        values ('${orgId}', '${orgId}/parity/f.csv', 'f.csv', 'text/csv', 10,
                decode('aa','hex'), 'ready')
        returning id)
      select id from inserted`);

    const bankAccountId = adminSql(`
      with inserted as (
        insert into public.bank_accounts (organization_id, name, bank_name)
        values ('${orgId}', 'Parity Current', 'Parity Bank') returning id)
      select id from inserted`);

    for (const importType of Object.keys(IMPORT_TARGET) as ImportType[]) {
      const { data, error } = await rpc(ownerId, 'start_import_batch', {
        p_document: documentId,
        p_import_type: importType,
        p_opts: { bank_account_id: bankAccountId },
      });
      expect(error, `${importType}: ${error?.message}`).toBeNull();

      const target = adminSql(
        `select target_table from public.import_batches where id = '${data as string}'`,
      );
      expect(target, `${importType} target`).toBe(IMPORT_TARGET[importType]);

      // Only one batch may be active per document, so close this one before the next type.
      await rpc(ownerId, 'reject_import_batch', { p_batch: data, p_reason: 'parity probe' });
    }
  });
});

describe('parity: transfer kind derivation (ADR-028)', () => {
  const PAIRS: ReadonlyArray<readonly [BankAccountType, BankAccountType]> = [
    ['current', 'savings'],
    ['current', 'current'],
    ['current', 'credit_card'],
    ['current', 'loan'],
    ['savings', 'other'],
  ];

  it('agrees with api.mark_transfer, which derives the kind and never accepts it', async () => {
    for (const [typeA, typeB] of PAIRS) {
      const accountA = adminSql(`
        with inserted as (
          insert into public.bank_accounts (organization_id, name, bank_name, account_type)
          values ('${orgId}', 'A ${typeA} ${typeB}', 'Bank', '${typeA}') returning id)
        select id from inserted`);
      const accountB = adminSql(`
        with inserted as (
          insert into public.bank_accounts (organization_id, name, bank_name, account_type)
          values ('${orgId}', 'B ${typeA} ${typeB}', 'Bank', '${typeB}') returning id)
        select id from inserted`);

      const txnA = adminSql(`
        with inserted as (
          insert into public.bank_transactions
                 (organization_id, bank_account_id, transaction_date, amount, period_id, record_status)
          values ('${orgId}', '${accountA}', '2026-05-10', -100.00,
                  '00000000-0000-0000-0000-000000000000', 'accepted')
          returning id)
        select id from inserted`);
      const txnB = adminSql(`
        with inserted as (
          insert into public.bank_transactions
                 (organization_id, bank_account_id, transaction_date, amount, period_id, record_status)
          values ('${orgId}', '${accountB}', '2026-05-10', 100.00,
                  '00000000-0000-0000-0000-000000000000', 'accepted')
          returning id)
        select id from inserted`);

      const { error } = await rpc(ownerId, 'mark_transfer', { p_txn: txnA, p_pair: txnB });
      expect(error, `${typeA}/${typeB}: ${error?.message}`).toBeNull();

      const kinds = adminSql(`
        select string_agg(transfer_kind::text, ',') from public.bank_transactions
         where id in ('${txnA}', '${txnB}')`).split(',');

      const expected = transferKindFor(typeA, typeB);
      expect(kinds[0], `${typeA}/${typeB} leg A`).toBe(expected);
      // Both legs describe one movement, so both must carry the same verdict.
      expect(kinds[1], `${typeA}/${typeB} leg B`).toBe(expected);
    }
  });
});

describe('RLS on the new tables', () => {
  it('a client reads the financial records of their own organization', async () => {
    const db = clientFor(clientUserId);
    for (const table of ['accounts', 'fiscal_periods', 'counterparties', 'bank_accounts'] as const) {
      const { error } = await db.from(table).select('id').eq('organization_id', orgId);
      expect(error, `${table} should read cleanly for a client`).toBeNull();
    }
    const { data } = await db.from('accounts').select('id').eq('organization_id', orgId);
    expect(data?.length, 'a client sees the seeded chart').toBe(26);
  });

  it('a client reads NOTHING of the import surface (ADR-038.4)', async () => {
    const db = clientFor(clientUserId);
    for (const table of ['source_documents', 'import_batches', 'import_rows', 'import_mappings'] as const) {
      const { data, error } = await db.from(table).select('id').eq('organization_id', orgId);
      expect(error, `${table} should not error`).toBeNull();
      expect(data ?? [], `${table} must be invisible without imports.review`).toHaveLength(0);
    }
  });

  it('an owner does read the import surface', async () => {
    const { data } = await clientFor(ownerId).from('source_documents').select('id')
      .eq('organization_id', orgId);
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('raw bank text is not selectable by anyone through the table (ADR-044.2; R2-A-04)', async () => {
    for (const userId of [ownerId, clientUserId]) {
      const { error } = await clientFor(userId)
        .from('bank_transactions').select('id, description_raw').eq('organization_id', orgId);
      expect(error, 'description_raw must be refused even for an owner').not.toBeNull();
      expect(sqlstate(error)).toBe(PERMISSION_DENIED);
    }
  });

  it('counterparty contact columns are likewise not selectable through the table', async () => {
    const { error } = await clientFor(ownerId)
      .from('counterparties').select('id, email, notes').eq('organization_id', orgId);
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('the definer view exposes raw text to imports.review and nothing to a client', async () => {
    const owner = await clientFor(ownerId).from('bank_transactions_raw').select('id')
      .eq('organization_id', orgId);
    expect(owner.error, owner.error?.message).toBeNull();
    expect((owner.data ?? []).length, 'an owner holds imports.review').toBeGreaterThan(0);

    const clientRead = await clientFor(clientUserId).from('bank_transactions_raw').select('id')
      .eq('organization_id', orgId);
    expect(clientRead.error).toBeNull();
    expect(clientRead.data ?? [], 'a client holds no imports.review').toHaveLength(0);
  });
});

describe('suspension freezes the financial tables (ADR-044.4; R2-A-07)', () => {
  // ADR-068: the frozen Home needs its month as well as its pointers, so fiscal_periods is among
  // the tables a suspended member may still read. (The snapshots metric_current points at are the
  // other half; home-figures.test.ts and pgTAP 06 assert those, including that history stays out.)
  const FROZEN_HOME = ['organizations', 'metric_current', 'health_current', 'health_scores', 'alerts',
    'fiscal_periods'] as const;
  const TENANT_DATA = ['ledger_entries', 'invoices', 'bank_transactions', 'accounts',
    'counterparties', 'import_batches', 'source_documents'] as const;

  beforeAll(() => {
    adminSql(`update public.organizations set status = 'suspended' where id = '${orgId}'`);
  });

  afterAll(() => {
    adminSql(`update public.organizations set status = 'active' where id = '${orgId}'`);
  });

  it('resolves the member to suspended_member', async () => {
    const { data } = await clientFor(ownerId).schema('api').rpc('my_context', { p_slug: orgSlug });
    expect((data as { role: string }[])[0]?.role).toBe('suspended_member');
  });

  it('still admits the frozen-Home tables', async () => {
    for (const table of FROZEN_HOME) {
      const column = table === 'organizations' ? 'id' : 'organization_id';
      const { error } = await clientFor(ownerId).from(table).select('*').eq(column, orgId);
      expect(error, `${table} should still be readable`).toBeNull();
    }
    const { data } = await clientFor(ownerId).from('organizations').select('id').eq('id', orgId);
    expect(data, 'the frozen Home still resolves the organization').toHaveLength(1);
    const periods = await clientFor(ownerId).from('fiscal_periods').select('id').eq('organization_id', orgId);
    expect(periods.data?.length ?? 0, 'the frozen Home has a month to show (ADR-068)').toBeGreaterThan(0);
  });

  it('and hides every other tenant table', async () => {
    for (const table of TENANT_DATA) {
      const { data, error } = await clientFor(ownerId).from(table).select('id')
        .eq('organization_id', orgId);
      expect(error, `${table} should not error`).toBeNull();
      expect(data ?? [], `${table} must be frozen for a suspended_member`).toHaveLength(0);
    }
  });
});

describe('the api surface refuses cross-tenant work with NOT FOUND', () => {
  let strangerId: string;
  let foreignAccountId: string;

  beforeAll(async () => {
    strangerId = createAuthUser('fin-stranger@itest.motion');
    const created = await rpc(strangerId, 'create_organization', { p_name: 'ITest Stranger' });
    if (created.error) throw new Error(`stranger org failed: ${created.error.message}`);
    foreignAccountId = adminSql(`
      select id from public.accounts
       where organization_id = '${created.data as string}' and standard_category = 'revenue'`);
  });

  it('api.remap_account on another organization raises P0002', async () => {
    const { error } = await rpc(ownerId, 'remap_account', {
      p_account: foreignAccountId, p_category: 'marketing',
    });
    expect(sqlstate(error), 'a 42501 would confirm the account exists').toBe(NOT_FOUND);
  });

  it('api.supersede_record on an invented id raises P0002', async () => {
    const { error } = await rpc(ownerId, 'supersede_record', {
      p_table: 'ledger_entries',
      p_record: '99999999-9999-4999-8999-999999999999',
      p_replacement: '88888888-8888-4888-8888-888888888888',
    });
    expect(sqlstate(error)).toBe(NOT_FOUND);
  });
});

describe('a system account cannot be re-categorised (ADR-004)', () => {
  it('raises VALIDATION, because a seeded account IS its category', async () => {
    const seeded = adminSql(`
      select id from public.accounts
       where organization_id = '${orgId}' and is_system and standard_category = 'revenue'`);
    const { error } = await rpc(ownerId, 'remap_account', {
      p_account: seeded, p_category: 'marketing',
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('22023');
  });

  it('but an imported account can be, and the change is recorded in history', async () => {
    const imported = adminSql(`
      with inserted as (
        insert into public.accounts
               (organization_id, name, normalized_name, account_type, standard_category, source)
        values ('${orgId}', 'Facebook Ads', 'facebook ads', 'expense', 'operating_expense', 'imported')
        returning id)
      select id from inserted`);
    /*
     * No hand-written opening row any more. `open_category_history` writes it when the account is
     * created (ADR-060): before that trigger existed, `account_category_history` was empty until
     * somebody re-categorised something, and this fixture's manual insert was the workaround that
     * let the assertion below pass while the real table stayed empty in production.
     */
    expect(Number(adminSql(`
      select count(*) from public.account_category_history
       where account_id = '${imported}' and valid_to is null`)),
    'creating an account opens its first interval').toBe(1);

    const { error } = await rpc(ownerId, 'remap_account', {
      p_account: imported, p_category: 'marketing',
    });
    expect(error, error?.message).toBeNull();

    const category = adminSql(`select standard_category from public.accounts where id = '${imported}'`);
    expect(category).toBe('marketing');

    // ADR-034: the old row is closed and a new one opened, so evidence resolved as-of an earlier
    // run still sees the category that produced those numbers.
    const open = adminSql(`
      select count(*) from public.account_category_history
       where account_id = '${imported}' and valid_to is null`);
    expect(Number(open), 'exactly one open history row').toBe(1);

    const closed = adminSql(`
      select count(*) from public.account_category_history
       where account_id = '${imported}' and valid_to is not null`);
    expect(Number(closed), 'the previous category was closed off').toBe(1);

    // A remap changes every metric the account feeds, so a recalculation must be queued.
    const jobs = adminSql(`
      select count(*) from public.jobs
       where organization_id = '${orgId}' and job_type = 'calculation.run'`);
    expect(Number(jobs)).toBeGreaterThan(0);
  });
});
