import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { CATEGORY_ACCOUNT_TYPE, STANDARD_CATEGORIES } from '@/modules/financials';
import { transferKindFor, type BankAccountType } from '@/modules/banking';
import { IMPORT_TARGET, type ImportType } from '@/modules/imports';
import { listBankTransactions, loadBankTransaction, readRawDescriptions } from '@/modules/banking';
import { listCounterparties } from '@/modules/financials';
import { standardCategoryAccountType, fiscalPosition, type StandardCategory } from '@/db/app/shared';
import { readOrganizationRow } from '@/db/app/financials-reads';
import { orgRows } from '@/db/rls';
import { globalRow, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc as call, sqlstate } from './setup';
import {
  addMember, dropFixtures, rowOf, rowsOf, seedAccount, seedBankAccount, seedBankTxn, seedBatch, seedCounterparty,
  seedDocument, seedImportRow, systemAccount,
} from './f-fixtures';

/**
 * Phase 2 (plan Phase 4) schema, through the ported functions and read policies.
 *
 * Two things are proven here:
 *   1. PARITY. Several rules exist twice — once where the data is written (the `src/db` ports of the
 *      SQL functions) and once in the modules because the UI must anticipate them. A divergence
 *      would let the interface offer something the write refuses, or worse, describe a transfer as
 *      cash-neutral when the write classed it otherwise. These tests fail on any drift.
 *   2. The read policies (`src/db/rls.ts`), per role, on the financial tables.
 */

const RUN = `fs${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.financials.itest.motion`;

let ownerId: string;
let clientUserId: string;
let orgId: string;
let orgSlug: string;
let strangerOrg: string | undefined;

const NOT_FOUND = 'P0002';

const rpc = (userId: string, fn: string, args: Record<string, unknown> = {}) => call(clientFor(userId), fn, args);

beforeAll(async () => {
  ownerId = await createAuthUser(`fin-owner@${DOMAIN}`);
  clientUserId = await createAuthUser(`fin-client@${DOMAIN}`);

  const created = await rpc(ownerId, 'create_organization', {
    p_name: `ITest Financials ${RUN}`,
    p_fiscal_year_start_month: 4,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  orgSlug = String((await globalRow(fs(), 'organizations', orgId).get()).get('slug'));
  await addMember(orgId, clientUserId, 'client');
}, 60_000);

afterAll(async () => {
  await dropFixtures([orgId, strangerOrg], DOMAIN);
}, 60_000);

describe('organization creation seeds the standard chart (ADR-004)', () => {
  it('creates one system account per standard category', async () => {
    expect(await rowsOf(orgId, 'accounts', { is_system: true })).toHaveLength(STANDARD_CATEGORIES.length);
  });

  it('covers every category exactly once', async () => {
    const categories = new Set((await rowsOf(orgId, 'accounts', { is_system: true })).map((a) => a.standard_category));
    expect(categories.size).toBe(26);
  });

  it('materialises a fiscal calendar to render before any data exists', async () => {
    expect(await rowsOf(orgId, 'fiscal_periods')).toHaveLength(24);
  });
});

describe('parity: the category to account-type map', () => {
  it('agrees with standard_category_account_type, as the writes apply it, for all 26 categories', () => {
    for (const category of STANDARD_CATEGORIES) {
      expect(standardCategoryAccountType(category as StandardCategory), `${category} disagrees between the write and the module`)
        .toBe(CATEGORY_ACCOUNT_TYPE[category]);
    }
    expect(STANDARD_CATEGORIES).toHaveLength(26);
  });
});

describe('parity: the fiscal calendar', () => {
  it('agrees with app.fiscal_position on the seeded periods of an April-start organization', async () => {
    // The seeded rows were computed by `api.create_organization`; this computes them independently.
    const periods = (await rowsOf(orgId, 'fiscal_periods')).sort((a, b) => String(a.period_start).localeCompare(String(b.period_start)));
    for (const p of periods) {
      const start = String(p.period_start);
      const month = Number(start.slice(5, 7));
      const calendarYear = Number(start.slice(0, 4));

      // Fiscal year is named by the calendar year it starts in; April start.
      const expectedYear = month >= 4 ? calendarYear : calendarYear - 1;
      const expectedQuarter = Math.floor(((month - 4 + 12) % 12) / 3) + 1;

      expect(p.fiscal_year, `${start} fiscal year`).toBe(expectedYear);
      expect(p.fiscal_quarter, `${start} fiscal quarter`).toBe(expectedQuarter);
      expect(fiscalPosition(start, 4)).toEqual({ fiscal_year: expectedYear, fiscal_quarter: expectedQuarter });
    }
  });
});

describe('parity: import type to target table', () => {
  it('agrees with api.start_import_batch for every import type', async () => {
    const documentId = await seedDocument(orgId, { filename: 'f.csv', kind: 'other' });
    const bankAccountId = await seedBankAccount(orgId, { name: 'Parity Current', bankName: 'Parity Bank' });

    for (const importType of Object.keys(IMPORT_TARGET) as ImportType[]) {
      const { data, error } = await rpc(ownerId, 'start_import_batch', {
        p_document: documentId,
        p_import_type: importType,
        p_opts: { bank_account_id: bankAccountId },
      });
      expect(error, `${importType}: ${error?.message}`).toBeNull();

      const batch = await rowOf(orgId, 'import_batches', data as string);
      expect(batch?.target_table, `${importType} target`).toBe(IMPORT_TARGET[importType]);

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
      const accountA = await seedBankAccount(orgId, { name: `A ${typeA} ${typeB}`, bankName: 'Bank', type: typeA });
      const accountB = await seedBankAccount(orgId, { name: `B ${typeA} ${typeB}`, bankName: 'Bank', type: typeB });
      const txnA = await seedBankTxn(orgId, { bankAccountId: accountA, date: '2026-05-10', amount: '-100.00', description: 'OUT' });
      const txnB = await seedBankTxn(orgId, { bankAccountId: accountB, date: '2026-05-10', amount: '100.00', description: 'IN' });

      const { error } = await rpc(ownerId, 'mark_transfer', { p_txn: txnA, p_pair: txnB });
      expect(error, `${typeA}/${typeB}: ${error?.message}`).toBeNull();

      const kinds = [(await rowOf(orgId, 'bank_transactions', txnA))?.transfer_kind, (await rowOf(orgId, 'bank_transactions', txnB))?.transfer_kind];

      const expected = transferKindFor(typeA, typeB);
      expect(kinds[0], `${typeA}/${typeB} leg A`).toBe(expected);
      // Both legs describe one movement, so both must carry the same verdict.
      expect(kinds[1], `${typeA}/${typeB} leg B`).toBe(expected);
    }
  });
});

describe('the read policies on the financial tables', () => {
  it('a client reads the financial records of their own organization', async () => {
    const db = clientFor(clientUserId);
    for (const table of ['accounts', 'fiscal_periods', 'bank_accounts'] as const) {
      expect((await orgRows(db, orgId, table)).length, `${table} should read for a client`).toBeGreaterThan(0);
    }
    expect(await orgRows(db, orgId, 'accounts'), 'a client sees the seeded chart').toHaveLength(26);
  });

  it('a client reads NOTHING of the import surface (ADR-038.4)', async () => {
    const db = clientFor(clientUserId);
    for (const table of ['source_documents', 'import_batches', 'import_rows', 'import_mappings'] as const) {
      expect(await orgRows(db, orgId, table), `${table} must be invisible without imports.review`).toHaveLength(0);
    }
  });

  it('an owner does read the import surface', async () => {
    expect((await orgRows(clientFor(ownerId), orgId, 'source_documents')).length).toBeGreaterThan(0);
  });

  /*
   * Raw bank text and counterparty contact columns (ADR-044.2; R2-A-04). PostgreSQL refused the
   * columns themselves to `authenticated`; the documents carry them, so what is proven here is that
   * the readers the pages use never return them.
   */
  it('raw bank text is not returned by the banking readers (ADR-044.2; R2-A-04)', async () => {
    for (const userId of [ownerId, clientUserId]) {
      const rows = await listBankTransactions(clientFor(userId), orgId, {}, { limit: 50, offset: 0 });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toHaveProperty('descriptionRaw');
      const one = await loadBankTransaction(clientFor(userId), orgId, rows[0]!.id);
      expect(one).not.toHaveProperty('descriptionRaw');
      expect(one).not.toHaveProperty('counterpartyNameRaw');
    }
  });

  it('counterparty contact columns are likewise not returned by the reader', async () => {
    await seedCounterparty(orgId, { name: 'Contact Ltd', kind: 'customer' });
    const rows = await listCounterparties(clientFor(ownerId), orgId, { limit: 50, offset: 0 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty('email');
      expect(row).not.toHaveProperty('notes');
    }
  });

  /*
   * ADR-172 hardening (2026-10-14, migration 20261018000033): the raw text is for REVIEW. The reader
   * returns a line only while a batch in review is about it — here, a row of a batch awaiting review
   * flagged as a duplicate of the line — and only to `imports.review` with `banking.view` or
   * `financials.view`. Once nothing is in review, nobody reads it, an owner included.
   */
  it('the raw-text reader exposes raw text to imports.review, only while it is in review, and nothing to a client', async () => {
    const lines = await rowsOf(orgId, 'bank_transactions');
    const line = String(lines[0]!.id);
    const rawRows = async (userId: string) => (await readRawDescriptions(clientFor(userId), orgId, lines.map((l) => String(l.id)))).length;
    expect(await rawRows(ownerId), 'nothing is in review: no raw text, even for an owner').toBe(0);

    const doc = await seedDocument(orgId, { filename: 'raw.csv', kind: 'bank_statement' });
    const batch = await seedBatch(orgId, {
      documentId: doc, importType: 'bank_statement', targetTable: 'bank_transactions', status: 'awaiting_review',
      bankAccountId: String(lines[0]!.bank_account_id), periodStart: '2026-05-01', periodEnd: '2026-05-31',
    });
    await seedImportRow(orgId, { batchId: batch, rowNumber: 1, status: 'duplicate', duplicateOfTable: 'bank_transactions', duplicateOfId: line });

    expect(await rawRows(ownerId), 'an owner holds imports.review and reads the line under review').toBe(1);
    expect(await rawRows(clientUserId), 'a client holds no imports.review').toBe(0);

    await orgRow(fs(), orgId, 'import_batches', batch).update({ status: 'rejected' });
    expect(await rawRows(ownerId), 'the review over, the raw text is gone again').toBe(0);
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

  beforeAll(async () => {
    await globalRow(fs(), 'organizations', orgId).update({ status: 'suspended' });
  });

  afterAll(async () => {
    await globalRow(fs(), 'organizations', orgId).update({ status: 'active' });
  });

  it('resolves the member to suspended_member', async () => {
    const { data } = await rpc(ownerId, 'my_context', { p_slug: orgSlug });
    expect((data as { role: string }[])[0]?.role).toBe('suspended_member');
  });

  it('still admits the frozen-Home tables', async () => {
    expect(await readOrganizationRow(clientFor(ownerId), orgId), 'the frozen Home still resolves the organization').not.toBeNull();
    for (const table of FROZEN_HOME) {
      if (table === 'organizations') continue;
      // Readable means the policy admits the table (an empty table still returns []), never an error.
      await expect(orgRows(clientFor(ownerId), orgId, table), `${table} should still be readable`).resolves.toBeInstanceOf(Array);
    }
    const periods = await orgRows(clientFor(ownerId), orgId, 'fiscal_periods');
    expect(periods.length, 'the frozen Home has a month to show (ADR-068)').toBeGreaterThan(0);
  });

  it('and hides every other tenant table', async () => {
    for (const table of TENANT_DATA) {
      expect(await orgRows(clientFor(ownerId), orgId, table), `${table} must be frozen for a suspended_member`).toHaveLength(0);
    }
  });
});

describe('the api surface refuses cross-tenant work with NOT FOUND', () => {
  let strangerId: string;
  let foreignAccountId: string;

  beforeAll(async () => {
    strangerId = await createAuthUser(`fin-stranger@${DOMAIN}`);
    const created = await rpc(strangerId, 'create_organization', { p_name: `ITest Stranger ${RUN}` });
    if (created.error) throw new Error(`stranger org failed: ${created.error.message}`);
    strangerOrg = created.data as string;
    foreignAccountId = await systemAccount(strangerOrg, 'revenue');
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
    const seeded = await systemAccount(orgId, 'revenue');
    const { error } = await rpc(ownerId, 'remap_account', {
      p_account: seeded, p_category: 'marketing',
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('22023');
  });

  it('but an imported account can be, and the change is recorded in history', async () => {
    // An imported account, as the import's account creation writes it: with its first interval
    // (what the `open_category_history` trigger did, ADR-060).
    const imported = await seedAccount(orgId, { name: 'Facebook Ads', category: 'operating_expense', accountType: 'expense' });
    expect(await rowsOf(orgId, 'account_category_history', { account_id: imported, valid_to: null }),
      'creating an account opens its first interval').toHaveLength(1);

    const { error } = await rpc(ownerId, 'remap_account', {
      p_account: imported, p_category: 'marketing',
    });
    expect(error, error?.message).toBeNull();

    const account = (await rowOf(orgId, 'accounts', imported))!;
    expect(account.standard_category).toBe('marketing');
    expect(account.account_type).toBe('expense');

    // ADR-034: the old row is closed and a new one opened, so evidence resolved as-of an earlier
    // run still sees the category that produced those numbers.
    const history = await rowsOf(orgId, 'account_category_history', { account_id: imported });
    expect(history.filter((h) => h.valid_to === null), 'exactly one open history row').toHaveLength(1);
    expect(history.filter((h) => h.valid_to !== null), 'the previous category was closed off').toHaveLength(1);

    // A remap changes every metric the account feeds, so a recalculation must be queued.
    const jobs = await fs().collection('jobs').where('organization_id', '==', orgId).where('job_type', '==', 'calculation.run').get();
    expect(jobs.size).toBeGreaterThan(0);
  });
});
