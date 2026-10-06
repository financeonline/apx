/**
 * Duplicate detection (IMPORT_ENGINE.md §9; CD-12, ADR-029).
 *
 * Pure. The hash is computed here at validation and stored on `import_rows.dedupe_hash`; the commit
 * transaction re-runs the checks in SQL by comparing STORED hashes, so there is no second
 * implementation of this recipe to drift (§9.3).
 *
 * The recipe is versioned. Changing any step below without bumping DEDUPE_VERSION would silently
 * reclassify every future import against differently-computed history.
 */

import { createHash } from 'node:crypto';
import type { FinancialRecordTable } from '@/modules/financials';
import type { RowIssue, ValidatedRow } from './pipeline-types';

export const DEDUPE_VERSION = 'dedupe.v1';

/**
 * The stable identity of the thing a row is about — deliberately NEVER a uuid (finding F-B-12).
 *
 * A uuid changes when an account is renamed and re-created, or when a bank account record is
 * remade, and the duplicate check would then miss a genuine re-import. Ledger and balance rows use
 * the account code where present, else the normalised account name; bank rows use the masked bank
 * identity; invoices use the invoice type.
 */
export interface ScopeKeyInput {
  readonly targetTable: FinancialRecordTable;
  readonly accountCode?: string | null;
  readonly accountNormalizedName?: string | null;
  readonly bankName?: string | null;
  readonly sortCodeMasked?: string | null;
  readonly accountNumberMasked?: string | null;
  readonly invoiceType?: string | null;
}

/**
 * ADR-047.12: "HSBC UK" and "HSBC" are one bank. Normalising the name is what lets a statement
 * re-imported under a renamed bank still be caught by the re-export check.
 */
export function normalizeBankName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(uk|plc|bank|ltd)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scopeKey(input: ScopeKeyInput): string {
  switch (input.targetTable) {
    case 'ledger_entries':
    case 'period_balances':
    case 'budget_lines': {
      const code = (input.accountCode ?? '').trim();
      return code !== '' ? `code:${code.toLowerCase()}` : `name:${input.accountNormalizedName ?? ''}`;
    }
    case 'bank_transactions':
      return [
        'bank',
        normalizeBankName(input.bankName),
        (input.sortCodeMasked ?? '').replace(/\D/g, ''),
        (input.accountNumberMasked ?? '').replace(/\D/g, ''),
      ].join(':');
    case 'invoices':
      return `invoice:${input.invoiceType ?? ''}`;
  }
}

/**
 * The description reduced to what identifies the payment rather than the export.
 *
 * Long digit runs and card-terminal suffixes are removed because the same payment appears with a
 * different transaction id in each export; leaving them in would make every re-import look new.
 */
export function normalizeDescription(description: string | null | undefined): string {
  return (description ?? '')
    .normalize('NFKC')
    .toLowerCase()
    // Card terminal and reference suffixes, before the general digit-run rule so `ref 000123` goes
    // as a unit rather than leaving a stray `ref`.
    .replace(/\*\d{3,}/g, ' ')
    .replace(/\b(ref|reference)\s*[:#]?\s*\d{3,}\b/g, ' ')
    .replace(/\d{6,}/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DedupeKeyInput extends ScopeKeyInput {
  readonly organizationId: string;
  /** transaction_date / entry_date / issue_date / period_start, ISO. */
  readonly date: string;
  /** Absolute value, two decimal places, as a string. */
  readonly amount: string;
  /** inflow/outflow, debit/credit, or the invoice type. */
  readonly direction: string;
  readonly description?: string | null;
  /** For invoices `norm_desc` is replaced by the invoice number (§9.1). */
  readonly invoiceNumber?: string | null;
}

/** Absolute value at two decimal places, as a string — never a JS number (ADR-006). */
export function absoluteAmountKey(amount: string): string {
  const trimmed = amount.trim().replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return `${whole || '0'}.${(fraction + '00').slice(0, 2)}`;
}

export function dedupeHash(input: DedupeKeyInput): string {
  const descriptorPart =
    input.targetTable === 'invoices'
      ? (input.invoiceNumber ?? '').trim().toLowerCase()
      : normalizeDescription(input.description);

  const key = [
    input.organizationId,
    input.targetTable,
    scopeKey(input),
    input.date,
    absoluteAmountKey(input.amount),
    input.direction,
    descriptorPart,
  ].join('|');

  return createHash('sha256').update(key, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------
// The passes (§9.2)
// ---------------------------------------------------------------------------------------------

/** An accepted record already in the database, as far as duplicate detection needs to know. */
export interface ExistingRecord {
  readonly id: string;
  readonly dedupeHash: string;
  readonly date: string;
  readonly amount: string;
  readonly scopeKey: string;
  readonly normalizedDescription: string;
}

/** An accepted invoice, for the update-candidate pass. */
export interface ExistingInvoice {
  readonly id: string;
  readonly invoiceType: string;
  readonly counterpartyKey: string;
  readonly invoiceNumber: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly paidDate: string | null;
  readonly dueDate: string | null;
  readonly status: string;
}

export interface DedupeCandidateRow {
  readonly rowNumber: number;
  readonly dedupeHash: string;
  readonly date: string;
  readonly amount: string;
  readonly scopeKey: string;
  readonly normalizedDescription: string;
  /** Invoice identity, for pass 1. */
  readonly invoiceType?: string;
  readonly counterpartyKey?: string;
  readonly invoiceNumber?: string;
  readonly totalAmount?: string;
  readonly amountPaid?: string;
  readonly paidDate?: string | null;
  readonly dueDate?: string | null;
  readonly status?: string;
}

export interface DedupeOutcome {
  readonly rowNumber: number;
  readonly issues: readonly RowIssue[];
  readonly status: ValidatedRow['status'];
  readonly suggestedDecision?: 'keep' | 'skip';
  readonly suggestedReason?: string;
  readonly duplicateOfTable?: FinancialRecordTable;
  readonly duplicateOfId?: string;
  readonly duplicateWithinBatchRow?: number;
}

/** The fields whose change makes a re-exported invoice an UPDATE rather than a duplicate (§9.2). */
const INVOICE_MUTABLE_FIELDS = ['totalAmount', 'amountPaid', 'paidDate', 'dueDate', 'status'] as const;

function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/**
 * A batch of identical rows on one day is usually real: a payroll run, rent for several units, a
 * batch supplier payment (finding F-B-17). Defaulting those to `skip` would silently halve a
 * payroll, so within-batch duplicates default to KEEP under these conditions.
 */
function isLegitimateRepeat(rows: readonly DedupeCandidateRow[]): boolean {
  if (rows.length >= 3) return true;
  return rows.some((r) => /payroll|salary|wages/.test(r.normalizedDescription));
}

export interface DedupeInput {
  readonly targetTable: FinancialRecordTable;
  readonly rows: readonly DedupeCandidateRow[];
  readonly existingRecords: readonly ExistingRecord[];
  readonly existingInvoices?: readonly ExistingInvoice[];
}

/**
 * Runs passes 1–4 in order. The order matters: an invoice whose payment has been applied must be
 * recognised as an UPDATE before the exact-duplicate pass sees it, or the normal monthly re-export
 * of an invoice list would be rejected wholesale.
 */
export function detectDuplicates(input: DedupeInput): DedupeOutcome[] {
  const byHash = new Map<string, ExistingRecord>();
  for (const record of input.existingRecords) {
    if (!byHash.has(record.dedupeHash)) byHash.set(record.dedupeHash, record);
  }

  const invoicesByIdentity = new Map<string, ExistingInvoice>();
  for (const invoice of input.existingInvoices ?? []) {
    invoicesByIdentity.set(
      `${invoice.invoiceType}|${invoice.counterpartyKey}|${invoice.invoiceNumber.toLowerCase()}`,
      invoice,
    );
  }

  const seenInBatch = new Map<string, DedupeCandidateRow[]>();
  for (const row of input.rows) {
    const group = seenInBatch.get(row.dedupeHash);
    if (group) group.push(row);
    else seenInBatch.set(row.dedupeHash, [row]);
  }

  const outcomes: DedupeOutcome[] = [];

  for (const row of input.rows) {
    // ---- Pass 1: invoice update candidates, BEFORE the exact-duplicate pass (§9.2, F-B-03) ----
    if (input.targetTable === 'invoices' && row.invoiceNumber) {
      const identity = `${row.invoiceType}|${row.counterpartyKey}|${row.invoiceNumber.toLowerCase()}`;
      const existing = invoicesByIdentity.get(identity);
      if (existing) {
        const changed = INVOICE_MUTABLE_FIELDS.filter((field) => {
          const before = existing[field] ?? null;
          const after = (row[field] ?? null) as string | null;
          return before !== after;
        });

        if (changed.length > 0) {
          outcomes.push({
            rowNumber: row.rowNumber,
            status: 'warning',
            suggestedDecision: 'keep',
            duplicateOfTable: 'invoices',
            duplicateOfId: existing.id,
            issues: [{
              code: 'IMP-INV-010',
              severity: 'warning',
              message:
                'This invoice already exists with different details; importing it will update the earlier record.',
              suggestion: changed.join(', '),
            }],
          });
          continue;
        }

        // Identical in every mutable field: a genuine duplicate, not an update.
        outcomes.push({
          rowNumber: row.rowNumber,
          status: 'duplicate',
          suggestedDecision: 'skip',
          duplicateOfTable: 'invoices',
          duplicateOfId: existing.id,
          issues: [{
            code: 'IMP-DUP-001',
            severity: 'duplicate',
            message: 'This invoice has already been imported.',
          }],
        });
        continue;
      }
    }

    // ---- Pass 2: cross-batch exact ----
    const existing = byHash.get(row.dedupeHash);
    if (existing) {
      outcomes.push({
        rowNumber: row.rowNumber,
        status: 'duplicate',
        suggestedDecision: 'skip',
        duplicateOfTable: input.targetTable,
        duplicateOfId: existing.id,
        issues: [{
          code: 'IMP-DUP-001',
          severity: 'duplicate',
          message: 'This row matches a record already imported.',
        }],
      });
      continue;
    }

    // ---- Pass 3: within-batch exact ----
    const group = seenInBatch.get(row.dedupeHash) ?? [];
    if (group.length > 1 && group[0]!.rowNumber !== row.rowNumber) {
      const legitimate = isLegitimateRepeat(group);
      outcomes.push({
        rowNumber: row.rowNumber,
        status: 'duplicate',
        suggestedDecision: legitimate ? 'keep' : 'skip',
        suggestedReason: legitimate ? 'batch payment' : undefined,
        duplicateWithinBatchRow: group[0]!.rowNumber,
        issues: [{
          code: 'IMP-DUP-002',
          severity: 'duplicate',
          message: 'This row is identical to another row in this file.',
          suggestion: legitimate
            ? 'Several identical payments on one day are usually a batch payment, so this is kept by default.'
            : undefined,
        }],
      });
      continue;
    }

    // ---- Pass 4: fuzzy, ±1 day ----
    const fuzzy = input.existingRecords.find(
      (record) =>
        record.scopeKey === row.scopeKey &&
        absoluteAmountKey(record.amount) === absoluteAmountKey(row.amount) &&
        record.normalizedDescription === row.normalizedDescription &&
        record.date !== row.date &&
        daysApart(record.date, row.date) <= 1,
    );
    if (fuzzy) {
      outcomes.push({
        rowNumber: row.rowNumber,
        status: 'warning',
        // Default KEEP: a payment a day apart is more often a second real payment than a
        // re-dated duplicate, and skipping it would lose money from the figures.
        suggestedDecision: 'keep',
        duplicateOfTable: input.targetTable,
        duplicateOfId: fuzzy.id,
        issues: [{
          code: 'IMP-DUP-003',
          severity: 'warning',
          message: 'A very similar record exists one day apart.',
        }],
      });
      continue;
    }

    outcomes.push({ rowNumber: row.rowNumber, status: 'valid', issues: [] });
  }

  return outcomes;
}

/**
 * Re-export detection, `IMP-COV-014` (§9.2 pass 5, batch level).
 *
 * The batch overlaps a committed batch of the same type by at least a full month, yet fewer than
 * half the overlapping rows matched as duplicates. That combination means the identities did not
 * line up — renamed accounts, or a second record for one real bank account — so importing both
 * would double-count the month.
 */
export interface OverlapInput {
  readonly overlappingMonths: number;
  readonly rowsInOverlap: number;
  readonly duplicatesInOverlap: number;
  readonly earlierBatchId: string;
}

export function detectReExport(input: OverlapInput): boolean {
  if (input.overlappingMonths < 1 || input.rowsInOverlap === 0) return false;
  return input.duplicatesInOverlap / input.rowsInOverlap < 0.5;
}
