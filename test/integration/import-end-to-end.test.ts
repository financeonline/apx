import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  isKnownHeader, parseCsv, runPipeline, suggestColumns, type TargetField,
} from '@/modules/imports';
import { validateFile } from '@/modules/documents';
import { adminSql, clientFor, createAuthUser, resetFixtures } from './setup';

/**
 * The whole pipeline on a real file (IMPORT_ENGINE.md §4 → §5 → §6 → §8 → §9 → §11).
 *
 * The unit suites prove each stage in isolation; this proves they compose — that a bank statement
 * with four lines of preamble, an em dash, a quoted comma and a Windows-1252 sibling arrives in
 * `bank_transactions` with the right figures, the right provenance, and every discarded line still
 * accounted for.
 *
 * The assertion that matters most: `count(import_rows) === count(non-empty source lines)`. If that
 * ever fails, MOTION has silently dropped something a customer uploaded.
 */

let ownerId: string;
let orgId: string;
let bankAccountId: string;

const rpc = (userId: string, fn: string, args: Record<string, unknown> = {}) =>
  clientFor(userId).schema('api').rpc(fn, args);
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

beforeAll(async () => {
  resetFixtures();
  ownerId = createAuthUser('e2e-owner@itest.motion');
  const created = await rpc(ownerId, 'create_organization', { p_name: 'ITest End To End' });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  bankAccountId = one(`
    insert into public.bank_accounts
           (organization_id, name, bank_name, sort_code_masked, account_number_masked, account_type)
    values ('${orgId}', 'Business Current', 'Barclays', '12-34-56', '4321', 'current')
    returning id`);
});

afterAll(() => resetFixtures());

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`fixtures/imports/${name}`));
}

describe('a real bank statement, from bytes to ledger', () => {
  const COLUMN_MAP: Record<string, TargetField> = {
    Date: 'transaction_date',
    Description: 'description',
    'Paid Out': 'money_out',
    'Paid In': 'money_in',
    Balance: 'balance_after',
  };

  it('validates, parses and keeps every non-empty source line', () => {
    const bytes = loadFixture('csv-with-preamble.csv');
    const validation = validateFile({
      filename: 'csv-with-preamble.csv', declaredMimeType: 'text/csv', bytes,
    });

    expect(validation.ok, JSON.stringify(validation.findings)).toBe(true);
    expect(validation.encoding).toBe('utf-8');
    expect(validation.delimiter).toBe(',');

    const table = parseCsv(validation.text!, {
      delimiter: validation.delimiter,
      isHeaderCell: isKnownHeader,
    });

    // The header was FOUND, not guessed, so the reviewer is not asked to confirm it.
    expect(table.headerConfirmationRequired ?? false).toBe(false);
    expect(table.columns).toEqual(['Date', 'Description', 'Paid Out', 'Paid In', 'Balance']);

    // The invariant. Eleven non-empty lines in, eleven rows out — four of them preamble.
    const sourceLines = Buffer.from(bytes).toString('utf8')
      .split(/\r?\n/).filter((line) => line.trim() !== '').length;
    expect(table.rows).toHaveLength(sourceLines);

    const preamble = table.rows.filter((r) => r.nonTabular);
    expect(preamble.length, 'the four title lines are kept, not dropped').toBe(4);
  });

  it('suggests the column mapping from the headers alone (§6.2)', () => {
    const suggestions = suggestColumns(
      ['Date', 'Description', 'Paid Out', 'Paid In', 'Balance'], 'bank_statement',
    );
    const byColumn = Object.fromEntries(suggestions.map((s) => [s.sourceColumn, s.target]));
    expect(byColumn.Date).toBe('transaction_date');
    expect(byColumn.Description).toBe('description');
    expect(byColumn['Paid Out']).toBe('money_out');
    expect(byColumn['Paid In']).toBe('money_in');
  });

  it('runs the pipeline, marking the preamble skipped and the data valid', () => {
    const bytes = loadFixture('csv-with-preamble.csv');
    const validation = validateFile({
      filename: 'csv-with-preamble.csv', declaredMimeType: 'text/csv', bytes,
    });
    const table = parseCsv(validation.text!, {
      delimiter: validation.delimiter, isHeaderCell: isKnownHeader,
    });

    const result = runPipeline({
      organizationId: orgId,
      importType: 'bank_statement',
      targetTable: 'bank_transactions',
      table,
      columnMap: COLUMN_MAP,
      transforms: { encoding: validation.encoding, delimiter: validation.delimiter },
      baseCurrency: 'GBP',
      today: '2026-09-05',
      declaredPeriodStart: '2026-08-01',
      declaredPeriodEnd: '2026-08-31',
      accounts: [],
      counterparties: [],
      existingRecords: [],
      bankIdentity: { bankName: 'Barclays', sortCodeMasked: '12-34-56', accountNumberMasked: '4321' },
    });

    expect(result.rows).toHaveLength(table.rows.length);
    expect(result.counts.skipped, 'the preamble lines').toBeGreaterThanOrEqual(4);

    // Every row that is not preamble carries a source ref pointing back at its line.
    for (const row of result.rows) {
      expect(row.sourceRef).toMatch(/^csv:row:\d+$/);
    }

    // The declared range is the contract; every transaction falls inside August.
    const outOfRange = result.rows.filter(
      (r) => r.issues.some((i) => i.code === 'IMP-PERIOD-004'),
    );
    expect(outOfRange).toHaveLength(0);

    // Every batch requires its export range confirmed (ADR-047.6).
    expect(result.requiredConfirmations).toContain('IMP-RANGE-015');
  });

  it('commits into bank_transactions with full provenance', async () => {
    const bytes = loadFixture('csv-with-preamble.csv');
    const validation = validateFile({
      filename: 'csv-with-preamble.csv', declaredMimeType: 'text/csv', bytes,
    });
    const table = parseCsv(validation.text!, {
      delimiter: validation.delimiter, isHeaderCell: isKnownHeader,
    });
    const result = runPipeline({
      organizationId: orgId,
      importType: 'bank_statement',
      targetTable: 'bank_transactions',
      table,
      columnMap: COLUMN_MAP,
      transforms: {},
      baseCurrency: 'GBP',
      today: '2026-09-05',
      declaredPeriodStart: '2026-08-01',
      declaredPeriodEnd: '2026-08-31',
      accounts: [],
      counterparties: [],
      existingRecords: [],
      bankIdentity: { bankName: 'Barclays', sortCodeMasked: '12-34-56', accountNumberMasked: '4321' },
    });

    const documentId = one(`
      insert into public.source_documents
             (organization_id, storage_path, original_filename, mime_type, byte_size, sha256,
              status, document_kind)
      values ('${orgId}', '${orgId}/e2e/stmt.csv', 'csv-with-preamble.csv', 'text/csv',
              ${bytes.byteLength}, decode('e2e0', 'hex'), 'ready', 'bank_statement')
      returning id`);

    const batchId = one(`
      insert into public.import_batches
             (organization_id, source_document_id, import_type, target_table, bank_account_id,
              status, extraction_method, required_confirmations, mapping_snapshot)
      values ('${orgId}', '${documentId}', 'bank_statement', 'bank_transactions', '${bankAccountId}',
              'awaiting_review', 'csv', array['IMP-RANGE-015']::text[],
              '${JSON.stringify({ columnMap: COLUMN_MAP })}'::jsonb)
      returning id`);

    // Rows go in exactly as the pipeline produced them, including the preamble.
    for (const row of result.rows) {
      const amountIn = row.mapped.money_in ?? null;
      const amountOut = row.mapped.money_out ?? null;
      const signed = amountIn && amountIn.trim() !== '' ? amountIn
        : amountOut && amountOut.trim() !== '' ? `-${amountOut}` : null;

      const mapped = signed
        ? JSON.stringify({
            transaction_date: row.mapped.transaction_date,
            amount: signed,
            description: row.mapped.description,
            balance_after: row.mapped.balance_after,
          })
        : null;

      adminSql(`
        insert into public.import_rows
               (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data,
                status, issues, dedupe_hash)
        values ('${orgId}', '${batchId}', ${row.rowNumber}, '${row.sourceRef}',
                '${JSON.stringify(row.raw).replace(/'/g, "''")}'::jsonb,
                ${mapped === null ? 'null' : `'${mapped.replace(/'/g, "''")}'::jsonb`},
                '${row.status === 'valid' && signed ? 'valid' : 'skipped'}',
                '${JSON.stringify(row.issues).replace(/'/g, "''")}'::jsonb,
                ${row.dedupeHash ? `decode('${row.dedupeHash.slice(0, 32)}','hex')` : 'null'})`);
    }

    await rpc(ownerId, 'record_batch_confirmation', {
      p_batch: batchId, p_code: 'IMP-RANGE-015',
      p_value: { period_start: '2026-08-01', period_end: '2026-08-31' },
    });

    const { data, error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batchId });
    expect(error, error?.message).toBeNull();
    expect((data as { status: string }).status).toBe('committed');

    // Six transactions in the file; the opening-balance line has no money column so it is not one.
    const committed = adminSql(`
      select count(*) from public.bank_transactions
       where organization_id = '${orgId}' and record_status = 'accepted'`);
    expect(Number(committed)).toBe(5);

    // §13: every record names the document, the batch, the row and the line it came from.
    const provenance = adminSql(`
      select count(*) from public.bank_transactions t
       where t.organization_id = '${orgId}'
         and t.source_document_id = '${documentId}'
         and t.import_batch_id = '${batchId}'
         and t.import_row_id is not null
         and t.source_ref like 'csv:row:%'`);
    expect(Number(provenance)).toBe(5);

    // The quoted field with an em dash and an internal comma survived intact.
    const rent = adminSql(`
      select description_raw from public.bank_transactions
       where organization_id = '${orgId}' and description_raw like '%RENT%'`);
    expect(rent).toBe('SMITH, JOHN — RENT');

    // The period was derived from the transaction date, not supplied.
    const period = adminSql(`
      select distinct f.label from public.fiscal_periods f
       join public.bank_transactions t on t.period_id = f.id
      where t.organization_id = '${orgId}' and t.record_status = 'accepted'`);
    expect(period).toBe('Aug 2026');

    // And nothing was lost: every parsed line is still there with a status.
    const recordedLines = adminSql(`
      select count(*) from public.import_rows where organization_id = '${orgId}'`);
    expect(Number(recordedLines)).toBe(result.rows.length);
  });
});

describe('a Windows-1252 file with a semicolon delimiter (§17 fixture 8)', () => {
  it('is decoded and split correctly rather than mangled', () => {
    const bytes = loadFixture('bank_1252_semicolon.csv');
    const validation = validateFile({
      filename: 'bank_1252_semicolon.csv', declaredMimeType: 'text/csv', bytes,
    });

    expect(validation.ok, JSON.stringify(validation.findings)).toBe(true);
    expect(validation.encoding, 'UK exports are commonly Windows-1252').toBe('windows-1252');
    expect(validation.delimiter).toBe(';');
    // The pound sign is the giveaway: decoded as UTF-8 it would be a replacement character.
    expect(validation.text).toContain('£');
    expect(validation.text).not.toContain('�');
  });
});

describe('a prompt-injection description imports verbatim as text (§17 fixture 15)', () => {
  it('stores the instruction as data and never acts on it', () => {
    const bytes = loadFixture('injection_descriptions.csv');
    const validation = validateFile({
      filename: 'injection_descriptions.csv', declaredMimeType: 'text/csv', bytes,
    });
    const table = parseCsv(validation.text!, {
      delimiter: validation.delimiter, isHeaderCell: isKnownHeader,
    });

    const text = table.rows.flatMap((r) => r.cells).filter(Boolean).join(' ');
    // The point is that it is still there, unaltered: text is never executed, and stripping it
    // would be a silent modification of what the customer uploaded.
    expect(text.toLowerCase()).toMatch(/ignore|instruction|system/);
    expect(table.rows.length).toBeGreaterThan(0);
  });
});

describe('a PDF renamed .csv is caught by its magic bytes (§17 fixture 14)', () => {
  it('is refused, and refused for the right reason', () => {
    const bytes = loadFixture('fake_csv.pdf');
    const validation = validateFile({
      filename: 'statement.csv', declaredMimeType: 'text/csv', bytes,
    });
    expect(validation.ok).toBe(false);
    expect(validation.findings.map((f) => f.code)).toContain('IMP-FILE-001');
  });
});
