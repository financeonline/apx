# MOTION — Import Engine

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-011, ADR-012, ADR-016, CD-03, CD-04, CD-10, CD-11, CD-12, CD-22, CD-28), `DATABASE_ARCHITECTURE.md §3–5`, `RBAC_MATRIX.md`, `MVP_SCOPE.md §2.3`
Consumed by: `SERVICE_ARCHITECTURE.md` (imports, documents modules), `TEST_STRATEGY.md`, `UX_ARCHITECTURE.md`

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026, ADR-027, ADR-028, ADR-029, ADR-030, ADR-031, ADR-033, ADR-035, ADR-037, ADR-038. Findings addressed: F-A-08, F-A-15, F-B-02, F-B-03, F-B-04, F-B-05, F-B-06, F-B-10, F-B-11, F-B-12, F-B-13, F-B-17, F-B-18, F-C-03, F-C-13, F-D-03, F-D-04, F-D-11, F-D-13, F-D-14, F-D-15. See `RED_TEAM_REVIEW.md`.

> **Revision 1.2 (red-team round 2, 2026-09-05).** Applies ADR-047 (R2-B-01..12: declared export ranges, reporting-sign balances, pinned cumulative differencing, credit-note negation, opening-journal rules, rollback that resets `superseded_by` and promotes dependants, open-items lists, bank identity normalisation); ADR-043 (extraction enqueue path), ADR-045.3 (§6.6), ADR-046.3 (§5.3–5.4). Findings addressed: R2-C-05, R2-C-11. See `RED_TEAM_REVIEW.md §6`.

Governing rule (SOW §23): **invalid and duplicate data is surfaced, never silently discarded.** Every row a user gives MOTION ends up as an `import_rows` record with a status the user can see. There is no code path that drops a row.

---

## 1. Pipeline overview

```
Upload ─► File validation ─► Parse ─► Map columns ─► Map accounts ─► Preview ─► Validate rows
      ─► Detect duplicates ─► Review ─► Commit (transaction) ─► Enqueue calculation ─► History
```

Owning module: `src/modules/imports` (pipeline, mapping, validation, commit) with `src/modules/documents` (upload, storage, scanning, text extraction) upstream. Permissions: `imports.create` for upload/start, `imports.review` for mapping, review, commit and roll back (`RBAC_MATRIX.md §2.1`). All writes — batch state, row decisions, commit, roll back, replace — happen through `api.*` SECURITY DEFINER functions (ADR-026) called by the imports services with the user's session; neither the browser nor the services write tables directly. Reads use the user's session client under RLS.

### 1.1 `import_batches` state machine

| From | Event | To | Notes |
|---|---|---|---|
| — | `startBatch` after upload | `created` | `source_documents.status` must be `ready` |
| `created` | parser starts | `parsing` | synchronous for CSV/XLSX ≤ 5,000 rows; `document.extract` job otherwise (CD-22) |
| `parsing` | parse succeeds | `mapping` | `import_rows` written with `raw_data`, status `pending` (including `IMP-ROW-005` skipped lines) |
| `parsing` | parse fails | `failed` | `error_summary` populated |
| `parsing` | extraction provider unavailable (`pdf_claude`) | `deferred_upstream` | per-page retries continue in the background (§5.4); pages already read are reviewable |
| `failed` / `deferred_upstream` | user retries | `created` | reuses the stored document; the SHA-256 duplicate check links to this batch instead of blocking |
| `mapping` | mapping saved (columns, accounts, balance basis, statement balances) | `validating` | `mapping_snapshot` frozen |
| `validating` | validation + duplicate pass completes | `awaiting_review` | `row_counts` populated |
| `awaiting_review` | reviewer changes mapping | `mapping` | re-validation required; previous decisions preserved where row hashes are unchanged |
| `awaiting_review` | reviewer commits, zero unresolved `error` rows, all confirmations recorded | `committing` | `api.commit_import_batch` (§11) |
| `awaiting_review` | reviewer rejects batch | `rejected` | `rolled_back_reason` reused for the rejection reason |
| `committing` | transaction succeeds | `committed` | `committed_at`, `calculation_job_id` |
| `committing` | transaction fails, or commit-time duplicate re-check collides | `awaiting_review` | nothing partially written; affected rows re-flagged (§9.3) |
| `committing` | job dies or is dead-lettered (`import.commit_large`) | `awaiting_review` | Postgres rolled the transaction back; `error_summary.stage = 'commit'`; stale-lock recovery performs the transition (ADR-031.3); a super admin can also "reset batch" from `/platform/jobs` |
| `committed` | reviewer rolls back | `rolled_back` | records soft-rejected (§12), recalculation enqueued; refused when other committed batches depend on this one |
| `committed` | reviewer chooses **Replace** from a later batch covering the same period/type | `rolled_back` | executed inside the replace transaction together with the new batch's commit (§12, ADR-029.3) |

Terminal states: `committed` (may still transition to `rolled_back`), `rolled_back`, `rejected`. `failed` and `deferred_upstream` are retryable. No state deletes anything.

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

Bank statements additionally require a `bank_account_id` (`banking.view` to list, `financials.edit` to create):

- Selecting an existing account is by name. Creating one inline requires bank name, last four digits of the account number and (UK) masked sort code. If an active account with the same masked identity already exists, creation is refused and the existing account is offered (ADR-029.4) — a second record for the same real account would defeat duplicate detection.
- The wizard asks for the **opening balance printed on the statement**, with an "I don't know" option (ADR-035). A typed value is stored on the batch as reviewer-entered `statement_opening_balance` and, for the account's first statement, offered as `bank_accounts.opening_balance` so cash metrics have a starting point (CD-06).
- If the document is a PDF and the deterministic parser fails, the Claude path (§5.4) is offered only when the organization's `features.ai_pdf_extraction` flag is on (CD-35) and the user holds `imports.review`, behind a one-line consent notice.

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
| CSV encoding | Detect BOM (UTF-8/16); otherwise attempt strict UTF-8 and fall back to Windows-1252 (common for UK exports containing `£`); the detected encoding is recorded in `transforms`. NUL bytes, or sequences undecodable in both encodings → reject. `SECURITY_MODEL.md §8` step 2 states the same rule | `IMP-FILE-005` |
| CSV delimiter | Sniff `,` `;` `\t` `|` over first 20 lines; require consistent field count in ≥ 90% of lines | `IMP-FILE-006` |
| PDF | Valid header/xref; page count ≤ 200; encrypted PDFs rejected; text layer probed on first 3 pages → `has_text_layer` | `IMP-FILE-007` |
| Malware | Supabase Storage scanning where enabled; additionally reject embedded JavaScript/OpenAction in PDFs | `IMP-FILE-008`, `status = quarantined` |
| Receipt photo (ADR-150) | JPEG or PNG by magic bytes (GIF refused); ≤ 5 MB, the AI provider's image limit; accepted for the Receipts import only, read only by AI on request | `IMP-FILE-001`, `IMP-FILE-009` |
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
Decode with the detected encoding, split with the detected delimiter honouring RFC 4180 quoting, trim trailing empty lines. **Header row** = the first line in which ≥ 3 cells match the synonyms table (§6.2). If no line qualifies, the first line whose cells are non-numeric and unique is *proposed* and the mapping step asks the user to confirm it, so a preamble line such as `Account Name,Acme Ltd` can no longer be taken as the header silently (F-B-18). Lines above the header (preamble, report titles, account summaries) are written to `import_rows` with status `skipped` and issue `IMP-ROW-005 non-tabular line`, so `count(import_rows) = number of non-empty source lines` (the row-count test in `TEST_STRATEGY.md §5.2`). Rows with a field count different from the header count are kept with `raw_data` padded/truncated and `IMP-ROW-001` attached later.

### 5.2 XLSX
Read with a streaming SheetJS-compatible parser (no formulas evaluated; cached values only). Sheet selection: if the workbook has one non-empty sheet, use it; otherwise the mapping step asks the user (default: first sheet with ≥ 2 rows and ≥ 3 columns). Header row detection: the first row in which ≥ 3 populated cells match the synonyms table; fallback and user confirmation as for CSV; rows above the header become `IMP-ROW-005` skipped rows. Merged cells: value is placed in the top-left cell; other cells of the range are `null` and inherit only for *label* columns (description/account), never for amounts. Dates come as serials → ISO via the 1900 epoch (1904 flag honoured). Hidden rows are still imported (with a warning `IMP-ROW-003`).

### 5.3 PDF — text-layer deterministic parser
Extract per-page text with positional data (x, y per token). Group tokens into lines by y (tolerance 2 pt). Detect a column grid from the header line matching one of the known grammars:

```
G1: DATE  DESCRIPTION  [PAID OUT|DEBIT|WITHDRAWALS]  [PAID IN|CREDIT|DEPOSITS]  BALANCE
G2: DATE  DESCRIPTION  AMOUNT  BALANCE
G3: DATE  TYPE  DESCRIPTION  MONEY OUT  MONEY IN  BALANCE
```

Tokens are assigned to columns by x-ranges from the header. A line that has a date in the date column starts a transaction; subsequent lines without a date and with text only in the description column are appended to the previous description (multi-line descriptions). Opening/closing balance capture (ADR-046.3, R2-C-11): candidates are only lines that sit **outside the transaction grid** — a line whose date column is empty and that is not a continuation of a transaction description; a line with a date in the date column is a transaction even if its text says "closing balance" ("Closing Costs Solicitor £2,300" is a payment, not a balance). Among candidates, `/(opening|start(ing)? balance|balance brought forward|b\/f)/i` with a money token → `statement.openingBalance` = the **first** match in document order; `/(closing|end(ing)? balance|balance carried forward|c\/f)/i` → `statement.closingBalance` = the **last** match in document order. Per-page "balance brought forward / carried forward" lines are recorded separately as `statement.pageBalances[page] = {broughtForward, carriedForward}` and checked for continuity (page N carried forward = page N+1 brought forward within 0.01; a break is `IMP-BAL-006` with the page named). Statement period from `/(\d{1,2}\s\w+\s\d{4})\s*(to|-|–)\s*(\d{1,2}\s\w+\s\d{4})/`. Lines on a transaction page that match no column pattern (page furniture, marketing text, a description that wrapped into the amount column) are written as `IMP-ROW-005` skipped rows so the reviewer can see them next to the page; nothing is discarded by tolerance. If fewer than 80% of lines on the first transaction page match a grammar, the deterministic parser yields nothing and the batch falls through to §5.4. `extraction_method = pdf_text`.

Rows from this parser are `assurance_level = calculated`, not `verified`: positional parsing is heuristic. They are promoted to `verified` at commit only when `IMP-BAL-006` passes with both statement balances captured **and** an unbroken `balance_after` chain on every row (ADR-033). Statements whose balances could not be captured (regex miss, e.g. "Start of statement balance") carry batch warning `IMP-BAL-007 unreconciled statement`, which is inherited into cash `data_quality`; the reviewer can type the printed balances into the batch header to reconcile.
  *As built:* "reconciled" is decided by the absence of `IMP-BAL-006`/`IMP-BAL-007` on the batch; the running-balance chain check skips rows without `balance_after` rather than failing them.

### 5.4 PDF — Claude-assisted extraction (CD-11, ADR-011, ADR-033)
Available only when `has_text_layer = true`, the deterministic parser (§5.3) failed, and the organization's `features.ai_pdf_extraction` flag is on (ADR-025, CD-35). It is **never auto-enqueued** (R2-C-11): after a failed deterministic parse the review screen shows a "Read with AI" button to a reviewer holding `imports.review`; pressing it after the consent line calls `api_server.enqueue_job` through the server with the reviewer as `requested_by` (ADR-043.3), which is the only path that creates a `document.extract` job. It cannot be requested when §5.3 succeeded. The job runs under `withOrgScope` with a system context that may write only `import_rows`, `import_batches` and `audit_events` — never a financial record table, never `source_documents` beyond status (`AI_ARCHITECTURE.md §14`).

- **Consent and audit.** Before "Read with AI" enqueues the job the screen shows: "MOTION will send the text of this document to its AI provider to read the rows. The file itself is not sent." The job writes audit `document.sent_to_ai {document_id, pages}` (F-A-15) through `api_server.record_access_event` with the reviewer as actor.
- **Budget.** Before **every model call** — first attempts and retries alike — the job decrements `platform_org_settings.ai_extraction_pages_per_day` (default 300) and checks the organization's monthly token ceiling (`AI_ARCHITECTURE.md §11`); a page that fails validation eight times therefore costs eight units, never one (R2-C-11). Exceeding either dead-letters the job with `QuotaExceeded`; the batch shows "AI reading paused until {reset}; upload CSV to continue now". Per-page token use and attempt counts are recorded in `import_batches.stats.extraction` (F-C-13).
- **Input.** Page text only — never the binary, never other organizations' data — one page at a time, wrapped as untrusted data (`AI_ARCHITECTURE.md §9`).
- **Output schema** (Zod; any violation = page failure, not a guess):
  ```ts
  { page: number,
    rows: { line: number; date: string /*ISO*/; description: string; amount: string /*signed decimal*/; balance?: string; reference?: string }[],
    openingBalanceRead?: string; closingBalanceRead?: string; periodStartRead?: string; periodEndRead?: string;
    confidence: 'high'|'medium'|'low'; notes: string[] }
  ```
  Every produced row is stamped `assurance_level = inferred`, `record_status = needs_review`, `import_rows.status = warning` with issue `IMP-PDF-001` ("read by AI — confirm against page N").
  *As built:* `record_status = needs_review` describes the IMPORT ROW stage, not the committed record: AI-read rows are reviewed before commit (`import_rows.status = warning` + `IMP-PDF-001` + the page-confirmation gate) and commit as `accepted` + `inferred` — `needs_review`, `duplicate` and `incomplete` are never written to record tables (Step 0 review). Writing `needs_review` at commit would drop the rows from every figure while coverage (decided by batch ranges) still claimed the month, so a covered month would read zero movement — a wrong number, not a blank.
- **Balances the gate trusts (F-C-03, R2-C-11).** The reconciliation gate `IMP-BAL-006` uses only balances captured by the deterministic rules of §5.3 or typed by the reviewer into the batch header from the page image. `openingBalanceRead`/`closingBalanceRead` are **not displayed until the reviewer has typed both values**; the UI then shows only "matches the AI reading" or "differs from the AI reading", never the AI figures themselves, so the path of least resistance is reading the page, not copying the model. If the typed values equal the AI-read values *and* no deterministic capture exists, the batch keeps `IMP-BAL-007` (unreconciled) and the page-wide tick is withheld — a model that hallucinated rows and balances that agree with them still cannot pass. If neither a deterministic nor a reviewer-typed pair exists, commit is blocked with "Enter the opening and closing balances printed on the statement". A page cannot therefore dictate any side of the equation.
- **Line-count check `IMP-PDF-002`.** For each page, the deterministic count of date-bearing lines — a line whose first token (after positional grouping) matches one of the §6.4 date patterns (ISO, day-first, month-first, `D Mon YYYY`, `DD Mon`) — must be within ±10% of the number of extracted rows; otherwise the page cannot be confirmed page-wide and every row on it needs an individual tick. The count is computed by the §5.3 tokeniser even when no grammar matched, so it does not depend on the failed parse.
- **Side-by-side review.** The page image is shown beside the rows; each row's `source_ref` (`page:N;line:M`) highlights the line. Commit requires, per page, either every row ticked, or "I have compared all rows on page N" — the page-wide tick is offered only when `confidence = 'high'` and `IMP-PDF-002` passed. `notes[]` render as "AI note (unverified)", plain text truncated to 200 characters, never as instructions to the reviewer.
- **Per-page completion (F-D-15).** `import_batches.stats.extraction = { pages_total, pages_extracted, pages_failed[], pages_deferred[], tokens }`. A page that fails schema validation or hits an upstream error is retried individually (up to 8 attempts, backoff capped at 15 minutes); a provider outage moves the batch to `deferred_upstream` ("waiting for the extraction service — you will be notified") rather than `failed`. Pages that succeeded are reviewable while others wait.
- **Assurance downstream.** `extraction_method = pdf_claude` is shown on the batch; committed records inherit `assurance_level = inferred`, so the Analyst, dashboard and evidence drawer label these figures with the canonical badge (`UX_ARCHITECTURE.md §8.1`).
  *As built (ADR-130):* records do inherit `inferred`; FIGURES now do too — every bank-sourced metric of a period (cash, and P&L / customer figures on the bank basis) is weakened to the weakest statement overlapping it, so Home, Health inputs, the analyst and the drawer agree. Before engine 6.0.0 the metric was badged by source alone.
- Claude never receives instructions from the page: the prompt states that page content is data. A row whose description contains an instruction-like phrase is still imported as text; text is never executed, and `description_normalized` masking (§6.4) applies as to any row.

### 5.4a Receipts — a photo or PDF read with AI on request (ADR-150)
A Receipts upload may be a JPEG or PNG photo (≤ 5 MB, `IMP-FILE-009`) or a PDF (≤ 10 pages, scanned or not). It is stored as a `receipt` document and a batch is started WAITING (`failed`, `pdf_text`, "Read receipts with AI"); nothing is read on upload. A reviewer with `imports.review`, while `ai_pdf_extraction` is on, chooses the EXPENSE account the receipts post to and consents to the FILE being sent; `document.extract` then calls `api_server.begin_receipt_extraction` (audit `document.sent_to_ai`, `file_sent: true`), charges each page against `ai_extraction_pages_per_day` and the token ceiling, and sends the file in one call to `ai.extractReceipts` (forced `submit_receipts`: page, position, date, who was paid, description, positive total, currency only when printed; a page the file lacks is a failure). Each receipt becomes a Receipts row — `Date`, `who was paid — description`, `Amount`, the chosen account, `Currency` — through the same pipeline as a CSV, with `IMP-PDF-001`; one-sided debit ledger entries as for any receipts list. The batch is `pdf_claude`, so the commit gate demands every page confirmed and the entries are `inferred`. No deterministic line count exists, so `IMP-PDF-002` is not raised and the page-wide tick depends on the model's confidence alone. A photo uploaded as any other type is refused before storage.

### 5.5 Scanned PDF (no text layer)
`source_documents.status = 'unreadable'`, no batch is created. The user sees: "This PDF is a scanned image. MOTION has stored it as a source document. Please upload the same statement as CSV or XLSX from your bank." OCR is post-MVP (`MVP_SCOPE.md §4`).

### 5.5a One invoice — a photo, scan or PDF read on the upload page (ADR-175)
A Sales invoices or Purchase invoices upload may be ONE invoice as a PDF, JPEG or PNG (≤ 5 MB for a photo). The browser reads it before anything is sent — the PDF's text layer, else Tesseract OCR in the tab, self-hosted under `/ocr` — and `src/core/invoice-reading` proposes the fields. The reviewer corrects them beside the invoice and ticks that every field was checked; the server receives only those fields (`CheckedInvoiceInput`). The file is stored as an `invoice` document (a scan is `ready`), and the fields become a one-row table with a fixed map, through the same pipeline, review and commit as a CSV row. `extraction_method = 'ocr'`; commit stamps `verified`. The batch range is the invoice date (set by the server), so one invoice never covers a month; IMP-INV-013 is recorded `partial`. An invoice photo without checked fields is refused before storage, and so are checked fields on any other type or on a CSV.

---

## 6. Mapping

### 6.1 Target field schemas per `import_type`

| import_type → target | Required fields | Optional fields |
|---|---|---|
| `general_ledger` → `ledger_entries` | `entry_date`, `account` (name or code), and either (`debit`, `credit`) or (`amount` + `direction`/sign) | `description`, `reference`, `journal_ref`, `counterparty`, `currency` |
| `trial_balance` → `period_balances (balance_kind = trial_balance)` | `account`, `period_start` (batch-level for a single-period file; per row when the file has one column per month), and either (`debit`, `credit`) or `closing_balance`; batch-level `balance_basis` confirmation (`IMP-TB-012`) | `opening_balance`, `code` |
| `pnl_report` → `period_balances (pnl_report)` | `account`/line label, `period_start` **and** `period_end` (batch-level from the report header; per row when month columns fan out), `amount`; `balanceSign` confirmation (`IMP-TB-013`) | — |
| `balance_sheet` → `period_balances (balance_sheet)` | `account`, `period_start` **and** `period_end`, `closing_balance`; `balanceSign` confirmation (`IMP-TB-013`) | month columns fan out as for P&L |
| `bank_statement` → `bank_transactions` | `transaction_date`, `description`, and either `amount` (signed) or (`money_out`, `money_in`) | `posted_date`, `balance_after`, `reference`, `counterparty_name`, `type` |
| `sales_invoices` / `sales_report` → `invoices (sales)` | `invoice_number`, `customer`, `issue_date`, `total_amount`; batch-level `invoice_list_kind ∈ {full, open_items}` (`IMP-INV-012`) | `due_date`, `subtotal`, `tax_amount`, `amount_paid`, `status`, `paid_date`, `description`, `currency` |
| `purchase_invoices` / `purchase_report` → `invoices (purchase)` | `invoice_number`, `supplier`, `issue_date`, `total_amount`; per-supplier `default_expense_category` confirmation (§6.5) | as above |
| `receipts` → `ledger_entries` (one row per receipt, account = user-chosen expense account) | `entry_date`, `amount`, `account` | `description`, `counterparty`, `reference` |
| `budget` → `budget_lines` (ADR-142; a plan, never read by the engine) | `period_start` (a month column; `2026-11`, `Nov 2026` or any day in the month read as the month) **or** a one-month declared range, `account`, `amount` | `code`, `currency` |

Rules attached to these schemas:

- **Declared export range (ADR-047.6, R2-B-06).** Every batch, of every type, declares `period_start` and `period_end` at mapping. Defaults are detected (min/max transaction or issue date for GL, bank and invoice files; `statement.periodStart/periodEnd` for statements; the report header for TB/P&L/BS files) and the reviewer confirms or corrects them ("This export covers 1 Jan – 31 Aug 2026"). Coverage in `FINANCIAL_ENGINE.md §2.2` uses the declared range only, so a month whose last posting falls on the 28th is still covered; there is no last-N-days heuristic. `IMP-PERIOD-004` flags rows dated outside the declared range.
- **Balances are stored in natural sign** (`debit − credit`). When a file supplies debit/credit columns, `closing_balance = debit − credit` and `transforms.balanceSign = natural`. A single signed column is inspected (§6.4 **Balance sign**): every P&L report and balance sheet from Xero, QuickBooks or Sage shows income and liabilities as positive numbers, which is *reporting* sign; the detector proposes `reporting` when Σ of income-mapped rows > 0 and Σ of expense-mapped rows > 0, the reviewer confirms with two sample rows (`IMP-TB-013`), and commit negates income/liability/equity lines to natural sign. The engine never sees reporting sign (ADR-047.3).
- **Multi-month single column.** A P&L or balance sheet with one value column whose declared range spans more than one month is `cumulative` anchored at `period_start` (one row per account for the range's last month) or is refused with "Split the report by month or export a trial balance".
- **Balance basis (`IMP-TB-012`, F-B-02).** Trial balances and balance sheets default to `cumulative` (fiscal-year-to-date for P&L accounts, life-to-date for balance-sheet accounts); P&L reports default to `movement`. The detector compares consecutive months where available (P&L balances that only grow within a fiscal year suggest cumulative) and the reviewer confirms the batch-level `balance_basis` before validation; the choice is frozen in `mapping_snapshot` together with `fiscal_year_start_month_at_commit` (ADR-047.4), the fiscal year the engine differences against. The engine differences each cumulative balance against the same account, same kind, same basis in the *immediately preceding* fiscal month; an account absent from that month's batch differences against 0 (`account_absent_prior`) (`FINANCIAL_ENGINE.md §3`).
- **Multi-period columns** (one column per month) fan out to one row per `(account, period_start)`; `import_batches.period_start/period_end` = min/max; `IMP-PER-012` is not applied to fan-out batches (F-B-10).
- **Total and subtotal rows (`IMP-ROW-004`).** A line whose label matches `/^(total|sub ?total|net|gross|operating|profit|loss|balance)\b/i`, or whose value equals the sum of the contiguous block above it (±0.01), is a total row: warning, default `skip`, never created as an account. Batch check `IMP-TOT-014`: for each detected total, Σ of the mapped lines in its block must equal the total ±0.01, else error — a mis-detected block would otherwise double revenue or expenses.
- **Sales and purchase reports** (SOW §6) are accepted when they contain one line per invoice. A report with no invoice-number column is stored as a source document and the user is asked for the invoice list ("This report summarises sales; MOTION needs the invoice list to import it").
- **Opening-balance journals (`IMP-GL-011`, F-B-06, ADR-047.4).** GL journals (matched per `journal_ref`, not per line) dated within ± 1 day of the fiscal-year start or of the export's first day whose `journal_ref`/description matches `/opening balance|brought forward|b\/f\b|b\/d\b|conversion balance|opening balance equity/i` are flagged as opening balances: warning, kept, excluded from P&L, used as balance-sheet opening balances (ADR-027.3). When the flagged journals sum to more than 10% of the batch's Σ|amount| the flag becomes a confirmation the reviewer must accept; any flag can be toggled through `api.set_opening_balance_flag(entry, bool)` so a supplier called "B/F Traders" is never mistaken for an opening balance without a human seeing it.
- **Unbalanced journals (`IMP-GL-010`).** When `journal_ref` grouping exists and Σ debit ≠ Σ credit for a journal, the rows are imported with a warning and `assurance_level = calculated` (partial and per-account exports are common); the batch summary states the imbalance. Without journal grouping the check is skipped with a warning.
- **Credit notes (CD-28, ADR-047.5).** A negative `total_amount` becomes `invoice_type = *_credit_note` and **all four money fields are negated together** (`subtotal`, `tax_amount`, `total_amount`, `amount_paid`), so a credit note exported as −1,000 / −200 / −1,200 / −1,200 is stored 1,000 / 200 / 1,200 / 1,200 and subtracted by type. `IMP-INV-011` (error) when `subtotal + tax_amount ≠ total_amount ± 0.01` with both present; a `subtotal` of 0 alongside a positive `total_amount` is treated as absent for VAT netting.
- **Open-items lists (`IMP-INV-012`, ADR-047.10).** When fewer than 10% of rows are paid and issue dates span more than 60 days, the reviewer confirms "This list contains only unpaid invoices" and the batch is stored with `invoice_list_kind = open_items`; such a list defines receivables and payables but never revenue or the DSO denominator. Otherwise `invoice_list_kind = full`.
  - *As built (ADR-125, FU-13):* the kind is written **at commit** by the trigger `import_batches_invoice_list_kind` (`app.invoice_list_kind_at_commit`): an invoice batch that reaches `committed` with no kind becomes `open_items` if the reviewer confirmed `IMP-INV-012`, else `full`. A kind already set on the batch is kept. Until then nothing wrote `full`: `api.record_batch_confirmation` copies `p_value ->> 'invoice_list_kind'`, which the review page never sends (it confirms `IMP-INV-012` with `{answer: 'yes'}`), and the column has no default, so every list committed through the app had a NULL kind. Migration `20260930000004` backfilled committed invoice batches by the same rule (`app.backfill_invoice_list_kind()`). Engine 4.0.0 states revenue only from a `full` sales list (FINANCIAL_ENGINE §2.2).

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

**Balance sign (`transforms.balanceSign ∈ {natural, reporting}`, ADR-047.3).** Applies to TB, P&L and balance-sheet files. Separate debit/credit columns → `natural`. One signed column → the detector sums the rows whose suggested category is income-type and those whose category is expense-type; both positive → propose `reporting` (income and liabilities shown positive), else `natural`. The mapping step shows two sample rows ("Sales 10,000 will be read as income; Rent 2,000 as an expense") and records the confirmation as `IMP-TB-013`. At commit, `reporting` negates income-, liability- and equity-type lines so storage is always natural sign.

**Bank identity (ADR-047.12).** A bank account's identity is `(sort_code_masked, account_number_masked)`; `bank_name` is normalised for comparison (lower-case; `uk`, `plc`, `bank`, `ltd` removed) so "HSBC UK" and "HSBC" are one account. The dedupe `scope_key` and the inline-creation refusal both use this identity.

**Masking (ADR-038.4, F-A-08).** `description_raw` and `raw_data` keep the source text verbatim. `description_normalized` replaces 6–8 digit account numbers and `NN-NN-NN` sort codes with `****` plus the last four characters. Client-facing views, exports produced for the client role and AI tool outputs use `description_normalized` only. `SECURITY_MODEL.md §12` describes what is stored where.

**Liability bank accounts (ADR-028).** For `credit_card` and `loan` accounts a purchase or drawdown increases the balance owed; `transforms.bankSign` defaults to `positive_out` and the reconciliation gate is evaluated as `−Σ amount = closing − opening`.

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

For purchase invoices, each supplier's `counterparties.default_expense_category` (a standard category; suggested from the keyword table applied to the supplier name, else `cost_of_sales`) is confirmed in the same step. It decides which expense bucket invoice-basis purchases fall into (ADR-027.4, F-B-05); it can be changed later under Customers and triggers recalculation.

### 6.6 Counterparty resolution
`normalized_name = lower(trim(collapse_ws(strip(name, /[^\p{L}\p{N} ]/u))))` with common suffixes removed (`ltd`, `limited`, `plc`, `llp`, `inc`). Exact `normalized_name` match → existing `counterparties.id`; no match → created with `kind` from the import type (`customer` for sales, `supplier` for purchase, `unknown` for GL/bank). `kind` is upgraded to `both` when the same counterparty appears on both sides. Merging is a later user action (`customers.edit`).

**Names may not carry figures (ADR-045.3, R2-C-05).** A counterparty or account name that contains a currency amount or a percentage (the claim grammar's currency and percentage classes, `AI_ARCHITECTURE.md §7.9`) is rejected at creation — in import mapping (`IMP-NAME-015`, error: "Names cannot contain amounts; edit the name or map to an existing customer"), in `api.update_counterparty` and in `api.merge_counterparties`. Entity names are exempt from the AI grounding scan, so this rule is what prevents a name such as "Acme Ltd (owed £45,000)" from smuggling a figure into a rendered statement. Digits alone ("3M", "7-Eleven", "Studio 54") remain allowed.

*As built (Step 0, 2026-10-04, migration `20261004000001`):* until this change nothing created a counterparty — the pipeline collected `newCounterparties` and no caller read them, so no invoice list could commit (`invoices.counterparty_id` is NOT NULL). The wizard now creates them for **invoice targets only**, between parsing and validation, through `api.create_import_counterparties` (kind decided in SQL from the batch). Deviations from the text above, kept deliberately and recorded rather than changed in this step:
- matching uses the database's `app.normalize_name` (lower-case, runs of non-alphanumerics to one space), **not** the suffix-stripping rule above, so "Acme" and "Acme Ltd" remain two counterparties;
- GL, receipt and bank rows still do not create counterparties (an unmatched name leaves `counterparty_id` NULL, as before);
- `IMP-NAME-015` is applied to counterparty names on invoice rows (and in SQL to the names this function creates), not yet to account names, and `api.update_counterparty` does not exist;
- a name matching a merged-away counterparty resolves to the counterparty it was merged into;
- an invoice row whose name could not be resolved is an `IMP-CP-016` error, and an unrecognised status word an `IMP-INV-013` error, so neither can fail the commit.

*Unicode identity (Step 0D, ADR-136, migration `20261006000001`):* `app.normalize_name` — the key accounts and counterparties are unique on and every import matches on — is NFKC, simple lower case (`pg_c_utf8`, final sigma folded), every run of whitespace, punctuation, symbols and controls to one space. Every letter, accent, mark and digit in every script is significant: "Müller" ≠ "Möller" ≠ "Muller", "株式会社トヨタ" and "شركة الأمل" are names, not the empty key. For ASCII it is the old key exactly. TypeScript mirrors it (`storedNameKey`), tested against the database over every code point Postgres assigns. Existing records were re-keyed; records the new key would make one name were HELD (key `<key> [held <id>]`), never merged: an import naming one is refused (`IMP-CP-019`, `IMP-ACCT-019`), a new record of the name is refused, and renaming or merging the records resolves it. The Step 0C stop-gaps `IMP-CP-017` / `IMP-CP-018` are withdrawn. Read-only report before migrating: `scripts/sql/unicode-names-dry-run.sql`.

*Import type table (Step 0):* the target table, `document_kind`, invoice side, bank-account rule and PDF support of every import type live in one place, `IMPORT_TYPE_SPECS` (`imports/domain/types.ts`), checked against `api.start_import_batch` and `document_kind_enum` by `test/unit/import-type-spec.test.ts`. A PDF of any type is **stored** as a source document under its kind (listed, access-controlled, linkable as evidence); only a `bank_statement` PDF is **read**. Any other PDF starts no batch and imports no rows, and the uploader is told to export the figures as CSV or Excel — the deterministic reader and the AI path are bank-statement-shaped (§5.3–§5.4), and `document.extract` refuses a non-statement batch. No OCR is introduced. The upload form offers every import type, balance sheets included, and accepts PDFs.

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
| `IMP-PERIOD-005` | error | A balance row with no period: no period column, and the declared range covers more than one month (Step 0D) |
| `IMP-CP-019` | error | The customer or supplier named matches records held for an identity decision (ADR-136) |
| `IMP-CP-020` | warning | The customer or supplier named was matched to an existing record spelled differently (beyond letter case) — D-3: matches are never silent |
| `IMP-ACCT-019` | error | The account named matches accounts held for an identity decision (ADR-136) |
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
| `IMP-INV-010` | warning | Invoice already exists with different `total_amount`/`amount_paid`/`paid_date`/`due_date`/`status`; this row will update (supersede) the earlier record (default keep) |
| `IMP-GL-011` | warning | Opening-balance journal; excluded from P&L, used as opening balances |
| `IMP-ROW-004` | warning | Total/subtotal row; not imported as an account (default skip) |
| `IMP-ROW-005` | skipped | Non-tabular line (preamble, page furniture, unmatched PDF line); recorded so nothing is silently dropped |
| `IMP-PDF-002` | warning | Page line count differs from the AI-extracted row count by more than 10%; per-row confirmation required on that page |
| `IMP-INV-011` | error | Invoice `subtotal + tax_amount ≠ total_amount` (± 0.01) when both are present |

### 8.2 Batch-level

| Code | Severity | Rule |
|---|---|---|
| `IMP-BAL-006` | error | Bank statement: `Σ amount ≠ closing − opening` (liability accounts: `−Σ amount`), evaluated only against balances captured by the deterministic parser or typed by the reviewer (never AI-read values); or the `balance_after` chain breaks between consecutive rows by more than 0.01 |
| `IMP-BAL-007` | warning | Statement balances could not be captured; the batch is unreconciled, cash `data_quality` inherits the warning, and `pdf_text` rows stay `calculated` |
| `IMP-GL-010` | warning | General ledger: `Σ debit ≠ Σ credit` per `journal_ref`; rows imported with `assurance = calculated` |
| `IMP-TB-011` | error | Trial balance: `Σ debit − Σ credit ≠ 0` within 0.01 (cumulative or movement alike) |
| `IMP-TB-012` | confirmation | Balance basis (`cumulative` / `movement`) must be confirmed for TB, P&L and balance-sheet batches |
| `IMP-TB-013` | confirmation | Balance sign (`natural` / `reporting`) must be confirmed for a single signed balance column (ADR-047.3) |
| `IMP-TB-016` | confirmation | Trial balance: "Is this the full trial balance — every account with a balance for the period: income, expenses, assets, liabilities and equity?" (scope `all_accounts`); P&L report: "Is this the full P&L report — every income and expense line for the period?" (scope `income_and_expense`). `report_complete`: `complete` / `partial`, nothing pre-selected, scope set by the server. Only `complete` lets a category with no line be read as zero; a trial balance must also balance (ADR-139). Batches imported before the question existed carry no answer: unconfirmed until an owner or admin confirms a month on the import page (`api.attest_report_completeness`, ADR-139 amendment). |
| `IMP-INV-012` | confirmation | Invoice list looks like open items only (< 10% paid, issue dates span > 60 days); confirm `invoice_list_kind = open_items` (ADR-047.10). The kind is written at commit from the confirmation: confirmed → `open_items`, otherwise `full` (ADR-125, FU-13) |
| `IMP-RANGE-015` | confirmation | Declared export range (`period_start`/`period_end`) must be confirmed for every batch (ADR-047.6) |
| `IMP-TOT-014` | error | A detected total row does not equal the sum of its block ±0.01 |
| `IMP-PER-012` | warning | Rows span more than one calendar month for a single-period report type (not applied to fan-out batches) |
| `IMP-COV-013` | confirmation | Period already has committed balances of the same kind; commit replaces **all** accounts of that kind for the period (ADR-029.2) — the reviewer confirms the list of accounts that will be retired. *As built (Step 0F, ADR-139, N-3): raised by `app.commit_import_batch` under the organisation lock — the first commit that would replace accepted balances writes nothing and returns `needs_confirmation`; once confirmed, the new rows are inserted `pending`, the old report superseded and the new one promoted in one transaction. The confirmation text names the replacement; it does not yet list the accounts.* |
| `IMP-COV-014` | warning / confirmation | GL or bank batch overlaps a committed batch of the same type by ≥ 1 full month with fewer than 50% of overlapping rows matched as duplicates (probable re-export with renamed accounts or a second bank-account record); Replace, or confirm with a reason. For bank batches the comparison strips `scope_key` from the hash and runs across all of the organization's accounts, so a statement re-imported under a renamed bank is caught and a second account's ordinary statement is not (ADR-047.12) |
| `IMP-BUD-001` | error | Budget: a second line for the same account and month in the file (ADR-142). Never summed — two figures for one month's rent are a question for the person |
| `IMP-BUD-002` | warning | Budget: a negative amount. Budgets are positive in the reporting sense; a negative one reduces what is planned |

Errors block commit of the affected rows (field-level) or of the batch (batch-level). Confirmations block commit until recorded. Warnings never block; they are shown and inherited into `data_quality` where relevant.

---

## 9. Duplicate detection (CD-12, ADR-029)

### 9.1 Identity and `dedupe_hash`
```
key = organization_id
    | target_table
    | scope_key           -- stable identity, see below
    | date (ISO)          -- transaction_date / entry_date / issue_date / period_start
    | amount (2 dp, absolute)
    | direction           -- inflow/outflow, debit/credit, or invoice_type
    | norm_desc
dedupe_hash = sha256(key)
```
`scope_key` is a **stable identity, never a uuid** (F-B-12): ledger and balance rows use `accounts.code` when present, else the mapped account's `normalized_name`; bank rows use the bank identity `(sort_code_masked, account_number_masked)` with `bank_name` normalised (§6.4, ADR-047.12); invoices use `invoice_type`. Renaming an account between exports or re-creating a bank account record therefore cannot defeat the check (and §2 refuses a second bank account with the same masked identity).

`norm_desc` = description lowercased, Unicode NFKC, punctuation removed, whitespace collapsed, with long digit runs (≥ 6 digits) and card-terminal suffixes (`*1234`, `ref 000123`) removed, so the same payment shown with different transaction ids still matches. For invoices `norm_desc` is replaced by `invoice_number`. The recipe version is stored in `import_batches.mapping_snapshot.dedupeVersion`; hashes are recomputed only when the version changes.

### 9.2 Passes (at validation)
1. **Invoices — update candidates first (F-B-03).** A hit on `(organization_id, invoice_type, counterparty_id, invoice_number)` among accepted invoices is compared field by field. If any of `total_amount`, `amount_paid`, `paid_date`, `due_date`, `status` differ → `IMP-INV-010 updated` (warning, default `keep`); at commit the new row supersedes the old one (§11) instead of colliding with the unique index. Only a fully identical row is `IMP-DUP-001`. This is the normal monthly path for a re-exported invoice list with payments applied.
2. **Cross-batch exact.** `dedupe_hash` found among accepted rows of the target table → `IMP-DUP-001`, `duplicate_of_table/id` set, status `duplicate`, default `skip`.
3. **Within-batch exact.** Same hash twice in the batch → the later row gets `IMP-DUP-002` with `duplicate_within_batch_row_id`. Default `skip`, **except** when ≥ 3 identical rows share a day, or `norm_desc` matches `/payroll|salary|wages/`, where the default is `keep` with reason "batch payment" (F-B-17: payroll runs, rent for several units, batch supplier payments are legitimately identical).
4. **Fuzzy.** Same scope, amount and `norm_desc`, date within ±1 day, against accepted rows and within batch → `IMP-DUP-003`, status `warning`, default `keep`.
5. **Re-export detection `IMP-COV-014`** (batch-level, GL and bank). The batch overlaps a committed batch of the same type by ≥ 1 full month and fewer than 50% of the rows in the overlapping months matched as duplicates → "This looks like a re-export with renamed accounts or a different bank account record. Replace the earlier batch, or confirm you want both." Commit requires the Replace flow (§12) or explicit confirmation with a reason.

Keeping a `duplicate` row requires `reviewer_reason`. Records committed from a `keep` decision on `IMP-DUP-001/002` carry `duplicate_reviewed = true`, which the `duplicate.transaction` alert rule excludes (`FINANCIAL_ENGINE.md §8`). Decisions and reasons are copied to the committed record's audit event.

### 9.3 Re-check at commit (F-D-13)
Validation-time results can be stale: another batch may have committed since. `api.commit_import_batch` takes the organization's advisory lock and re-runs passes 1 and 2 against accepted rows inside the commit transaction. Any new pass-2 collision aborts the commit, returns the batch to `awaiting_review` and re-flags the affected rows; the reviewer sees "N rows now duplicate a batch committed at {time}". A new pass-1 match (an invoice of the same identity committed meanwhile with different figures) is not a collision: the row is marked `IMP-INV-010` and commits as an update, and a candidate whose target was itself updated meanwhile follows the chain to the current row (ADR-073). At commit an update candidate is inserted `pending`, the prior row superseded, and the new row then accepted — so the identity index is never asked to hold two accepted rows (ADR-073). Two reviewers, two tabs, or two people uploading the same statement can therefore never both commit the same rows.

---

## 10. Review UI contract

Route: `/app/[orgSlug]/data/imports/[batchId]`. Permission: `imports.review`.

- Header: file name, type, period detected, row counts by status, extraction method badge, statement balances and reconciliation status. Statement balance fields are pre-filled from the deterministic parser, editable by the reviewer, with AI-read values shown as suggestions for `pdf_claude` batches (§5.4).
- **Nothing-to-check fast path (F-D-11).** When a batch has zero issues and no confirmations pending, the review screen renders as a one-line summary ("142 rows · £38,420.10 in · £41,002.55 out · March 2026 — nothing to check") with **Commit** as the primary action; the grid is behind "Show rows".
- Issue panel grouped by plain-language category — **Dates · Amounts · Duplicates · Missing information · Totals · Read by AI** — with the issue code in a tooltip (`UX_ARCHITECTURE.md §8.1`: codes are never the label). Clicking a group filters the grid.
- Confirmations panel: balance basis (`IMP-TB-012`), replacement of existing balances (`IMP-COV-013`), probable re-export (`IMP-COV-014`), and PDF page confirmations, each with the plain-language consequence.
- Row grid: source ref, raw values (collapsed), mapped values (editable in place for `error`/`warning` rows; edits write `mapped_data`, set `reviewer_decision = fixed`, re-validate that row, and are logged). *Not yet built; `api.fix_import_row` is dropped until the edit exists and re-validates the row — a `pending` row parks the batch, and ADR-026 allows no `api.*` function that `authenticated` may not call (ADR-075).*
- Bulk actions: keep/skip selected; "skip all errors"; "keep all fuzzy duplicates"; "keep all exact duplicates with reason" (one reason applied to all).
- Commit button enabled only when: no row has status `error` (fixed or skipped), no batch-level error, every confirmation recorded, and for `pdf_claude` batches every page confirmed.
- PDF side-by-side pane (§5.4) for `pdf_text` and `pdf_claude` batches.
- Reject batch (reason required); Replace an earlier batch (§12) when the coverage strip shows overlap.
- Every decision is a server action calling `api.decide_import_rows` / `api.fix_import_row` / `api.confirm_pdf_page` / `api.set_statement_balances`; the grid never mutates state locally without a server round-trip.

---

## 11. Commit

`imports.service.commitBatch(ctx, batchId)` → `api.commit_import_batch(batch_id)` (ADR-026). The service validates input and calls the function through the user's session client; the function is `SECURITY DEFINER` and enforces everything below in SQL, so no other path can commit a batch.

1. **Preconditions, re-validated in SQL, never trusted from the client:** the caller resolves to a role holding `imports.review` for the batch's organization; batch status `awaiting_review`; zero rows with status `error`; no batch-level error (`IMP-BAL-006`, `IMP-TB-011`, `IMP-TOT-014`); every confirmation recorded (`IMP-TB-012`, `IMP-COV-013`, `IMP-COV-014`); for `pdf_claude` batches every page confirmed per §5.4.
2. `pg_advisory_xact_lock(hash(organization_id))`; batch → `committing`.
3. **Duplicate re-check** (§9.3); abort on collision.
4. **Insert, in one transaction,** for each row with status `valid|warning`, or `duplicate` with `reviewer_decision = keep`: the target record with `import_batch_id`, `import_row_id`, `source_document_id`, `source_ref`, `dedupe_hash`, `duplicate_reviewed`, `record_status = accepted`, `assurance_level` (`verified` for CSV/XLSX rows; `calculated` for `pdf_text`, promoted to `verified` when the batch reconciled per §5.3; `inferred` for `pdf_claude`). `period_id` is assigned by the `period_assign` trigger from the row's date (`period_start` for balances).
   - **Invoices:** `IMP-INV-010` rows set `superseded_by` on the prior accepted invoice.
   - **Period balances — batch-scoped supersession (ADR-029.2, F-B-11):** committing `balance_kind` K for period P supersedes *every* accepted, non-superseded row of kind K for P from other batches, not only matching accounts, so renamed or dropped accounts cannot linger; the reviewer confirmed the list of retired accounts at `IMP-COV-013`. The partial unique index is `(organization_id, period_id, account_id, balance_kind)`.
   - Every insert and supersede writes `record_status_events (record_table, record_id, status, at, actor)` (ADR-034), which evidence as-of resolution relies on.
5. `import_rows` → `committed` with `committed_table`, `committed_record_id`; `import_batches.row_counts`, `status = committed`, `committed_at`, `reviewed_by`; the declared `period_start/period_end` confirmed at `IMP-RANGE-015` are stored on the batch (ADR-047.6; coverage tests read them, never the last posting date), together with `balance_sign`, `fiscal_year_start_month_at_commit` and `invoice_list_kind` (for an invoice batch left without one, set by the commit trigger: `open_items` if `IMP-INV-012` was confirmed, else `full` — ADR-125, FU-13); `import_mappings` upserted from `mapping_snapshot`; audit `import.committed` with counts and a summary of reviewer decisions.
6. The function enqueues `calculation.run` through `api.enqueue_job` (`{trigger: 'import_commit', triggerRefId: batchId, periodFrom: min(period)}`), stores `import_batches.calculation_job_id`, and the worker kick follows. `calculation_run_id` is written only by the run that actually included the batch (ADR-031.1, F-B-13/F-D-01).
7. **Large batches (> 5,000 rows).** The service enqueues `import.commit_large {batchId}` through `api_server.enqueue_job` (via `core/db/server-rpc.ts`) with `jobs.requested_by = ctx.userId`; the worker calls `api_server.commit_batch_as(requested_by, batchId)`, which re-validates that the actor still holds `imports.review` for the batch's organization, takes the org advisory lock, re-runs the batch gating and the duplicate re-check, and audits with `actor_user_id = requested_by` (ADR-043.3). The batch shows `committing` with a progress indicator; the transaction is still atomic.

Failure at any step rolls the transaction back; the batch returns to `awaiting_review`; nothing is partially written; the error is shown in plain language.

---

## 12. Rejection, roll back and replace (ADR-029.3)

- **Reject** (before commit): `api.reject_import_batch(batch_id, reason)` → status `rejected`, rows `rejected`, audit `import.rejected`. Document remains.
- **Roll back** (after commit): `api.rollback_import_batch(batch_id, reason)`:
  1. **Dependants are promoted, not refused (ADR-047.9, R2-B-09).** Find `import_rows` in *other committed* batches whose `duplicate_of_id` points at records of this batch and whose decision was `skip` — rows that were skipped because this batch already held them. In the same transaction each such row is committed from its stored `mapped_data` as a record of the *dependent* batch (`promoted_from_batch_id = this batch`, `record_status_events accepted`, same `assurance_level`), so overlapping statement chains (A → B → C, each skipping a few rows of the previous one) can be corrected at any point without rolling back the whole chain. The rollback is refused only when a dependent row has no `mapped_data` or its batch is itself already rolled back.
     *As built (ADR-130, migration 20261005000001):* "same `assurance_level`" means what the DEPENDANT batch's commit would have stamped (`app.batch_record_assurance` — the commit CASE by name), not `verified`; and the promoted record carries the same columns commit writes (subtotal, tax, payment date, counterparty, running balance, opening flag). Rows whose own batch is already rolled back are skipped by the selection, not refused (unchanged; recorded as a deviation).
  2. Records of the batch → `record_status = 'rejected'`, `rejected_reason = 'batch rolled back'`; `record_status_events (rejected)` for each.
  3. **Supersession chains are re-linked in the column (ADR-047.1, R2-B-01).** If this batch's row B superseded A and was itself superseded by C, `A.superseded_by ← C`. If B was current, A becomes current again: `A.superseded_by ← NULL, A.superseded_at ← NULL` (the `superseded_at_set` trigger permits the reset) and a `restored` event is written; engine loaders, `app.aggregate_periods` and the partial unique indexes key on the column and therefore see A immediately, while evidence as-of resolution reads the events (`EVIDENCE_MODEL.md §3`). Batch-scoped balance supersession restores the whole superseded batch the same way.
  4. `import_rows` → `rejected`; batch `rolled_back`; `calculation.run` enqueued with trigger `import_rollback`; audit `import.rolled_back` with the count of promoted rows.
- **Replace** — the normal corrected-file path: from the coverage strip or from the review screen of the new batch, `api.replace_import_batch(old_batch_id, new_batch_id, reason)` runs, in **one transaction**: roll back of the old batch (steps 1–4, including promotion of dependants), re-run of the new batch's duplicate passes against the now-rejected rows *and* the promoted rows so the new batch's rows win and promoted duplicates are superseded, then commit of the new batch (§11). The user sees "Replace March statement (batch 12) with this file" together with the counts that will change.
- Alerts and actions that cited rolled-back evidence are not deleted. Alerts whose subject record was rejected auto-resolve with `status_reason_code = 'record_removed'`; old evidence resolves with the `rejected` badge and a link to the replacement where one exists.
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

Re-importing the same file is blocked at upload (file duplicate; a `failed`/`deferred_upstream` batch for that file is offered for retry instead). Importing a *corrected* version of a period uses **Replace** (§12): the coverage strip shows the overlap and offers "Replace batch 12 with this file", which rolls back the earlier batch, re-runs duplicate detection and commits the new batch in one transaction. Plain "roll back" of the earlier batch is refused while a later batch depends on it (F-B-04). Overlapping `period_balances` supersede at batch scope after `IMP-COV-013` confirmation.

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
| Balance does not reconcile (PDF) | `IMP-BAL-006` | Difference amount and the pages where the running balance breaks | Commit blocked | Commit with a plug entry; trust AI-read balances |
| The same invoice list is re-exported next month with payments applied | §9.2 pass 1 | "14 invoices updated (payments applied)", default keep | New rows supersede the old; receivables fall accordingly | Treat a payment update as a duplicate; fail on the unique index |
| A corrected statement is re-imported for a month already committed | `IMP-COV-014`, duplicate passes | "Replace batch 12 with this file" with row deltas | Replace flow: roll back old, re-dedupe, commit new, one transaction | Roll back the old batch after its rows were skipped as duplicates |
| A trial balance holds year-to-date balances | `IMP-TB-012` detection (balances grow month on month) | "These balances look cumulative — confirm" with a two-month example | `balance_basis = cumulative`; the engine differences consecutive balances (ADR-027) | Treat YTD balances as monthly movement |
| A P&L report contains total and subtotal rows | `IMP-ROW-004`, `IMP-TOT-014` | Total rows listed as "Totals (not imported)"; check that lines add up | Totals excluded; a mismatch blocks commit | Import "Total income" as an account |
| The AI extraction service is unavailable | `document.extract` upstream error | "Waiting for the extraction service"; pages already read are reviewable | `deferred_upstream`; per-page retry with backoff up to 15 min; notification when done | Mark the batch failed after three minutes; ask for a re-upload |
| A P&L report shows income as positive numbers | `IMP-TB-013` detection (income and expense rows both positive) | "This report shows income as positive — confirm" with two sample rows | `balanceSign = reporting`; lines negated to natural sign at commit | Store reporting sign and report negative revenue |
| The invoice list contains only unpaid invoices | `IMP-INV-012` (< 10% paid, > 60-day span) | "This looks like an aged-debtors list — confirm" | `invoice_list_kind = open_items`; defines receivables only | Use an open-items list as the revenue basis or the DSO denominator |
| A corrected statement replaces the first of three overlapping months | Replace on batch A while B and C skipped rows as duplicates of A | "Replace batch A; 7 rows held by B and C will be kept" | Dependants promoted into B and C, A rejected, A′ committed, one recalculation | Refuse until B and C are rolled back; lose the skipped rows |
| The export's last posting is before month end | Declared range confirmed at `IMP-RANGE-015` | "This export covers 1 Jan – 31 Aug" | Coverage uses the declared range; August is complete | Treat the last posting date as the end of coverage |
| A bank account record is created twice for one real account | masked-identity check at creation (§2) | "This account already exists — use it?" | Creation refused; existing account selected | Allow two records and double-count the statement |

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
| Organization suspended or pending deletion mid-import | All import actions return `PermissionDenied`; state preserved; queued jobs for the organization are requeued with backoff, not run (`SERVICE_ARCHITECTURE.md §5`) |
| Worker dies during a large commit | Postgres rolls the transaction back; stale-lock recovery (budget × 3) returns the batch to `awaiting_review` with `error_summary.stage = 'commit'`; the reviewer commits again; a super admin can reset from `/platform/jobs` |
| Extraction provider outage | `deferred_upstream`; per-page retries; no re-upload needed; the SHA duplicate check links to this batch |
| Two batches for the same period validated before either commits | The second commit's re-check (§9.3) re-flags the overlapping rows and returns that batch to review |
| Calculation coalesced with a running run | The running run marks itself stale and re-runs; `calculation_run_id` is set only by the run that included the batch (ADR-031.1) |

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
16. `tb_cumulative_q1.xlsx` — three monthly TBs with year-to-date balances (`IMP-TB-012`; ADR-027 differencing).
17. `invoices-sales-month2.csv` — the month-1 list re-exported with payments applied (`IMP-INV-010`, supersession, receivables fall).
18. `bank-card-repayment.csv` + `card-statement.csv` — a current-account payment paired with the card statement inflow; must remain a cash outflow (ADR-028).
19. `gl-opening-balance-journal.csv` — GL export starting mid-year with a brought-forward journal (`IMP-GL-011`).
20. `statement-injected-balances.pdf` — text layer whose invisible text asserts fake opening/closing balances and a plausible row; deterministic or reviewer balances must win the gate; `IMP-PDF-002` must trip.
21. `bank-payroll-batch.csv` — eight identical payroll rows on one day; default keep with reason; no `duplicate.transaction` alert.
22. `csv-with-preamble.csv` — four non-tabular lines before the header (`IMP-ROW-005`; row count equals non-empty lines).
23. `gl-renamed-accounts.csv` — cumulative re-export where "4000 Sales" became "4000 Sales Revenue" (`IMP-COV-014`, stable `scope_key`).
24. `statement-fake-closing-line.pdf` — a transaction line reading "CLOSING COSTS SOLICITOR £2,300.00" inside the grid and a per-page "Balance carried forward" footer; the deterministic capture must take the footer, not the transaction (R2-C-11).
25. `counterparty-name-with-amount.csv` — a sales list whose customer column contains "Acme Ltd (owed £45,000)" and "Beta 12% Ltd"; both rows fail `IMP-NAME-015` (R2-C-05).
26. `bank_claude_only-retry-budget.pdf` — a page that fails schema validation three times before succeeding; the page budget must decrement by four (R2-C-11).
`pnl_multi_period.xlsx` (5) now also contains "Total income" and "Total expenses" rows (`IMP-ROW-004`, `IMP-TOT-014`).
27. `pnl-reporting-sign.xlsx` — Xero-style P&L with income and expenses positive; `IMP-TB-013` proposes `reporting`; revenue must be positive after commit (R2-B-03).
28. `invoices-open-items-only.csv` — aged-debtors export, 4% paid, 140-day span; `IMP-INV-012` confirmation; never a revenue basis (R2-B-10).
29. `statements-overlapping-3.csv` — three statements (1 Jan–3 Feb, 1 Feb–3 Mar, 1 Mar–3 Apr) with overlapping rows; replacing the first promotes seven rows into the second and third and leaves the accepted count unchanged (R2-B-09).
30. `credit-note-with-tax.csv` — invoice 1,000/200/1,200 and its credit note −1,000/−200/−1,200 refunded; revenue and receivables net to zero; one deliberately inconsistent row trips `IMP-INV-011` (R2-B-05).
31. `gl-conversion-balance.csv` — Xero conversion-balance journal dated the day before the export start, plus a supplier "B/F Traders Ltd"; only the journal is flagged `IMP-GL-011`, and the flag needs confirmation because it exceeds 10% of the batch (R2-B-04).
32. `gl-declared-range-aug.csv` — GL declared 1 Jan–31 Aug with the last posting on Friday 28 Aug; August must be covered and complete (R2-B-06).
