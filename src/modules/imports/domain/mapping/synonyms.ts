/**
 * Column-mapping suggestion (IMPORT_ENGINE.md §6.2) and the saved-mapping signature (§6.3).
 *
 * Pure and dependency-free apart from `node:crypto`, because two other things depend on it: the
 * mapping step, and the CSV/XLSX/PDF parsers, which use `isKnownHeader` to decide whether a line is
 * the header row rather than preamble. A parser that guessed at that would silently promote
 * "Account Name,Acme Ltd" to a header (§5.1, finding F-B-18), so the rule lives here, in one place,
 * and is injected into the parsers rather than reimplemented by each of them.
 *
 * A suggestion is only ever a suggestion: §6.2 requires the reviewer to confirm every column, so
 * this file is allowed to be wrong. What it is not allowed to be is inconsistent between the
 * parsers, the mapping screen and the saved-mapping lookup.
 */

import { createHash } from 'node:crypto';
import type { ColumnSuggestion, TargetField } from '../pipeline-types';
import type { ImportType } from '../types';

/**
 * The runtime list of `TargetField`. `pipeline-types.ts` declares the union as a type only, and the
 * exactness check below fails to compile if a field is added there and forgotten here.
 */
export const TARGET_FIELDS = [
  'entry_date', 'transaction_date', 'issue_date', 'due_date', 'paid_date', 'posted_date',
  'period_start', 'period_end',
  'account', 'code', 'description', 'reference', 'journal_ref',
  'counterparty', 'customer', 'supplier', 'currency', 'type',
  'amount', 'debit', 'credit', 'money_in', 'money_out', 'balance_after',
  'opening_balance', 'closing_balance',
  'invoice_number', 'subtotal', 'tax_amount', 'total_amount', 'amount_paid', 'status',
] as const satisfies readonly TargetField[];

type _MissingTargetField = Exclude<TargetField, (typeof TARGET_FIELDS)[number]>;
/** Compile-time proof that TARGET_FIELDS covers the union; never read at runtime. */
const _targetFieldsAreExhaustive: _MissingTargetField extends never ? true : never = true;

/**
 * §6.2: "Headers are normalised (lowercase, strip punctuation, collapse spaces)".
 *
 * Punctuation becomes a space rather than nothing, so "money-out" and "money out" normalise the
 * same way and "a/c no" does not become the unreadable "acno". Letters and digits are matched with
 * Unicode classes: an accented header must survive normalisation, because §6.3 hashes the result
 * and two different headers that collapsed to the same string would share a saved mapping.
 */
export function normalizeHeader(cell: string): string {
  return cell
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

/**
 * `header_signature = sha256(normalised headers joined by '|')` (§6.3).
 *
 * Order matters and is preserved: a file with the same headers in a different order is a different
 * layout, and applying a saved column map to it positionally would map the wrong column.
 */
export function headerSignature(headers: readonly string[]): string {
  return createHash('sha256')
    .update(headers.map(normalizeHeader).join('|'), 'utf8')
    .digest('hex');
}

/**
 * The synonyms table of §6.2, extended with the spellings the same exports actually produce.
 *
 * `targets` is RANKED, not single, because several headers legitimately mean two different target
 * fields depending on what else is in the file. "Payee" is a description on a bank statement that
 * has no other description column, and a counterparty on one that does; "Reference" is a reference
 * on a bank statement and an invoice number on an invoice list. `suggestColumns` resolves that with
 * the rest of the header row in hand instead of guessing here.
 */
interface SynonymEntry {
  readonly headers: readonly string[];
  readonly targets: readonly TargetField[];
}

export const SYNONYM_TABLE: readonly SynonymEntry[] = [
  // ------------------------------------------------------------------------------------------
  // Dates (§6.2 row 1, plus the per-type dates of §6.1)
  // ------------------------------------------------------------------------------------------
  {
    headers: [
      'date', 'txn date', 'transaction date', 'trans date', 'tran date', 'posting date',
      'post date', 'date posted', 'value date', 'dated', 'date of transaction',
    ],
    targets: ['transaction_date', 'entry_date'],
  },
  {
    headers: ['entry date', 'journal date', 'gl date', 'ledger date', 'accounting date', 'date entered'],
    targets: ['entry_date', 'transaction_date'],
  },
  {
    headers: ['posted date', 'posted', 'cleared date', 'date cleared', 'settlement date'],
    targets: ['posted_date'],
  },
  {
    headers: [
      'issue date', 'invoice date', 'date issued', 'issued date', 'document date', 'tax point',
      'tax date', 'date of invoice',
    ],
    targets: ['issue_date'],
  },
  { headers: ['due', 'due date', 'payment due', 'date due', 'due on'], targets: ['due_date'] },
  {
    headers: ['paid date', 'date paid', 'payment date', 'settled date', 'date settled'],
    targets: ['paid_date'],
  },
  {
    headers: ['period start', 'period from', 'from date', 'date from', 'start date', 'month', 'budget month'],
    targets: ['period_start'],
  },
  {
    headers: ['period end', 'period to', 'to date', 'date to', 'end date', 'as at', 'as at date', 'as of', 'as of date'],
    targets: ['period_end'],
  },

  // ------------------------------------------------------------------------------------------
  // Account and code (§6.2 rows 7 and 8)
  // ------------------------------------------------------------------------------------------
  {
    headers: [
      'account', 'account name', 'nominal', 'nominal account', 'nominal name', 'gl account',
      'ledger account', 'category', 'account description', 'account title', 'chart of accounts', 'coa',
    ],
    targets: ['account'],
  },
  {
    headers: [
      'code', 'account code', 'nominal code', 'acct no', 'account no', 'account number', 'gl code',
      'a c code', 'acc code', 'nominal ledger code', 'account ref',
    ],
    targets: ['code', 'account'],
  },

  // ------------------------------------------------------------------------------------------
  // Description, reference, journal (§6.2 row 2)
  // ------------------------------------------------------------------------------------------
  {
    headers: [
      'description', 'narrative', 'details', 'detail', 'memo', 'particulars',
      'transaction description', 'transaction details', 'narrative details', 'remarks', 'notes',
      'note', 'line description',
    ],
    targets: ['description'],
  },
  {
    // §6.2 lists "payee" under BOTH description and customer/supplier. Description first: on a bank
    // statement description is a REQUIRED field (§6.1) and counterparty is optional, so a file whose
    // only text column is "Payee" must still satisfy the required field.
    headers: ['payee', 'paid to', 'beneficiary', 'paid to received from'],
    targets: ['description', 'counterparty'],
  },
  {
    headers: [
      'reference', 'ref', 'ref no', 'reference number', 'your reference', 'payment reference',
      'transaction reference',
    ],
    targets: ['reference', 'invoice_number'],
  },
  {
    headers: ['journal ref', 'journal', 'journal no', 'journal number', 'journal reference', 'batch', 'batch ref'],
    targets: ['journal_ref', 'reference'],
  },

  // ------------------------------------------------------------------------------------------
  // Counterparty (§6.2 row 10)
  // ------------------------------------------------------------------------------------------
  { headers: ['counterparty', 'contact', 'contact name', 'party', 'third party'], targets: ['counterparty'] },
  {
    headers: ['customer', 'client', 'customer name', 'client name', 'sold to', 'bill to', 'debtor'],
    targets: ['customer', 'counterparty'],
  },
  {
    headers: ['supplier', 'vendor', 'supplier name', 'vendor name', 'creditor'],
    targets: ['supplier', 'counterparty'],
  },

  // ------------------------------------------------------------------------------------------
  // Currency, type, status
  // ------------------------------------------------------------------------------------------
  { headers: ['currency', 'ccy', 'currency code', 'curr'], targets: ['currency'] },
  {
    headers: ['type', 'transaction type', 'txn type', 'entry type', 'payment type', 'invoice type'],
    targets: ['type'],
  },
  { headers: ['status', 'invoice status', 'payment status', 'state'], targets: ['status'] },

  // ------------------------------------------------------------------------------------------
  // Amounts (§6.2 rows 3–6)
  // ------------------------------------------------------------------------------------------
  {
    headers: ['amount', 'value', 'net', 'total', 'transaction amount', 'amt', 'net amount', 'budget', 'budget amount', 'planned', 'plan'],
    targets: ['amount', 'total_amount'],
  },
  { headers: ['debit', 'dr', 'debit amount', 'dr amount'], targets: ['debit', 'money_out'] },
  { headers: ['credit', 'cr', 'credit amount', 'cr amount'], targets: ['credit', 'money_in'] },
  {
    headers: ['paid out', 'money out', 'withdrawals', 'withdrawal', 'out', 'payments out', 'debits', 'withdrawn'],
    targets: ['money_out', 'debit'],
  },
  {
    headers: ['paid in', 'money in', 'deposits', 'deposit', 'in', 'payments in', 'credits', 'received'],
    targets: ['money_in', 'credit'],
  },
  {
    headers: ['balance', 'running balance', 'closing balance', 'balance after', 'bal', 'running bal'],
    targets: ['balance_after', 'closing_balance'],
  },
  {
    headers: ['opening balance', 'opening', 'brought forward', 'b f', 'balance b f', 'opening bal'],
    targets: ['opening_balance'],
  },
  {
    headers: ['carried forward', 'c f', 'balance c f', 'closing bal'],
    targets: ['closing_balance', 'balance_after'],
  },

  // ------------------------------------------------------------------------------------------
  // Invoices (§6.2 row 9 and the invoice schema of §6.1)
  // ------------------------------------------------------------------------------------------
  {
    headers: [
      'invoice', 'invoice no', 'invoice number', 'inv', 'inv no', 'invoice ref', 'bill number',
      'document number', 'number', 'doc no',
    ],
    targets: ['invoice_number', 'reference'],
  },
  {
    headers: ['subtotal', 'sub total', 'goods', 'goods value', 'net of vat', 'amount excl vat', 'excl vat'],
    targets: ['subtotal'],
  },
  { headers: ['tax', 'vat', 'tax amount', 'vat amount', 'sales tax', 'gst', 'vat total'], targets: ['tax_amount'] },
  {
    headers: ['total amount', 'gross', 'gross amount', 'invoice total', 'total incl vat', 'grand total', 'total value'],
    targets: ['total_amount', 'amount'],
  },
  {
    headers: ['amount paid', 'paid', 'payments received', 'amount received', 'settled amount'],
    targets: ['amount_paid'],
  },
];

/** Normalised header → ranked targets. First entry wins if the table ever repeats a header. */
const SYNONYM_INDEX: ReadonlyMap<string, readonly TargetField[]> = (() => {
  const index = new Map<string, readonly TargetField[]>();
  for (const entry of SYNONYM_TABLE) {
    for (const header of entry.headers) {
      const key = normalizeHeader(header);
      if (!index.has(key)) index.set(key, entry.targets);
    }
  }
  return index;
})();

/** `transaction_date` → "transaction date", so a header equal to the field name matches exactly. */
const CANONICAL_HEADER: ReadonlyMap<string, TargetField> = new Map(
  TARGET_FIELDS.map((field) => [field.replace(/_/gu, ' '), field] as const),
);

/**
 * Exports label money columns "Amount (GBP)", "Debit £" or "Paid out (USD)". The qualifier is not
 * part of the header's meaning, so it is removed before matching — but NOT before hashing, because
 * `header_signature` must distinguish two files that genuinely differ.
 */
const CURRENCY_CODES_IN_HEADERS =
  'gbp|usd|eur|aed|inr|cad|aud|nzd|chf|jpy|zar|sek|nok|dkk|pln|hkd|sgd|cny';
const CURRENCY_QUALIFIER = new RegExp(`\\s+(?:in\\s+)?(?:${CURRENCY_CODES_IN_HEADERS})$`, 'u');

function matchKeys(normalized: string): readonly string[] {
  const stripped = normalized.replace(CURRENCY_QUALIFIER, '').trim();
  return stripped !== '' && stripped !== normalized ? [normalized, stripped] : [normalized];
}

/**
 * Does this cell read as a column header? Used by the CSV, XLSX and PDF parsers to find the header
 * row (§5.1–§5.3) and injected into them so there is exactly one answer in the system.
 *
 * Deliberately strict — a full-string match on the normalised cell, not a containment match. A
 * looser rule would accept "Date of birth" or "Total sales for the year to 31 March" as headers and
 * turn a report's preamble into the table.
 */
export function isKnownHeader(cell: string): boolean {
  const normalized = normalizeHeader(cell);
  if (normalized === '') return false;
  return matchKeys(normalized).some((key) => SYNONYM_INDEX.has(key) || CANONICAL_HEADER.has(key));
}

type MatchStrength = 'exact' | 'synonym' | 'weak';

interface HeaderMatch {
  readonly index: number;
  readonly sourceColumn: string;
  readonly strength: MatchStrength;
  readonly targets: readonly TargetField[];
}

/** Longest contiguous token run of a known header inside a longer one ("customer name (billing)"). */
function containedMatch(normalized: string): readonly TargetField[] | null {
  const tokens = normalized.split(' ');
  let best: { length: number; targets: readonly TargetField[] } | null = null;
  for (const [key, targets] of SYNONYM_INDEX) {
    const keyTokens = key.split(' ');
    if (keyTokens.length > tokens.length) continue;
    for (let start = 0; start + keyTokens.length <= tokens.length; start += 1) {
      let hit = true;
      for (let offset = 0; offset < keyTokens.length; offset += 1) {
        if (tokens[start + offset] !== keyTokens[offset]) { hit = false; break; }
      }
      if (hit && (best === null || keyTokens.length > best.length)) {
        best = { length: keyTokens.length, targets };
      }
    }
  }
  return best?.targets ?? null;
}

function matchHeader(sourceColumn: string, index: number): HeaderMatch | null {
  const normalized = normalizeHeader(sourceColumn);
  if (normalized === '') return null;
  for (const key of matchKeys(normalized)) {
    const canonical = CANONICAL_HEADER.get(key);
    if (canonical !== undefined) {
      const synonyms = SYNONYM_INDEX.get(key) ?? [];
      // The canonical field is preferred, but the synonym ranking behind it is still a useful
      // fallback when another column has already claimed it.
      const targets = [canonical, ...synonyms.filter((t) => t !== canonical)];
      return { index, sourceColumn, strength: 'exact', targets };
    }
  }
  for (const key of matchKeys(normalized)) {
    const targets = SYNONYM_INDEX.get(key);
    if (targets !== undefined) return { index, sourceColumn, strength: 'synonym', targets };
  }
  const contained = containedMatch(normalized);
  return contained === null ? null : { index, sourceColumn, strength: 'weak', targets: contained };
}

/**
 * Where a neutral target means something more specific for a given import type.
 *
 * The same header means different things in different files: "Date" is `entry_date` in a general
 * ledger and `transaction_date` on a bank statement; "Debit" is a GL direction column but the
 * money-out column of a statement; "Contact" is the customer on a sales list and the supplier on a
 * purchase list. Suggesting a field the import type has no schema for (§6.1) would just make the
 * reviewer re-pick every column.
 */
const TYPE_RETARGET: Readonly<Partial<Record<ImportType, Readonly<Partial<Record<TargetField, TargetField>>>>>> = {
  general_ledger: { transaction_date: 'entry_date', money_out: 'debit', money_in: 'credit', customer: 'counterparty', supplier: 'counterparty', total_amount: 'amount' },
  receipts: { transaction_date: 'entry_date', money_out: 'debit', money_in: 'credit', customer: 'counterparty', supplier: 'counterparty', total_amount: 'amount' },
  bank_statement: { entry_date: 'transaction_date', debit: 'money_out', credit: 'money_in', customer: 'counterparty', supplier: 'counterparty', total_amount: 'amount' },
  trial_balance: { money_out: 'debit', money_in: 'credit', balance_after: 'closing_balance', total_amount: 'amount' },
  balance_sheet: { money_out: 'debit', money_in: 'credit', balance_after: 'closing_balance', total_amount: 'amount' },
  pnl_report: { money_out: 'debit', money_in: 'credit', balance_after: 'closing_balance', total_amount: 'amount' },
  sales_invoices: { transaction_date: 'issue_date', entry_date: 'issue_date', counterparty: 'customer', supplier: 'customer', amount: 'total_amount' },
  sales_report: { transaction_date: 'issue_date', entry_date: 'issue_date', counterparty: 'customer', supplier: 'customer', amount: 'total_amount' },
  purchase_invoices: { transaction_date: 'issue_date', entry_date: 'issue_date', counterparty: 'supplier', customer: 'supplier', amount: 'total_amount' },
  purchase_report: { transaction_date: 'issue_date', entry_date: 'issue_date', counterparty: 'supplier', customer: 'supplier', amount: 'total_amount' },
  // ADR-142: a budget is month, account and amount.
  budget: { transaction_date: 'period_start', entry_date: 'period_start', issue_date: 'period_start', period_end: 'period_start', total_amount: 'amount', closing_balance: 'amount', debit: 'amount' },
};

function retarget(targets: readonly TargetField[], importType?: ImportType): readonly TargetField[] {
  const table = importType === undefined ? undefined : TYPE_RETARGET[importType];
  const moved = table === undefined ? targets : targets.map((t) => table[t] ?? t);
  return [...new Set(moved)];
}

const STRENGTH_ORDER: Readonly<Record<MatchStrength, number>> = { exact: 0, synonym: 1, weak: 2 };

/**
 * Suggest a target field for each source column (§6.2).
 *
 * Two columns cannot map to the same target, so the strongest match takes the field and a weaker
 * one falls to its next candidate: given "Description" and "Payee", description is claimed by the
 * exact match and "Payee" becomes the counterparty. A column with no candidate left is simply not
 * suggested — §6.2 keeps unmapped columns in `raw_data` and shows them as "ignored".
 *
 * `importType` is optional so the parsers can call this before the type is known; passing it moves
 * the neutral targets onto the fields that type's schema actually has (§6.1).
 */
export function suggestColumns(
  headers: readonly string[],
  importType?: ImportType,
): ColumnSuggestion[] {
  const matches = headers
    .map((header, index) => matchHeader(header, index))
    .filter((m): m is HeaderMatch => m !== null)
    .sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] || a.index - b.index);

  const claimed = new Set<TargetField>();
  const byIndex = new Map<number, ColumnSuggestion>();
  for (const match of matches) {
    const candidates = retarget(match.targets, importType);
    const target = candidates.find((candidate) => !claimed.has(candidate));
    if (target === undefined) continue;
    claimed.add(target);
    // A field reached only because the stronger candidate was taken is a weaker suggestion than the
    // header's own match strength implies, and the reviewer should see it flagged as such.
    const confidence: ColumnSuggestion['confidence'] =
      match.strength === 'weak' || target !== candidates[0] ? 'weak' : match.strength;
    byIndex.set(match.index, { sourceColumn: match.sourceColumn, target, confidence });
  }

  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, suggestion]) => suggestion);
}
