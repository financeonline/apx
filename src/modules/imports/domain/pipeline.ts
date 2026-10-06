/**
 * The pure pipeline: a parsed table plus a mapping in, validated rows out
 * (IMPORT_ENGINE.md §6 → §7 → §8 → §9).
 *
 * Everything here is a function of its arguments. The service layer supplies what it read from the
 * database — the chart of accounts, the counterparties, the records already committed — and gets
 * back the rows to write. That is what makes the malformed-file catalogue (§17) testable without a
 * database, and what stops the rules being re-implemented at each call site.
 *
 * The invariant that governs the whole file: **every parsed line produces exactly one output row.**
 * A line that is not data becomes a `skipped` row carrying `IMP-ROW-005`; a line that cannot be read
 * becomes an `error` row a human must resolve. Neither is dropped (SOW §23).
 */

import { maskDescription } from './transforms';
import { detectDateColumn, parseDateValue, readsDifferentlyUnderAlternate } from './transforms/dates';
import { detectNumberColumn, parseAmount } from './transforms/numbers';
import {
  balanceFromDebitCredit, bankAmountFromInOut, bankAmountFromSigned, glFromDebitCredit, glFromSigned,
} from './transforms/signs';
import { detectDuplicates, dedupeHash, normalizeDescription, scopeKey, type DedupeCandidateRow, type ExistingInvoice, type ExistingRecord } from './dedupe';
import { checkBatch, looksLikeOpenItems, requiredConfirmations, statusForIssues, validateRow, satisfiedFieldSet } from './validate-rows';
import type {
  BatchIssue, ParsedTable, RowIssue, TargetField, Transforms, ValidatedRow,
} from './pipeline-types';
import { IMPORT_TYPE_SPECS, type ImportTarget, type ImportType } from './types';
import { classifyInvoice } from './invoices';
import { heldNameKey, nameCarriesFigure, storedNameKey } from './mapping/counterparty';
import type { FinancialRecordTable } from '@/modules/financials';

export interface AccountRef {
  readonly id: string;
  readonly code: string | null;
  readonly normalizedName: string;
  /** The name as stored, for the reviewer's message when the name is held (ADR-136). */
  readonly name?: string;
}

export interface CounterpartyRef {
  readonly id: string;
  readonly normalizedName: string;
  /** The name as stored, for the reviewer's message when the name is held (ADR-136). */
  readonly name?: string;
}

/** The target fields that hold money (§6.1), read through the §6.4 number transform before signs. */
const MONEY_FIELDS = [
  'amount', 'debit', 'credit', 'money_in', 'money_out', 'balance_after', 'opening_balance', 'closing_balance',
  'subtotal', 'tax_amount', 'total_amount', 'amount_paid',
] as const;

/** The target fields that hold a date (§6.1), read through the §6.4 transform. */
const DATE_FIELDS = ['entry_date', 'transaction_date', 'issue_date', 'due_date', 'paid_date', 'posted_date', 'period_start', 'period_end'] as const;

/** The calendar month a declared range lies inside, or null when it spans more than one. */
function singleMonthOf(start: string, end: string): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  if (start.slice(0, 7) !== end.slice(0, 7) || end < start) return null;
  const [y, m] = start.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${start.slice(0, 7)}-01`, end: `${start.slice(0, 7)}-${String(last).padStart(2, '0')}` };
}

function primaryDateFieldOf(target: ImportTarget): string {
  switch (target) {
    case 'ledger_entries': return 'entry_date';
    case 'bank_transactions': return 'transaction_date';
    case 'invoices': return 'issue_date';
    case 'period_balances': return 'period_start';
    case 'budget_lines': return 'period_start';
  }
}

export interface PipelineInput {
  readonly organizationId: string;
  readonly importType: ImportType;
  readonly targetTable: ImportTarget;
  readonly table: ParsedTable;
  readonly columnMap: Readonly<Record<string, TargetField>>;
  readonly transforms: Transforms;
  readonly baseCurrency: string;
  /** ISO country, for the day-first default when a date column is ambiguous (§6.4). */
  readonly countryCode?: string;
  readonly today: string;
  readonly declaredPeriodStart: string;
  readonly declaredPeriodEnd: string;
  readonly accounts: readonly AccountRef[];
  readonly counterparties: readonly CounterpartyRef[];
  readonly existingRecords: readonly ExistingRecord[];
  readonly existingInvoices?: readonly ExistingInvoice[];
  /** Bank identity, for the dedupe scope key of a statement (§9.1, ADR-047.12). */
  readonly bankIdentity?: {
    readonly bankName: string | null;
    readonly sortCodeMasked: string | null;
    readonly accountNumberMasked: string | null;
  };
  readonly liabilityAccount?: boolean;
  readonly ambiguousDateRows?: ReadonlySet<number>;
  /**
   * Issues the caller adds to every tabular row — the extraction job's `IMP-PDF-001` ("read by
   * AI — confirm against page N"), which is about how the row was produced, not what it says.
   */
  /** §5.4: the batch cannot commit until statement balances exist (AI-read documents). */
  readonly balancesRequired?: boolean;
  readonly annotateRow?: (row: { readonly rowNumber: number; readonly sourceRef: string; readonly sourcePage?: number }) => readonly RowIssue[];
}

export interface PipelineResult {
  readonly rows: readonly ValidatedRow[];
  readonly batchIssues: readonly BatchIssue[];
  readonly requiredConfirmations: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  /** Accounts in the file with no match in the chart, for the account-mapping step (§6.5). */
  readonly unmappedAccounts: readonly string[];
  /** New counterparty names the commit will create (§6.6). */
  readonly newCounterparties: readonly string[];
  /**
   * Names that matched an existing counterparty (letter for letter). Sent with the new ones so the
   * database can make a customer met on a purchase list `both` (§6.6) — the kind is its decision.
   */
  readonly matchedCounterparties: readonly string[];
}

const DATE_FIELD_BY_TARGET: Readonly<Record<ImportTarget, string>> = {
  ledger_entries: 'entry_date',
  bank_transactions: 'transaction_date',
  invoices: 'issue_date',
  period_balances: 'period_start',
  budget_lines: 'period_start',
};

/** Applies the column map to one parsed line, producing target-field values. */
function mapRow(
  columns: readonly string[],
  cells: readonly (string | null)[],
  columnMap: Readonly<Record<string, TargetField>>,
): { mapped: Record<string, string | null>; raw: Record<string, string | null> } {
  const mapped: Record<string, string | null> = {};
  const raw: Record<string, string | null> = {};

  columns.forEach((column, index) => {
    const value = cells[index] ?? null;
    // raw_data keeps EVERY column, including the ones nobody mapped: it is the file as it arrived,
    // and level-4 evidence highlighting reads it (§13).
    raw[column] = value;
    const target = columnMap[column];
    if (target) mapped[target] = value;
  });

  return { mapped, raw };
}

/** The median of a column, used only for the outlier warning. Absolute values, as strings. */
function medianAbsolute(values: readonly (string | null)[]): string | undefined {
  const numeric = values
    .filter((v): v is string => v !== null && v.trim() !== '')
    .map((v) => Math.abs(Number.parseFloat(v.replace(/[^\d.-]/g, ''))))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (numeric.length === 0) return undefined;
  return String(numeric[Math.floor(numeric.length / 2)]);
}

export function runPipeline(input: PipelineInput): PipelineResult {
  const { table, columnMap } = input;
  const dateField = DATE_FIELD_BY_TARGET[input.targetTable];

  const accountsByCode = new Map(
    input.accounts.filter((a) => a.code).map((a) => [a.code!.toLowerCase(), a]),
  );
  const accountsByName = new Map(input.accounts.map((a) => [a.normalizedName, a]));
  const counterpartiesByName = new Map(input.counterparties.map((c) => [c.normalizedName, c]));
  /*
   * Names HELD for an identity decision (ADR-136): records that became one name when keys became
   * Unicode-aware, kept apart until a person decides. A row naming one is refused, never booked to
   * either record and never the cause of a third.
   */
  const heldAccounts = heldNames(input.accounts);
  const heldCounterparties = heldNames(input.counterparties);

  const requiredFields = satisfiedFieldSet(input.importType, new Set(Object.values(columnMap))) ?? [];

  const unmappedAccounts = new Set<string>();
  const newCounterparties = new Set<string>();
  const matchedCounterparties = new Set<string>();
  /** Rows naming an account or counterparty whose records are held for a decision (ADR-136). */
  const nameIssues = new Map<number, RowIssue>();
  /** D-3: rows matched to a customer or supplier whose stored spelling differs (beyond letter case). */
  const spellingWarnings = new Map<number, RowIssue>();

  // ---- Pass A: map every line, resolve identities, collect what is missing ----
  interface Staged {
    readonly rowNumber: number;
    readonly sourceRef: string;
    readonly raw: Record<string, string | null>;
    readonly mapped: Record<string, string | null>;
    readonly nonTabular: boolean;
    readonly hidden: boolean;
    readonly fieldCountMismatch: boolean;
    readonly accountValue: string | null;
    readonly sourcePage?: number;
  }

  // Map every line first: the §6.4 number formats are a property of a COLUMN, so they are decided
  // over the whole table before any row's money is turned into a signed amount.
  const mappedRows = table.rows.map((row) => {
    /*
     * The header line is a source line — it stays in `rows` so nothing is discarded (SOW §23) — but
     * it is not a record. Every parser leaves it in place and names it by `headerRow`; treating it
     * as data made "Date" fail the date column on every file and left a reviewer dismissing an
     * "error" that was the column headings (ADR-083).
     */
    const nonTabular = row.nonTabular === true || (table.headerRow !== undefined && row.rowNumber === table.headerRow);
    const { mapped, raw } = mapRow(table.columns, row.cells, columnMap);
    return { row, nonTabular, mapped, raw };
  });

  /*
   * §6.4 numbers: separators are detected per column — `1.234,56` against `1,234.56`, a space as a
   * thousands separator, currency symbols, every negative style — and each cell is read with the
   * column's format. Detection and reading existed and were never called, so a cell of "2,500.00"
   * reached the sign transform as text it could not parse and fell out of the sum; only files
   * without thousands separators ever reconciled (ADR-083). A cell the format cannot read is left
   * as written, so the row's own issue names it.
   */
  for (const field of MONEY_FIELDS) {
    const cells = mappedRows.filter((m) => !m.nonTabular).map((m) => m.mapped[field] ?? null);
    if (cells.every((cell) => cell === null || cell === undefined || cell.trim() === '')) continue;
    const detected = detectNumberColumn(cells);
    const format = {
      decimalSeparator: input.transforms.decimalSeparator ?? detected.decimalSeparator,
      thousandsSeparator: input.transforms.thousandsSeparator ?? detected.thousandsSeparator,
    };
    for (const m of mappedRows) {
      if (m.nonTabular) continue;
      const cell = m.mapped[field];
      if (cell === null || cell === undefined || cell.trim() === '') continue;
      const parsed = parseAmount(cell, { format });
      if (parsed.ok && parsed.amount !== null) m.mapped[field] = parsed.amount;
    }
  }

  const staged: Staged[] = mappedRows.map(({ row, nonTabular, mapped, raw }) => {
    const accountValue = mapped.account ?? null;

    /*
     * Money into the shape the target table stores it in (§7.3).
     *
     * A file says "Debit 9,000" or "Paid Out 500"; `ledger_entries` stores a magnitude and a side,
     * and `bank_transactions` stores one signed number. Without this step `mapped_data` carried the
     * file's own columns and no `direction` or `amount`, so no ledger could ever commit — the
     * insert failed on a NOT NULL constraint (ADR-058.4).
     *
     * `signs.ts` owns every one of these conversions, so the importer and the engine cannot disagree
     * about which way a debit points.
     */
    if (!nonTabular) {
      normaliseMoney(mapped, input.targetTable, input.transforms);
    }

    /*
     * An invoice row's type comes from the list it is in (§6.1): `invoices.invoice_type` is NOT
     * NULL and nothing in the file says it. A negative total is a credit note, with all four money
     * fields negated together so it is stored as a positive amount subtracted by type (CD-28,
     * ADR-047.5). The status a file writes ("Paid", "Part paid") is read into the enum here, or
     * left as written so `IMP-INV-013` names it rather than the commit failing on a cast.
     */
    const invoiceSide = IMPORT_TYPE_SPECS[input.importType].invoiceSide;
    if (!nonTabular && input.targetTable === 'invoices' && invoiceSide !== null) {
      classifyInvoice(mapped, invoiceSide);
    }

    if (!nonTabular && accountValue) {
      const byCode = mapped.code ? accountsByCode.get(mapped.code.toLowerCase()) : undefined;
      const accountKey = storedNameKey(accountValue);
      const byName = accountsByName.get(accountKey);
      const account = byCode ?? byName;
      if (account) mapped.account_id = account.id;
      else if (heldAccounts.has(accountKey)) nameIssues.set(row.rowNumber, heldIssue('account', accountValue, heldAccounts.get(accountKey)!));
      else unmappedAccounts.add(accountValue);
    }

    const counterpartyValue = mapped.counterparty ?? mapped.customer ?? mapped.supplier ?? null;
    if (!nonTabular && counterpartyValue) {
      const key = storedNameKey(counterpartyValue);
      const existing = counterpartiesByName.get(key);
      // The key keeps every letter in every script (ADR-136): a match is the same name.
      if (heldCounterparties.has(key)) {
        nameIssues.set(row.rowNumber, heldIssue('counterparty', counterpartyValue, heldCounterparties.get(key)!));
      } else if (existing) {
        mapped.counterparty_id = existing.id;
        if (!nameCarriesFigure(counterpartyValue)) matchedCounterparties.add(counterpartyValue);
        // D-3 (owner decision): a match is never silent when the spelling differs — "Acme, Ltd."
        // booked to "Acme Ltd" is right only if they are the same business, so the reviewer sees it.
        if (existing.name !== undefined && spellingDiffers(counterpartyValue, existing.name)) {
          spellingWarnings.set(row.rowNumber, {
            code: 'IMP-CP-020', severity: 'warning', field: 'customer',
            message: `"${counterpartyValue}" was matched to the existing "${existing.name}", which is spelled differently.`,
            suggestion: 'If they are different businesses, rename one of them under Customers before importing.',
          });
        }
      // ADR-045.3: a name carrying a figure is never created; the row says so (IMP-NAME-015).
      } else if (!nameCarriesFigure(counterpartyValue)) {
        newCounterparties.add(counterpartyValue);
      }
    }

    // The masked description is derived here, once, so no reader has to remember to mask
    // (ADR-038.4). The raw text stays in `raw`.
    if (mapped.description) mapped.description_normalized = maskDescription(mapped.description);

    return {
      rowNumber: row.rowNumber,
      sourceRef: row.sourceRef,
      raw,
      mapped,
      nonTabular,
      hidden: row.hidden === true,
      fieldCountMismatch: row.cells.length !== table.columns.length && !nonTabular,
      accountValue,
      ...(row.sourcePage === undefined ? {} : { sourcePage: row.sourcePage }),
    };
  });

  // ---- Pass B: validate ----
  const amountMedian = medianAbsolute(staged.map((s) => s.mapped.amount ?? s.mapped.total_amount ?? null));
  /*
   * §6.4 dates: detect each date column's order over the whole column, then read every cell with
   * it. Detection and reading existed and were never called, so a column of "01 Mar 2026" reached
   * the validator as text and failed `IMP-DATE-001` on every row; only ISO-dated files ever passed
   * (ADR-083). The order is the reviewer's per-column choice, else the file's, else what the column
   * itself disambiguates, else the organisation's country. Rows that would read differently the
   * other way round are marked `IMP-DATE-003` so the reviewer sees them.
   */
  const ambiguousDateRows = new Set<number>(input.ambiguousDateRows ?? []);
  const dateFields = DATE_FIELDS.filter((field) => staged.some((s) => !s.nonTabular && s.mapped[field] !== undefined));
  /*
   * A budget names months, and a month is often written "2026-11" or "Nov 2026" rather than as a day
   * (ADR-142). A year-and-month is read as the first of that month before the date column is read.
   */
  if (input.targetTable === 'budget_lines') {
    for (const s of staged) {
      const cell = s.mapped.period_start;
      if (s.nonTabular || cell === null || cell === undefined) continue;
      const ym = /^\s*(\d{4})[-/.](\d{1,2})\s*$/.exec(cell);
      if (ym) s.mapped.period_start = `${ym[1]}-${ym[2]!.padStart(2, '0')}-01`;
    }
  }
  for (const field of dateFields) {
    const detection = detectDateColumn(
      staged.filter((s) => !s.nonTabular).map((s) => s.mapped[field] ?? null),
      { countryCode: input.countryCode },
    );
    const order = input.transforms.dateOrderByColumn?.[field] ?? input.transforms.dateOrder ?? detection.order ?? detection.proposedOrder;
    for (const s of staged) {
      if (s.nonTabular) continue;
      const cell = s.mapped[field];
      if (cell === null || cell === undefined || cell.trim() === '') continue;
      const iso = parseDateValue(cell, order);
      // An unreadable cell is left as written, so `IMP-DATE-001` names it rather than a blank.
      if (iso !== null) s.mapped[field] = iso;
      if (field === primaryDateFieldOf(input.targetTable) && readsDifferentlyUnderAlternate(cell, order)) ambiguousDateRows.add(s.rowNumber);
    }
  }
  // A budget line belongs to a month: any day in it names the month (ADR-142).
  if (input.targetTable === 'budget_lines') {
    for (const s of staged) {
      const iso = s.mapped.period_start;
      if (!s.nonTabular && iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) s.mapped.period_start = `${iso.slice(0, 7)}-01`;
    }
  }

  /*
   * Currency (Phase 13, ADR-101). A file with no currency column used to reach commit with none,
   * and the insert's fallback stamped the row 'GBP' whatever the organisation reports in — an INR
   * statement stored as pounds. The row is stamped with the organisation's currency HERE, where the
   * base currency is known, so nothing downstream has to guess; a file that does name a currency
   * keeps it, upper-cased, and IMP-CUR-007 below still refuses one that differs.
   */
  for (const s of staged) {
    if (s.nonTabular) continue;
    const named = s.mapped.currency;
    s.mapped.currency = named === undefined || named === null || named.trim() === ''
      ? input.baseCurrency.toUpperCase()
      : named.trim().toUpperCase();
  }
  const hiddenRows = new Set(staged.filter((s) => s.hidden).map((s) => s.rowNumber));

  /*
   * A balance report (trial balance, P&L, balance sheet) usually has no date column: the period is
   * the one the upload declared. `period_balances.period_start` assigns the fiscal period, so a row
   * without it reached commit and failed every such import on `period_assign` (validation, Step 0C).
   * Only a declared range inside ONE calendar month names the period; any wider range leaves the row
   * without one, and IMP-PERIOD-005 asks the reviewer instead of guessing a month.
   */
  if (input.targetTable === 'period_balances' || input.targetTable === 'budget_lines') {
    const month = singleMonthOf(input.declaredPeriodStart, input.declaredPeriodEnd);
    if (month !== null) {
      for (const s of staged) {
        if (s.nonTabular) continue;
        const start = s.mapped.period_start;
        if (start !== undefined && start !== null && start.trim() !== '') continue;
        s.mapped.period_start = month.start;
        const end = s.mapped.period_end;
        if (end === undefined || end === null || end.trim() === '') s.mapped.period_end = month.end;
      }
    }
  }

  const validationCtx = {
    importType: input.importType,
    targetTable: input.targetTable,
    baseCurrency: input.baseCurrency,
    declaredPeriodStart: input.declaredPeriodStart,
    declaredPeriodEnd: input.declaredPeriodEnd,
    today: input.today,
    amountMedian,
    uncategorisedAccounts: unmappedAccounts,
    ambiguousDateRows,
    hiddenRows,
  };

  const issuesByRow = new Map<number, RowIssue[]>();
  for (const s of staged) {
    const issues = validateRow(
      { rowNumber: s.rowNumber, mapped: s.mapped, nonTabular: s.nonTabular, fieldCountMismatch: s.fieldCountMismatch },
      validationCtx,
      requiredFields,
    );
    const nameIssueOfRow = nameIssues.get(s.rowNumber);
    const spelling = spellingWarnings.get(s.rowNumber);
    // The specific reason replaces the generic "could not be matched" (IMP-CP-016) it would cause.
    issuesByRow.set(s.rowNumber, [
      ...(nameIssueOfRow === undefined ? issues : [...issues.filter((i) => i.code !== 'IMP-CP-016'), nameIssueOfRow]),
      ...(spelling === undefined ? [] : [spelling]),
    ]);
  }

  // ADR-142: one budget line per account and month. A second one is an error on that row, never a
  // silent sum — two figures for one month's rent is a question for the person, not for MOTION.
  if (input.targetTable === 'budget_lines') {
    const seen = new Map<string, number>();
    for (const s of staged) {
      if (s.nonTabular || !s.accountValue || !s.mapped.period_start) continue;
      const key = `${s.mapped.period_start.slice(0, 7)}|${storedNameKey(s.accountValue)}`;
      const first = seen.get(key);
      if (first === undefined) { seen.set(key, s.rowNumber); continue; }
      issuesByRow.set(s.rowNumber, [...(issuesByRow.get(s.rowNumber) ?? []), {
        code: 'IMP-BUD-001', severity: 'error', field: 'account',
        message: `"${s.accountValue}" already has a budget for ${s.mapped.period_start.slice(0, 7)} on row ${first}.`,
        suggestion: 'Keep one line per account and month, or skip this row.',
      }]);
    }
  }

  // ---- Pass C: duplicates, over the rows that could actually commit ----
  const dedupeRows: DedupeCandidateRow[] = staged
    .filter((s) => !s.nonTabular && (issuesByRow.get(s.rowNumber) ?? []).every((i) => i.severity !== 'error'))
    .map((s) => {
      const key = scopeKey({
        targetTable: input.targetTable as FinancialRecordTable,
        accountCode: s.mapped.code ?? null,
        accountNormalizedName: s.accountValue?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() ?? null,
        bankName: input.bankIdentity?.bankName ?? null,
        sortCodeMasked: input.bankIdentity?.sortCodeMasked ?? null,
        accountNumberMasked: input.bankIdentity?.accountNumberMasked ?? null,
        invoiceType: s.mapped.invoice_type ?? null,
      });

      const amount = s.mapped.amount ?? s.mapped.total_amount ?? s.mapped.closing_balance ?? '0';
      const date = s.mapped[dateField] ?? '';
      const direction = s.mapped.direction
        ?? s.mapped.invoice_type
        ?? (amount.trim().startsWith('-') ? 'outflow' : 'inflow');

      return {
        rowNumber: s.rowNumber,
        dedupeHash: dedupeHash({
          organizationId: input.organizationId,
          targetTable: input.targetTable as FinancialRecordTable,
          accountCode: s.mapped.code ?? null,
          accountNormalizedName: s.accountValue ?? null,
          bankName: input.bankIdentity?.bankName ?? null,
          sortCodeMasked: input.bankIdentity?.sortCodeMasked ?? null,
          accountNumberMasked: input.bankIdentity?.accountNumberMasked ?? null,
          invoiceType: s.mapped.invoice_type ?? null,
          date,
          amount,
          direction,
          description: s.mapped.description ?? null,
          invoiceNumber: s.mapped.invoice_number ?? null,
        }),
        date,
        amount,
        scopeKey: key,
        normalizedDescription: normalizeDescription(s.mapped.description),
        invoiceType: s.mapped.invoice_type ?? undefined,
        counterpartyKey: s.mapped.counterparty_id ?? undefined,
        invoiceNumber: s.mapped.invoice_number ?? undefined,
        totalAmount: s.mapped.total_amount ?? undefined,
        amountPaid: s.mapped.amount_paid ?? undefined,
        paidDate: s.mapped.paid_date ?? null,
        dueDate: s.mapped.due_date ?? null,
        status: s.mapped.status ?? undefined,
      };
    });

  const duplicateOutcomes = new Map(
    detectDuplicates({
      targetTable: input.targetTable as FinancialRecordTable,
      rows: dedupeRows,
      existingRecords: input.existingRecords,
      existingInvoices: input.existingInvoices,
    }).map((o) => [o.rowNumber, o]),
  );
  const hashByRow = new Map(dedupeRows.map((r) => [r.rowNumber, r.dedupeHash]));

  // ---- Assemble ----
  const rows: ValidatedRow[] = staged.map((s) => {
    const duplicate = duplicateOutcomes.get(s.rowNumber);
    const annotated = s.nonTabular || input.annotateRow === undefined
      ? []
      : input.annotateRow({ rowNumber: s.rowNumber, sourceRef: s.sourceRef, ...(s.sourcePage === undefined ? {} : { sourcePage: s.sourcePage }) });
    const issues = [...(issuesByRow.get(s.rowNumber) ?? []), ...(duplicate?.issues ?? []), ...annotated];
    return {
      rowNumber: s.rowNumber,
      sourceRef: s.sourceRef,
      ...(s.sourcePage === undefined ? {} : { sourcePage: s.sourcePage }),
      raw: s.raw,
      mapped: s.mapped,
      issues,
      status: statusForIssues(issues, duplicate?.status),
      dedupeHash: hashByRow.get(s.rowNumber),
      suggestedDecision: duplicate?.suggestedDecision,
      suggestedReason: duplicate?.suggestedReason,
    };
  });

  // ---- Batch level ----
  const committable = rows.filter((r) => r.status === 'valid' || r.status === 'warning');
  const invoiceRows = committable.map((r) => ({
    paid: (r.mapped.amount_paid ?? '0') !== '0' && r.mapped.amount_paid === r.mapped.total_amount,
    issueDate: r.mapped.issue_date ?? input.declaredPeriodStart,
  }));

  const openItems = input.targetTable === 'invoices' && looksLikeOpenItems(invoiceRows);

  const batchIssues = checkBatch({
    targetTable: input.targetTable,
    importType: input.importType,
    amounts: committable.map((r) => r.mapped.amount ?? '0'),
    debits: committable.map((r) => r.mapped.debit ?? '0'),
    credits: committable.map((r) => r.mapped.credit ?? '0'),
    openingBalance: table.statement?.openingBalance ?? null,
    closingBalance: table.statement?.closingBalance ?? null,
    balanceChain: committable.map((r) => r.mapped.balance_after ?? null),
    liabilityAccount: input.liabilityAccount,
    balancesRequired: input.balancesRequired,
    distinctMonths: new Set(committable.map((r) => (r.mapped[dateField] ?? '').slice(0, 7))).size,
  });

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  counts.total = rows.length;

  return {
    rows,
    batchIssues,
    requiredConfirmations: requiredConfirmations({
      targetTable: input.targetTable,
      importType: input.importType,
      singleSignedBalanceColumn:
        input.targetTable === 'period_balances'
        && !Object.values(columnMap).includes('debit'),
      looksLikeOpenItems: openItems,
    }),
    counts,
    unmappedAccounts: [...unmappedAccounts],
    newCounterparties: [...newCounterparties],
    matchedCounterparties: [...matchedCounterparties],
  };
}

/** The two Unicode-name refusals, worded for the person who has to fix the file. */
/** The held keys among existing records, each with the names of its records (ADR-136). */
function heldNames(records: ReadonlyArray<{ normalizedName: string; name?: string }>): Map<string, string[]> {
  const held = new Map<string, string[]>();
  for (const record of records) {
    const key = heldNameKey(record.normalizedName);
    if (key === null) continue;
    held.set(key, [...(held.get(key) ?? []), record.name ?? key]);
  }
  return held;
}

/**
 * D-3: whether a matched name is spelled differently from the stored one, beyond letter case and
 * surrounding or repeated spaces. Case alone is how exports differ ("ACME LTD"); punctuation, accents
 * written another way and other characters are what a reviewer should look at.
 */
function spellingDiffers(fileName: string, storedName: string): boolean {
  const plain = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
  return plain(fileName) !== plain(storedName);
}

function heldIssue(kind: 'account' | 'counterparty', name: string, records: readonly string[]): RowIssue {
  const listed = records.map((r) => `"${r}"`).join(' and ');
  return kind === 'counterparty'
    ? {
        code: 'IMP-CP-019', severity: 'error', field: 'customer',
        message: `"${name}" matches ${listed}, which MOTION holds apart until someone decides whether they are the same customer or supplier.`,
        suggestion: 'Rename or merge those records under Customers, then upload the file again.',
      }
    : {
        code: 'IMP-ACCT-019', severity: 'error', field: 'account',
        message: `"${name}" matches the accounts ${listed}, which MOTION holds apart until someone decides whether they are the same account.`,
        suggestion: 'Rename one of those accounts under Accounts, then upload the file again.',
      };
}

/**
 * Fills in `direction` and `amount` from whichever columns the file actually used.
 *
 * Mutates the mapped row in place, which is what the rest of the staging step expects. Anything it
 * cannot resolve is LEFT ALONE rather than guessed: `validateRows` then reports it as an issue the
 * reviewer sees, which is the whole design — a row MOTION cannot read is shown, never dropped.
 */
function normaliseMoney(
  mapped: Record<string, string | null>,
  targetTable: ImportTarget,
  transforms: Transforms,
): void {
  if (targetTable === 'ledger_entries') {
    if (mapped.direction && mapped.amount) return;

    if (mapped.debit !== undefined || mapped.credit !== undefined) {
      const result = glFromDebitCredit(mapped.debit, mapped.credit);
      if (result.direction !== null && result.amount !== null) {
        mapped.direction = result.direction;
        mapped.amount = result.amount;
      }
      return;
    }

    if (mapped.amount) {
      const result = glFromSigned(mapped.amount, transforms.glSign);
      if (result.direction !== null && result.amount !== null) {
        mapped.direction = result.direction;
        mapped.amount = result.amount;
      }
    }
    return;
  }

  /*
   * H-2 (Step 0E): a TB / P&L / balance-sheet row is stored as `closing_balance` (NOT NULL), which is
   * what the engine reads. The three supported layouts (§6.1 REQUIRED_FIELDS):
   *   - a balance column → `closing_balance` as given (its sign confirmed at IMP-TB-013, applied at commit);
   *   - Debit and Credit columns → closing = debit − credit, natural sign, and both totals kept;
   *   - one signed amount column → `closing_balance` = amount (IMP-TB-013 again).
   * Before this, the last two never produced a closing balance, so such a row validated and then failed
   * the commit on the NOT NULL column. A row with no figure in any of them is left without one: the
   * required-field check reports it, nothing turns it into a zero.
   */
  if (targetTable === 'period_balances') {
    const given = mapped.closing_balance;
    const hasClosing = given !== undefined && given !== null && given.trim() !== '';
    if (mapped.debit !== undefined || mapped.credit !== undefined) {
      const result = balanceFromDebitCredit(mapped.debit, mapped.credit);
      if (result.debitTotal !== null) mapped.debit_total = result.debitTotal;
      if (result.creditTotal !== null) mapped.credit_total = result.creditTotal;
      if (!hasClosing && result.closing !== null) mapped.closing_balance = result.closing;
      return;
    }
    if (!hasClosing && mapped.amount !== undefined && mapped.amount !== null && mapped.amount.trim() !== '') {
      mapped.closing_balance = mapped.amount;
    }
    return;
  }

  if (targetTable === 'bank_transactions') {
    if (mapped.amount) {
      /*
       * A single signed column is only readable under the reviewer's answer to "Are payments out
       * shown as negative?" (§6.4). Absent that answer the column is left exactly as the file wrote
       * it: guessing would invert every movement in a credit-card export.
       */
      if (transforms.bankSign !== undefined) {
        const result = bankAmountFromSigned(mapped.amount, transforms.bankSign);
        if (result.amount !== null) mapped.amount = result.amount;
      }
      return;
    }
    if (mapped.money_in !== undefined || mapped.money_out !== undefined) {
      const result = bankAmountFromInOut(mapped.money_in, mapped.money_out);
      if (result.amount !== null) mapped.amount = result.amount;
    }
  }
}
