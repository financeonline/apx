import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  failImportBatch, registerDocument, finalizeUpload, setBatchValidation, writeImportRows,
} from '@/core/db';
import { ValidationError } from '@/core/errors';
import {
  decodeCsvBytes, sniffDelimiter, uploadDocument, validateFile,
} from '@/modules/documents';
import { isKnownHeader, suggestCategory, suggestColumns } from '../domain/mapping';
import { resolveBankSign, type BankAccountType } from '../domain/transforms/signs';
import { runPipeline } from '../domain/pipeline';
import { parseCsv } from '../domain/parsers/csv';
import { parseXlsx } from '../domain/parsers/xlsx';
import type { ParsedTable, TargetField, Transforms } from '../domain/pipeline-types';
import type { ImportTarget, ImportType } from '../domain/types';
import { parseAndValidate } from './parse-and-validate';
import { createImportAccounts, startImportBatch } from './index';

/**
 * The import wizard's one server-side journey (IMPORT_ENGINE.md §2–§7).
 *
 * Upload, start a batch, parse the file, propose a column map and validate every row — in one call,
 * with the bytes still in hand. The alternative is to store the file, redirect, and read it back
 * from Storage to parse it; that costs a round trip and a second copy of the "is this file readable"
 * question, and buys nothing a reviewer can see.
 *
 * Nothing here decides whether a batch may COMMIT. That is `app.assert_batch_committable`, re-checked
 * in SQL at the moment of commit against data that may have changed since (§11).
 */

export interface StartImportInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly db: SupabaseClient;
  readonly file: File;
  readonly importType: ImportType;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly bankAccountId: string | null;
  /** A reviewer's corrections to the proposed map, on a second pass (§6.4). */
  readonly columnMap?: Readonly<Record<string, TargetField>>;
}

export interface StartImportResult {
  readonly batchId: string;
  readonly documentId: string;
  readonly counts: Record<string, number>;
  /** Accounts the file named that the chart did not have, now created as `uncategorised` (§6.5). */
  readonly accountsCreated: number;
  readonly requiredConfirmations: readonly string[];
  readonly columns: readonly string[];
  readonly columnMap: Readonly<Record<string, TargetField>>;
  /** True when the header row was proposed rather than recognised, so §5.1 wants confirmation. */
  readonly headerConfirmationRequired: boolean;
}

const TARGET_BY_TYPE: Readonly<Record<ImportType, ImportTarget>> = {
  general_ledger: 'ledger_entries',
  trial_balance: 'period_balances',
  pnl_report: 'period_balances',
  balance_sheet: 'period_balances',
  bank_statement: 'bank_transactions',
  sales_invoices: 'invoices',
  purchase_invoices: 'invoices',
  sales_report: 'period_balances',
  purchase_report: 'period_balances',
  receipts: 'bank_transactions',
};

export function targetFor(importType: ImportType): ImportTarget {
  return TARGET_BY_TYPE[importType];
}

/** Reads a spreadsheet or delimited file into the shape the pipeline expects. */
async function parseTable(file: File, bytes: Uint8Array): Promise<ParsedTable> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    return parseXlsx(bytes, { isHeaderCell: isKnownHeader });
  }

  if (name.endsWith('.pdf')) {
    /*
     * A PDF needs the extraction path — text layer, deterministic table parse, page-by-page review
     * (§10) — which runs as a `document.extract` job rather than inline. Saying so is better than
     * accepting the file and leaving a batch that never becomes rows.
     */
    throw new ValidationError(
      'PDF statements are not ready yet. Export the same period as CSV or Excel and upload that.',
    );
  }

  const decoded = decodeCsvBytes(bytes);
  if (!decoded.ok) {
    throw new ValidationError(
      decoded.reason === 'nul_byte'
        ? 'That file is not a text file — it looks like a spreadsheet or an image with a .csv name.'
        : 'That file could not be read as text. Export it again as CSV or Excel.',
    );
  }

  // An unsniffable delimiter falls back to a comma rather than refusing: a single-column file has
  // no delimiter to find, and refusing it would reject a perfectly importable list.
  const sniffed = sniffDelimiter(decoded.text);
  return parseCsv(decoded.text, {
    delimiter: sniffed.ok ? sniffed.delimiter : ',',
    isHeaderCell: isKnownHeader,
  });
}

/**
 * The proposed map, from the file's own headers.
 *
 * §6.3 wants a saved mapping to win, then a synonym suggestion, then the reviewer. This supplies the
 * middle one and lets the reviewer override it; a saved-mapping lookup is the next thing to add.
 */
function proposeColumnMap(
  table: ParsedTable, importType: ImportType,
): Record<string, TargetField> {
  const map: Record<string, TargetField> = {};
  for (const suggestion of suggestColumns(table.columns, importType)) {
    // First suggestion per column wins: `suggestColumns` returns them strongest-first, so an exact
    // header match is never displaced by a weak one later in the list.
    if (map[suggestion.sourceColumn] === undefined) {
      map[suggestion.sourceColumn] = suggestion.target;
    }
  }
  return map;
}

/**
 * The transforms a file's own shape forces (§6.4).
 *
 * A statement with one signed `amount` column cannot be read without knowing which way round it
 * writes payments out, and reading it the wrong way round inverts every cash movement in the file.
 * §6.4 gives a default for card and loan accounts only; anywhere else the answer is a human's, so
 * this REFUSES rather than guesses. That refusal happens before anything is stored, so a file
 * nobody can answer for leaves no batch behind (ADR-058.1).
 */
async function resolveTransforms(
  db: SupabaseClient,
  organizationId: string,
  input: { importType: ImportType; bankAccountId: string | null },
  columnMap: Readonly<Record<string, TargetField>>,
): Promise<Transforms> {
  if (targetFor(input.importType) !== 'bank_transactions') return {};

  const targets = new Set(Object.values(columnMap));
  const singleSignedColumn = targets.has('amount')
    && !targets.has('money_in') && !targets.has('money_out');
  if (!singleSignedColumn) return {};

  const accountType = input.bankAccountId === null
    ? null
    : await loadBankAccountType(db, organizationId, input.bankAccountId);

  const bankSign = accountType === null ? null : resolveBankSign(undefined, accountType);
  if (bankSign === null) {
    throw new ValidationError(
      'This statement has a single amount column, so MOTION cannot tell whether payments out are '
      + 'shown as negative. Export it again with separate money-in and money-out columns.',
    );
  }
  return { bankSign };
}

async function loadBankAccountType(
  db: SupabaseClient, orgId: string, bankAccountId: string,
): Promise<BankAccountType | null> {
  const { data } = await db
    .from('bank_accounts')
    .select('account_type')
    .eq('organization_id', orgId)
    .eq('id', bankAccountId)
    .maybeSingle();
  return (data as { account_type?: BankAccountType } | null)?.account_type ?? null;
}

export async function startImport(input: StartImportInput): Promise<StartImportResult> {
  const { db, organizationId, userId, requestId } = input;
  const actor = { userId, requestId };

  const bytes = new Uint8Array(await input.file.arrayBuffer());

  // §4: the file is checked BEFORE anything is stored, so a file MOTION will not read never
  // becomes a document, a batch or a row.
  const validation = validateFile({
    filename: input.file.name,
    declaredMimeType: input.file.type || 'application/octet-stream',
    bytes,
  });
  if (!validation.ok) {
    throw new ValidationError(
      validation.findings[0]?.message ?? 'That file could not be read.',
      validation.findings.map((f) => ({ path: 'file', message: f.message })),
    );
  }

  /*
   * Parse BEFORE anything is stored.
   *
   * Starting the batch first left an orphan behind whenever the file could not be read — a document
   * and a batch in `uploaded` that would never become rows, cluttering the import history with
   * things that never happened. A file MOTION cannot parse should leave no trace but the sentence
   * explaining why (ADR-058.1).
   */
  const table = await parseTable(input.file, bytes);

  // Both are decided from the parsed table alone, and either can refuse the file — so both happen
  // on the same side of the upload as the parse, for the same reason (ADR-058.1).
  const columnMap = input.columnMap ?? proposeColumnMap(table, input.importType);
  const transforms = await resolveTransforms(db, organizationId, input, columnMap);

  const uploaded = await uploadDocument(
    {
      orgId: organizationId,
      userId,
      db,
      requestId,
      registerDocument: (meta) => registerDocument(actor, organizationId, meta),
      finalizeUpload: (documentId, byteSize, scanResult, status) =>
        finalizeUpload(actor, organizationId, { documentId, byteSize, scanResult, status }),
    },
    {
      filename: input.file.name,
      declaredMimeType: input.file.type || 'application/octet-stream',
      bytes,
      documentKind: input.importType,
    },
  );

  if (uploaded.status !== 'ready') {
    throw new ValidationError(
      uploaded.status === 'quarantined'
        ? 'That file did not pass the safety check, so it has not been imported.'
        : 'That file could not be read. If it is a scan, we cannot extract figures from it yet.',
    );
  }

  const batchId = await startImportBatch(db, {
    documentId: uploaded.documentId,
    importType: input.importType,
    // ABSENT, not null: `StartImportBatchInput` requires a bank account for a statement and forbids
    // one elsewhere, and it expresses "no account" as the key being missing. A null is a value.
    ...(input.bankAccountId === null ? {} : { bankAccountId: input.bankAccountId }),
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  }, requestId);

  /*
   * The accounts the file names, created before validation (§6.5).
   *
   * A first pass tells us which account names the chart does not have. They are created with a
   * keyword-suggested category — never a trusted one: an account created here shows first on
   * `/data/accounts` and marks everything it feeds incomplete until a human confirms it. Doing this
   * BEFORE the rows are written means the rows resolve, rather than every ledger commit failing on
   * `account_id` being NOT NULL (ADR-058.3).
   */
  const created = await createMissingAccounts({
    db, organizationId, actor, batchId, importType: input.importType,
    table, columnMap, transforms, periodStart: input.periodStart, periodEnd: input.periodEnd,
    bankAccountId: input.bankAccountId,
  });

  const result = await validateBatch({
    db, organizationId, actor,
    batchId,
    importType: input.importType,
    table,
    columnMap,
    transforms,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    bankAccountId: input.bankAccountId,
  });

  return {
    batchId,
    documentId: uploaded.documentId,
    accountsCreated: created,
    counts: result.counts,
    requiredConfirmations: result.requiredConfirmations,
    columns: table.columns,
    columnMap,
    headerConfirmationRequired: table.headerConfirmationRequired === true,
  };
}

interface ValidateBatchInput {
  readonly db: SupabaseClient;
  readonly organizationId: string;
  readonly actor: { userId: string; requestId: string };
  readonly batchId: string;
  readonly importType: ImportType;
  readonly table: ParsedTable;
  readonly columnMap: Readonly<Record<string, TargetField>>;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly bankAccountId: string | null;
  readonly transforms?: Transforms;
}

async function validateBatch(input: ValidateBatchInput): Promise<{
  counts: Record<string, number>;
  requiredConfirmations: readonly string[];
}> {
  const { db, organizationId, actor, batchId } = input;

  const { data: org } = await db
    .from('organizations')
    .select('base_currency, timezone')
    .eq('id', organizationId)
    .maybeSingle();

  const settings = org as { base_currency?: string; timezone?: string } | null;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: settings?.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  return parseAndValidate(
    {
      db,
      actorUserId: actor.userId,
      today,
      baseCurrency: settings?.base_currency ?? 'GBP',
      requestId: actor.requestId,
      writeRows: (batch, rows) => writeImportRows(actor, organizationId, batch, rows),
      setValidation: (batch, batchIssues, required, counts, statement) =>
        setBatchValidation(actor, organizationId, batch, batchIssues, required, counts, statement),
      failBatch: (batch, stage, message) =>
        failImportBatch(actor, organizationId, batch, stage, message),
    },
    {
      organizationId,
      batchId,
      importType: input.importType,
      targetTable: targetFor(input.importType),
      table: input.table,
      columnMap: input.columnMap,
      transforms: input.transforms ?? {},
      declaredPeriodStart: input.periodStart,
      declaredPeriodEnd: input.periodEnd,
      bankAccountId: input.bankAccountId,
    },
  );
}

/**
 * A dry run of the pipeline, purely to learn which accounts are missing.
 *
 * `runPipeline` is pure and already reports `uncategorisedAccounts`, so this costs a second pass
 * over the parsed table and no database work beyond the create. It is separate from `validateBatch`
 * because nothing should be WRITTEN until the accounts exist — otherwise the rows are written once
 * with a null account and again after the create, and a reader sees the batch change under them.
 */
async function createMissingAccounts(input: ValidateBatchInput): Promise<number> {
  const { db, organizationId, batchId } = input;

  const [accounts, counterparties] = await Promise.all([
    loadAccountRefs(db, organizationId),
    Promise.resolve([] as never[]),
  ]);
  void counterparties;

  const dryRun = runPipeline({
    organizationId,
    importType: input.importType,
    targetTable: targetFor(input.importType),
    table: input.table,
    columnMap: input.columnMap,
    transforms: input.transforms ?? {},
    baseCurrency: 'GBP',
    today: input.periodEnd,
    declaredPeriodStart: input.periodStart,
    declaredPeriodEnd: input.periodEnd,
    accounts,
    counterparties: [],
    existingRecords: [],
  });

  const missing: string[] = [...new Set(dryRun.unmappedAccounts)];
  if (missing.length === 0) return 0;

  return createImportAccounts(
    db,
    batchId,
    missing.map((name) => {
      const suggestion = suggestCategory(name);
      return {
        name,
        /*
         * Only an EXACT or STRONG keyword match becomes a category. A weak one is a guess, and a
         * guessed category silently changes which metric an account feeds — so `uncategorised` is
         * the honest answer and the Accounts page asks a human for a real one (§6.5).
         */
        standardCategory: suggestion.confidence === 'exact' || suggestion.confidence === 'strong'
          ? suggestion.category
          : 'uncategorised',
      };
    }),
  );
}

async function loadAccountRefs(
  db: SupabaseClient, orgId: string,
): Promise<Array<{ id: string; code: string | null; normalizedName: string }>> {
  const { data } = await db
    .from('accounts')
    .select('id, code, normalized_name')
    .eq('organization_id', orgId);
  return ((data ?? []) as Array<{ id: string; code: string | null; normalized_name: string }>)
    .map((row) => ({ id: row.id, code: row.code, normalizedName: row.normalized_name }));
}
