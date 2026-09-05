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
import { detectDuplicates, dedupeHash, normalizeDescription, scopeKey, type DedupeCandidateRow, type ExistingInvoice, type ExistingRecord } from './dedupe';
import { checkBatch, looksLikeOpenItems, requiredConfirmations, statusForIssues, validateRow, satisfiedFieldSet } from './validate-rows';
import type {
  BatchIssue, ParsedTable, RowIssue, TargetField, Transforms, ValidatedRow,
} from './pipeline-types';
import type { ImportTarget, ImportType } from './types';
import type { FinancialRecordTable } from '@/modules/financials';

export interface AccountRef {
  readonly id: string;
  readonly code: string | null;
  readonly normalizedName: string;
}

export interface CounterpartyRef {
  readonly id: string;
  readonly normalizedName: string;
}

export interface PipelineInput {
  readonly organizationId: string;
  readonly importType: ImportType;
  readonly targetTable: ImportTarget;
  readonly table: ParsedTable;
  readonly columnMap: Readonly<Record<string, TargetField>>;
  readonly transforms: Transforms;
  readonly baseCurrency: string;
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
}

const DATE_FIELD_BY_TARGET: Readonly<Record<ImportTarget, string>> = {
  ledger_entries: 'entry_date',
  bank_transactions: 'transaction_date',
  invoices: 'issue_date',
  period_balances: 'period_start',
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

  const requiredFields = satisfiedFieldSet(input.importType, new Set(Object.values(columnMap))) ?? [];

  const unmappedAccounts = new Set<string>();
  const newCounterparties = new Set<string>();

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
  }

  const staged: Staged[] = table.rows.map((row) => {
    const { mapped, raw } = mapRow(table.columns, row.cells, columnMap);
    const accountValue = mapped.account ?? null;

    if (!row.nonTabular && accountValue) {
      const byCode = mapped.code ? accountsByCode.get(mapped.code.toLowerCase()) : undefined;
      const byName = accountsByName.get(accountValue.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
      const account = byCode ?? byName;
      if (account) mapped.account_id = account.id;
      else unmappedAccounts.add(accountValue);
    }

    const counterpartyValue = mapped.counterparty ?? mapped.customer ?? mapped.supplier ?? null;
    if (!row.nonTabular && counterpartyValue) {
      const key = counterpartyValue.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const existing = counterpartiesByName.get(key);
      if (existing) mapped.counterparty_id = existing.id;
      else newCounterparties.add(counterpartyValue);
    }

    // The masked description is derived here, once, so no reader has to remember to mask
    // (ADR-038.4). The raw text stays in `raw`.
    if (mapped.description) mapped.description_normalized = maskDescription(mapped.description);

    return {
      rowNumber: row.rowNumber,
      sourceRef: row.sourceRef,
      raw,
      mapped,
      nonTabular: row.nonTabular === true,
      hidden: row.hidden === true,
      fieldCountMismatch: row.cells.length !== table.columns.length && !row.nonTabular,
      accountValue,
    };
  });

  // ---- Pass B: validate ----
  const amountMedian = medianAbsolute(staged.map((s) => s.mapped.amount ?? s.mapped.total_amount ?? null));
  const hiddenRows = new Set(staged.filter((s) => s.hidden).map((s) => s.rowNumber));

  const validationCtx = {
    importType: input.importType,
    targetTable: input.targetTable,
    baseCurrency: input.baseCurrency,
    declaredPeriodStart: input.declaredPeriodStart,
    declaredPeriodEnd: input.declaredPeriodEnd,
    today: input.today,
    amountMedian,
    uncategorisedAccounts: unmappedAccounts,
    ambiguousDateRows: input.ambiguousDateRows,
    hiddenRows,
  };

  const issuesByRow = new Map<number, RowIssue[]>();
  for (const s of staged) {
    issuesByRow.set(
      s.rowNumber,
      validateRow(
        { rowNumber: s.rowNumber, mapped: s.mapped, nonTabular: s.nonTabular, fieldCountMismatch: s.fieldCountMismatch },
        validationCtx,
        requiredFields,
      ),
    );
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
    const issues = [...(issuesByRow.get(s.rowNumber) ?? []), ...(duplicate?.issues ?? [])];
    return {
      rowNumber: s.rowNumber,
      sourceRef: s.sourceRef,
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
  };
}
