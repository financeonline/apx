# MOTION — Database Architecture (PostgreSQL / Supabase)

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-001..020), `TENANCY_MODEL.md`, `RBAC_MATRIX.md`
Consumed by: every other document. Table and column names here are canonical; other documents must use them verbatim.

Conventions
- Schema `public` for application tables, `app` for security-definer helper functions, `auth`/`storage` are Supabase's.
- Primary keys are `uuid DEFAULT gen_random_uuid()` except `audit_events` (`bigint identity`).
- Every table has `created_at timestamptz NOT NULL DEFAULT now()`; mutable tables also have `updated_at` maintained by trigger.
- Money: `NUMERIC(18,2)` + `currency CHAR(3)`; ratios/scores: `NUMERIC(20,6)` (ADR-006).
- Enums are Postgres `ENUM` types named `*_enum`; values listed inline below.
- Tenant tables: see the rule set in `TENANCY_MODEL.md §6`. "RLS: tenant-data" below means exactly that rule set with the standard write class.
- Cross-org FK: written as `FK(org, x) → table(org, id)`; every parent table exposes `UNIQUE (organization_id, id)` to support it.

Legend for the "RLS" column: **T-data** = tenant data class · **T-gov** = tenant governance class · **Platform** = super admin only · **Append** = append-only.

---

## 1. Identity

### `profiles`
Purpose: application profile for every auth user (mirror of `auth.users`, created by trigger on signup).
PK `id uuid` = `auth.users.id`. Fields: `email citext UNIQUE`, `full_name`, `avatar_url`, `last_active_org_id uuid NULL → organizations`, `timezone`, `onboarding_state jsonb`, `disabled_at`.
RLS: select/update own row; other users' `full_name`/`avatar_url` exposed through view `org_member_profiles` (security definer, filtered by shared organization). Audit: `disabled_at` changes.

### `platform_users`
Purpose: platform role grants (ADR-002).
PK `user_id → profiles`. Fields: `platform_role platform_role_enum {super_admin, employee}`, `status {active, suspended}`, `granted_by → profiles`, `notes`.
RLS: Platform (select own row allowed for employees). Audit: trigger diff. Constraint: trigger blocks insert when user has any `organization_memberships` row and vice versa.

### `invitations`
Purpose: pending invites into an organization.
PK `id`. Fields: `organization_id`, `email citext`, `role membership_role_enum {owner, admin, client}`, `token_hash text UNIQUE`, `invited_by → profiles`, `expires_at`, `accepted_at`, `accepted_user_id`, `status {pending, accepted, expired, revoked}`.
Indexes: `(organization_id, status)`, `(email) WHERE status='pending'`. RLS: T-gov. Audit: create/accept/revoke events.

---

## 2. Tenancy

### `organizations`
Purpose: the tenant root (`TENANCY_MODEL.md §2`).
PK `id`. Fields: `slug citext UNIQUE`, `name`, `legal_name`, `country_code CHAR(2)`, `base_currency CHAR(3)`, `fiscal_year_start_month smallint 1..12 DEFAULT 1`, `industry`, `kind {customer, adviser} DEFAULT customer`, `status {active, suspended, pending_deletion, deleted}`, `plan {trial, starter, professional, enterprise}`, `features jsonb DEFAULT '{}'`, `settings jsonb DEFAULT '{}'` (alert prefs, AI quota override), `created_by`, `deleted_at`.
Indexes: `(status)`. RLS: read if `id IN accessible_org_ids()`; update owner/admin restricted to (`name`, `legal_name`, `fiscal_year_start_month`, `settings`, `industry`) via column-level grant, super admin all. Audit: trigger diff.

### `organization_memberships`
PK `id`. Fields: `organization_id`, `user_id → profiles`, `role membership_role_enum`, `status {active, suspended}`, `invited_by`, `joined_at`. `UNIQUE (organization_id, user_id)`, `UNIQUE (organization_id, id)`.
Indexes: `(user_id, status)`, `(organization_id, role)`. RLS: T-gov with role ceiling `WITH CHECK`. Triggers: last-owner protection; platform-user exclusivity. Audit: trigger diff.

### `organization_assignments`
PK `id`. Fields: `organization_id`, `employee_user_id → platform_users`, `assigned_by → profiles`, `grantor_organization_id NULL → organizations` (post-MVP adviser firms), `status {active, revoked, expired}`, `starts_at`, `ends_at DEFAULT now() + interval '12 months'`, `revoked_by`, `revoked_reason`. `UNIQUE (organization_id, employee_user_id)`.
Indexes: `(employee_user_id, status)`. RLS: select owner/admin/super admin + employee where self; insert super admin only; update super admin, or owner limited to setting `status='revoked'` (`WITH CHECK`). Audit: trigger diff.

### `fiscal_periods`
Purpose: materialised calendar months per organization (ADR-007).
PK `id`. Fields: `organization_id`, `period_start date`, `period_end date`, `fiscal_year smallint`, `fiscal_quarter smallint`, `label text` ("Mar 2026"), `is_locked bool DEFAULT false` (post-MVP close). `UNIQUE (organization_id, period_start)`, `UNIQUE (organization_id, id)`.
RLS: T-data (write by system only via services). Audit: none.

---

## 3. Financials

### `accounts`
Purpose: organization chart of accounts mapped to standard categories (ADR-004, CD-04).
PK `id`. Fields: `organization_id`, `code text NULL`, `name text`, `normalized_name text`, `account_type {asset, liability, equity, income, expense}`, `standard_category standard_category_enum` (26 values, ADR-004), `is_system bool` (seeded), `is_active bool`, `source {seeded, imported, user}`, `external_ref text`, `mapping_confidence {confirmed, suggested, unmapped}`.
Constraints: `UNIQUE (organization_id, code) WHERE code IS NOT NULL`, `UNIQUE (organization_id, normalized_name)`, `UNIQUE (organization_id, id)`, check that `account_type` is consistent with `standard_category` (lookup function).
Indexes: `(organization_id, standard_category)`. RLS: T-data. Audit: trigger diff on `standard_category` changes (a re-mapping changes every metric).

### `counterparties`
Purpose: customers and suppliers (ADR-004, ADR-016).
PK `id`. Fields: `organization_id`, `name`, `normalized_name`, `kind {customer, supplier, both, unknown}`, `external_ref`, `email`, `notes`, `is_active`, `merged_into_id NULL → counterparties`. `UNIQUE (organization_id, normalized_name)`, `UNIQUE (organization_id, id)`.
Indexes: `(organization_id, kind)`. RLS: T-data. Audit: merge events. Post-MVP CRM extends with `crm_*` tables keyed to this id; do not add pipeline fields here.

### `ledger_entries`
Purpose: transaction-level accounting lines from GL, sales/purchase reports, receipts.
PK `id`. Fields: `organization_id`, `entry_date date`, `period_id → fiscal_periods (org-composite)`, `account_id → accounts (org-composite)`, `direction {debit, credit}`, `amount NUMERIC(18,2) CHECK (amount >= 0)`, `currency`, `description`, `reference`, `counterparty_id NULL (org-composite)`, `journal_ref text` (groups lines of one journal), `source_document_id NULL`, `import_batch_id`, `import_row_id`, `source_ref text` (sheet/row or page/line), `record_status record_status_enum {pending, needs_review, accepted, duplicate, rejected, incomplete}`, `assurance_level assurance_level_enum {verified, calculated, estimated, inferred}`, `dedupe_hash bytea`, `rejected_reason`, `superseded_by NULL → ledger_entries`, `superseded_at timestamptz NULL`.
Indexes: `(organization_id, period_id, account_id) WHERE record_status='accepted'`, `(organization_id, entry_date)`, `(organization_id, dedupe_hash)`, `(organization_id, counterparty_id)`, `(import_batch_id)`.
RLS: T-data. Audit: service events on status change; never hard delete.

### `period_balances`
Purpose: summary-level balances from trial balance, P&L and balance-sheet imports (CD-03).
PK `id`. Fields: `organization_id`, `period_id`, `account_id`, `opening_balance NUMERIC(18,2)`, `debit_total`, `credit_total`, `closing_balance`, `currency`, `balance_kind {trial_balance, pnl_report, balance_sheet}`, `source_document_id`, `import_batch_id`, `import_row_id`, `source_ref`, `record_status`, `assurance_level`, `superseded_by NULL → period_balances`, `superseded_at timestamptz NULL`.
Constraints: `UNIQUE (organization_id, period_id, account_id, import_batch_id)`; at most one *accepted, non-superseded* row per `(organization_id, period_id, account_id)` (partial unique index). A newer committed batch for the same period/account supersedes the older row (service sets `superseded_by`), never overwrites.
Indexes: `(organization_id, period_id) WHERE record_status='accepted' AND superseded_by IS NULL`. RLS: T-data.

### `invoices`
Purpose: sales and purchase invoices and credit notes for receivables/payables, aging and customer revenue (CD-07, CD-28).
PK `id`. Fields: `organization_id`, `invoice_type {sales, purchase, sales_credit_note, purchase_credit_note}`, `counterparty_id (org-composite)`, `invoice_number`, `issue_date`, `due_date NULL`, `period_id` (by issue date), `subtotal`, `tax_amount`, `total_amount`, `amount_paid DEFAULT 0`, `balance_due NUMERIC(18,2) GENERATED ALWAYS AS (total_amount - amount_paid) STORED`, `currency`, `status {open, partially_paid, paid, void}`, `paid_date NULL`, `description`, `source_document_id`, `import_batch_id`, `import_row_id`, `source_ref`, `record_status`, `assurance_level`, `dedupe_hash`, `superseded_by`, `superseded_at timestamptz NULL`.
Constraints: `UNIQUE (organization_id, invoice_type, counterparty_id, invoice_number) WHERE record_status='accepted'`.
Indexes: `(organization_id, invoice_type, status, due_date)`, `(organization_id, counterparty_id, issue_date)`, `(organization_id, period_id)`. RLS: T-data. Invoice lines (`invoice_lines`) are post-MVP (CD-08).

---

## 4. Banking

### `bank_accounts`
PK `id`. Fields: `organization_id`, `name`, `bank_name`, `account_number_masked` (last 4 only; full numbers are never stored), `sort_code_masked`, `currency`, `account_type {current, savings, credit_card, loan, other}`, `ledger_account_id NULL → accounts` (link to the cash account in the chart), `opening_balance NUMERIC(18,2) NULL`, `opening_balance_date date NULL`, `is_active`. `UNIQUE (organization_id, id)`.
RLS: T-data. Audit: opening balance edits (they move every cash figure).

### `bank_transactions`
PK `id`. Fields: `organization_id`, `bank_account_id (org-composite)`, `transaction_date date`, `posted_date NULL`, `period_id`, `amount NUMERIC(18,2)` (signed: positive inflow, negative outflow), `currency`, `description_raw`, `description_normalized`, `counterparty_name_raw`, `counterparty_id NULL`, `category_account_id NULL → accounts` (standard-category account chosen by rules or user), `category_source {rule, user, ai_suggested, none}`, `balance_after NUMERIC(18,2) NULL` (from statement), `reference`, `is_transfer bool DEFAULT false`, `transfer_pair_id NULL → bank_transactions`, `recurring_group_id NULL → recurring_payment_groups`, `matched_ledger_entry_id NULL → ledger_entries` (post-MVP reconciliation), `source_document_id`, `import_batch_id`, `import_row_id`, `source_ref` (page/line), `record_status`, `assurance_level`, `dedupe_hash`, `superseded_by`, `superseded_at timestamptz NULL`.
Indexes: `(organization_id, bank_account_id, transaction_date) WHERE record_status='accepted'`, `(organization_id, period_id)`, `(organization_id, dedupe_hash)`, `(organization_id, recurring_group_id)`, `(organization_id, category_account_id)`.
RLS: T-data.

### `recurring_payment_groups`
Purpose: detected recurring outflows/inflows for anomaly rules (SOW §13, §15).
PK `id`. Fields: `organization_id`, `bank_account_id NULL`, `counterparty_key text` (normalised description signature), `direction {inflow, outflow}`, `cadence {weekly, fortnightly, monthly, quarterly, annual, irregular}`, `expected_amount NUMERIC(18,2)`, `amount_tolerance_ratio NUMERIC(20,6)`, `first_seen date`, `last_seen date`, `occurrence_count int`, `next_expected date NULL`, `status {active, stopped, changed}`, `detector_version text`. `UNIQUE (organization_id, bank_account_id, counterparty_key, direction)`.
RLS: T-data (system-written). Audit: none.

---

## 5. Documents & Imports

### `source_documents`
Purpose: every uploaded file (SOW §5, §6, §12).
PK `id`. Fields: `organization_id`, `storage_bucket DEFAULT 'source-documents'`, `storage_path`, `original_filename`, `mime_type`, `byte_size`, `sha256 bytea`, `document_kind {bank_statement, general_ledger, trial_balance, pnl_report, balance_sheet, sales_report, purchase_report, invoice, receipt, other, unknown}`, `page_count NULL`, `has_text_layer bool NULL`, `extracted_text_path NULL` (Storage path of text dump), `status {uploaded, scanning, ready, unreadable, quarantined, deleted}`, `scan_result jsonb`, `uploaded_by`, `deleted_at`.
Constraints: `UNIQUE (organization_id, sha256) WHERE deleted_at IS NULL` (file-level duplicate, CD-12), `UNIQUE (organization_id, id)`.
Indexes: `(organization_id, document_kind, created_at)`. RLS: T-data, but SELECT additionally requires role ≠ client (policy expression `app.org_role(organization_id) <> 'client'`). Audit: upload, download (service event), delete.

### `import_mappings`
Purpose: saved column mappings per organization for reuse (SOW §6 "mapping").
PK `id`. Fields: `organization_id`, `name`, `import_type import_type_enum {general_ledger, trial_balance, pnl_report, balance_sheet, bank_statement, sales_invoices, purchase_invoices, receipts}`, `header_signature text` (hash of normalised headers), `column_map jsonb` (source column → target field), `transforms jsonb` (date format, decimal separator, sign convention, sheet name), `account_map jsonb` (source account name → `accounts.id`), `created_by`, `last_used_at`. `UNIQUE (organization_id, import_type, header_signature)`.
RLS: T-data.

### `import_batches`
Purpose: one import run of one file into one target table (ADR-012).
PK `id`. Fields: `organization_id`, `source_document_id (org-composite)`, `import_type`, `target_table {ledger_entries, period_balances, bank_transactions, invoices}`, `bank_account_id NULL`, `mapping_id NULL`, `mapping_snapshot jsonb` (frozen copy at commit), `status {created, parsing, mapping, validating, awaiting_review, committing, committed, rolled_back, rejected, failed}`, `row_counts jsonb` `{total, valid, warning, error, duplicate, skipped, committed}`, `period_start date NULL`, `period_end date NULL`, `statement_opening_balance NULL`, `statement_closing_balance NULL`, `extraction_method {csv, xlsx, pdf_text, pdf_claude, manual}`, `created_by`, `reviewed_by`, `committed_at`, `rolled_back_at`, `rolled_back_reason`, `error_summary jsonb`, `calculation_run_id NULL`.
Indexes: `(organization_id, status, created_at desc)`, `(source_document_id)`. RLS: T-data. Audit: create, commit, roll back, reject (service events).

### `import_rows`
Purpose: every parsed row, forever (SOW §23 "surfaced rather than silently discarded").
PK `id`. Fields: `organization_id`, `batch_id → import_batches (org-composite)`, `row_number int`, `source_ref text` (sheet!row, or page:line), `raw_data jsonb`, `mapped_data jsonb`, `status {pending, valid, warning, error, duplicate, skipped, committed, rejected}`, `issues jsonb` (array of `{code, severity, field, message, suggestion}`), `dedupe_hash bytea`, `duplicate_of_table NULL`, `duplicate_of_id NULL`, `duplicate_within_batch_row_id NULL`, `reviewer_decision {none, keep, skip, fixed}`, `reviewer_reason`, `committed_table NULL`, `committed_record_id NULL`.
Constraints: `UNIQUE (batch_id, row_number)`. Indexes: `(batch_id, status)`, `(organization_id, dedupe_hash)`. RLS: T-data. Retention: rows are kept as long as the batch; `raw_data` may be moved to cold storage after 24 months (post-MVP).

---

## 6. Intelligence

### `calculation_runs`
Purpose: one deterministic execution of the financial engine (ADR-008).
PK `id`. Fields: `organization_id`, `trigger {import_commit, import_rollback, recalc_manual, scheduled, account_remapped, settings_changed}`, `trigger_ref_id NULL`, `engine_version text`, `period_from → fiscal_periods`, `period_to`, `status {queued, running, succeeded, failed}`, `input_fingerprint bytea` (hash of accepted record ids + versions in range), `started_at`, `finished_at`, `duration_ms`, `error jsonb`, `stats jsonb`.
Indexes: `(organization_id, created_at desc)`. RLS: T-data (system-written). Audit: failure events.

### `metric_snapshots`
Purpose: every computed metric value, including breakdowns (ADR-008, ADR-005).
PK `id`. Fields: `organization_id`, `calculation_run_id`, `period_id`, `metric_key text` (from the registry in `FINANCIAL_ENGINE.md §3`), `dimension_type {none, account, standard_category, counterparty, bank_account}`, `dimension_id uuid NULL`, `value NUMERIC(20,6) NULL` (NULL = not computable), `unit {money, ratio, count, days}`, `currency`, `basis {period_balances, ledger, invoices, bank, mixed, none}`, `assurance_level`, `data_quality jsonb` `{completeness: 0..1, warnings: [...], missing: [...]}`, `components jsonb` (named inputs and intermediate values, e.g. `{revenue: 120000, cost_of_sales: 45000}`), `evidence_query jsonb` (descriptor, ADR-009), `is_current bool DEFAULT true`.
Constraints: `UNIQUE NULLS NOT DISTINCT (calculation_run_id, period_id, metric_key, dimension_type, dimension_id)` (Postgres 15+; `dimension_id` is NULL for `dimension_type = 'none'` and for the synthetic "Unattributed" breakdown row, so NULLs must compare equal).
Indexes: `(organization_id, metric_key, period_id) WHERE is_current` (the hot path), `(organization_id, period_id, dimension_type) WHERE is_current`.
RLS: T-data. Retention: non-current snapshots kept for 12 months then archived.

### `health_scores`
PK `id`. Fields: `organization_id`, `calculation_run_id`, `period_id`, `score smallint 0..100 NULL`, `dimensions_used smallint`, `dimensions_total smallint`, `breakdown jsonb` (array of `{key, score, weight_config, weight_applied, metrics: [{metric_key, value, snapshot_id}], rules: [{rule, result, points}], positives: [...], negatives: [...], data_quality}`), `config_version text`, `is_current bool`. `UNIQUE (organization_id, period_id, calculation_run_id)`.
Indexes: `(organization_id, period_id) WHERE is_current`. RLS: T-data.

### `alerts`
PK `id`. Fields: `organization_id`, `rule_key text`, `rule_version text`, `severity {critical, high, medium, low, info}`, `metric_key NULL`, `period_id`, `subject_type {none, account, counterparty, bank_transaction, recurring_group, standard_category}`, `subject_id NULL`, `title`, `explanation text`, `threshold_summary jsonb` (the numbers that tripped it), `recommended_next_step text`, `evidence_bundle_id → evidence_bundles`, `status {open, acknowledged, resolved, dismissed}`, `status_changed_by`, `status_changed_at`, `status_reason_code {user, condition_cleared, record_removed, rule_retired} DEFAULT 'user'`, `status_reason text NULL`, `action_id NULL → actions`, `dedupe_key text`, `calculation_run_id`, `first_seen_at`, `last_evaluated_at`.
Constraints: `UNIQUE (organization_id, dedupe_key)` (ADR-018). Indexes: `(organization_id, status, severity)`, `(organization_id, period_id)`. RLS: T-data; clients may change `status` only through the security-definer function `app.alert_set_status(alert_id, new_status, reason)`, which permits clients to set `acknowledged` only (`RBAC_MATRIX.md §2.1`, `alerts.manage` ◐) and permits owner/admin/employee/super admin any transition. Audit: status changes.

### `evidence_bundles`
PK `id`. Fields: `organization_id`, `kind {metric, alert, ai_response, health_score, action, report}`, `origin_table`, `origin_id`, `calculation_run_id NULL` (as-of), `created_by_type {system, ai, user}`, `created_by NULL`. `UNIQUE (organization_id, id)`.
RLS: T-data for SELECT/INSERT only; **no UPDATE or DELETE policy** (bundles are immutable, `EVIDENCE_MODEL.md §8`).

### `evidence_items`
PK `id`. Fields: `organization_id`, `bundle_id (org-composite)`, `sort_order`, `item_type {metric_snapshot, calculation_run, ledger_entry, bank_transaction, invoice, period_balance, counterparty, account, source_document, fiscal_period, query}`, `ref_id uuid NULL`, `query_descriptor jsonb NULL`, `label text`, `claim text NULL` (the statement this item supports), `assurance_level`.
Constraint: exactly one of `ref_id`, `query_descriptor` non-null. Indexes: `(bundle_id, sort_order)`, `(organization_id, item_type, ref_id)`. RLS: T-data for SELECT/INSERT only; **no UPDATE or DELETE policy** (append-only).

---

## 7. AI

### `ai_conversations`
PK `id`. Fields: `organization_id`, `user_id`, `title`, `status {active, archived}`, `last_message_at`. Indexes: `(organization_id, user_id, last_message_at desc)`. RLS: T-data, but SELECT/UPDATE limited to `user_id = auth.uid()` or role owner/admin (owners may review conversations in their org — stated in Settings; super admin via audit). Insert requires `ai.use` (checked in service).

### `ai_messages`
PK `id`. Fields: `organization_id`, `conversation_id (org-composite)`, `role {user, assistant, system, tool}`, `content text` (user text or assistant narrative), `structured_response jsonb` (validated response contract, assistant only), `prompt_version`, `model`, `input_tokens`, `output_tokens`, `latency_ms`, `grounding_status {passed, failed, degraded, not_applicable}`, `grounding_report jsonb`, `evidence_bundle_id NULL`, `period_context jsonb` (resolved periods the answer is about), `flagged bool DEFAULT false`.
Indexes: `(conversation_id, created_at)`. RLS: same as conversation.

### `ai_tool_calls`
PK `id`. Fields: `organization_id`, `message_id (org-composite)`, `sequence smallint`, `tool_name`, `input jsonb`, `authorized bool`, `denial_reason NULL`, `output_hash bytea`, `output_summary jsonb` (counts, metric keys, ids returned; not full payload), `duration_ms`, `error NULL`.
Indexes: `(message_id, sequence)`, `(organization_id, tool_name, created_at)`. RLS: select owner/admin/super admin; insert by service only. Audit: this table *is* the AI audit trail.

### `ai_feedback`
PK `id`. Fields: `organization_id`, `message_id NULL`, `alert_id NULL`, `user_id`, `feedback_type {incorrect, unhelpful, helpful, unsafe}`, `comment`, `status {open, reviewed, actioned, dismissed}`, `reviewed_by`, `reviewed_at`, `resolution_note`.
RLS: insert own; select own + owner/admin; platform review via `platform.ai_feedback.review`.

---

## 8. Actions

### `actions`
Purpose: SOW §17 Action Centre fields, verbatim.
PK `id`. Fields: `organization_id`, `title`, `issue text` (problem/opportunity), `recommendation text`, `priority {critical, high, medium, low}`, `owner_user_id NULL → profiles` (member or assigned employee; validated in service), `due_date NULL`, `status {open, in_progress, completed, dismissed}`, `source_type {ai, alert, health_score, user, report}`, `source_id NULL`, `evidence_bundle_id NULL`, `outcome_notes NULL`, `outcome_value NUMERIC(18,2) NULL`, `outcome_currency`, `completed_at`, `dismissed_reason`, `created_by`.
Indexes: `(organization_id, status, priority, due_date)`, `(organization_id, owner_user_id, status)`. RLS: T-data; clients may update only rows where `owner_user_id = auth.uid()` and only `status`, `outcome_notes`, `outcome_value` (security-definer `app.action_update_own`). Audit: create, assign, status change.

### `action_comments` — post-MVP (Team Management, CD-26). Not created in MVP.

---

## 9. Audit, Security, Operations

### `audit_events`
PK `id bigint identity`. Fields: `organization_id NULL` (NULL = platform event), `actor_user_id NULL`, `actor_type {user, employee, platform_admin, system, ai}`, `action text` (dotted verb, e.g. `import.committed`, `member.role_changed`, `document.downloaded`, `org.data_viewed`, `ai.answered`), `target_table NULL`, `target_id NULL`, `before jsonb NULL`, `after jsonb NULL`, `metadata jsonb`, `ip inet NULL`, `user_agent text NULL`, `request_id text`, `created_at`.
Indexes: `(organization_id, created_at desc)`, `(actor_user_id, created_at desc)`, `(action, created_at desc)`. RLS: Append — INSERT via security-definer function `app.audit(...)` only (no direct insert policy); SELECT owner/admin for own org, super admin all; no UPDATE/DELETE policies; table owner revokes those privileges from `authenticated` and `service_role` except the purge job's redaction path. Partition by month from 10M rows (not at MVP).

### `jobs`
PK `id`. Fields: `organization_id NULL`, `job_type {calculation.run, document.extract, import.commit_large, alerts.evaluate, org.purge, report.render, ai.eval}`, `idempotency_key text NULL` (unique partial index `WHERE status IN ('queued','running')`, so enqueueing the same work twice is a no-op; `SERVICE_ARCHITECTURE.md §5`), `payload jsonb`, `status {queued, running, succeeded, failed, dead}`, `attempts smallint`, `max_attempts smallint DEFAULT 3`, `run_after timestamptz`, `locked_at`, `locked_by`, `last_error`, `result jsonb`, `finished_at`.
Indexes: `(status, run_after) WHERE status='queued'`, `(organization_id, job_type, created_at desc)`. RLS: Platform (select); workers use service role. `org.purge` is the only job allowed to hard-delete tenant rows.

### `role_permissions`
Purpose: read-only mirror of the TypeScript permission matrix (ADR-003), regenerated by `scripts/sync-permission-matrix.ts` into a migration; used by `app.has_permission()`.
PK `(role text, permission text)`. No RLS needed (readable by `authenticated`, writable by nobody at runtime; `REVOKE INSERT/UPDATE/DELETE`). pgTAP parity test in `TEST_STRATEGY.md §2`.

### `platform_settings`
Single-row-per-key config: `key text PK`, `value jsonb`, `updated_by`. Holds default AI quotas, alert defaults, health-score config version pointer. RLS: Platform.

---

## 10. Enum summary

| Enum | Values |
|---|---|
| `platform_role_enum` | super_admin, employee |
| `membership_role_enum` | owner, admin, client |
| `standard_category_enum` | revenue, other_income, cost_of_sales, operating_expense, payroll, marketing, interest_expense, tax_expense, depreciation, other_expense, cash, receivables, inventory, other_current_asset, fixed_asset, other_asset, payables, credit_card, loan, tax_liability, other_current_liability, long_term_liability, equity, drawings, transfer, uncategorised |
| `record_status_enum` | pending, needs_review, accepted, duplicate, rejected, incomplete |
| `assurance_level_enum` | verified, calculated, estimated, inferred |
| `import_type_enum` | general_ledger, trial_balance, pnl_report, balance_sheet, bank_statement, sales_invoices, purchase_invoices, receipts |
| `metric_basis_enum` | period_balances, ledger, invoices, bank, mixed, none |
| `severity_enum` | critical, high, medium, low, info |
| `action_status_enum` | open, in_progress, completed, dismissed |

`payroll` and `marketing` are sub-types of operating expense kept as distinct standard categories because the SOW scenarios (§14) and health dimensions (§9) need them; the engine treats them as operating expenses in totals.

---

## 11. RLS policy templates

```sql
-- Helper functions (security definer, search_path pinned): app.is_super_admin(), app.accessible_org_ids(), app.org_role(uuid)
-- Template for a tenant data table:
alter table ledger_entries enable row level security;
alter table ledger_entries force row level security;

create policy sel on ledger_entries for select to authenticated
  using (organization_id in (select app.accessible_org_ids()));

create policy ins on ledger_entries for insert to authenticated
  with check (app.has_permission(organization_id, 'financials.edit'));

create policy upd on ledger_entries for update to authenticated
  using (app.has_permission(organization_id, 'financials.edit'))
  with check (app.has_permission(organization_id, 'financials.edit'));

-- app.has_permission(org uuid, perm text) = exists(select 1 from role_permissions
--   where role = app.org_role(org) and permission = perm)

-- no delete policy on financial record tables: deletes are impossible for authenticated; only org.purge (service role) deletes.
```

Governance tables use `app.has_permission(organization_id, 'users.manage')` plus the ceiling checks; platform tables use `app.is_super_admin()`. Each table's write policy names the permission from `RBAC_MATRIX.md §2.1` that owns it (`imports.create` for `import_batches`/`import_rows`/`source_documents`, `banking.reconcile` for `bank_transactions` updates, `customers.edit` for `counterparties`, `actions.create` for `actions`, `settings.manage` for `organizations`). The service role bypasses RLS by design, which is why ADR-013 confines it to job workers wrapped in `withOrgScope`.

## 12. Triggers and constraints checklist

| Trigger / constraint | Table | Purpose |
|---|---|---|
| `set_updated_at` | all mutable | timestamps |
| `profiles_from_auth` | `auth.users` → `profiles` | create profile on signup |
| `last_owner_guard` | `organization_memberships` | CD-14 |
| `platform_user_exclusivity` | `organization_memberships`, `platform_users` | RBAC §3.5 |
| `audit_diff` | governance tables, `accounts`, `bank_accounts` (opening balance), `organizations` | ADR-015 |
| `period_assign` | `ledger_entries`, `bank_transactions`, `invoices`, `period_balances` | derive `period_id` from date, creating the fiscal period if missing |
| `single_current_balance` | `period_balances` | partial unique index |
| `evidence_item_xor` | `evidence_items` | ref_id XOR query_descriptor |
| `superseded_at_set` | four financial record tables | sets `superseded_at = now()` whenever `superseded_by` becomes non-null, so evidence `as_of` resolution (`EVIDENCE_MODEL.md §3`) can select the rows that were current at a calculation run's `finished_at` |
| `alert_dedupe` | `alerts` | unique dedupe_key |
| Composite FKs | every tenant→tenant FK | cross-org reference impossible |

## 13. What is deliberately absent

- No `entities`, `business_units` (ADR-001). No `organization_groups`, `organization_group_members` (CD-29), `support_access_grants` (CD-13), `invoice_lines`, `products`, `crm_*`, `campaigns`, `forecasts`, `scenarios`, `budgets`, `reports` tables in MVP; each arrives with its phase and attaches by `organization_id` and, where relevant, `counterparty_id`/`period_id`.
- No editable `permissions` or `roles` tables: the matrix is code, and `role_permissions` is a generated, read-only mirror (ADR-003). If per-organization custom roles are ever sold, add `organization_roles` then.
- No per-metric row-link table: evidence uses descriptors (ADR-009).
- No `users` table of our own: `profiles` mirrors Supabase Auth.
