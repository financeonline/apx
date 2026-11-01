import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_KINDS, IMPORT_TARGET, IMPORT_TYPES, IMPORT_TYPE_SPECS, assertImportSupported, isDocumentKind, proposeColumnMap,
  pdfHandling, targetFor,
} from '@/modules/imports';
import { ValidationError } from '@/core/errors';
import {
  DOCUMENT_KINDS as DB_DOCUMENT_KINDS, IMPORT_TYPES as DB_IMPORT_TYPES, importTargetOf,
} from '@/db/app/imports-shared';
import { INVOICE_TYPES } from '@/db/app/imports-records';

/**
 * One table decides each import type's record target, source-document kind and invoice side
 * (`IMPORT_TYPE_SPECS`). Its twin facts live in the database layer (`src/db`, the port of the SQL
 * enums and of `api.start_import_batch`), so this file checks the table against THOSE: the wizard
 * once kept a private copy of the target map that disagreed with `api.start_import_batch` for
 * receipts and both reports, and passed the import type as a `document_kind_enum` value — which it
 * is not for invoice lists and receipts.
 */

/** The enum values the database layer accepts. */
const ENUMS: Record<string, readonly string[]> = {
  import_type_enum: DB_IMPORT_TYPES,
  document_kind_enum: DB_DOCUMENT_KINDS,
  invoice_type_enum: INVOICE_TYPES,
};
function enumValues(name: string): string[] {
  const values = ENUMS[name];
  if (!values) throw new Error(`${name} is not defined`);
  return [...values];
}

/** `api.start_import_batch`'s target for every type, as the database layer computes it. */
function sqlTargets(): Record<string, string> {
  return Object.fromEntries(DB_IMPORT_TYPES.map((t) => [t, importTargetOf(t)]));
}

describe('the import type table agrees with the database', () => {
  it('covers every value of import_type_enum, and nothing else', () => {
    expect([...IMPORT_TYPES].sort()).toEqual(enumValues('import_type_enum').sort());
  });

  it('sends every type to the table api.start_import_batch records', () => {
    const sql = sqlTargets();
    for (const type of IMPORT_TYPES) {
      expect(IMPORT_TYPE_SPECS[type].target, type).toBe(sql[type]);
      // The wizard's validation target and the barrel's map read the same table.
      expect(targetFor(type), type).toBe(sql[type]);
      expect(IMPORT_TARGET[type], type).toBe(sql[type]);
    }
  });

  it('registers every upload with a real document_kind_enum value', () => {
    const kinds = new Set(enumValues('document_kind_enum'));
    for (const type of IMPORT_TYPES) {
      expect(kinds.has(IMPORT_TYPE_SPECS[type].documentKind), `${type} → ${IMPORT_TYPE_SPECS[type].documentKind}`).toBe(true);
    }
    // The three that failed the cast before: the type name is not a kind.
    expect(kinds.has('sales_invoices')).toBe(false);
    expect(kinds.has('receipts')).toBe(false);
    expect(IMPORT_TYPE_SPECS.sales_invoices.documentKind).toBe('invoice');
    expect(IMPORT_TYPE_SPECS.purchase_invoices.documentKind).toBe('invoice');
    expect(IMPORT_TYPE_SPECS.receipts.documentKind).toBe('receipt');
  });

  it('gives every invoice-target type a side, and no other type one', () => {
    const sides = new Set(enumValues('invoice_type_enum'));
    for (const type of IMPORT_TYPES) {
      const spec = IMPORT_TYPE_SPECS[type];
      if (spec.target === 'invoices') {
        expect(spec.invoiceSide, type).not.toBeNull();
        expect(sides.has(spec.invoiceSide!)).toBe(true);
        expect(sides.has(`${spec.invoiceSide!}_credit_note`)).toBe(true);
      } else {
        expect(spec.invoiceSide, type).toBeNull();
      }
    }
  });

  it('asks for a bank account exactly where the database requires one', () => {
    // `api.start_import_batch` refuses a bank_transactions batch without an account.
    for (const type of IMPORT_TYPES) {
      expect(IMPORT_TYPE_SPECS[type].bankAccount === 'required', type)
        .toBe(IMPORT_TYPE_SPECS[type].target === 'bank_transactions');
    }
  });

  it('offers every type on the upload form, with the bank account question driven by the table', () => {
    const form = readFileSync(
      path.resolve(process.cwd(), 'src/app/app/[orgSlug]/data/imports/new/upload-form.tsx'), 'utf8');
    const offered = [...form.matchAll(/value: '([a-z_]+)'/g)].map((m) => m[1]!);
    // Every type the agreement's §8 lists, balance sheets included.
    expect(offered.sort()).toEqual([...IMPORT_TYPES].sort());
    expect(form).not.toMatch(/importType === 'receipts'/);
    // The picker accepts PDFs; whether one is READ is the server's decision (pdfSupported).
    expect(form).toMatch(/accept="[^"]*\.pdf/);
  });
});

describe('combinations MOTION cannot import are refused before anything is stored', () => {
  const ok = { bankAccountId: null };

  it('refuses a type the form did not offer', () => {
    expect(() => assertImportSupported({ ...ok, importType: 'payroll' })).toThrow(ValidationError);
    expect(() => assertImportSupported({ ...ok, importType: '' })).toThrow('Choose what kind of file');
  });

  it('needs a bank account for a statement, and refuses one anywhere else', () => {
    expect(() => assertImportSupported({ ...ok, importType: 'bank_statement' })).toThrow('bank account');
    expect(assertImportSupported({ importType: 'bank_statement', bankAccountId: 'b' })).toBe('bank_statement');
    for (const type of IMPORT_TYPES.filter((t) => t !== 'bank_statement')) {
      expect(() => assertImportSupported({ importType: type, bankAccountId: 'b' }), type)
        .toThrow('not imported into a bank account');
      expect(assertImportSupported({ ...ok, importType: type }), type).toBe(type);
    }
  });

  it('refuses a range that ends before it starts, or is not two dates — before the file is stored', () => {
    const gl = { ...ok, importType: 'general_ledger' };
    expect(() => assertImportSupported({ ...gl, periodStart: '2026-09-30', periodEnd: '2026-01-01' }))
      .toThrow('cannot be before the first');
    expect(() => assertImportSupported({ ...gl, periodStart: '', periodEnd: '2026-01-01' }))
      .toThrow('first and last day');
    expect(assertImportSupported({ ...gl, periodStart: '2026-01-01', periodEnd: '2026-01-01' })).toBe('general_ledger');
    expect(assertImportSupported(gl)).toBe('general_ledger');
  });

  it('reads PDF figures for bank statements; receipts are read with AI on request (ADR-150); every other PDF is stored, not read', () => {
    for (const type of IMPORT_TYPES) {
      expect(pdfHandling(type), type).toBe(type === 'bank_statement' ? 'read' : type === 'receipts' ? 'read_on_request' : 'store_only');
    }
  });
});

describe('the document kinds the app sends are the database\'s', () => {
  it('DOCUMENT_KINDS is document_kind_enum, value for value', () => {
    expect([...DOCUMENT_KINDS].sort()).toEqual(enumValues('document_kind_enum').sort());
    expect(isDocumentKind('invoice')).toBe(true);
    expect(isDocumentKind('sales_invoices')).toBe(false);
  });
});

describe('a ledger that names its accounts only by code', () => {
  const table = (columns: string[]) => ({ columns, rows: [] }) as unknown as Parameters<typeof proposeColumnMap>[0];

  it('reads the code as the account when no column names one (fixtures/imports/gl_unmapped_accounts.xlsx)', () => {
    const map = proposeColumnMap(table(['Date', 'Journal', 'Code', 'Description', 'Debit', 'Credit']), 'general_ledger');
    expect(map.Code).toBe('account');
  });

  it('keeps the code as the code when an account column is there too', () => {
    const map = proposeColumnMap(table(['Date', 'Code', 'Account', 'Debit', 'Credit']), 'general_ledger');
    expect(map.Code).toBe('code');
    expect(map.Account).toBe('account');
  });
});
