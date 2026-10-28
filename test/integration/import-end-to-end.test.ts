import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  isKnownHeader, parseCsv, runPipeline, suggestColumns, type TargetField,
} from '@/modules/imports';
import { validateFile } from '@/modules/documents';
import { orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, fs, rpc as call } from './setup';
import { makeOrg, seedBankAccount } from './f-fixtures';
import { seedBatch, seedDocument, seedRows, where } from './i-fixtures';

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

const RUN = `ie${Date.now().toString(36)}`;
let ownerId: string;
let orgId: string;
let bankAccountId: string;

const rpc = (userId: string, fn: string, args: Record<string, unknown> = {}) => call(clientFor(userId), fn, args);

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${RUN}.e2e.itest.motion`);
  orgId = await makeOrg(ownerId, `ITest End To End ${RUN}`);
  bankAccountId = await seedBankAccount(orgId, {
    name: 'Business Current', bankName: 'Barclays', sortCode: '12-34-56', accountNumber: '4321',
  });
}, 60_000);

afterAll(async () => {
  const jobs = await fs().collection('jobs').where('organization_id', '==', orgId).get();
  await Promise.all(jobs.docs.map((d) => d.ref.delete()));
  await deleteOrg(orgId);
});

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

    const documentId = await seedDocument(orgId, {
      filename: 'csv-with-preamble.csv', byteSize: bytes.byteLength, kind: 'bank_statement',
    });
    const batchId = await seedBatch(orgId, {
      importType: 'bank_statement', bankAccountId, documentId, required: ['IMP-RANGE-015'],
      periodStart: null, periodEnd: null,
    });

    // Rows go in exactly as the pipeline produced them, including the preamble.
    await seedRows(orgId, batchId, result.rows.map((row) => {
      const amountIn = row.mapped.money_in ?? null;
      const amountOut = row.mapped.money_out ?? null;
      const signed = amountIn && amountIn.trim() !== '' ? amountIn
        : amountOut && amountOut.trim() !== '' ? `-${amountOut}` : null;
      return {
        rowNumber: row.rowNumber,
        mapped: signed ? {
          transaction_date: row.mapped.transaction_date ?? null, amount: signed,
          description: row.mapped.description ?? null, balance_after: row.mapped.balance_after ?? null,
        } : null,
        status: row.status === 'valid' && signed ? 'valid' : 'skipped',
        issues: JSON.parse(JSON.stringify(row.issues)) as unknown[],
        hash: row.dedupeHash ? row.dedupeHash.slice(0, 32) : null,
      };
    }));
    // seedRows names each row `csv:row:<n>`, which is what the pipeline produced.
    for (const row of result.rows) expect(row.sourceRef).toBe(`csv:row:${row.rowNumber}`);

    await rpc(ownerId, 'record_batch_confirmation', {
      p_batch: batchId, p_code: 'IMP-RANGE-015',
      p_value: { period_start: '2026-08-01', period_end: '2026-08-31' },
    });

    const { data, error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batchId });
    expect(error, error?.message).toBeNull();
    expect((data as { status: string }).status).toBe('committed');

    // Six transactions in the file; the opening-balance line has no money column so it is not one.
    const committed = await where(orgId, 'bank_transactions', { record_status: 'accepted' });
    expect(committed).toHaveLength(5);

    // §13: every record names the document, the batch, the row and the line it came from.
    const provenance = committed.filter((t) => t.source_document_id === documentId && t.import_batch_id === batchId
      && t.import_row_id && String(t.source_ref).startsWith('csv:row:'));
    expect(provenance).toHaveLength(5);

    // The quoted field with an em dash and an internal comma survived intact.
    const rent = committed.filter((t) => String(t.description_raw).includes('RENT')).map((t) => t.description_raw);
    expect(rent).toEqual(['SMITH, JOHN — RENT']);

    // The period was derived from the transaction date, not supplied.
    const periods = [...new Set(committed.map((t) => String(t.period_id)))];
    const labels = await Promise.all(periods.map(async (p) => (await orgRow(fs(), orgId, 'fiscal_periods', p).get()).get('label')));
    expect(labels).toEqual(['Aug 2026']);

    // And nothing was lost: every parsed line is still there with a status.
    expect(await where(orgId, 'import_rows', { batch_id: batchId })).toHaveLength(result.rows.length);
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
