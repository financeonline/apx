# MOTION — Import Engine

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-011, ADR-012, ADR-016, CD-03, CD-04, CD-10, CD-11, CD-12, CD-22, CD-28), `DATABASE_ARCHITECTURE.md §3–5`, `RBAC_MATRIX.md`, `MVP_SCOPE.md §2.3`
Consumed by: `SERVICE_ARCHITECTURE.md` (imports, documents modules), `TEST_STRATEGY.md`, `UX_ARCHITECTURE.md`

Governing rule (SOW §23): **invalid and duplicate data is surfaced, never silently discarded.** Every row a user gives MOTION ends up as an `import_rows` record with a status the user can see. There is no code path that drops a row.

---

## 1. Pipeline overview

```
Upload ─► File validation ─► Parse ─► Map columns ─► Map accounts ─► Preview ─► Validate rows
      ─► Detect duplicates ─► Review ─► Commit (transaction) ─► Enqueue calculation ─► History
```

Owning module: `src/modules/imports` (pipeline, mapping, validation, commit) with `src/modules/documents` (upload, storage, scanning, text extraction) upstream. Permissions: `imports.create` for upload/start, `imports.review` for mapping, review, commit and roll back (`RBAC_MATRIX.md §2.1`). The browser never writes to any table; all steps are server actions or route handlers using the user's session client (ADR-013).

### 1.1 `import_batches` state machine

| From | Event | To | Notes |
|---|---|---|---|
| — | `startBatch` after upload | `created` | `source_documents.status` must be `ready` |
| `created` | parser starts | `parsing` | synchronous for CSV/XLSX ≤ 5,000 rows; `document.extract` job otherwise (CD-22) |
| `parsing` | parse succeeds | `mapping` | `import_rows` written with `raw_data`, status `pending` |
| `parsing` | parse fails | `failed` | `error_summary` populated; batch is retryable from `created` |
| `mapping` | mapping saved (columns + accounts) | `validating` | `mapping_snapshot` frozen |
| `validating` | validation + duplicate pass completes | `awaiting_review` | `row_counts` populated |
| `awaiting_review` | reviewer changes mapping | `mapping` | re-validation required; previous decisions preserved where row hashes are unchanged |
| `awaiting_review` | reviewer commits, zero unresolved `error` rows | `committing` | |
| `awaiting_review` | reviewer rejects batch | `rejected` | `rolled_back_reason` reused for the rejection reason |
| `committing` | transaction succeeds | `committed` | `committed_at`, `calculation_run_id` |
| `committing` | transaction fails | `awaiting_review` | nothing partially written; error shown |
| `committed` | reviewer rolls back | `rolled_back` | records soft-rejected (§12), recalculation enqueued |

Terminal states: `committed` (may still transition to `rolled_back`), `rolled_back`, `rejected`, `failed`. No state deletes anything.

### 1.2 `import_rows` statuses

| Status | Meaning | Feeds commit? |
|---|---|---|
| `pending` | parsed, not yet validated | no |
| `valid` | no issues | yes |
| `warning` | issues of severity `warning` only | yes (default keep) |
| `error` | at least one `error` issue unresolved | no — blocks commit until fixed or skipped |
| `duplicate` | matches an existing record or another row (§9) | only if `reviewer_decision = keep` |
| `skipped` | reviewer chose not to import | no |
| `committed` | written to target table; `committed_table`/`committed_record_id` set | done |
| `rejected` | batch rejected or rolled back | no |

`reviewer_decision ∈ {none, keep, skip, fixed}` records what a human did; `reviewer_reason` is mandatory for `keep` on a duplicate and for `skip` on a `valid` row.

---

## 2. Upload

Path: browser → `POST /api/imports/upload` (multipart) → `documents.service.uploadDocument(ctx, file, declaredKind)`.

1. `assertCan(ctx, 'imports.create')`.
2. Limits: 25 MB per file; after parsing, 50,000 rows per file (a larger file is rejected at parse with `IMP-FILE-004` and the advice to split by period). One file per batch.
3. SHA-256 computed server-side while streaming to a temp buffer. Lookup `source_documents (organization_id, sha256) WHERE deleted_at IS NULL`. On hit: respond `409` with the earlier document id, its batch status and a link; no new row is written (CD-12, file duplicate). The user may still open the earlier batch.
4. File validation (§4). Failure → the file is stored with `status = 'quarantined'` and `scan_result` populated so the user and platform can see what was rejected; it is never parsed.
5. Storage write to bucket `source-documents`, path `{organization_id}/{document_id}/{sanitised-original-filename}` (`TENANCY_MODEL.md §8`).
6. `source_documents` row: `document_kind` = the user's selection from the upload form. The form pre-selects a suggestion from filename and header heuristics (`statement`, `stmt` → `bank_statement`; `trial balance`, `TB` → `trial_balance`; `ledger`, `journal`, `GL` → `general_ledger`; `invoice` + `customer` column → `sales_invoices`; `bill`, `supplier` → `purchase_invoices`), but the user's choice wins and is recorded. `document_kind` maps 1:1 to `import_type` except `invoice`/`receipt` (single-document kinds), `other`/`unknown` (store only; no batch).
7. Audit: `document.uploaded`.
8. Response: `{ documentId, suggestedImportType, textLayer: true|false|null, pageCount }`. The client then calls `imports.service.startBatch`.

Bank statements additionally require a `bank_account_id` (select existing or create inline; `banking.view` to list, `financials.edit` to create).

---

## 3. Storage and metadata

- Bucket is private; reads are 60-second signed URLs minted by `GET /api/documents/[documentId]/url` after `assertCan(ctx, 'documents.view')` and an audit event `document.downloaded`.
- Metadata lives only in `source_documents`; Storage object metadata is not trusted.
- PDF text dumps are stored alongside as `{organization_id}/{document_id}/text.json` (`extracted_text_path`), page-indexed, so the review UI can highlight lines without re-extracting.
- Retention follows the organization (CD-23). Deleting a document is only possible if no `import_batches` reference it, or as part of `org.purge`.

---

## 4. File validation

Runs in `documents/domain/validate-file.ts` before storage. Every failure yields a `scan_result` entry `{code, message, detail}`.

| Check | Rule | Failure code |
|---|---|---|
| Extension ↔ MIME sniff | Magic bytes must match the declared type: `text/csv` (or `text/plain` with delimiter structure), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/pdf`. `.xls` (BIFF) is rejected with advice to save as `.xlsx`. | `IMP-FILE-001` |
| Size | ≤ 25 MB | `IMP-FILE-002` |
| XLSX structure | Valid ZIP with `[Content_Types].xml` and `xl/workbook.xml`; no external links; `xl/vbaProject.bin` present → reject (macros) | `IMP-FILE-003` |
| Row cap | ≤ 50,000 data rows across the chosen sheet | `IMP-FILE-004` |
| CSV encoding | Detect BOM (UTF-8/16); otherwise attempt UTF-8 strict, fall back to Windows-1252; record `encoding` in `transforms`. Undecodable bytes → reject | `IMP-FILE-005` |
| CSV delimiter | Sniff `,` `;` `\t` `|` over first 20 lines; require consistent field count in ≥ 90% of lines | `IMP-FILE-006` |
| PDF | Valid header/xref; page count ≤ 200; encrypted PDFs rejected; text layer probed on first 3 pages → `has_text_layer` | `IMP-FILE-007` |
| Malware | Supabase Storage scanning where enabled; additionally reject embedded JavaScript/OpenAction in PDFs | `IMP-FILE-008`, `status = quarantined` |
| Filename | Sanitised to `[A-Za-z0-9._-]`, truncated to 120 chars; original kept in `original_filename` | — |

Quarantined files are visible to owners/admins under Data → Documents with the reason, and to platform under `/platform/jobs` failures; they cannot be downloaded by tenants.

---

## 5. Parsing

Parsers live in `imports/domain/parsers/*`, are pure (bytes in, `ParsedTable` out), and are unit-tested against the fixtures in §17.

```ts
type ParsedTable = {
  sheet?: string;                 // XLSX sheet or PDF 'page:N'
  headerRow?: number;             // 1-based, undefined if headerless
  columns: string[];              // raw header texts, or generated 'col_1'…
  rows: { rowNumber: number; sourceRef: string; cells: (string|null)[] }[];
  statement?: { openingBalance?: string; closingBalance?: string; periodStart?: string; periodEnd?: string; accountMasked?: string };
  warnings: { code: string; message: string }[];
};
```

### 5.1 CSV
Decode with detected encoding, split with detected delimiter honouring RFC 4180 quoting, trim trailing empty lines. Header row = first line whose cells are non-numeric and unique; if none, `headerRow` undefined and columns are `col_1…`. Rows with a field count different from the header count are kept with `raw_data` padded/truncated and a `IMP-ROW-001` (malformed row) issue attached later.

### 5.2 XLSX
Read with a streaming SheetJS-compatible parser (no formulas evaluated; cached values only). Sheet selection: if the workbook has one non-empty sheet, use it; otherwise the mapping step asks the user (default: first sheet with ≥ 2 rows and ≥ 3 columns). Header row detection: first row where ≥ 60% of populated cells are text and the next row contains ≥ 1 number or date. Merged cells: value is placed in the top-left cell; other cells of the range are `null` and inherit only for *label* columns (description/account), never for amounts. Dates come as serials → ISO via the 1900 epoch (1904 flag honoured). Hidden rows are still imported (with a warning `IMP-ROW-003`).

### 5.3 PDF — text-layer deterministic parser
Extract per-page text with positional data (x, y per token). Group tokens into lines by y (tolerance 2 pt). Detect a column grid from the header line matching one of the known grammars:

```
G1: DATE  DESCRIPTION  [PAID OUT|DEBIT|WITHDRAWALS]  [PAID IN|CREDIT|DEPOSITS]  BALANCE
G2: DATE  DESCRIPTION  AMOUNT  BALANCE
G3: DATE  TYPE  DESCRIPTION  MONEY OUT  MONEY IN  BALANCE
```

Tokens are assigned to columns by x-ranges from the header. A line that has a date in the date column starts a transaction; subsequent lines without a date and with text only in the description column are appended to the previous description (multi-line descriptions). Opening/closing balance capture: lines matching `/(opening|balance brought forward|start balance)/i` and `/(closing|balance carried forward|end balance)/i` with a money token populate `statement.openingBalance/closingBalance`; statement period from `/(\d{1,2}\s\w+\s\d{4})\s*(to|-|–)\s*(\d{1,2}\s\w+\s\d{4})/`. If no grammar matches ≥ 80% of lines on the first transaction page, the deterministic parser yields nothing and the batch falls through to §5.4. `extraction_method = pdf_text`.

### 5.4 PDF — Claude-assisted extraction (CD-11, ADR-011)
Used only when `has_text_layer = true` and §5.3 failed, or the user explicitly requests it. Runs as a `document.extract` job.

- Input: page text (never the binary, never other organizations' data) one page at a time, wrapped as untrusted data (see `AI_ARCHITECTURE.md §9`).
- Output schema (validated with Zod; any violation = page failure, not a guess):
  ```ts
  { page: number,
    rows: { line: number; date: string /*ISO*/; description: string; amount: string /*signed decimal*/; balance?: string; reference?: string }[],
    openingBalance?: string; closingBalance?: string; periodStart?: string; periodEnd?: string;
    confidence: 'high'|'medium'|'low'; notes: string[] }
  ```
- Every produced row is stamped `assurance_level = inferred`, `record_status = needs_review`, `import_rows.status = warning` with issue `IMP-PDF-001` ("extracted by AI, confirm against page N").
- **Balance reconciliation gate.** For bank statements: `Σ amount` over all extracted rows must equal `closingBalance − openingBalance` (both from the statement, both required); per-page running balances must chain. Mismatch → batch-level error `IMP-BAL-006` and **commit is blocked** until rows are corrected in review or the user re-uploads as CSV. For non-statement PDFs (a P&L report), the gate is: reported totals present on the page must equal the sum of extracted lines within 0.01.
- **Side-by-side review requirement.** The review UI shows the page image next to the rows; each row's `source_ref` (`page:N;line:M`) highlights the line. The reviewer must either tick each row or tick "I have compared all rows on page N" for each page before commit is enabled. `extraction_method = pdf_claude` is shown on the batch and inherited as `assurance_level = inferred` on committed records, so the AI Analyst and dashboard label these figures accordingly.
- Claude never receives instructions from the page: the prompt states that page content is data. Any row whose description contains an instruction-like phrase is still imported as text; text is never executed.

### 5.5 Scanned PDF (no text layer)
`source_documents.status = 'unreadable'`, no batch is created. The user sees: "This PDF is a scanned image. MOTION has stored it as a source document. Please upload the same statement as CSV or XLSX from your bank." OCR is post-MVP (`MVP_SCOPE.md §4`).

---

## 6. Mapping

### 6.1 Target field schemas per `import_type`

| import_type → target | Required fields | Optional fields |
|---|---|---|
| `general_ledger` → `ledger_entries` | `entry_date`, `account` (name or code), and either (`debit`, `credit`) or (`amount` + `direction`/sign) | `description`, `reference`, `journal_ref`, `counterparty`, `currency` |
| `trial_balance` → `period_balances (balance_kind = trial_balance)` | `account`, `period` (batch-level: one period per file) and either (`debit`, `credit`) or `closing_balance` | `opening_balance`, `code` |
| `pnl_report` → `period_balances (pnl_report)` | `account`/line label, `period` (batch-level), `amount` (movement) | multi-period columns (one column per month → fan out to rows) |
| `balance_sheet` → `period_balances (balance_sheet)` | `account`, `period` (batch-level), `closing_balance` | multi-period columns |
| `bank_statement` → `bank_transactions` | `transaction_date`, `description`, and either `amount` (signed) or (`money_out`, `money_in`) | `posted_date`, `balance_after`, `reference`, `counterparty_name`, `type` |
| `sales_invoices` → `invoices (sales)` | `invoice_number`, `customer`, `issue_date`, `total_amount` | `due_date`, `subtotal`, `tax_amount`, `amount_paid`, `status`, `paid_date`, `description`, `currency` |
| `purchase_invoices` → `invoices (purchase)` | `invoice_number`, `supplier`, `issue_date`, `total_amount` | as above |
| `receipts` → `ledger_entries` (one row per receipt, account = user-chosen expense account) | `entry_date`, `amount`, `account` | `description`, `counterparty`, `reference` |

Negative `total_amount` on invoices becomes `invoice_type = *_credit_note` with positive amount (CD-28).

### 6.2 Column-mapping suggestion
Headers are normalised (lowercase, strip punctuation, collapse spaces) and matched against a synonyms table in `imports/domain/mapping/synonyms.ts`. Examples:

| Target | Synonyms |
|---|---|
| `transaction_date` / `entry_date` | date, txn date, transaction date, posting date, value date, dated |
| `description` | description, narrative, details, memo, particulars, payee, transaction description |
| `amount` | amount, value, net, total, transaction amount |
| `money_out` / `debit` | paid out, debit, withdrawals, money out, dr, out |
| `money_in` / `credit` | paid in, credit, deposits, money in, cr, in |
| `balance_after` | balance, running balance, closing balance |
| `account` | account, account name, nominal, gl account, ledger account, category |
| `code` | code, account code, nominal code, acct no |
| `invoice_number` | invoice, invoice no, inv #, number, reference |
| `customer` / `supplier` | customer, client, contact, supplier, vendor, payee |
| `due_date` | due, due date, payment due |

A suggestion is shown as pre-filled with a "suggested" tag; the user confirms. Unmapped source columns are kept in `raw_data` but not imported (shown as "ignored: 3 columns").

### 6.3 Saved mappings
`header_signature = sha256(normalised headers joined by '|')`. On parse, `import_mappings (organization_id, import_type, header_signature)` is looked up; a hit pre-applies `column_map`, `transforms` and `account_map` and shows "Using your saved mapping from 12 May". Saving is automatic on commit; the user can rename or delete mappings under Data → Imports → Mappings.

### 6.4 Transforms

**Dates.** Detect per column: ISO (`2026-03-14`), day-first (`14/03/2026`, `14-03-26`, `14 Mar 2026`), month-first (`03/14/2026`), Excel serial. Ambiguity rule: if every value in the column parses validly as both D/M/Y and M/D/Y (all day and month parts ≤ 12), the mapping step **requires** an explicit choice, defaulting to the organization's country (`GB` → day-first). If some values disambiguate (a 14 in the first slot), that ordering is applied to all and the column is marked "detected day-first". After a choice, rows whose meaning changes between the two interpretations are counted and shown ("31 rows would be read differently if month-first"), and each carries `IMP-DATE-003` (warning) so reviewers see them.

**Numbers.** Decimal and thousands separators detected per column from the pattern of `.` and `,`; `1.234,56` vs `1,234.56`; a space thousands separator is accepted. Currency symbols and codes are stripped and compared with the organization's `base_currency` (CD-10, `IMP-CUR-007`).

**Negative styles.** `(123.45)`, `123.45-`, `-123.45`, `123.45 CR`/`DR` suffix, separate CR/DR column. All normalised to a signed decimal string.

**Bank sign convention.** If the file has `money_out`/`money_in` columns, `amount = money_in − money_out`. If it has a single `amount` column, the mapping step asks "Are payments out shown as negative?" with a preview of three sample rows; the answer is saved in `transforms.bankSign ∈ {negative_out, positive_out}`. Credit-card accounts default to `positive_out`.

**GL direction.** Debit/credit columns map to `direction` + positive `amount`. A signed single column maps by sign (positive = debit) unless the user overrides in `transforms.glSign`.

### 6.5 Account mapping to standard categories (CD-04, ADR-004)
Every distinct `account` value (and code) in the file becomes a candidate. Resolution order: exact match on `accounts.code`; exact on `normalized_name`; saved `account_map` from the matching mapping; keyword suggestion; else `uncategorised`.

Keyword suggestion examples (`imports/domain/mapping/category-keywords.ts`):

| Keyword pattern | standard_category |
|---|---|
| sales, revenue, turnover, fees earned, income (not "other") | `revenue` |
| cost of sales, cogs, purchases, materials, direct costs, subcontract | `cost_of_sales` |
| salaries, wages, payroll, paye, pension, ni, staff costs | `payroll` |
| marketing, advertising, ads, google, meta, promotion | `marketing` |
| rent, rates, utilities, insurance, software, subscriptions, travel, office | `operating_expense` |
| interest paid, loan interest, bank charges | `interest_expense` |
| corporation tax, income tax | `tax_expense` |
| depreciation, amortisation | `depreciation` |
| bank, current account, cash, petty cash | `cash` |
| debtors, receivable, accounts receivable | `receivables` |
| creditors, payable, accounts payable | `payables` |
| vat, gst, sales tax | `tax_liability` |
| loan, director's loan, hp, finance lease | `loan` |
| drawings, dividends | `drawings` |
| transfer, tfr | `transfer` |

The confirm step lists every account with its suggested category and confidence (`accounts.mapping_confidence = suggested`); the reviewer confirms all or edits individually; on confirm, new `accounts` rows are created with `source = imported`, `mapping_confidence = confirmed`. Accounts left `uncategorised` are allowed (warning `IMP-ACCT-005`), but the batch summary states "N accounts uncategorised — revenue and profit will be marked incomplete until mapped", and any metric that touches them carries `data_quality.missing`.

For bank statements there is no account column; `category_account_id` is assigned later by the banking rules engine (`banking` module), so no mapping step is needed beyond the bank account and sign.

### 6.6 Counterparty resolution
`normalized_name = lower(trim(collapse_ws(strip(name, /[^\p{L}\p{N} ]/u))))` with common suffixes removed (`ltd`, `limited`, `plc`, `llp`, `inc`). Exact `normalized_name` match → existing `counterparties.id`; no match → created with `kind` from the import type (`customer` for sales, `supplier` for purchase, `unknown` for GL/bank). `kind` is upgraded to `both` when the same counterparty appears on both sides. Merging is a later user action (`customers.edit`).

---

## 7. Preview

After mapping, the server returns the first 50 rows as `mapped_data` alongside per-column statistics: parsed/unparsed counts, min/max date, min/max amount, sum, distinct counts for account/counterparty, and the number of rows that would change meaning under the other date ordering. The preview is read-only; problems are fixed by adjusting the mapping (returns to `mapping`) or later in review.

---

## 8. Row validation

Validation is pure (`imports/domain/validate-rows.ts`) over `mapped_data` and produces `issues[]` per row: `{code, severity: 'error'|'warning', field?, message, suggestion?}`.

### 8.1 Field-level

| Code | Severity | Rule |
|---|---|---|
| `IMP-REQ-003` | error | Required field (per §6.1) empty |
| `IMP-DATE-001` | error | Date unparseable under chosen format |
| `IMP-DATE-002` | warning | Date more than 5 years old or more than 90 days in the future |
| `IMP-DATE-003` | warning | Date reads differently under the alternative D/M ordering |
| `IMP-AMT-002` | error | Amount not a valid decimal after transforms; or both `money_in` and `money_out` populated |
| `IMP-AMT-003` | warning | Amount is zero |
| `IMP-AMT-004` | warning | Absolute amount > 100 × the column median (possible unit/decimal error) |
| `IMP-PERIOD-004` | error | Date outside the declared statement/report period |
| `IMP-ACCT-005` | warning | Account maps to `uncategorised` |
| `IMP-ACCT-006` | error | Account value blank on a GL/TB row |
| `IMP-CUR-007` | error | Currency ≠ `organizations.base_currency` (CD-10) |
| `IMP-INV-008` | error | Invoice `amount_paid` > `total_amount` |
| `IMP-INV-009` | warning | `due_date` earlier than `issue_date` |
| `IMP-ROW-001` | error | Malformed row (field count mismatch) |
| `IMP-ROW-002` | warning | Row is entirely blank (auto-skipped, still recorded) |
| `IMP-ROW-003` | warning | Row was hidden in the source sheet |
| `IMP-PDF-001` | warning | Row extracted by AI; needs visual confirmation |
| `IMP-DUP-001` | duplicate | Exact record duplicate against committed data |
| `IMP-DUP-002` | duplicate | Exact duplicate of another row in this batch |
| `IMP-DUP-003` | warning | Fuzzy duplicate (±1 day) |

### 8.2 Batch-level

| Code | Severity | Rule |
|---|---|---|
| `IMP-BAL-006` | error | Bank statement: `Σ amount ≠ closing − opening` (when both balances known); or `balance_after` chain breaks between consecutive rows by more than 0.01 |
| `IMP-GL-010` | error | General ledger: `Σ debit ≠ Σ credit` per `journal_ref` (when journals are present); warning if no journal grouping exists |
| `IMP-TB-011` | error | Trial balance: `Σ debit − Σ credit ≠ 0` within 0.01 |
| `IMP-PER-012` | warning | Rows span more than one calendar month for a report type that should be single-period |
| `IMP-COV-013` | warning | Period already has committed data of the same type (supersession or overlap, see §11) |

Errors block commit of the affected rows (field-level) or of the batch (batch-level). Warnings never block; they are shown and inherited into `data_quality` where relevant.

---

## 9. Duplicate detection (CD-12)

### 9.1 `dedupe_hash` recipe
```
key = organization_id
    | target_table
    | scope_id            -- bank_account_id for bank rows; account_id for ledger rows; invoice_type for invoices; account_id for period_balances
    | date (ISO)          -- transaction_date / entry_date / issue_date / period_start
    | amount (2 dp, absolute)
    | direction           -- inflow/outflow, debit/credit, or invoice_type
    | norm_desc
dedupe_hash = sha256(key)
```
`norm_desc` = description lowercased, Unicode NFKC, punctuation removed, whitespace collapsed, **with long digit runs (≥ 6 digits) and card-terminal suffixes (e.g. `*1234`, `ref 000123`) removed** so that the same payment shown with different transaction ids still matches, but two same-day equal payments to different payees do not. For invoices `norm_desc` is replaced by `invoice_number`. The recipe version is stored in `import_batches.mapping_snapshot.dedupeVersion`; hashes are recomputed only when the version changes.

### 9.2 Passes
1. **Cross-batch exact.** Look up `dedupe_hash` in the target table for the organization where `record_status = 'accepted'`. Hit → `IMP-DUP-001`, `duplicate_of_table/id` set, row status `duplicate`, `reviewer_decision` default `skip`.
2. **Within-batch exact.** Same hash twice in the batch → later row gets `IMP-DUP-002` with `duplicate_within_batch_row_id`; default `skip`. (Legitimately repeated identical transactions are the common false positive; the review UI says so and one click keeps both with reason "legitimate repeat".)
3. **Fuzzy.** Same scope, amount and `norm_desc`, date within ±1 day, against committed rows and within batch → `IMP-DUP-003`, status `warning`, default `keep`.

Keeping a `duplicate` row requires `reviewer_reason`. The decision and reason are copied to the committed record's audit event.

---

## 10. Review UI contract

Route: `/app/[orgSlug]/data/imports/[batchId]`. Permission: `imports.review`.

- Header: file name, type, period detected, row counts by status, extraction method badge, statement balances and reconciliation status.
- Issue panel grouped by code with counts; clicking filters the grid.
- Row grid: source ref, raw values (collapsed), mapped values (editable in place for `error`/`warning` rows; edits write `mapped_data`, set `reviewer_decision = fixed`, re-validate that row, and are logged).
- Bulk actions: keep/skip selected; "skip all errors"; "keep all fuzzy duplicates".
- Commit button enabled only when: no row has status `error` (fixed or skipped), no batch-level error, and for `pdf_claude` batches every page is confirmed.
- PDF side-by-side pane (§5.4) for `pdf_text` and `pdf_claude` batches.
- Reject batch (reason required).
- Every decision is a server action; the grid never mutates state locally without a server round-trip.

---

## 11. Commit

`imports.service.commitBatch(ctx, batchId)`:

1. `assertCan(ctx, 'imports.review')`; batch must be `awaiting_review`; re-run batch-level checks server-side (never trust the client's "all resolved").
2. Transition to `committing`.
3. Single database transaction (Postgres function `app.commit_import_batch(batch_id)` called with the user's session so RLS applies; the function is `SECURITY INVOKER`):
   - For each row with status `valid|warning`, or `duplicate` with `reviewer_decision = keep`: insert into the target table with `import_batch_id`, `import_row_id`, `source_document_id`, `source_ref`, `dedupe_hash`, `record_status = accepted` (or `needs_review` for `inferred` rows the reviewer did not tick individually — not possible after §10 gating, but enforced), `assurance_level` (`verified` for CSV/XLSX/pdf_text rows, `inferred` for pdf_claude). `period_id` is assigned by the `period_assign` trigger.
   - `period_balances`: if an accepted, non-superseded row exists for `(organization_id, period_id, account_id)`, set its `superseded_by` to the new row (`IMP-COV-013` warned the reviewer). Never overwrite.
   - Update `import_rows` to `committed` with `committed_table`, `committed_record_id`.
   - Update `import_batches.row_counts`, `status = committed`, `committed_at`, `reviewed_by`.
   - Upsert `import_mappings` from `mapping_snapshot`.
4. After commit: enqueue `calculation.run` job `{organizationId, trigger: 'import_commit', triggerRefId: batchId, periodFrom: min(period), periodTo: 'latest'}` and write `calculation_run_id` back; audit `import.committed` with counts and reviewer decisions summary.
5. Batches over 5,000 rows run steps 3–4 inside an `import.commit_large` job with the batch shown as `committing` and a progress indicator; the transaction is still atomic.

Failure in step 3 rolls the transaction back, returns the batch to `awaiting_review` and shows the database error in plain language; nothing is partially written.

---

## 12. Rejection and roll back

- **Reject** (before commit): status `rejected`, rows `rejected`, reason stored, audit `import.rejected`. Document remains.
- **Roll back** (after commit): `imports.service.rollbackBatch(ctx, batchId, reason)` → all records with this `import_batch_id` get `record_status = 'rejected'`, `rejected_reason = 'batch rolled back'`; superseded `period_balances` rows have `superseded_by` cleared so the previous values return; `import_rows` → `rejected`; batch `rolled_back`; enqueue `calculation.run` with trigger `import_rollback`; audit `import.rolled_back`. Alerts and actions that cited rolled-back evidence are not deleted; alerts are re-evaluated by the run and may auto-resolve with `status_reason = 'evidence rolled back'`.
- Hard deletion never happens outside `org.purge` (ADR-012).

---

## 13. Traceability

Every committed record carries `source_document_id`, `import_batch_id`, `import_row_id` and a human-readable `source_ref`:

| Source | `source_ref` format | Example |
|---|---|---|
| CSV | `csv:row:{n}` (1-based, counting the header as row 1) | `csv:row:17` |
| XLSX | `sheet:{name}!row:{n}` | `sheet:Bank!row:42` |
| PDF | `page:{p};line:{l}` | `page:3;line:12` |
| Manual entry | `manual` | |

The evidence drawer (`EVIDENCE_MODEL.md`) resolves `source_ref` to open the document at the page/row. Rows and records are linked both ways so a reviewer can ask "what did this row become?" and a user can ask "where did this transaction come from?".

---

## 14. Import history and re-import

Route `/app/[orgSlug]/data/imports`: table of batches (date, file, type, period, status, counts, who), filter by status/type, link to review or read-only detail for committed batches, roll back action, and a "Data coverage" strip (months × data types: none / partial / full / conflicting) that is the MVP reconciliation status (CD-20).

Re-importing the same file is blocked at upload (file duplicate). Importing a *corrected* version of a period is the normal path: commit the new batch; overlapping bank/GL rows are caught as duplicates (kept or skipped), overlapping `period_balances` supersede with a warning, and the user is offered "roll back the earlier batch" from the coverage strip when two batches cover the same period and type.

---

## 15. What happens when…

| Situation | Detection | User sees | System does | Never does |
|---|---|---|---|---|
| Required columns are missing | Mapping step cannot satisfy §6.1 required fields | Mapping screen highlights the unfilled required targets with the file's actual headers; commit unavailable | Batch stays in `mapping`; saved mapping suggestions offered | Guess a column; import with blanks |
| Rows are malformed | Parser field-count mismatch; unparseable cells | Rows listed under `IMP-ROW-001` with raw text; fix in place or skip | Row kept in `import_rows` with status `error` | Drop the row; shift cells |
| Duplicates exist | `dedupe_hash` passes (§9) | Duplicate panel with the matching record side-by-side, default skip, keep-with-reason | Row status `duplicate`; decision audited | Import silently; delete the earlier record |
| Document is unreadable (scanned/encrypted/corrupt) | §4 / §5.5 | Clear message naming the cause and the CSV alternative; document kept | `source_documents.status` `unreadable` or `quarantined`; no batch | Attempt OCR; guess rows |
| Dates are ambiguous | Column parses validly both ways (§6.4) | Explicit D/M vs M/D choice with three sample rows and a count of rows that would change | Choice stored in transforms; affected rows flagged `IMP-DATE-003` | Default silently to US or UK order |
| Amounts are invalid | `IMP-AMT-002/004`, `IMP-CUR-007` | Row-level issue with the raw value and the detected separator/currency | Row `error`; batch commit blocked until fixed/skipped | Coerce to zero; strip and hope |
| Data is incomplete (uncategorised accounts, missing opening balance, partial month) | `IMP-ACCT-005`, missing statement balances, `IMP-PER-012`, coverage strip | Warnings in review and a persistent "data quality" note on the dashboard naming what is missing (CD-04, CD-06) | Commits allowed; metrics computed with `data_quality.completeness < 1` and `incomplete` labels | Present incomplete metrics as verified |
| Same period imported twice | `IMP-COV-013`, duplicate passes | Warning naming the earlier batch; offer to roll it back | Supersede balances; dedupe transactions | Double count |
| Balance does not reconcile (PDF) | `IMP-BAL-006` | Difference amount and the pages where the running balance breaks | Commit blocked | Commit with a plug entry |

---

## 16. Failure states and retries

| Failure | Behaviour |
|---|---|
| Upload interrupted | No `source_documents` row; the client retries; partial Storage objects are cleaned by a nightly job |
| Parser exception | Batch `failed` with `error_summary {stage, message, rowNumber?}`; user can retry (`created`) or upload another file; platform sees it in `/platform/jobs` |
| `document.extract` job fails | Retried 3× with backoff (`SERVICE_ARCHITECTURE.md §5`); then `failed` with the message "AI extraction did not complete; upload CSV or try again" |
| Commit transaction fails | Returns to `awaiting_review`; error surfaced; no partial data |
| Calculation run fails after commit | Batch remains `committed`; dashboard shows "figures updating… delayed" banner; job retried; platform alerted |
| Concurrent reviewers | Optimistic concurrency on `import_batches.updated_at`; second writer gets `ConflictError` and a reload prompt |
| Organization suspended mid-import | All import actions return `PermissionDenied`; state preserved |

---

## 17. Test fixtures (malformed-file catalogue)

Kept under `fixtures/imports/` with an expected-outcome JSON per file:

1. `gl_clean.csv` — 200 balanced journals, 12 months.
2. `gl_unbalanced_journal.csv` — one journal off by 0.01 (`IMP-GL-010`).
3. `gl_unmapped_accounts.xlsx` — 4 accounts with no keyword match.
4. `tb_march.xlsx` — trial balance that sums to zero; `tb_march_off.xlsx` — off by 10.
5. `pnl_multi_period.xlsx` — 12 month columns to fan out.
6. `bank_out_in_columns.csv` — G1 layout; `bank_signed.csv` — single signed column; `bank_positive_out.csv` — credit-card style.
7. `bank_ambiguous_dates.csv` — all dates ≤ 12/12.
8. `bank_1252_semicolon.csv` — Windows-1252, `;` delimiter, `1.234,56` numbers.
9. `bank_dupes.csv` — 3 exact duplicates of committed rows, 2 within-batch, 2 fuzzy, 1 legitimate repeat.
10. `bank_text.pdf` — text-layer statement matching G1; `bank_text_multiline.pdf` — multi-line descriptions; `bank_text_balance_break.pdf` — chain break on page 2.
11. `bank_claude_only.pdf` — text layer, non-grammar layout (drives §5.4 with a recorded Claude fixture response).
12. `bank_scanned.pdf` — image only.
13. `invoices_sales.csv` incl. one negative total (credit note) and one `amount_paid > total`.
14. `macro.xlsm`, `oversize_26mb.csv`, `rows_50001.csv`, `encrypted.pdf`, `fake_csv.pdf` (wrong extension).
15. `injection_descriptions.csv` — descriptions containing prompt-injection strings; must import verbatim as text.
