/**
 * Row and batch validation (IMPORT_ENGINE.md §8).
 *
 * Pure: `mapped_data` in, `issues[]` out. Every code in §8.1 and §8.2 is implemented here, and the
 * severity decides what happens:
 *   error         blocks commit of that row (field-level) or of the batch (batch-level)
 *   warning       never blocks; shown, and inherited into data_quality where relevant
 *   duplicate     handled by dedupe.ts; the row commits only on an explicit `keep`
 *   confirmation  blocks commit until a human records the decision
 *
 * Nothing here ever drops a row. An invalid row becomes an `error` row that a reviewer must fix or
 * skip, and a skip is recorded with a reason. That is the difference between an import engine and a
 * data-loss engine (SOW §23).
 */

import { Decimal, parseDecimalOrNull, tryParseDecimal } from '@/core/money';

/**
 * A non-throwing parse.
 *
 * `parseDecimalOrNull` returns null for a MISSING value but raises for an unreadable one — correct
 * at a data-access boundary, where rubbish is a bug. Here it is the opposite: an unreadable amount
 * is the ordinary case this function exists to report, and throwing would abandon the whole row
 * instead of attaching `IMP-AMT-002` to it. Discarding a record because it is malformed is the one
 * thing this engine must never do (SOW §23).
 */
const readAmount = (value: string): Decimal | null => tryParseDecimal(value);
import type { StandardCategory } from '@/modules/financials';
import type {
  BatchIssue, MappedRow, RowIssue, ValidatedRow,
} from './pipeline-types';
import { IMPORT_TYPE_SPECS, type ImportTarget, type ImportType } from './types';
import { INVOICE_STATUSES } from './invoices';
import { nameFigureIssue } from './mapping/counterparty';

/** Required and optional target fields per import type (§6.1). */
export const REQUIRED_FIELDS: Readonly<Record<ImportType, readonly string[][]>> = {
  // Each inner array is an ALTERNATIVE set: satisfy any one of them.
  general_ledger: [['entry_date', 'account', 'debit', 'credit'], ['entry_date', 'account', 'amount']],
  receipts: [['entry_date', 'amount', 'account']],
  trial_balance: [['account', 'debit', 'credit'], ['account', 'closing_balance']],
  pnl_report: [['account', 'amount'], ['account', 'closing_balance']],
  balance_sheet: [['account', 'closing_balance'], ['account', 'amount']],
  bank_statement: [
    ['transaction_date', 'description', 'amount'],
    ['transaction_date', 'description', 'money_in', 'money_out'],
  ],
  sales_invoices: [['invoice_number', 'customer', 'issue_date', 'total_amount']],
  sales_report: [['invoice_number', 'customer', 'issue_date', 'total_amount']],
  purchase_invoices: [['invoice_number', 'supplier', 'issue_date', 'total_amount']],
  purchase_report: [['invoice_number', 'supplier', 'issue_date', 'total_amount']],
};

/** Which alternative set the mapping satisfies, or null when none is satisfied (§15 row 1). */
export function satisfiedFieldSet(
  importType: ImportType,
  mappedTargets: ReadonlySet<string>,
): readonly string[] | null {
  for (const alternative of REQUIRED_FIELDS[importType]) {
    if (alternative.every((field) => mappedTargets.has(field))) return alternative;
  }
  return null;
}

export interface RowValidationContext {
  readonly importType: ImportType;
  readonly targetTable: ImportTarget;
  readonly baseCurrency: string;
  /** The declared export range confirmed at IMP-RANGE-015 (ADR-047.6). */
  readonly declaredPeriodStart: string;
  readonly declaredPeriodEnd: string;
  /** "Today" is injected, never read from the clock, so validation is deterministic. */
  readonly today: string;
  /** Median absolute amount of the column, for the outlier check. */
  readonly amountMedian?: string;
  /** Accounts whose mapping resolved to `uncategorised` (§6.5). */
  readonly uncategorisedAccounts?: ReadonlySet<string>;
  /** Rows whose meaning changes under the other date ordering (§6.4). */
  readonly ambiguousDateRows?: ReadonlySet<number>;
  /** Rows the parser marked hidden in the source sheet. */
  readonly hiddenRows?: ReadonlySet<number>;
  /** Rows an AI extraction produced (§5.4). */
  readonly aiExtractedRows?: ReadonlySet<number>;
  readonly categoryOf?: (accountValue: string) => StandardCategory | undefined;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The date field that carries this import type's meaning. */
function primaryDateField(target: ImportTarget): string {
  switch (target) {
    case 'ledger_entries': return 'entry_date';
    case 'bank_transactions': return 'transaction_date';
    case 'invoices': return 'issue_date';
    case 'period_balances': return 'period_start';
  }
}

/** Validates one row. Returns every issue found; the caller derives the status. */
export function validateRow(
  row: { rowNumber: number; mapped: MappedRow; nonTabular?: boolean; fieldCountMismatch?: boolean },
  ctx: RowValidationContext,
  requiredFields: readonly string[],
): RowIssue[] {
  const issues: RowIssue[] = [];
  const value = (field: string): string | null => {
    const v = row.mapped[field];
    return v === undefined || v === null || v.trim() === '' ? null : v.trim();
  };

  // A non-tabular line is recorded rather than dropped, and is not validated as data (§5.1).
  if (row.nonTabular) {
    return [{
      code: 'IMP-ROW-005',
      severity: 'skipped',
      message: 'This line is not part of the table; it has been kept for reference but not imported.',
    }];
  }

  if (row.fieldCountMismatch) {
    issues.push({
      code: 'IMP-ROW-001',
      severity: 'error',
      message: 'This line has a different number of columns from the header.',
      suggestion: 'Check the raw text and correct it, or skip the row.',
    });
  }

  const populated = Object.values(row.mapped).filter((v) => v !== null && v.trim() !== '');
  if (populated.length === 0) {
    // Recorded, not dropped: the row count must still equal the source line count.
    return [{
      code: 'IMP-ROW-002',
      severity: 'warning',
      message: 'This row is blank.',
    }];
  }

  // Two of the §6.1 field sets name a PAIR of columns where a row legitimately fills only one:
  // a statement line is money in or money out, and a ledger line is a debit or a credit. The
  // requirement is that the columns are MAPPED — checked once per batch by satisfiedFieldSet — not
  // that every row populates both. Requiring both would fail every real bank statement laid out
  // with separate in and out columns, which is the commonest layout there is.
  const EITHER_OR: readonly (readonly [string, string])[] = [
    ['money_in', 'money_out'],
    ['debit', 'credit'],
  ];
  const pairPartner = new Map<string, string>();
  for (const [a, b] of EITHER_OR) {
    if (requiredFields.includes(a) && requiredFields.includes(b)) {
      pairPartner.set(a, b);
      pairPartner.set(b, a);
    }
  }
  const reportedPairs = new Set<string>();

  for (const field of requiredFields) {
    if (value(field) !== null) continue;

    const partner = pairPartner.get(field);
    if (partner !== undefined) {
      // Satisfied when either side of the pair carries a value.
      if (value(partner) !== null) continue;
      const pairKey = [field, partner].sort().join('|');
      if (reportedPairs.has(pairKey)) continue;
      reportedPairs.add(pairKey);
      issues.push({
        code: 'IMP-REQ-003',
        severity: 'error',
        field,
        message: `This row has neither ${field.replace(/_/g, ' ')} nor ${partner.replace(/_/g, ' ')}.`,
      });
      continue;
    }

    issues.push({
      code: 'IMP-REQ-003',
      severity: 'error',
      field,
      message: `${field.replace(/_/g, ' ')} is required and is empty.`,
    });
  }

  // ---- Dates ----
  const dateField = primaryDateField(ctx.targetTable);
  const dateValue = value(dateField);
  // A balance row's period comes from the file or from a one-month declared range (pipeline); with
  // neither, the database cannot assign a fiscal period, so the reviewer is asked here.
  if (dateValue === null && ctx.targetTable === 'period_balances' && populated.length > 0) {
    issues.push({
      code: 'IMP-PERIOD-005', severity: 'error', field: dateField,
      message: 'This balance has no period: the file has no period column and the declared range covers more than one month.',
      suggestion: 'Upload one month per file, or map the column that names each period.',
    });
  }
  if (dateValue !== null) {
    if (!isValidIsoDate(dateValue)) {
      issues.push({
        code: 'IMP-DATE-001',
        severity: 'error',
        field: dateField,
        message: 'This date could not be read in the format chosen for this column.',
      });
    } else {
      const ageDays = daysBetween(dateValue, ctx.today);
      if (ageDays > 5 * 365) {
        issues.push({
          code: 'IMP-DATE-002', severity: 'warning', field: dateField,
          message: 'This date is more than five years old.',
        });
      } else if (ageDays < -90) {
        issues.push({
          code: 'IMP-DATE-002', severity: 'warning', field: dateField,
          message: 'This date is more than 90 days in the future.',
        });
      }

      // The declared range is the contract for what this file covers (ADR-047.6). A row outside it
      // means the range is wrong or the row is, and either way a human must look.
      if (dateValue < ctx.declaredPeriodStart || dateValue > ctx.declaredPeriodEnd) {
        issues.push({
          code: 'IMP-PERIOD-004', severity: 'error', field: dateField,
          message: 'This date falls outside the period this file says it covers.',
          suggestion: 'Correct the declared period, or skip the row.',
        });
      }
    }
  }

  if (ctx.ambiguousDateRows?.has(row.rowNumber)) {
    issues.push({
      code: 'IMP-DATE-003', severity: 'warning', field: dateField,
      message: 'This date would be read differently if the day and month were the other way round.',
    });
  }

  if (ctx.hiddenRows?.has(row.rowNumber)) {
    issues.push({
      code: 'IMP-ROW-003', severity: 'warning',
      message: 'This row was hidden in the source sheet; it has still been imported.',
    });
  }

  if (ctx.aiExtractedRows?.has(row.rowNumber)) {
    issues.push({
      code: 'IMP-PDF-001', severity: 'warning',
      message: 'This row was read by AI; confirm it against the page.',
    });
  }

  // ---- Amounts ----
  const moneyIn = value('money_in');
  const moneyOut = value('money_out');
  if (moneyIn !== null && moneyOut !== null) {
    issues.push({
      code: 'IMP-AMT-002', severity: 'error',
      message: 'This row has a value in both the money-in and money-out columns.',
    });
  }

  for (const field of ['amount', 'total_amount', 'closing_balance', 'debit', 'credit'] as const) {
    const raw = value(field);
    if (raw === null) continue;
    const parsed = readAmount(raw);
    if (parsed === null) {
      issues.push({
        code: 'IMP-AMT-002', severity: 'error', field,
        message: `"${raw}" is not an amount MOTION can read.`,
      });
      continue;
    }
    if (parsed.isZero() && (field === 'amount' || field === 'total_amount')) {
      issues.push({ code: 'IMP-AMT-003', severity: 'warning', field, message: 'This amount is zero.' });
    }
    if (ctx.amountMedian && (field === 'amount' || field === 'total_amount')) {
      const median = readAmount(ctx.amountMedian);
      // A hundredfold outlier is usually a decimal or unit error — pence entered as pounds.
      if (median && !median.isZero() && parsed.abs().greaterThan(median.abs().times(100))) {
        issues.push({
          code: 'IMP-AMT-004', severity: 'warning', field,
          message: 'This amount is far larger than the others in this column; check the decimal point.',
        });
      }
    }
  }

  // ---- Currency ----
  const currency = value('currency');
  if (currency !== null && currency.toUpperCase() !== ctx.baseCurrency.toUpperCase()) {
    issues.push({
      code: 'IMP-CUR-007', severity: 'error', field: 'currency',
      message: `This row is in ${currency}, but this organization reports in ${ctx.baseCurrency}.`,
      suggestion: 'Multi-currency is not supported yet; convert the file or skip the row.',
    });
  }

  // ---- Accounts ----
  const account = value('account');
  if (ctx.targetTable === 'ledger_entries' || ctx.targetTable === 'period_balances') {
    if (account === null) {
      issues.push({
        code: 'IMP-ACCT-006', severity: 'error', field: 'account',
        message: 'This row has no account.',
      });
    } else if (ctx.uncategorisedAccounts?.has(account)) {
      issues.push({
        code: 'IMP-ACCT-005', severity: 'warning', field: 'account',
        message: `"${account}" is not mapped to a category yet, so figures that use it will be marked incomplete.`,
      });
    }
  }

  // ---- Invoices ----
  if (ctx.targetTable === 'invoices') {
    const total = readAmount(value('total_amount') ?? '');
    const paid = readAmount(value('amount_paid') ?? '');
    const subtotal = readAmount(value('subtotal') ?? '');
    const tax = readAmount(value('tax_amount') ?? '');

    if (total && paid && paid.abs().greaterThan(total.abs())) {
      issues.push({
        code: 'IMP-INV-008', severity: 'error', field: 'amount_paid',
        message: 'The amount paid is greater than the invoice total.',
      });
    }

    const issue = value('issue_date');
    const due = value('due_date');
    if (issue && due && isValidIsoDate(issue) && isValidIsoDate(due) && due < issue) {
      issues.push({
        code: 'IMP-INV-009', severity: 'warning', field: 'due_date',
        message: 'The due date is before the issue date.',
      });
    }

    // The pipeline reads a status it recognises into the enum; anything else would fail the cast
    // at commit and take the whole batch down with a Postgres sentence.
    const status = value('status');
    if (status && !(INVOICE_STATUSES as readonly string[]).includes(status)) {
      issues.push({
        code: 'IMP-INV-013', severity: 'error', field: 'status',
        message: `MOTION does not recognise the invoice status "${status}".`,
        suggestion: 'Use Open, Part paid, Paid or Void, or skip the row. A draft invoice has not been issued.',
      });
    }

    // `invoices.counterparty_id` is NOT NULL. The wizard creates the names a list introduces before
    // it validates (§6.6), so an unresolved name here is one that could not be created — and it
    // must stop the row, not the commit.
    const party = value('customer') ?? value('supplier') ?? value('counterparty');
    if (party && !value('counterparty_id')) {
      const role = IMPORT_TYPE_SPECS[ctx.importType].invoiceSide === 'purchase' ? 'supplier' : 'customer';
      issues.push(nameFigureIssue(party, role) ?? {
        code: 'IMP-CP-016', severity: 'error', field: role,
        message: `"${party}" could not be matched to or added as a ${role}.`,
        suggestion: 'Upload the file again, or correct the name.',
      });
    }

    // ADR-047.5: a subtotal of 0 alongside a positive total is treated as ABSENT, not as a
    // contradiction — many exports leave it blank as zero.
    const subtotalPresent = subtotal !== null && !subtotal.isZero();
    if (subtotalPresent && tax !== null && total !== null) {
      const expected = subtotal.plus(tax);
      if (expected.minus(total).abs().greaterThan(new Decimal('0.01'))) {
        issues.push({
          code: 'IMP-INV-011', severity: 'error',
          message: 'The subtotal and tax do not add up to the invoice total.',
        });
      }
    }
  }

  return issues;
}

/** Derives the row status from its issues and any duplicate outcome (§1.2). */
export function statusForIssues(
  issues: readonly RowIssue[],
  duplicateStatus?: ValidatedRow['status'],
): ValidatedRow['status'] {
  if (issues.some((i) => i.severity === 'skipped')) return 'skipped';
  if (issues.some((i) => i.severity === 'error')) return 'error';
  if (duplicateStatus === 'duplicate') return 'duplicate';
  if (issues.some((i) => i.severity === 'warning') || duplicateStatus === 'warning') return 'warning';
  return 'valid';
}

// ---------------------------------------------------------------------------------------------
// Batch-level checks (§8.2)
// ---------------------------------------------------------------------------------------------

export interface BatchCheckInput {
  readonly targetTable: ImportTarget;
  readonly importType: ImportType;
  /** Signed amounts of every row that will commit. */
  readonly amounts: readonly string[];
  readonly debits?: readonly string[];
  readonly credits?: readonly string[];
  /** Deterministic or reviewer-typed only — never AI-read (§5.4, F-C-03). */
  readonly openingBalance?: string | null;
  readonly closingBalance?: string | null;
  /** Running balances in row order, for the chain check. */
  readonly balanceChain?: readonly (string | null)[];
  /** Liability accounts reconcile as −Σ amount = closing − opening (ADR-028). */
  readonly liabilityAccount?: boolean;
  /**
   * §5.4: an AI-read statement cannot commit without balances at all — with neither a deterministic
   * capture nor a typed pair the gate is an ERROR that names what to do, not a warning.
   */
  readonly balancesRequired?: boolean;
  readonly journals?: ReadonlyArray<{ ref: string; debit: string; credit: string }>;
  readonly totalsBlocks?: ReadonlyArray<{ label: string; total: string; blockSum: string }>;
  readonly distinctMonths?: number;
  readonly isFanOut?: boolean;
  readonly confirmationsRecorded?: ReadonlySet<string>;
}

const TOLERANCE = new Decimal('0.01');

function sum(values: readonly string[]): Decimal {
  return values.reduce<Decimal>((acc, v) => {
    const parsed = readAmount(v);
    return parsed ? acc.plus(parsed) : acc;
  }, new Decimal(0));
}

export function checkBatch(input: BatchCheckInput): BatchIssue[] {
  const issues: BatchIssue[] = [];

  // ---- Bank statement reconciliation (IMP-BAL-006 / IMP-BAL-007) ----
  if (input.targetTable === 'bank_transactions') {
    const opening = parseDecimalOrNull(input.openingBalance ?? '');
    const closing = parseDecimalOrNull(input.closingBalance ?? '');

    if (opening === null || closing === null) {
      if (input.balancesRequired) {
        issues.push({
          code: 'IMP-BAL-006', severity: 'error',
          message: 'Enter the opening and closing balances printed on the statement.',
          detail: { suggestion: 'Rows read by AI cannot be imported until the statement balances have been entered from the page.' },
        });
      } else {
        // Not an error: an unreconciled statement still imports, but the warning follows the figures
        // all the way to the dashboard's data_quality (§5.3).
        issues.push({
          code: 'IMP-BAL-007', severity: 'warning',
          message: 'The statement opening and closing balances could not be read, so this import cannot be reconciled.',
          detail: { suggestion: 'Type the printed balances into the batch header to reconcile it.' },
        });
      }
    } else {
      const total = sum(input.amounts);
      const movement = input.liabilityAccount ? total.negated() : total;
      const expected = closing.minus(opening);
      if (movement.minus(expected).abs().greaterThan(TOLERANCE)) {
        issues.push({
          code: 'IMP-BAL-006', severity: 'error',
          message: 'The transactions do not add up to the difference between the opening and closing balances.',
          detail: {
            difference: movement.minus(expected).toFixed(2),
            expected: expected.toFixed(2),
            actual: movement.toFixed(2),
          },
        });
      }
    }

    // The running-balance chain is an independent check: it localises WHERE a statement broke.
    if (input.balanceChain && input.balanceChain.length > 1) {
      for (let i = 1; i < input.balanceChain.length; i += 1) {
        const previous = readAmount(input.balanceChain[i - 1] ?? '');
        const current = readAmount(input.balanceChain[i] ?? '');
        const amount = readAmount(input.amounts[i] ?? '');
        if (!previous || !current || !amount) continue;
        if (previous.plus(amount).minus(current).abs().greaterThan(TOLERANCE)) {
          issues.push({
            code: 'IMP-BAL-006', severity: 'error',
            message: 'The running balance does not follow on from the previous row.',
            detail: { atRow: i + 1 },
          });
          break;
        }
      }
    }
  }

  // ---- General ledger (IMP-GL-010) ----
  if (input.targetTable === 'ledger_entries' && input.journals && input.journals.length > 0) {
    const unbalanced = new Map<string, Decimal>();
    for (const line of input.journals) {
      const debit = readAmount(line.debit) ?? new Decimal(0);
      const credit = readAmount(line.credit) ?? new Decimal(0);
      unbalanced.set(line.ref, (unbalanced.get(line.ref) ?? new Decimal(0)).plus(debit).minus(credit));
    }
    // No tolerance, unlike IMP-TB-011 which §8.2 states as "within 0.01": a journal either balances
    // or it does not, and §17's fixture 2 is a journal off by exactly 0.01 that must be flagged.
    const offending = [...unbalanced.entries()].filter(([, delta]) => !delta.isZero());
    if (offending.length > 0) {
      // A warning, not an error: partial and per-account exports are common and still useful.
      issues.push({
        code: 'IMP-GL-010', severity: 'warning',
        message: `${offending.length} journal${offending.length === 1 ? '' : 's'} do not balance; those rows are marked as calculated rather than verified.`,
        detail: { journals: offending.slice(0, 10).map(([ref, delta]) => ({ ref, delta: delta.toFixed(2) })) },
      });
    }
  }

  // ---- Trial balance (IMP-TB-011) ----
  if (input.importType === 'trial_balance' && input.debits && input.credits) {
    const delta = sum(input.debits).minus(sum(input.credits));
    if (delta.abs().greaterThan(TOLERANCE)) {
      issues.push({
        code: 'IMP-TB-011', severity: 'error',
        message: 'This trial balance does not balance.',
        detail: { difference: delta.toFixed(2) },
      });
    }
  }

  // ---- Totals (IMP-TOT-014) ----
  for (const block of input.totalsBlocks ?? []) {
    const total = readAmount(block.total);
    const blockSum = readAmount(block.blockSum);
    if (!total || !blockSum) continue;
    if (total.minus(blockSum).abs().greaterThan(TOLERANCE)) {
      // An error, because a mis-detected block would double revenue or expenses.
      issues.push({
        code: 'IMP-TOT-014', severity: 'error',
        message: `"${block.label}" does not equal the lines above it.`,
        detail: { total: total.toFixed(2), lines: blockSum.toFixed(2) },
      });
    }
  }

  // ---- Single-period report spanning months (IMP-PER-012) ----
  if (!input.isFanOut && (input.distinctMonths ?? 1) > 1
      && input.targetTable === 'period_balances') {
    issues.push({
      code: 'IMP-PER-012', severity: 'warning',
      message: 'The rows in this report span more than one month.',
    });
  }

  return issues;
}

/** The confirmations a batch of this shape must record before it can commit (§8.2). */
export function requiredConfirmations(input: {
  readonly targetTable: ImportTarget;
  readonly importType: ImportType;
  readonly singleSignedBalanceColumn?: boolean;
  readonly looksLikeOpenItems?: boolean;
  readonly replacesExistingBalances?: boolean;
  readonly looksLikeReExport?: boolean;
}): string[] {
  const codes: string[] = [];

  // Every batch of every type declares its export range (ADR-047.6). Coverage depends on it.
  codes.push('IMP-RANGE-015');

  if (input.targetTable === 'period_balances') {
    codes.push('IMP-TB-012');
    if (input.singleSignedBalanceColumn) codes.push('IMP-TB-013');
    // N-1 (Step 0F): only the reviewer can say a report lists EVERY account for the period; without
    // that, a category or line it has no row for is unknown, never zero (FINANCIAL_ENGINE §3). Asked of
    // balance sheets too (owner decision, 2026-10-06): a missing receivables line is not 0.00.
    codes.push('IMP-TB-016');
    if (input.replacesExistingBalances) codes.push('IMP-COV-013');
  }
  if (input.targetTable === 'invoices' && input.looksLikeOpenItems) codes.push('IMP-INV-012');
  // R-2 (owner decision): only the reviewer knows whether a list holds every invoice still unpaid at
  // its start — older ones included. Without that, it states nothing about what is owed.
  if (input.targetTable === 'invoices') codes.push('IMP-INV-013');
  if (input.looksLikeReExport) codes.push('IMP-COV-014');

  return codes;
}

/**
 * Whether an invoice list is an aged-debtors list rather than a full sales history (ADR-047.10).
 * Getting this wrong makes an open-items list define revenue, which would understate it badly.
 */
export function looksLikeOpenItems(rows: ReadonlyArray<{ paid: boolean; issueDate: string }>): boolean {
  if (rows.length === 0) return false;
  const paidShare = rows.filter((r) => r.paid).length / rows.length;
  const dates = rows.map((r) => r.issueDate).sort();
  const spanDays = daysBetween(dates[0]!, dates[dates.length - 1]!);
  return paidShare < 0.1 && spanDays > 60;
}
