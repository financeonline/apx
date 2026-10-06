import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_KINDS, IMPORT_TARGET, IMPORT_TYPES, IMPORT_TYPE_SPECS, assertImportSupported, isDocumentKind,
  pdfHandling, targetFor,
} from '@/modules/imports';
import { ValidationError } from '@/core/errors';

/**
 * One table decides each import type's record target, source-document kind and invoice side
 * (`IMPORT_TYPE_SPECS`). Its twin facts live in SQL, so this file reads the migrations themselves:
 * the wizard once kept a private copy of the target map that disagreed with `api.start_import_batch`
 * for receipts and both reports, and passed the import type as a `document_kind_enum` value — which
 * it is not for invoice lists and receipts. Neither drift was visible to a test that only compared
 * TypeScript with TypeScript.
 */

const MIGRATIONS = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

/** The newest definition of a function, as the database ends up with it. */
function latestDefinition(fn: string): string {
  let found: string | null = null;
  for (const file of migrationFiles) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const start = sql.search(new RegExp(`create (or replace )?function ${fn.replace('.', '\\.')}\\(`));
    if (start >= 0) found = sql.slice(start);
  }
  if (found === null) throw new Error(`${fn} is not defined in any migration`);
  return found.slice(0, found.indexOf('$$;') + 3);
}

/** The enum's values as the database ends up with them: its CREATE, plus every later ADD VALUE. */
function enumValues(name: string): string[] {
  let values: string[] | null = null;
  for (const file of migrationFiles) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const match = new RegExp(`create type public\\.${name} as enum\\s*\\(([^)]*)\\)`).exec(sql);
    if (match) values = [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    for (const added of sql.matchAll(new RegExp(`alter type public\\.${name} add value (?:if not exists )?'([a-z_]+)'`, 'g'))) {
      if (values !== null && !values.includes(added[1]!)) values.push(added[1]!);
    }
  }
  if (values === null) throw new Error(`${name} is not defined`);
  return values;
}

/** `api.start_import_batch`'s CASE, read as the database will execute it. */
function sqlTargets(): Record<string, string> {
  const body = latestDefinition('api.start_import_batch');
  const block = /v_target := case p_import_type([\s\S]*?)end::public\.import_target_enum/.exec(body);
  if (!block) throw new Error('the target CASE was not found');
  const cases = Object.fromEntries(
    [...block[1]!.matchAll(/when '([a-z_]+)' then '([a-z_]+)'/g)].map((m) => [m[1]!, m[2]!]),
  );
  const fallback = /else '([a-z_]+)'/.exec(block[1]!)![1]!;
  return Object.fromEntries(IMPORT_TYPES.map((t) => [t, cases[t] ?? fallback]));
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

  it('reads PDF figures for bank statements only; every other PDF is stored, not read', () => {
    for (const type of IMPORT_TYPES) {
      expect(pdfHandling(type), type).toBe(type === 'bank_statement' ? 'read' : 'store_only');
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
