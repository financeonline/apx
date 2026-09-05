# MOTION — Database Architecture (PostgreSQL / Supabase)

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-001..020, ADR-026..038), `TENANCY_MODEL.md`, `RBAC_MATRIX.md`
Consumed by: every other document. Table and column names here are canonical; other documents must use them verbatim.

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026 (no table writes for `authenticated`; `api.*` mutation functions, §11/§14), ADR-027 (`period_balances.period_start`, `balance_basis`, `default_expense_category`), ADR-029 (batch-scoped supersession, `duplicate_reviewed`), ADR-030 (`fiscal_periods.is_complete`, `organizations.timezone`), ADR-031 (`metric_current`, `health_current`, `calculation_runs.as_of/stale`, `calculation_job_id`, retention), ADR-034 (`category_history`, `account_category_history`, `record_status_events`, `alert_revisions`, `same_org_ref`), ADR-038 (`platform_org_settings`, `report_files`, column-limited `profiles`, invitations uniqueness, `import_*` read gating, jobs lifecycle, audit coverage). Findings addressed: F-A-01, F-A-02, F-A-03, F-A-05, F-A-06, F-A-07, F-A-08, F-A-09, F-A-11, F-A-13, F-A-17, F-B-02, F-B-03, F-B-06, F-B-10, F-B-11, F-B-13, F-B-14, F-B-16, F-B-17, F-C-07, F-C-11, F-C-15, F-C-16, F-C-18, F-D-01, F-D-03, F-D-05, F-D-06, F-D-14, F-D-18. See `RED_TEAM_REVIEW.md`.

> **Revision 1.2 (red-team round 2, 2026-09-05).** Applies ADR-047 (R2-B-01..12: rollback resets `superseded_by`; `alerts.reopened_at/dismissed_at`; `import_batches.balance_sign`, `fiscal_year_start_month_at_commit`, `invoice_list_kind`, declared ranges; `promoted_from_batch_id`; `platform_settings.taxable_categories`; `calculation_runs.chunks`/`superseded`; `metric_current.previous_snapshot_id`; one `transfer_kind` enum; 90-day retention); ADR-043 (two API schemas: `api` for user intent, `api_server` for server-asserted facts; `record_access_event`; document register/delete order), ADR-044 (MFA at the database for employees; column privileges on raw bank text; `motion_definer` ownership and function hygiene; one suspension semantic with allow-list role checks; `app.throttle`; organization state machine; `ownership_transfers`; completed polymorphic guards and composite job FKs), ADR-046 (`append_only_guard`; complete change-set and `as_of_ts`; `restored` writer; canonical descriptor hash). Findings addressed: R2-A-01, R2-A-02, R2-A-03, R2-A-04, R2-A-05, R2-A-06, R2-A-07, R2-A-08, R2-A-09, R2-A-10, R2-A-11, R2-A-12, R2-C-09, R2-C-10. See `RED_TEAM_REVIEW.md §6`.

Conventions
- Schema `public` for application tables (SELECT under RLS only), `api` for the SECURITY DEFINER mutation functions exposed to PostgREST (§14), `app` for internal helper functions (never exposed), `auth`/`storage` are Supabase's. `authenticated` and `anon` hold **no INSERT/UPDATE/DELETE privilege on any table** (ADR-026).
- Primary keys are `uuid DEFAULT gen_random_uuid()` except `audit_events` (`bigint identity`).
- Every table has `created_at timestamptz NOT NULL DEFAULT now()`; mutable tables also have `updated_at` maintained by trigger.
- Money: `NUMERIC(18,2)` + `currency CHAR(3)`; ratios/scores: `NUMERIC(20,6)` (ADR-006).
- Enums are Postgres `ENUM` types named `*_enum`; values listed inline below.
- Tenant tables: see the rule set in `TENANCY_MODEL.md §6`. "RLS: T-data" below means the SELECT policy `organization_id IN (select app.accessible_org_ids())`; every write to the table happens through the `api.*` function(s) named in §14 or through a job worker. Where a table lists a narrower SELECT rule it overrides the class default.
- Cross-org FK: written as `FK(org, x) → table(org, id)`; every parent table exposes `UNIQUE (organization_id, id)` to support it.

Legend for the "RLS" column (SELECT rules; writes are function-only everywhere): **T-data** = tenant data class · **T-gov** = tenant governance class (owner/admin/super admin read) · **Platform** = super admin only · **Append** = append-only (no update/delete for anyone but the purge redaction path).

---

## 1. Identity

### `profiles`
Purpose: application profile for every auth user (mirror of `auth.users`, created by trigger on signup).
PK `id uuid` = `auth.users.id`. Fields: `email citext UNIQUE`, `full_name`, `avatar_url`, `last_active_org_id uuid NULL → organizations`, `timezone`, `onboarding_state jsonb`, `disabled_at`.
RLS: select own row; other users' `full_name`/`avatar_url` exposed through view `org_member_profiles` (security definer, filtered by shared organization). Writes: `api.update_profile` may change only `full_name, avatar_url, timezone, onboarding_state, last_active_org_id` (ADR-038.3); `email` is written only by the auth-sync trigger; `disabled_at` only by `api.disable_user`. Middleware ignores a `last_active_org_id` outside the accessible set. Audit: `disabled_at` changes.

### `platform_users`
Purpose: platform role grants (ADR-002).
PK `user_id → profiles`. Fields: `platform_role platform_role_enum {super_admin, employee}`, `status {active, suspended}`, `granted_by → profiles`, `notes`.
RLS: Platform (select own row allowed for employees). Audit: trigger diff. Constraint: trigger blocks insert when user has any `organization_memberships` row and vice versa.

### `invitations`
Purpose: pending invites into an organization.
PK `id`. Fields: `organization_id`, `email citext`, `role membership_role_enum {owner, admin, client}`, `token_hash text UNIQUE`, `invited_by → profiles`, `expires_at`, `accepted_at`, `accepted_user_id`, `status {pending, accepted, expired, revoked}`.
Constraints: partial unique `(organization_id, email) WHERE status = 'pending'` (ADR-038.12). Indexes: `(organization_id, status)`, `(email) WHERE status='pending'`. RLS: T-gov for SELECT; `/invite/[token]` validity is checked through `api.accept_invitation(token)` (no anonymous table read). Acceptance compares `invitations.email` with `auth.jwt()->>'email'` (confirmed) and re-checks that `invited_by` is still an active owner/admin whose ceiling ≥ `role`. Writes: `api.invite_member`, `api.revoke_invitation`, `api.accept_invitation`. Audit: create/accept/revoke events.

---

## 2. Tenancy

### `organizations`
Purpose: the tenant root (`TENANCY_MODEL.md §2`).
PK `id`. Fields: `slug citext UNIQUE`, `name`, `legal_name`, `country_code CHAR(2)`, `base_currency CHAR(3)`, `fiscal_year_start_month smallint 1..12 DEFAULT 1`, `industry`, `kind {customer, adviser} DEFAULT customer`, `status {active, suspended, pending_deletion, deleted}`, `plan {trial, starter, professional, enterprise}`, `features jsonb DEFAULT '{}'`, `settings jsonb DEFAULT '{}'` (tenant-editable: alert prefs, `vat_registered`, `default_vat_rate` — never quotas), `timezone text NOT NULL DEFAULT 'Europe/London'` (ADR-030.5), `deletion_requested_at timestamptz NULL`, `created_by`, `deleted_at`.
Indexes: `(status)`. RLS: read if `id IN accessible_org_ids()`. Writes: `api.update_organization` (owner/admin: `name`, `legal_name`, `fiscal_year_start_month`, `timezone`, `settings`, `industry`; platform staff additionally `plan`, `features`, `kind`, `industry` and `status` **only between `active` and `suspended`**; `pending_deletion`/`deleted` are set only by `api.request_deletion` and `org.purge`; `deletion_requested_at`, `slug`, `created_by` are never patchable — ADR-044.6), `api.request_deletion` / `api.cancel_deletion`. Platform-controlled per-organization values live in `platform_org_settings`, not here (F-A-09). Trigger: `status → 'pending_deletion'` enqueues `org.purge` with `run_after = now() + 30 days` (ADR-026.4). Audit: trigger diff.

### `organization_memberships`
PK `id`. Fields: `organization_id`, `user_id → profiles`, `role membership_role_enum`, `status {active, suspended}`, `invited_by`, `joined_at`. `UNIQUE (organization_id, user_id)`, `UNIQUE (organization_id, id)`.
Indexes: `(user_id, status)`, `(organization_id, role)`. RLS: T-gov for SELECT (members additionally read their own row). Writes only via `api.accept_invitation`, `api.change_member_role`, `api.remove_member`, `api.initiate_ownership_transfer`/`api.accept_ownership_transfer`, which enforce: role ceiling on both the *current* and the *target* role (an admin may touch only rows whose current role ∈ {admin, client} and never their own row upward), `status` changes under the same ceiling, last-owner guard, no self-elevation (F-A-02). Triggers: last-owner protection; platform-user exclusivity (both remain as backstops). Audit: trigger diff.

### `organization_assignments`
PK `id`. Fields: `organization_id`, `employee_user_id → platform_users`, `assigned_by → profiles`, `grantor_organization_id NULL → organizations` (post-MVP adviser firms), `status {active, revoked, expired}`, `starts_at`, `ends_at DEFAULT now() + interval '12 months'`, `revoked_by`, `revoked_reason`. `UNIQUE (organization_id, employee_user_id)`.
Indexes: `(employee_user_id, status)`. RLS: select owner/admin/super admin + employee where self. Writes: `api.create_assignment` (super admin, aal2, re-auth), `api.revoke_assignment` (super admin, or an owner of that organization; sets `status='revoked'` only). Audit: trigger diff.

### `ownership_transfers`
Purpose: the two-step sole-ownership transfer (CD-14, ADR-044.7; R2-A-11) — the only path by which a non-owner becomes owner without an owner acting at that moment, so it is modelled and invariant-checked in SQL.
PK `id`. Fields: `organization_id`, `initiator_user_id → profiles`, `nominee_user_id → profiles`, `demote_initiator bool`, `status ownership_transfer_status_enum {pending, accepted, cancelled, expired}`, `expires_at timestamptz DEFAULT now() + interval '7 days'`, `accepted_at`, `cancelled_by`. `UNIQUE (organization_id) WHERE status = 'pending'`, `UNIQUE (organization_id, id)`.
RLS: T-gov (owner/admin/super admin read) plus the nominee's own row. Writes: `api.initiate_ownership_transfer`, `api.accept_ownership_transfer` (requires `auth.uid() = nominee_user_id`, status `pending` and unexpired, nominee currently an active `admin`, initiator currently an active `owner`, under the org advisory lock), `api.cancel_ownership_transfer` (initiator or any owner). Audit: `audit_diff` plus function events.

### `fiscal_periods`
Purpose: materialised calendar months per organization (ADR-007).
PK `id`. Fields: `organization_id`, `period_start date`, `period_end date`, `fiscal_year smallint`, `fiscal_quarter smallint`, `label text` ("Mar 2026"), `is_complete bool NOT NULL DEFAULT false` (ADR-030.1; maintained by the calculation run: true when `period_end ≤` the latest data date of the chosen P&L source and cash coverage is full), `is_locked bool DEFAULT false` (post-MVP close). `UNIQUE (organization_id, period_start)`, `UNIQUE (organization_id, id)`.
RLS: T-data. Writes: the `period_assign` trigger (SECURITY DEFINER) and the calculation job only. Audit: none.

---

## 3. Financials

### `accounts`
Purpose: organization chart of accounts mapped to standard categories (ADR-004, CD-04).
PK `id`. Fields: `organization_id`, `code text NULL`, `name text`, `normalized_name text`, `account_type {asset, liability, equity, income, expense}`, `standard_category standard_category_enum` (26 values, ADR-004), `is_system bool` (seeded), `is_active bool`, `source {seeded, imported, user}`, `external_ref text`, `mapping_confidence {confirmed, suggested, unmapped}`.
Constraints: `UNIQUE (organization_id, code) WHERE code IS NOT NULL`, `UNIQUE (organization_id, normalized_name)`, `UNIQUE (organization_id, id)`, check that `account_type` is consistent with `standard_category` (lookup function).
Indexes: `(organization_id, standard_category)`. RLS: T-data. Writes: `api.confirm_account_mapping`, `api.remap_account` (also appends to `account_category_history`, ADR-034), seeding inside `api.create_organization`. Audit: trigger diff on `standard_category` changes (a re-mapping changes every metric).

### `counterparties`
Purpose: customers and suppliers (ADR-004, ADR-016).
PK `id`. Fields: `organization_id`, `name`, `normalized_name`, `kind {customer, supplier, both, unknown}`, `default_expense_category standard_category_enum NULL` (ADR-027.4: category applied to purchase invoices from this supplier when no line-level mapping exists), `external_ref`, `email`, `notes`, `is_active`, `merged_into_id NULL → counterparties (org-composite)`. `UNIQUE (organization_id, normalized_name)`, `UNIQUE (organization_id, id)`.
Indexes: `(organization_id, kind)`. RLS: T-data. Writes: `api.commit_import_batch` (creation), `api.update_counterparty`, `api.merge_counterparties`. Audit: merge events. Post-MVP CRM extends with `crm_*` tables keyed to this id; do not add pipeline fields here.

### `ledger_entries`
Purpose: transaction-level accounting lines from GL, sales/purchase reports, receipts.
PK `id`. Fields: `organization_id`, `entry_date date`, `period_id → fiscal_periods (org-composite)`, `account_id → accounts (org-composite)`, `direction {debit, credit}`, `amount NUMERIC(18,2) CHECK (amount >= 0)`, `currency`, `description`, `reference`, `counterparty_id NULL (org-composite)`, `journal_ref text` (groups lines of one journal), `source_document_id NULL`, `import_batch_id`, `import_row_id`, `source_ref text` (sheet/row or page/line), `record_status record_status_enum {pending, needs_review, accepted, duplicate, rejected, incomplete}`, `assurance_level assurance_level_enum {verified, calculated, estimated, inferred}`, `dedupe_hash bytea`, `duplicate_reviewed bool NOT NULL DEFAULT false` (ADR-029.6), `is_opening_balance bool NOT NULL DEFAULT false` (ADR-027.3, `IMP-GL-011` journals; excluded from P&L, used as opening balances), `rejected_reason`, `superseded_by NULL → ledger_entries (org-composite)`, `superseded_at timestamptz NULL`. Revision 1.2 (ADR-047.9): `promoted_from_batch_id uuid NULL → import_batches (org-composite)` — set when a row skipped as a duplicate of a rolled-back batch is committed into its own batch by `api.rollback_import_batch`.
Indexes: `(organization_id, period_id, account_id) WHERE record_status='accepted'`, `(organization_id, entry_date)`, `(organization_id, dedupe_hash)`, `(organization_id, counterparty_id)`, `(organization_id, import_batch_id)`.
RLS: T-data. Writes: `api.commit_import_batch`, `api.rollback_import_batch`, `api.supersede_record` only (ADR-026.6); every status/supersession change also appends to `record_status_events`. Trigger `audit_diff` as backstop. Never hard delete.

### `period_balances`
Purpose: summary-level balances from trial balance, P&L and balance-sheet imports (CD-03).
PK `id`. Fields: `organization_id`, `period_start date NOT NULL` (ADR-027.1; `period_id` derived from it by `period_assign`, so multi-period fan-out files produce one row per month), `period_id`, `account_id`, `opening_balance NUMERIC(18,2) NULL`, `debit_total NULL`, `credit_total NULL`, `closing_balance NUMERIC(18,2) NOT NULL` (natural sign `debit − credit`; computed as such when a file supplies debit/credit columns), `currency`, `balance_kind {trial_balance, pnl_report, balance_sheet}`, `balance_basis {cumulative, movement}` (copied from `import_batches.balance_basis`; ADR-027.2), `source_document_id`, `import_batch_id`, `import_row_id`, `source_ref`, `record_status`, `assurance_level`, `duplicate_reviewed bool DEFAULT false`, `superseded_by NULL → period_balances (org-composite)`, `superseded_at timestamptz NULL`. Revision 1.2 (ADR-047.9): `promoted_from_batch_id uuid NULL → import_batches (org-composite)` — set when a row skipped as a duplicate of a rolled-back batch is committed into its own batch by `api.rollback_import_batch`.
Constraints: `UNIQUE (organization_id, period_id, account_id, import_batch_id)`; at most one *accepted, non-superseded* row per `(organization_id, period_id, account_id, balance_kind)` (partial unique index `single_current_balance`, ADR-029.2). Supersession is **batch-scoped**: committing kind K for period P supersedes every accepted row of kind K for P from other batches; rollback restores the whole superseded batch and re-links chains (A→B→C: rolling back B re-points C to A) so the partial index always holds.
Indexes: `(organization_id, period_id, balance_kind) WHERE record_status='accepted' AND superseded_by IS NULL`. RLS: T-data. Writes: `api.commit_import_batch`, `api.rollback_import_batch`, `api.supersede_record`.

### `invoices`
Purpose: sales and purchase invoices and credit notes for receivables/payables, aging and customer revenue (CD-07, CD-28).
PK `id`. Fields: `organization_id`, `invoice_type {sales, purchase, sales_credit_note, purchase_credit_note}`, `counterparty_id (org-composite)`, `invoice_number`, `issue_date`, `due_date NULL`, `period_id` (by issue date), `subtotal`, `tax_amount`, `total_amount`, `amount_paid DEFAULT 0`, `balance_due NUMERIC(18,2) GENERATED ALWAYS AS (total_amount - amount_paid) STORED`, `currency`, `status {open, partially_paid, paid, void}`, `paid_date NULL`, `description`, `source_document_id`, `import_batch_id`, `import_row_id`, `source_ref`, `record_status`, `assurance_level`, `dedupe_hash`, `duplicate_reviewed bool DEFAULT false`, `superseded_by NULL → invoices (org-composite)`, `superseded_at timestamptz NULL`. Revision 1.2 (ADR-047.9): `promoted_from_batch_id uuid NULL → import_batches (org-composite)` — set when a row skipped as a duplicate of a rolled-back batch is committed into its own batch by `api.rollback_import_batch`.
Constraints: `UNIQUE (organization_id, invoice_type, counterparty_id, invoice_number) WHERE record_status='accepted' AND superseded_by IS NULL`. A re-imported invoice with the same key and any changed field (`total_amount, amount_paid, paid_date, due_date, status`) is an *update candidate* (`IMP-INV-010`): commit supersedes the prior row instead of rejecting it as a duplicate (ADR-029.1); receivables at any `asOf` use the current row with the `paid_date`/`amount_paid` time logic (ADR-047.10); `record_status_events` serve evidence as-of resolution only.
Indexes: `(organization_id, invoice_type, status, due_date)`, `(organization_id, counterparty_id, issue_date)`, `(organization_id, period_id)`. RLS: T-data. Writes: `api.commit_import_batch`, `api.rollback_import_batch`, `api.supersede_record`. Invoice lines (`invoice_lines`) are post-MVP (CD-08).

---

## 4. Banking

### `bank_accounts`
PK `id`. Fields: `organization_id`, `name`, `bank_name`, `account_number_masked` (last 4 only for this table), `sort_code_masked`, `currency`, `account_type {current, savings, credit_card, loan, other}`, `ledger_account_id NULL → accounts (org-composite)` (link to the cash account in the chart), `opening_balance NUMERIC(18,2) NULL`, `opening_balance_date date NULL`, `is_active`. `UNIQUE (organization_id, id)`; `UNIQUE (organization_id, bank_name, sort_code_masked, account_number_masked)` (ADR-029.4: inline creation of an account with an existing masked identity is refused and the existing account offered).
RLS: T-data. Writes: `api.create_bank_account`, `api.set_opening_balance`. Audit: opening balance edits (they move every cash figure).

### `bank_transactions`
PK `id`. Fields: `organization_id`, `bank_account_id (org-composite)`, `transaction_date date`, `posted_date NULL`, `period_id`, `amount NUMERIC(18,2)` (signed: positive inflow, negative outflow), `currency`, `description_raw`, `description_normalized`, `counterparty_name_raw`, `counterparty_id NULL`, `category_account_id NULL → accounts` (standard-category account chosen by rules or user), `category_source {rule, user, ai_suggested, none}`, `balance_after NUMERIC(18,2) NULL` (from statement), `reference`, `is_transfer bool DEFAULT false`, `transfer_pair_id NULL → bank_transactions (org-composite)`, `transfer_kind {none, cash_transfer, card_repayment, loan_repayment, loan_drawdown, other_transfer} DEFAULT 'none'` (ADR-028: only `cash_transfer` pairs are excluded from cash metrics), `recurring_group_id NULL → recurring_payment_groups (org-composite)`, `matched_ledger_entry_id NULL → ledger_entries (org-composite)` (post-MVP reconciliation), `source_document_id`, `import_batch_id`, `import_row_id`, `source_ref` (page/line), `record_status`, `assurance_level`, `dedupe_hash`, `duplicate_reviewed bool DEFAULT false`, `superseded_by NULL → bank_transactions (org-composite)`, `superseded_at timestamptz NULL`. Revision 1.2 (ADR-047.9): `promoted_from_batch_id uuid NULL → import_batches (org-composite)` — set when a row skipped as a duplicate of a rolled-back batch is committed into its own batch by `api.rollback_import_batch`.
`description_raw` is stored verbatim (it may contain third-party sort codes and account numbers); `description_normalized` masks 6–8-digit account-number and `nn-nn-nn` sort-code patterns to `****1234` and is the only description field exposed to the client role, to AI tool outputs and to exports (ADR-038.4).
Indexes: `(organization_id, bank_account_id, transaction_date) WHERE record_status='accepted'`, `(organization_id, period_id)`, `(organization_id, dedupe_hash)`, `(organization_id, recurring_group_id)`, `(organization_id, category_account_id)`.
RLS: T-data. Writes: `api.commit_import_batch`, `api.rollback_import_batch`, `api.supersede_record`, `api.override_bank_category` and `api.mark_transfer` (both append to `category_history`), and the banking job (rule categorisation, transfer and recurring detection, also via `category_history`).

Column privileges (ADR-044.2; R2-A-04): `REVOKE SELECT (description_raw, counterparty_name_raw) ON bank_transactions FROM authenticated`. Raw text is readable only through the definer view `bank_transactions_raw` (`security_invoker = false`, body checks `app.has_permission(organization_id, 'imports.review')`), used by import review and the evidence trace; every other reader — client role, AI tools, exports — sees `description_normalized`. The same pattern applies to `counterparties.email` and `counterparties.notes` for the client role (`counterparties_contact` view gated by `customers.edit`).

### `recurring_payment_groups`
Purpose: detected recurring outflows/inflows for anomaly rules (SOW §13, §15).
PK `id`. Fields: `organization_id`, `bank_account_id NULL`, `counterparty_key text` (normalised description signature), `direction {inflow, outflow}`, `cadence {weekly, fortnightly, monthly, quarterly, annual, irregular}`, `expected_amount NUMERIC(18,2)`, `amount_tolerance_ratio NUMERIC(20,6)`, `first_seen date`, `last_seen date`, `occurrence_count int`, `next_expected date NULL`, `status {active, stopped, changed}`, `detector_version text`. `UNIQUE (organization_id, bank_account_id, counterparty_key, direction)`.
RLS: T-data. Writes: banking job only. Audit: none.

---

## 5. Documents & Imports

### `source_documents`
Purpose: every uploaded file (SOW §5, §6, §12).
PK `id`. Fields: `organization_id`, `storage_bucket DEFAULT 'source-documents'`, `storage_path`, `original_filename`, `mime_type`, `byte_size`, `sha256 bytea`, `document_kind {bank_statement, general_ledger, trial_balance, pnl_report, balance_sheet, sales_report, purchase_report, invoice, receipt, other, unknown}`, `page_count NULL`, `has_text_layer bool NULL`, `extracted_text_path NULL` (Storage path of text dump), `status {uploaded, scanning, ready, unreadable, quarantined, deleted}`, `scan_result jsonb`, `uploaded_by`, `deleted_at`.
Constraints: `UNIQUE (organization_id, sha256) WHERE deleted_at IS NULL` (file-level duplicate, CD-12), `UNIQUE (organization_id, id)`.
Indexes: `(organization_id, document_kind, created_at)`. RLS: T-data, but SELECT is an allow-list of `('owner','admin','employee','super_admin')` — never `<> 'client'`, so a `suspended_member` cannot fall through (ADR-044.4; R2-A-07). Writes: `api_server.register_document` (called by the upload route after validation and the Storage write), `api.delete_document` (only if unreferenced; the signer removes the object), the extraction job (`status`, `has_text_layer`, `extracted_text_path`, `page_count`). Storage objects are never readable through Storage policies; see `TENANCY_MODEL.md §8`. Audit: upload, download, `document.sent_to_ai` (ADR-033), delete.

### `import_mappings`
Purpose: saved column mappings per organization for reuse (SOW §6 "mapping").
PK `id`. Fields: `organization_id`, `name`, `import_type import_type_enum {general_ledger, trial_balance, pnl_report, balance_sheet, bank_statement, sales_invoices, purchase_invoices, receipts}`, `header_signature text` (hash of normalised headers), `column_map jsonb` (source column → target field), `transforms jsonb` (date format, decimal separator, sign convention, sheet name), `account_map jsonb` (source account name → `accounts.id`), `created_by`, `last_used_at`. `UNIQUE (organization_id, import_type, header_signature)`.
RLS: SELECT requires `app.has_permission(organization_id, 'imports.review')` (ADR-038.4). Writes: `api.save_import_mapping`, `api.commit_import_batch` (upsert from `mapping_snapshot`).

### `import_batches`
Purpose: one import run of one file into one target table (ADR-012).
PK `id`. Fields: `organization_id`, `source_document_id (org-composite)`, `import_type`, `target_table {ledger_entries, period_balances, bank_transactions, invoices}`, `bank_account_id NULL`, `mapping_id NULL`, `mapping_snapshot jsonb` (frozen copy at commit), `status {created, parsing, mapping, validating, awaiting_review, committing, committed, rolled_back, rejected, failed}`, `row_counts jsonb` `{total, valid, warning, error, duplicate, skipped, committed}`, `period_start date NOT NULL`, `period_end date NOT NULL` (the **declared export range** confirmed at `IMP-RANGE-015`; coverage tests read these, never the last posting date, ADR-047.6), `statement_opening_balance NULL`, `statement_closing_balance NULL`, `balance_sign {natural, reporting}` (ADR-047.3), `fiscal_year_start_month_at_commit smallint` (frozen fiscal year used for cumulative differencing, ADR-047.4), `invoice_list_kind {full, open_items} NULL` (ADR-047.10), `balance_basis {cumulative, movement} NULL` (ADR-027.1; required for `period_balances` targets, confirmed by the reviewer via `IMP-TB-012`), `extraction_method {csv, xlsx, pdf_text, pdf_claude, manual}`, `pages_extracted int NULL`, `pages_failed int[] NULL` (ADR-033 per-page completion), `created_by`, `reviewed_by`, `committed_at`, `rolled_back_at`, `rolled_back_reason`, `replaced_batch_id NULL → import_batches (org-composite)` (ADR-029.3 replace flow), `error_summary jsonb`, `calculation_job_id NULL → jobs` (set at enqueue), `calculation_run_id NULL` (set only by the run that actually included the batch, ADR-031.1).
`period_start`/`period_end` are set at commit to min/max `entry_date`/`issue_date`/`period_start` of committed rows for GL, invoice and fan-out balance batches (ADR-030.2).
Indexes: `(organization_id, status, created_at desc)`, `(organization_id, source_document_id)`. RLS: SELECT requires `imports.review` (ADR-038.4; the batch header exposes statement balances and the mapping). Writes: `api.start_import_batch`, `api.save_import_mapping`, `api.confirm_account_mapping`, `api.commit_import_batch`, `api.reject_import_batch`, `api.rollback_import_batch`, the parse/extract job, and the job-death recovery path (`committing → awaiting_review` with `error_summary.stage = 'commit'`, ADR-031.3). Audit: create, commit, roll back, reject.

### `import_rows`
Purpose: every parsed row, forever (SOW §23 "surfaced rather than silently discarded").
PK `id`. Fields: `organization_id`, `batch_id → import_batches (org-composite)`, `row_number int`, `source_ref text` (sheet!row, or page:line), `raw_data jsonb`, `mapped_data jsonb`, `status {pending, valid, warning, error, duplicate, skipped, committed, rejected}`, `issues jsonb` (array of `{code, severity, field, message, suggestion}`), `dedupe_hash bytea`, `duplicate_of_table NULL`, `duplicate_of_id NULL`, `duplicate_within_batch_row_id NULL`, `reviewer_decision {none, keep, skip, fixed}`, `reviewer_reason`, `committed_table NULL`, `committed_record_id NULL`.
Constraints: `UNIQUE (batch_id, row_number)`. Indexes: `(organization_id, batch_id, status)`, `(organization_id, dedupe_hash)`, `(organization_id, duplicate_of_table, duplicate_of_id)` (ADR-029.3 dependency lookup at rollback). RLS: SELECT requires `imports.review` (ADR-038.4: `raw_data` is the file verbatim, including unmapped columns). Writes: parse/extract job, `api.decide_import_rows`, `api.fix_import_row`, `api.confirm_pdf_page`, `api.commit_import_batch`, `api.reject_import_batch`, `api.rollback_import_batch`. Status `skipped` with issue `IMP-ROW-005` records non-tabular source lines so the row count always equals the count of non-empty source lines (ADR-033). Retention: rows are kept for the life of the organization; `raw_data` is never moved while the batch is `committed` (level-4 highlighting depends on it).

---

## 6. Intelligence

### `calculation_runs`
Purpose: one deterministic execution of the financial engine (ADR-008).
PK `id`. Fields: `organization_id`, `job_id → jobs (org-composite, ADR-044.8)`, `trigger {import_commit, import_rollback, recalc_manual, scheduled, account_remapped, settings_changed, banking_edit, record_superseded, counterparty_merged}`, `trigger_ref_id NULL`, `engine_version text`, `period_from → fiscal_periods`, `period_to`, `as_of date NOT NULL` (ADR-031.2; part of the fingerprint when the run touches the current period), `as_of_ts timestamptz NOT NULL` (the transaction snapshot time of the aggregation step; evidence resolves as-of this instant, not `finished_at` — ADR-046.2; R2-C-10), `status {queued, running, succeeded, failed}`, `failure_reason {error, worker_lost, superseded} NULL`, `stale bool NOT NULL DEFAULT false` (set when a commit, rollback, banking edit, `record_status_events` row or `counterparties.merged_into_id` change lands after `started_at`; the worker loops until clear, ADR-031.1, ADR-046.2), `input_fingerprint bytea` (hash of accepted record ids + `updated_at` in range ∪ account category map ∪ settings ∪ `as_of` where applicable), `started_at`, `finished_at`, `duration_ms`, `error jsonb`, `stats jsonb` (coverage per period, aggregate row counts, timings). Revision 1.2 (ADR-047.7): `status` gains `superseded`; `chunks jsonb` (array of `{cursor, aggregated_at, finished_at}`; the descriptor `as_of` instant per chunk); `progress jsonb {periods_done, periods_total}`; `input_fingerprint` is computed *before* any write from aggregate metadata and a run whose fingerprint equals the last succeeded run's finishes as `succeeded` with `stats.no_change = true` (ADR-047.8).
Indexes: `(organization_id, created_at desc)`, `(organization_id, status) WHERE status = 'running'`. RLS: T-data. Writes: calculation job only. Recovery: a run `running` longer than budget × 3 is marked `failed (worker_lost)` before any new run acquires the org lock (ADR-031.3). Audit: failure events.

### `metric_snapshots`
Purpose: every computed metric value, including breakdowns (ADR-008, ADR-005).
PK `id`. Fields: `organization_id`, `calculation_run_id`, `period_id`, `metric_key text` (from the registry in `FINANCIAL_ENGINE.md §3`), `dimension_type {none, account, standard_category, counterparty, bank_account}`, `dimension_id uuid NULL`, `value NUMERIC(20,6) NULL` (NULL = not computable), `unit {money, ratio, count, days}`, `currency`, `basis {period_balances, ledger, invoices, bank, mixed, none}`, `assurance_level`, `data_quality jsonb` `{completeness: 0..1, warnings: [...], missing: [...]}`, `components jsonb` (named inputs with values **and snapshot ids**, e.g. `{revenue: {value: "120000.00", snapshot_id: "…"}, cost_of_sales: {…}}`; ADR-034), `evidence_query jsonb` (`{kind:'leaf', descriptor}` for metrics computed directly from records — descriptor names `account_ids`/`bank_account_ids` resolved at run time, never `standard_categories` — or `{kind:'derived', components:[{name, snapshot_id}]}` for derived metrics; variance snapshots store `{kind:'derived', components:[{name:'current', snapshot_id}, {name:'comparison', snapshot_id}]}`; ADR-009, ADR-034).
Constraints: `UNIQUE NULLS NOT DISTINCT (calculation_run_id, period_id, metric_key, dimension_type, dimension_id)` (Postgres 15+; `dimension_id` is NULL for `dimension_type = 'none'` and for the synthetic "Unattributed" breakdown row, so NULLs must compare equal). The table is **append-only**; there is no `is_current` column (ADR-031.5). Which snapshot is current is held by `metric_current`.
Indexes: `(organization_id, calculation_run_id)`, `(organization_id, period_id, metric_key)`; partition by hash of `organization_id` (8 partitions) from day one.
RLS: T-data. Writes: calculation job only. Retention: a snapshot referenced by `metric_current`, `evidence_items`, `health_scores.breakdown`, `alerts` or `alert_revisions` is never archived; unreferenced snapshots older than 90 days are compacted by `snapshots.compact` (ADR-031.5).

### `metric_current`
Purpose: pointer table naming the current snapshot per metric cell (ADR-031.5), replacing per-row `is_current` flips. Revision 1.2 (ADR-047.7): `previous_snapshot_id uuid NULL` records the pointer replaced by the current run so a failed run restores the previous pointers for its whole range; daily `scheduled` runs rewrite only the `as_of_dependent` keys of the current period (ADR-047.8).
PK `(organization_id, period_id, metric_key, dimension_type, dimension_id)` with `NULLS NOT DISTINCT`. Fields: `snapshot_id → metric_snapshots (org-composite)`, `calculation_run_id`, `updated_at`.
Semantics: a run deletes every pointer for its period range and inserts pointers for what it wrote, so dimensions that vanish (a remapped category, a merged counterparty) are retired in the same transaction (F-B-16). The dashboard hot path is `metric_current JOIN metric_snapshots`. Indexes: `(organization_id, metric_key, period_id)`. RLS: T-data. Writes: calculation job only.

### `health_scores`
PK `id`. Fields: `organization_id`, `calculation_run_id`, `period_id`, `score smallint 0..100 NULL`, `dimensions_used smallint`, `dimensions_total smallint`, `breakdown jsonb` (array of `{key, score, weight_config, weight_applied, metrics: [{metric_key, value, snapshot_id}], rules: [{rule, result, points}], positives: [...], negatives: [...], data_quality}`), `config_version text`. `UNIQUE (organization_id, period_id, calculation_run_id)`. Append-only; the current row per period is named by `health_current (organization_id, period_id) PK → health_score_id`, rewritten per run exactly like `metric_current` (ADR-031.5). Rule inputs that used to read `alerts` rows (K3, B3) are condition counts recorded in `breakdown[].metrics` with contributing snapshot ids (ADR-035); no health score row is written for a period with `is_complete = false` (ADR-030.4).
Indexes: `(organization_id, period_id)`. RLS: T-data. Writes: calculation job only.

### `alerts`
PK `id`. Fields: `organization_id`, `rule_key text`, `rule_version text`, `severity {critical, high, medium, low, info}`, `metric_key NULL`, `period_id`, `subject_type {none, account, counterparty, bank_transaction, recurring_group, standard_category}`, `subject_id NULL`, `title`, `explanation text`, `threshold_summary jsonb` (the numbers that tripped it), `recommended_next_step text`, `current_revision_id → alert_revisions (org-composite)` (ADR-034; the alert's evidence bundle is `alert_revisions.evidence_bundle_id` of the current revision — there is no second pointer on `alerts`, ADR-046.1; R2-C-09), `status {open, acknowledged, resolved, dismissed}`, `status_changed_by`, `status_changed_at`, `status_reason_code {user, condition_cleared, record_removed, rule_retired, severity_increased} DEFAULT 'user'`, `status_reason text NULL`, `action_id NULL → actions (org-composite)`, `dedupe_key text`, `key_kind {state, event}` (ADR-036: state rules are keyed by `(rule_key, subject)`, event rules by `(rule_key, period_id, subject)`), `calculation_run_id`, `first_seen_at`, `reopened_at timestamptz NULL`, `dismissed_at timestamptz NULL` (ADR-047.2: a `resolved` state alert re-opens with `condition_returned` when its condition returns; a `dismissed` alert re-opens on severity increase or after 90 days), `last_evaluated_at`.
Constraints: `UNIQUE (organization_id, dedupe_key)` (ADR-018). Indexes: `(organization_id, status, severity)`, `(organization_id, period_id)`. RLS: T-data. Writes: alerts job (create/upsert, each re-evaluation that changes severity, explanation, thresholds or evidence appends an `alert_revisions` row and, when severity increases on an `acknowledged` alert, re-opens it with `status_reason_code = 'severity_increased'`); `api.set_alert_status(alert_id, new_status, reason)` permits clients to set `acknowledged` only (`RBAC_MATRIX.md §2.1`, `alerts.manage` ◐) and owner/admin/employee/super admin any transition. Audit: status changes, `alert.reevaluated` (before/after severity).

### `alert_revisions`
Purpose: immutable history of what an alert said at each evaluation (ADR-034; F-C-16).
PK `id`. Fields: `organization_id`, `alert_id (org-composite)`, `revision_no int`, `rule_version`, `severity`, `explanation`, `threshold_summary jsonb`, `evidence_bundle_id (org-composite)`, `calculation_run_id`. `UNIQUE (alert_id, revision_no)`. Append-only. RLS: T-data. Writes: alerts job only. Evidence items pin `(alert_id, revision_no)`.

### `evidence_bundles`
PK `id`. Fields: `organization_id`, `kind {metric, alert, ai_response, health_score, action, report}`, `origin_table`, `origin_id` (guarded by `same_org_ref`), `calculation_run_id NULL` (as-of), `created_by_type {system, ai, user}`, `created_by NULL`. `UNIQUE (organization_id, id)`.
RLS: T-data for SELECT; bundles of kind `ai_response` are readable only by the origin message's owner or an org owner/admin (F-C-11). Append-only (no update/delete for anyone but purge). Writes: jobs (alerts, health, report), `api_server.ai_persist_turn`, `api.create_action` (clone), `api.build_metric_bundle`.

### `evidence_items`
PK `id`. Fields: `organization_id`, `bundle_id (org-composite)`, `sort_order`, `item_type {metric_snapshot, calculation_run, ledger_entry, bank_transaction, invoice, period_balance, counterparty, account, source_document, fiscal_period, alert, query}` (`alert` pins `(alert_id, revision_no)` via `ref_id` + `ref_revision_no int NULL`; ADR-034), `ref_id uuid NULL` (guarded by `same_org_ref`), `query_descriptor jsonb NULL`, `descriptor_hash bytea NULL` (sha256 of the canonical descriptor; AI bundles may carry a `query` item only when the hash matches a descriptor a tool returned in that turn, ADR-032.6), `label text`, `claim text NULL` (the statement this item supports), `assurance_level`.
Constraint: exactly one of `ref_id`, `query_descriptor` non-null. Indexes: `(organization_id, bundle_id, sort_order)`, `(organization_id, item_type, ref_id)`. RLS: same as the bundle. Append-only. Writes: as for `evidence_bundles`.

### `category_history`
Purpose: append-only history of `bank_transactions.category_account_id`, `is_transfer`/`transfer_kind` so descriptors resolve as-of a calculation run (ADR-034; F-C-07).
PK `id`. Fields: `organization_id`, `bank_transaction_id (org-composite)`, `category_account_id NULL (org-composite)`, `is_transfer`, `transfer_kind`, `source {rule, user, ai_suggested, none}`, `valid_from timestamptz`, `valid_to timestamptz NULL`, `changed_by NULL`. Indexes: `(organization_id, bank_transaction_id, valid_from)`. RLS: T-data. Writes: banking job, `api.override_bank_category`, `api.mark_transfer`.

### `account_category_history`
Purpose: append-only history of `accounts.standard_category` (ADR-034).
PK `id`. Fields: `organization_id`, `account_id (org-composite)`, `standard_category`, `valid_from`, `valid_to NULL`, `changed_by`. Indexes: `(organization_id, account_id, valid_from)`. RLS: T-data. Writes: `api.remap_account`, `api.confirm_account_mapping`.

### `record_status_events`
Purpose: append-only lifecycle log for the four financial record tables so evidence resolves as-of a run and rollbacks are reversible (ADR-034; F-C-07).
PK `id bigint identity`. Fields: `organization_id`, `record_table {ledger_entries, bank_transactions, invoices, period_balances}`, `record_id uuid`, `event {accepted, superseded, unsuperseded, rejected, restored}`, `related_record_id uuid NULL` (the superseding/restored row), `import_batch_id NULL`, `actor_user_id NULL`, `at timestamptz`. Indexes: `(organization_id, record_table, record_id, at)`, `(organization_id, import_batch_id)`. RLS: T-data. Writes: `api.commit_import_batch` (`accepted`, `superseded` for invoice update candidates), `api.rollback_import_batch` (`rejected`; `unsuperseded` for rows whose superseding row is rejected; `restored` for every row of a superseded batch that returns to accepted when the superseding batch is rolled back — ADR-046.2), `api.supersede_record` (`superseded`). The resolver honours `unsuperseded` and `restored` identically. Append-only (`append_only_guard`, ADR-046.1).

---

## 7. AI

### `ai_conversations`
PK `id`. Fields: `organization_id`, `user_id`, `title`, `status {active, archived}`, `last_message_at`. `UNIQUE (organization_id, id)`. Indexes: `(organization_id, user_id, last_message_at desc)`. RLS: T-data, but SELECT limited to `user_id = auth.uid()` or role owner/admin (owners may review conversations in their org — stated in Settings; super admin via audit). The chat service loads a conversation only by `(organization_id = ctx.orgId, id, user_id = ctx.userId)` before any model call (ADR-032.8; F-C-11). Writes: `api_server.ai_persist_turn` (creates the conversation on first turn after checking `ai.use` and quota), `api.archive_conversation`.

### `ai_messages`
PK `id`. Fields: `organization_id`, `conversation_id (org-composite)`, `role {user, assistant}`, `content text NULL` (user text only; **NULL for assistant rows** — the validated `structured_response` is the only assistant channel, ADR-032.4), `structured_response jsonb` (validated response contract v2, assistant only), `prompt_version`, `model`, `input_tokens`, `output_tokens`, `latency_ms`, `grounding_status {passed, failed, degraded, not_applicable}`, `grounding_report jsonb`, `evidence_bundle_id NULL`, `period_context jsonb` (resolved periods the answer is about), `flagged bool DEFAULT false`.
Indexes: `(organization_id, conversation_id, created_at)`. RLS: same as conversation. Writes: `api_server.ai_persist_turn` only (user row before the model call, assistant row plus tool calls plus bundle after validation, in one transaction).

### `ai_tool_calls`
PK `id`. Fields: `organization_id`, `message_id (org-composite)`, `sequence smallint`, `tool_name`, `input jsonb`, `authorized bool`, `denial_reason NULL`, `output_hash bytea`, `output_summary jsonb` (counts, metric keys, ids returned; not full payload), `duration_ms`, `error NULL`.
Indexes: `(organization_id, message_id, sequence)`, `(organization_id, tool_name, created_at)`. RLS: select owner/admin/super admin. Writes: `api_server.ai_persist_turn` only (the function requires the message to belong to a conversation owned by `auth.uid()`). Audit: this table *is* the AI audit trail.

### `ai_feedback`
PK `id`. Fields: `organization_id`, `message_id NULL`, `alert_id NULL`, `user_id`, `feedback_type {incorrect, unhelpful, helpful, unsafe}`, `comment`, `status {open, reviewed, actioned, dismissed}`, `reviewed_by`, `reviewed_at`, `resolution_note`.
RLS: select own + owner/admin; platform review via `platform.ai_feedback.review`. `message_id`/`alert_id` guarded by `same_org_ref`. Writes: `api.submit_ai_feedback` (own), `api.review_ai_feedback` (platform). Opening an item in `/platform/ai-feedback` writes `org.data_viewed` (ADR-038.6).

---

## 8. Actions

### `actions`
Purpose: SOW §17 Action Centre fields, verbatim.
PK `id`. Fields: `organization_id`, `title`, `issue text` (problem/opportunity), `recommendation text`, `priority {critical, high, medium, low}`, `owner_user_id NULL → profiles` (member or assigned employee; validated in service), `due_date NULL`, `status {open, in_progress, completed, dismissed}`, `source_type {ai, alert, health_score, user, report}`, `source_id NULL`, `evidence_bundle_id NULL`, `outcome_notes NULL`, `outcome_value NUMERIC(18,2) NULL`, `outcome_currency`, `completed_at`, `dismissed_reason`, `created_by`.
Indexes: `(organization_id, status, priority, due_date)`, `(organization_id, owner_user_id, status)`. `source_id` guarded by `same_org_ref`. RLS: T-data. Writes: `api.create_action` (refuses `source_type = 'ai'` unless the source message has `grounding_status = 'passed'`, ADR-032.5; clones the source bundle), `api.update_action`, `api.assign_action`, `api.set_action_status` (clients only on rows where `owner_user_id = auth.uid()` and only `status`, `outcome_notes`, `outcome_value`). Audit: create, assign, status change.

### `action_comments` — post-MVP (Team Management, CD-26). Not created in MVP.

---

## 9. Audit, Security, Operations

### `audit_events`
PK `id bigint identity`. Fields: `organization_id NULL` (NULL = platform event), `actor_user_id NULL`, `actor_type {user, employee, platform_admin, system, ai}`, `action text` (dotted verb, e.g. `import.committed`, `member.role_changed`, `document.downloaded`, `org.data_viewed`, `ai.answered`), `target_table NULL`, `target_id NULL`, `before jsonb NULL`, `after jsonb NULL`, `metadata jsonb`, `ip inet NULL`, `user_agent text NULL`, `request_id text`, `created_at`.
Indexes: `(organization_id, created_at desc)`, `(actor_user_id, created_at desc)`, `(action, created_at desc)`. RLS: Append — rows are inserted only by the internal `app.audit(action, target_table, target_id, before, after, metadata)`, which derives `actor_user_id` (`auth.uid()`), `actor_type` (`app.actor_type()`), `organization_id` (validated against the accessible set), `ip`, `user_agent` and `request_id` from request settings and is **not exposed** to PostgREST (ADR-026.5; F-A-05); SELECT owner/admin for own org, super admin all; no UPDATE/DELETE for any role; the purge redaction path (`metadata = '{}'`, `ip = NULL`, `user_agent = NULL`, `before/after = NULL` for the organization, ADR-038.9) runs as the table owner inside `org.purge`. `metadata` keys are an allow-list of ids per action (never emails, filenames or free text). Partitioned by month of `created_at` from day one (the partition key must exist before the table grows). `organization_id` and `actor_user_id` are deliberately **not** foreign keys (ADR-048.1): an append-only log must outlive what it describes, and `ON DELETE SET NULL` would both rewrite history and be refused by `append_only_guard`, making an organization undeletable. The ids stay populated after the row they point at is gone, which is what keeps a purged organization's events findable (ADR-038.9).

### `jobs`
PK `id`. Fields: `organization_id NULL`, `job_type {calculation.run, document.extract, import.commit_large, alerts.evaluate, org.purge, report.render, ai.eval, storage.cleanup_orphans, snapshots.compact}`, `idempotency_key text NULL` (unique partial index `WHERE status = 'queued'` — **queued only**, so a job that is already running does not swallow a new request; a colliding enqueue merges `payload.periodFrom = LEAST(...)`, ADR-031.1), `payload jsonb` (never carries an organization id, `asOf`, `trigger` or actor; keys are allow-listed per type — ADR-043.3), `requested_by uuid NULL → profiles` (the human actor at enqueue; jobs act *as* this user through `api_server.*` and re-validate that the user still holds the permission — ADR-043.3; R2-A-05), `status {queued, running, succeeded, failed, dead, cancelled, deferred_upstream}`, `attempts smallint`, `max_attempts smallint DEFAULT 3` (`calculation.run` 5, `document.extract` 8), `run_after timestamptz`, `locked_at`, `locked_by`, `last_error`, `result jsonb`, `finished_at`.
Constraints: `UNIQUE (organization_id, id)` so `report_files.job_id`, `calculation_runs.job_id` and `import_batches.calculation_job_id` are org-composite (ADR-044.8). Indexes: `(status, run_after) WHERE status='queued'`, `(organization_id, job_type, created_at desc)`, `(organization_id, status) WHERE status IN ('queued','running')`. Reclaim rule: a `running` job whose `locked_at < now() − max_runtime(job_type) × 3` is returned to `queued` (`attempts + 1`) by the worker before it claims; `org.purge` waits only for running jobs that are not reclaimable (ADR-044.6; R2-A-10). RLS: Platform (select). Writes: user-callable `api.enqueue_job(org, job_type, payload)` for `calculation.run` (`trigger = recalc_manual`, permission `intelligence.recompute`) and `report.render` (`reports.generate`) only; every other type is enqueued by `api_server.enqueue_job(actor, org, job_type, payload)` from server code or by workers (ADR-043.3); both derive `organization_id` from the argument validated against the actor's accessible set and re-validate it against the payload row for `import.commit_large` (batch), `document.extract` (document), `alerts.evaluate` (run) and `report.render` (period); `api.cancel_job`, `api.requeue_job` / `api.reset_import_batch` (super admin; audited `job.requeued`; `requeue_job` refuses `org.purge` unless `status = 'pending_deletion' AND deletion_requested_at IS NOT NULL`), the `organizations` deletion trigger (`org.purge`, `run_after = now() + 30 days`; cancelled by `api.cancel_deletion`), and workers. Workers skip and requeue with backoff any job of a `suspended` or `pending_deletion` organization except `org.purge`, which waits for zero running jobs of that organization (ADR-038.12). `org.purge` is the only job allowed to hard-delete tenant rows and re-verifies `status = 'pending_deletion' AND deletion_requested_at <= now() − 30 days`.

### `api_rate_limits`
Purpose: database-side throttling of the RPC surface, which is reachable directly on the Supabase host and never passes the Vercel edge (ADR-044.5; R2-A-08).
PK `(actor_user_id uuid, bucket text, window_start timestamptz)`. Fields: `count int`. `app.throttle(actor, bucket, limit, window)` performs `INSERT … ON CONFLICT DO UPDATE SET count = count + 1` and raises `QUOTA` (SQLSTATE 53400) when the count exceeds `limit`; it is the first statement of every `api.*` function (default bucket `rpc` 120/min; named buckets: `create_organization` 3/day and ≤ 5 owned organizations on `trial`, `register_document` 20/h, `invite_member` 20/h, `enqueue_job` 30/h per type, `accept_invitation` 10/h with audit `member.invitation_failed`, `ai_persist_turn` user turns 10/min counted before the organization quota). Rows older than 24 h are deleted by `storage.cleanup_orphans` (shared nightly job). RLS: Platform (select); no user access.

### `role_permissions`
Purpose: read-only mirror of the TypeScript permission matrix (ADR-003), regenerated by `scripts/sync-permission-matrix.ts` into a migration; used by `app.has_permission()`.
PK `(role text, permission text)`. No RLS needed (readable by `authenticated`, writable by nobody at runtime; `REVOKE INSERT/UPDATE/DELETE`). pgTAP parity test in `TEST_STRATEGY.md §2`.

### `platform_settings`
Single-row-per-key config: `key text PK`, `value jsonb`, `updated_by`. Holds default AI quotas, extraction page budgets, alert defaults, model ids, health-score config version pointer. RLS: Platform. Writes: `api.update_platform_settings` (super admin, aal2). Audit: `audit_diff` (ADR-038.11). Keys include `taxable_categories` (default `{revenue, cost_of_sales, operating_expense, marketing}`; the set the bank proxy nets down for VAT, ADR-047.5, CD-33).

### `platform_org_settings`
Purpose: platform-controlled per-organization values that tenants must not edit (ADR-038.5; F-A-09).
PK `organization_id → organizations`. Fields: `ai_quota_daily int NULL`, `ai_token_ceiling_monthly bigint NULL`, `ai_extraction_pages_per_day int NULL`, `model_overrides jsonb`, `notes`, `updated_by`. NULL means "use `platform_settings` default". RLS: Platform (select); the quota resolver reads it through `app.effective_quota(org)` (SECURITY DEFINER, read-only). Writes: `api.update_platform_org_settings` (super admin). Audit: `audit_diff`.

### `report_files`
Purpose: rendered report artefacts (ADR-038.7; F-A-11).
PK `id`. Fields: `organization_id`, `period_id (org-composite)`, `report_kind {monthly_management}`, `job_id → jobs (org-composite)`, `storage_bucket DEFAULT 'reports'`, `storage_path` (`{organization_id}/{period}/{job_id}.pdf`), `sha256`, `byte_size`, `generated_by`, `evidence_bundle_id NULL (org-composite)`, `deleted_at`. `UNIQUE (organization_id, id)`. Indexes: `(organization_id, period_id, created_at desc)`. RLS: T-data with SELECT requiring `reports.view`. Writes: `report.render` job. Downloads only through `/api/reports/[reportId]/download`, which resolves by `(organization_id, id)`, mints a 60-second signed URL and writes `report.downloaded`. Purge deletes the `reports/{organization_id}/` prefix.

---

## 10. Enum summary

| Enum | Values |
|---|---|
| `platform_role_enum` | super_admin, employee |
| `membership_role_enum` | owner, admin, client |
| `standard_category_enum` | revenue, other_income, cost_of_sales, operating_expense, payroll, marketing, interest_expense, tax_expense, depreciation, other_expense, cash, receivables, inventory, other_current_asset, fixed_asset, other_asset, payables, credit_card, loan, tax_liability, other_current_liability, long_term_liability, equity, drawings, transfer, uncategorised |
| `record_status_enum` | pending, needs_review, accepted, duplicate, rejected, incomplete |
| `assurance_level_enum` | verified, calculated, estimated, inferred |
| `import_type_enum` | general_ledger, trial_balance, pnl_report, balance_sheet, bank_statement, sales_invoices, purchase_invoices, sales_report, purchase_report, receipts (`sales_report`/`purchase_report` target `invoices`, SOW §6) |
| `metric_basis_enum` | period_balances, ledger, invoices, bank, mixed, none |
| `severity_enum` | critical, high, medium, low, info |
| `action_status_enum` | open, in_progress, completed, dismissed |
| `balance_basis_enum` | cumulative, movement |
| `transfer_kind_enum` | none, cash_transfer, card_repayment, loan_repayment, loan_drawdown, other_transfer (the single enum used by `bank_transactions`, `category_history` and `FINANCIAL_ENGINE.md §4.2`; ADR-047.12) |
| `job_status_enum` | queued, running, succeeded, failed, dead, cancelled, deferred_upstream |
| `record_status_event_enum` | accepted, superseded, unsuperseded, rejected, restored |
| `alert_key_kind_enum` | state, event |
| `ownership_transfer_status_enum` | pending, accepted, cancelled, expired |
| `access_event_enum` (allow-list for `api_server.record_access_event`) | document.downloaded, report.downloaded, export.created, evidence.viewed, org.data_viewed, document.quarantined, document.sent_to_ai, auth.sign_in, auth.sign_out, auth.failed, member.invitation_failed |
| `effective_role` (text, from `app.org_role()`) | super_admin, employee, owner, admin, client, suspended_member, NULL |

`payroll` and `marketing` are sub-types of operating expense kept as distinct standard categories because the SOW scenarios (§14) and health dimensions (§9) need them; the engine treats them as operating expenses in totals.

---

## 11. Privileges and RLS policy templates (ADR-026)

Writes never happen through table privileges. The only principals that can change rows are the SECURITY DEFINER functions in schema `api` (§14), the internal `app.*` helpers they call, and job workers holding the service role inside `withOrgScope`.

```sql
-- 1. No table writes for end users, ever.
revoke insert, update, delete on all tables in schema public from authenticated, anon;
alter default privileges in schema public revoke insert, update, delete on tables from authenticated, anon;
revoke all on schema app from public, anon, authenticated;          -- app is internal
grant usage on schema api to authenticated;                          -- api is the RPC surface

-- 2. Reads are bounded by RLS on every tenant table.
alter table public.ledger_entries enable row level security;
alter table public.ledger_entries force row level security;
create policy sel on public.ledger_entries for select to authenticated
  using (organization_id in (select app.accessible_org_ids()));

-- Suspension semantic (ADR-044.4; R2-A-07): a suspended organization stays in accessible_org_ids() only for the
-- five "frozen Home" tables (organizations, metric_current, health_current, health_scores, alerts); every other
-- tenant-data policy adds the suspended_member exclusion. Role checks are ALLOW-LISTS, never `<> 'client'`.
create policy sel on public.ledger_entries for select to authenticated
  using (organization_id in (select app.accessible_org_ids())
     and app.org_role(organization_id) in ('owner','admin','employee','super_admin','client'));

-- Narrower SELECT rules where the doc says so, e.g.
create policy sel on public.import_rows for select to authenticated
  using (app.has_permission(organization_id, 'imports.review'));           -- app.has_permission is granted to authenticated (4th helper)
create policy sel on public.source_documents for select to authenticated
  using (organization_id in (select app.accessible_org_ids())
     and app.org_role(organization_id) in ('owner','admin','employee','super_admin'));

-- Column privileges (ADR-044.2): raw bank text is not readable through the table by anyone.
revoke select (description_raw, counterparty_name_raw) on public.bank_transactions from authenticated;
-- readable only via the definer view public.bank_transactions_raw (imports.review) — see §4.

-- 3. Mutations: one function per use case (catalogue in §14). Skeleton:
create function api.set_alert_status(p_alert_id uuid, p_status text, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_role text;
begin
  select organization_id into v_org from public.alerts where id = p_alert_id;
  if v_org is null or not (v_org = any (array(select app.accessible_org_ids()))) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_role := app.org_role(v_org);
  if not app.has_permission(v_org, 'alerts.manage') then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  if v_role = 'client' and p_status <> 'acknowledged' then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  update public.alerts set status = p_status, status_changed_by = auth.uid(), status_changed_at = now(),
         status_reason_code = 'user', status_reason = p_reason where id = p_alert_id;
  perform app.audit('alert.status_changed', 'alerts', p_alert_id, null, jsonb_build_object('status', p_status), '{}'::jsonb);
  return p_alert_id;
end $$;
revoke all on function api.set_alert_status(uuid, text, text) from public;
grant execute on function api.set_alert_status(uuid, text, text) to authenticated;

-- app.has_permission(org uuid, perm text) = exists(select 1 from public.role_permissions
--   where role = app.org_role(org) and permission = perm)  -- evaluated once per call, not per row
```

Rules:
- **Two API schemas (ADR-043).** `api` holds user-intent functions (`GRANT EXECUTE TO authenticated`); `api_server` holds server-asserted functions executable **only by `service_role`** (`REVOKE ALL FROM public, authenticated, anon`) and called from `src/core/db/server-rpc.ts` with the human actor passed explicitly. The browser can express intent only; every fact the server observed (grounding, scan results, tool calls, downloads) is written under a principal the browser cannot obtain (R2-A-01).
- **Ownership and hygiene (ADR-044.3).** Every `api.*`, `api_server.*`, `app.*` and trigger function is `SECURITY DEFINER`, owned by `motion_definer` (`NOLOGIN`, `NOBYPASSRLS`), which owns every `public` table — a function sees rows because its owner owns the tables, not because RLS is bypassed — with `SET search_path = ''`, every reference schema-qualified, `REVOKE ALL FROM public`, explicit `GRANT EXECUTE`. Every statement inside a function filters by the validated `v_org` (pgTAP greps each body for `organization_id = v_org` or a documented exemption). Every function body is wrapped so `unique_violation`/`foreign_key_violation` re-raise as `CONFLICT`/`VALIDATION` with `DETAIL = NULL` and no key values (direct RPC callers bypass `core/errors`). pgTAP asserts owner, `proconfig`, `prosecdef` and grants for each (`TEST_STRATEGY.md §3`).
- **Throttle first (ADR-044.5).** Every `api.*` function begins with `app.throttle(auth.uid(), '<bucket>', limit, window)`.
- **Org lock on record mutations.** `commit_import_batch`, `rollback_import_batch`, `replace_import_batch`, `supersede_record`, `mark_transfer`, `remap_account`, `merge_counterparties` and `accept_ownership_transfer` take `pg_advisory_xact_lock(hashtext('org:' || v_org))` before reading state (R2-A-06.5).
- Functions derive the actor from `auth.uid()`; they take the organization (or a row id from which it is derived) as an argument and validate it against `app.accessible_org_ids()`; a foreign or missing id raises `NOT_FOUND`, never `PERMISSION_DENIED` (no enumeration).
- `app.org_role()` returns `suspended_member` for members of a `suspended` organization and NULL for suspended memberships; `role_permissions` maps `suspended_member` to `dashboard.view` only (ADR-038.2), and every tenant-data policy except the five frozen-Home tables excludes it (ADR-044.4). `app.is_platform_user()` = active `platform_users` row **and** `coalesce(auth.jwt()->>'aal','aal1') = 'aal2'`; both the employee branch of `app.accessible_org_ids()` and the employee case of `app.org_role()` use it, so an employee at `aal1` reads nothing and can execute no data function (ADR-044.1; R2-A-03). `app.is_super_admin()` = `app.is_platform_user()` with role `super_admin`.
- `EffectiveRole` in `core/permissions` includes `suspended_member`; TypeScript never tests `role === 'client'` — it tests `can(ctx, …)` — so the suspended state cannot widen a client's access by falling through a `<> 'client'` branch (R2-A-07).
- The service role bypasses RLS by design, which is why ADR-013 confines it to job workers wrapped in `withOrgScope(job.organization_id)` and to the Storage signer.
- No table has a DELETE path for any role except `org.purge`; no financial record table has an in-place amendment path — corrections are supersessions (`api.supersede_record`).

## 12. Triggers and constraints checklist

| Trigger / constraint | Table | Purpose |
|---|---|---|
| `set_updated_at` | all mutable | timestamps |
| `profiles_from_auth` | `auth.users` → `profiles` | create profile on signup |
| `last_owner_guard` | `organization_memberships` | CD-14 |
| `platform_user_exclusivity` | `organization_memberships`, `platform_users` | RBAC §3.5 |
| `audit_diff` | governance tables, `accounts`, `bank_accounts` (opening balance), `organizations`, `platform_settings`, `platform_org_settings`, and the four financial record tables (backstop) | ADR-015, ADR-026.6, ADR-038.11 |
| `period_assign` | `ledger_entries`, `bank_transactions`, `invoices`, `period_balances` (from `period_start`) | derive `period_id` from date, creating the fiscal period if missing (SECURITY DEFINER) |
| `single_current_balance` | `period_balances` | partial unique index on `(organization_id, period_id, account_id, balance_kind)` (ADR-029.2) |
| `evidence_item_xor` | `evidence_items` | ref_id XOR query_descriptor |
| `same_org_ref` | `evidence_items.ref_id` (via `item_type`), `evidence_bundles.origin_id`, `alerts.subject_id` (skipped for `standard_category`), `actions.source_id`, `calculation_runs.trigger_ref_id`, `ai_feedback.message_id/alert_id`, `import_rows.duplicate_of_id`, `import_rows.committed_record_id` (via `committed_table`), `record_status_events.record_id` and `related_record_id` (via `record_table`), `metric_snapshots.dimension_id` and `metric_current.dimension_id` (via `dimension_type`, skipped for `none`/`standard_category`) | resolves the target table from the discriminator column and asserts `organization_id` equality (ADR-034, ADR-044.8; F-A-13, R2-A-12) |
| `append_only_guard` | `evidence_bundles`, `evidence_items`, `alert_revisions`, `record_status_events`, `category_history`, `account_category_history`, `metric_snapshots`, `health_scores` | `BEFORE UPDATE OR DELETE … RAISE 'IMMUTABLE'` unless `current_setting('app.purge', true) = 'on'`, which only `org.purge` sets; tested as the table owner and as the service role (ADR-046.1; R2-C-09) |
| `record_superseded` / `counterparty_merged` | four record tables / `counterparties` | flag the running `calculation_runs` row `stale` and enqueue `calculation.run` with the matching trigger (ADR-046.2; R2-C-10) |
| `ownership_transfer_pending_unique` | `ownership_transfers` | partial unique `(organization_id) WHERE status = 'pending'` (ADR-044.7) |
| `enqueue_purge_on_deletion` | `organizations` | `status → 'pending_deletion'` inserts `org.purge` with `run_after = now() + 30 days`; `api.cancel_deletion` marks it `cancelled` (ADR-026.4, ADR-038.12) |
| `bank_identity_unique` | `bank_accounts` | unique masked identity per organization (ADR-029.4) |
| `invitation_pending_unique` | `invitations` | partial unique `(organization_id, email) WHERE status='pending'` |
| `mask_description` | `bank_transactions` | derives `description_normalized` with account-number/sort-code masking (ADR-038.4) |
| `superseded_at_set` | four financial record tables | sets `superseded_at = now()` whenever `superseded_by` becomes non-null and **permits the reset to NULL** performed by `api.rollback_import_batch` when a row is restored (ADR-047.1); the column is the current state, `record_status_events` the history, so evidence `as_of` resolution (`EVIDENCE_MODEL.md §3`) can select the rows that were current at a calculation run's `finished_at` |
| `alert_dedupe` | `alerts` | unique dedupe_key |
| Composite FKs | every plain tenant→tenant FK (all marked `(org-composite)` above, including `superseded_by`, `transfer_pair_id`, `merged_into_id`, `category_account_id`, `ledger_account_id`, `source_document_id`, `import_batch_id`, `import_row_id`, `matched_ledger_entry_id`, `evidence_bundle_id`, `action_id`, `current_revision_id`) | cross-org reference impossible for non-polymorphic references; polymorphic ones are covered by `same_org_ref`; references to `jobs` (`report_files.job_id`, `calculation_runs.job_id`, `import_batches.calculation_job_id`) are composite through `jobs (organization_id, id)`. pgTAP enumerates every FK column on tenant tables and fails on any non-composite one; `jobs` and `audit_events` are the only tables exempt from the enumeration, by name (ADR-044.8) |

## 13. What is deliberately absent

- No `entities`, `business_units` (ADR-001). No `organization_groups`, `organization_group_members` (CD-29), `support_access_grants` (CD-13), `invoice_lines`, `products`, `crm_*`, `campaigns`, `forecasts`, `scenarios`, `budgets` tables in MVP (`report_files` exists for rendered PDFs; there is no report *definition* table); each arrives with its phase and attaches by `organization_id` and, where relevant, `counterparty_id`/`period_id`.
- No editable `permissions` or `roles` tables: the matrix is code, and `role_permissions` is a generated, read-only mirror (ADR-003). If per-organization custom roles are ever sold, add `organization_roles` then.
- No per-metric row-link table: evidence uses descriptors (ADR-009).
- No `users` table of our own: `profiles` mirrors Supabase Auth.
- No `is_current` flags: currency of snapshots and health scores is held by the `metric_current`/`health_current` pointer tables (ADR-031.5).
- No `storage.objects` policies for `authenticated`/`anon`; the signer is the only reader (ADR-038.1).

---

## 14. API function catalogue (schemas `api` and `api_server`)

### 14.1 Schema `api` — user-intent functions

Common contract (ADR-026, ADR-043, ADR-044.3): `SECURITY DEFINER`, owned by `motion_definer`, `SET search_path = ''`, schema-qualified references, `REVOKE ALL FROM public`, `GRANT EXECUTE TO authenticated`; first statement `app.throttle(auth.uid(), bucket, limit, window)`; the actor is `auth.uid()` (never a parameter); the organization is an argument or is derived from a row id and validated against `app.accessible_org_ids()`; the role is `app.org_role(org)`; permissions are checked with `app.has_permission(org, '<permission>')`; invariants are enforced in SQL; every function writes its audit event(s) through `app.audit()` in the same transaction; results are ids; constraint violations are re-raised without detail; failures raise typed errors (`NOT_FOUND` P0002, `PERMISSION_DENIED` 42501, `VALIDATION` 22023, `CONFLICT` 23505/40001, `QUOTA` 53400) that `core/errors` maps 1:1. Every argument is something the user legitimately chooses (an id in their organization, a role, a reason, a decision); no `api.*` function accepts a fact the server observed. Platform functions additionally require `app.is_super_admin()` (`aal2`) and, where marked *re-auth*, that the latest `auth.jwt()->'amr'` entry with method `totp` or `password` has a timestamp within 600 s (Supabase tokens carry `amr`, not `auth_time`). TypeScript services call these through `rpc()` on the user-session client; job workers never call `api.*`. Each function has a pgTAP test invoked as every fixture role (`TEST_STRATEGY.md §3`).

| Function | Permission checked | Invariants enforced | Audit action(s) | Tables written | Called from |
|---|---|---|---|---|---|
| `create_organization(name, country, currency, fy_start, timezone)` | any signed-in user without a platform role (self-serve) or `platform.orgs.manage` | platform-user exclusivity; slug uniqueness; seeds standard accounts and 12 forward periods; creator becomes owner (self-serve) | `org.created` | organizations, organization_memberships, accounts, fiscal_periods | onboarding, `/platform` |
| `update_organization(org, patch)` | `settings.manage` (tenant columns) / `platform.orgs.manage` (plan, features, kind, status) | tenant patch limited to name, legal_name, fiscal_year_start_month (refused while any `cumulative` balance batch exists unless every affected batch is re-confirmed, ADR-047.4), timezone, industry, settings (quota keys rejected); platform patch limited to plan, features, kind, industry and `status` between `active` and `suspended` only; `pending_deletion`/`deleted`/`deletion_requested_at`/`slug`/`created_by` refused (ADR-044.6); fiscal-year change enqueues `calculation.run` | `org.updated` | organizations, jobs | settings, `/platform` |
| `request_deletion(org)` / `cancel_deletion(org)` | `org.delete` | status transitions active→pending_deletion→active; sets/clears `deletion_requested_at`; cancel marks the purge job `cancelled` | `org.deletion_requested`, `org.deletion_cancelled` | organizations, jobs | settings/danger |
| `invite_member(org, email, role)` | `users.invite` + ceiling (`role IN ('admin','client')` unless owner/super admin) | no pending invitation for the email; email not an existing member; email not a platform user; token hashed | `member.invited` | invitations | settings/team |
| `revoke_invitation(invitation)` | `users.invite` | pending only | `member.invitation_revoked` | invitations | settings/team |
| `accept_invitation(token)` | signed-in | token valid, unexpired, unused; `invitations.email = auth.jwt()->>'email'` and email confirmed; inviter still active owner/admin with ceiling ≥ role; platform-user exclusivity; creates membership | `member.joined`, `member.invitation_accepted` | invitations, organization_memberships | `/invite/[token]` |
| `change_member_role(org, user, role)` | `users.manage` + ceiling on current **and** target role; admins never touch owner rows or their own row upward | last-owner guard; no self-elevation; owner promotion only by owner/super admin | `member.role_changed` | organization_memberships | settings/team |
| `remove_member(org, user)` / `leave_organization(org)` | `users.manage` (or self) | last-owner guard; admin may remove admin/client only (session revocation is done by `tenancy.removeMember` in application code after the RPC returns — SQL cannot call the Auth admin API) | `member.removed` | organization_memberships | settings/team, account |
| `set_member_status(org, user, status)` | `users.manage` + ceiling | admins cannot suspend owners; last-owner guard | `member.status_changed` | organization_memberships | settings/team |
| `initiate_ownership_transfer(org, nominee, demote_initiator)` / `accept_ownership_transfer(transfer)` / `cancel_ownership_transfer(transfer)` | owner (initiate, cancel) / nominee (accept) | initiate: nominee is an active admin, no pending transfer for the org, `expires_at = now() + 7 days`; accept: `auth.uid() = nominee_user_id`, status `pending` and unexpired, nominee **currently** an active admin, initiator **currently** an active owner, under the org advisory lock; initiator demoted only if `demote_initiator`; cancel by initiator or any owner (ADR-044.7) | `ownership.transfer_initiated`, `ownership.transferred`, `ownership.transfer_cancelled` | ownership_transfers, organization_memberships | settings/danger |
| `create_assignment(org, employee, ends_at)` *re-auth* | `assignments.manage` (super admin) | employee has active `platform_users.employee`; unique per org | `assignment.created` (org + platform) | organization_assignments | `/platform/assignments` |
| `revoke_assignment(assignment, reason)` | `assignments.manage` or owner of that org | status → revoked only; archives the employee's conversations in that org | `assignment.revoked` (org + platform) | organization_assignments, ai_conversations | settings/team, `/platform` |
| `grant_platform_role(user, role)` / `revoke_platform_role(user)` *re-auth* | `platform.users.manage` | exclusivity with memberships; revoke invalidates sessions | `platform.role_granted/revoked` | platform_users | `/platform/users` |
| `disable_user(user)` / `enable_user(user)` *re-auth* | `platform.users.manage` | refuses to disable the sole owner of any organization unless another owner exists | `user.disabled/enabled` | profiles | `/platform/users` |
| `update_profile(patch)` | self | columns limited to full_name, avatar_url, timezone, onboarding_state, last_active_org_id (must be accessible) | `profile.updated` | profiles | account |
| `delete_document(document)` | `imports.review` | no referencing batches; document not `quarantined` pending investigation; sets `status = 'deleted'`, `deleted_at` and returns the storage path — the signer then deletes the object; `storage.cleanup_orphans` also removes objects whose row is `deleted` (ADR-043.4; R2-A-09) | `document.deleted` | source_documents | data/documents |
| `start_import_batch(document, import_type, opts)` | `imports.create` | document `ready`; one active batch per document; bank type requires bank_account; enqueues parse for > 5,000 rows | `import.started` | import_batches, jobs | wizard |
| `save_import_mapping(batch, mapping)` / `confirm_account_mapping(batch, account_map)` | `imports.review` | batch in `mapping`/`awaiting_review`; balance_basis required for balance targets (`IMP-TB-012`); creates `accounts` rows with `mapping_confidence`; appends `account_category_history` | `import.mapped` | import_batches, import_mappings, accounts, account_category_history | wizard |
| `decide_import_rows(batch, decisions[])` / `fix_import_row(batch, row, patch)` / `confirm_pdf_page(batch, page)` | `imports.review` | reason mandatory for keep-on-duplicate and skip-on-valid; re-validates fixed rows; optimistic concurrency on `updated_at` | `import.row_decided` | import_rows, import_batches | review |
| `commit_import_batch(batch)` | `imports.review` | org advisory lock; batch `awaiting_review`; zero unresolved errors; batch-level checks re-run in SQL; pdf_claude page confirmations complete; cross-batch dedupe re-run (new collisions → back to `awaiting_review`); inserts records with `record_status`/`assurance_level`; batch-scoped supersession for `period_balances`; invoice update candidates supersede; `duplicate_reviewed` set from decisions; writes `record_status_events`; sets `period_start/period_end`; enqueues `calculation.run` and records `calculation_job_id`; > 5,000 rows via `import.commit_large` job under the same function | `import.committed` | ledger_entries / period_balances / bank_transactions / invoices, counterparties, import_rows, import_batches, import_mappings, record_status_events, jobs | review, `import.commit_large` job |
| `reject_import_batch(batch, reason)` | `imports.review` | pre-commit only | `import.rejected` | import_batches, import_rows | review |
| `rollback_import_batch(batch, reason, mode)` | `imports.review` | org advisory lock; **promotes dependants** (ADR-047.9): every `skip`-decided `import_rows` row of another committed batch whose `duplicate_of_id` targets this batch is committed from its `mapped_data` as a record of that batch with `promoted_from_batch_id`; refuses only when such a row lacks `mapped_data` or its batch is rolled back; rejects this batch's records with `record_status_events (rejected)`; re-links supersession chains **in the column** and resets `superseded_by`/`superseded_at` to NULL on restored rows, writing `restored` events (ADR-047.1); `mode = 'replace'` (via `replace_import_batch`) then re-runs dedupe for the new batch against rejected and promoted rows and commits it in the same transaction; enqueues `calculation.run` | `import.rolled_back` (with promoted count), `import.replaced` | record tables, import_rows, import_batches, record_status_events, jobs | history / coverage strip |
| `replace_import_batch(old_batch, new_batch)` | `imports.review` | Named wrapper for `rollback_import_batch(old, reason, 'replace')`: old batch committed, new batch awaiting_review, same period/type; single transaction (ADR-029.3) | `import.rolled_back`, `import.committed`, `import.replaced` | as rollback_import_batch | coverage strip / review screen |
| `set_opening_balance_flag(entry, flag)` | `financials.edit` | entry in org; toggles the `IMP-GL-011` opening-balance flag on a ledger journal (all lines of the `journal_ref`); enqueues `calculation.run` (ADR-047.4) | `ledger.opening_flag_changed` | ledger_entries | chart / GL review |
| `set_statement_balances(batch, opening, closing)` | `imports.review` | batch in mapping/awaiting_review; values marked reviewer-entered; re-runs IMP-BAL-006 (ADR-033) | `import.mapped` | import_batches | review screen |
| `set_last_active_org(org)` | any non-`none` role for org | org in accessible set | — | profiles | org switcher |
| `create_action_from_alert(alert, input)` | `actions.create` | alert in org; clones the alert's current revision bundle; links `alerts.action_id` | `action.created`, `alert.converted_to_action` | actions, evidence_bundles, evidence_items, alerts | alert card |
| `create_action_from_recommendation(message, index)` | `actions.create` | message in org and visible to caller; `grounding_status = passed` else raises (ADR-032.5); clones bundle | `action.created` | actions, evidence_bundles, evidence_items | AI answer |
| `update_own_action(action, patch)` | `actions.update_own` | `owner_user_id = auth.uid()`; only status, outcome_notes, outcome_value | `action.status_changed` | actions | client action detail |
| `supersede_record(table, record, replacement)` | `financials.edit` | never updates in place; writes replacement + `superseded_by/at` + `record_status_events`; ledger corrections may add a reversing entry; enqueues `calculation.run` | `record.superseded` | record table, record_status_events, jobs | money pages |
| `create_bank_account(org, input)` / `set_opening_balance(account, amount, date)` | `financials.edit` | masked identity unique; opening balance change enqueues `calculation.run` | `bank_account.created`, `bank_account.opening_balance_set` | bank_accounts, jobs | banking, wizard |
| `override_bank_category(txn, account)` / `mark_transfer(txn, pair)` | `banking.reconcile` | `category_source = 'user'`; transfer_kind derived from account types (ADR-028); appends `category_history`; enqueues `calculation.run` (`banking_edit`) | `bank_txn.recategorised`, `bank_txn.transfer_marked` | bank_transactions, category_history, jobs | banking |
| `remap_account(account, category)` | `financials.edit` | account_type consistency; appends `account_category_history`; enqueues `calculation.run` (`account_remapped`, coalesced 5 min) | `account.remapped` | accounts, account_category_history, jobs | data/accounts |
| `update_counterparty(cp, patch)` / `merge_counterparties(from, into)` | `customers.edit` | kind/default_expense_category; merge sets `merged_into_id` and enqueues `calculation.run` | `counterparty.updated/merged` | counterparties, jobs | customers |
| `set_alert_status(alert, status, reason)` | `alerts.manage` (client: acknowledged only) | valid transition; dismissed alerts record cooldown | `alert.status_changed` | alerts | insights |
| `create_action(org, input, source?)` | `actions.create` | source `ai` requires `grounding_status = 'passed'`; owner must be member/assigned employee; clones source bundle | `action.created` | actions, evidence_bundles, evidence_items | actions, analyst, alerts |
| `update_action(action, patch)` / `assign_action(action, owner)` / `set_action_status(action, status, outcome)` | `actions.create` / `actions.assign` / `actions.update_own` (client: own rows, status+outcome only) | assignee validity; completed sets `completed_at` | `action.updated/assigned/status_changed` | actions | actions |
| `create_conversation(org)` | `ai.use` + throttle | conversation owned by `(org, auth.uid())`; user-message persistence and everything the server observed go through `api_server.ai_persist_turn` (§14.2) | — | ai_conversations | analyst |
| `archive_conversation(conversation)` | `ai.use` (own) or `users.manage` | — | — | ai_conversations | analyst |
| `submit_ai_feedback(message?, alert?, type, comment)` / `review_ai_feedback(feedback, status, note)` | `ai.use` (own org) / `platform.ai_feedback.review` | `same_org_ref`; review sets `ai_messages.flagged` | `ai.feedback_submitted/reviewed` | ai_feedback, ai_messages | analyst, `/platform/ai-feedback` |
| `enqueue_job(org, job_type, payload)` | `calculation.run` (forced `trigger = recalc_manual`) → `intelligence.recompute`; `report.render` → `reports.generate`; every other type → refused (`PERMISSION_DENIED`) | `org` validated against the accessible set; payload keys allow-listed per type (`periodFrom`, `periodTo` / `periodId`); `asOf`, `trigger`, `requested_by` derived (`requested_by = auth.uid()`); idempotency merge on queued jobs; throttle 30/h per type (ADR-043.3; R2-A-05) | `job.enqueued` | jobs | services |
| `cancel_job(job)` / `requeue_job(job)` / `reset_import_batch(batch)` | `intelligence.recompute` (own org, queued only) / `platform.jobs.view` (super admin) | reset only for `committing` batches whose job is dead/failed; `requeue_job` refuses `org.purge` unless `status = 'pending_deletion' AND deletion_requested_at IS NOT NULL` (ADR-044.6) | `job.cancelled`, `job.requeued`, `import.reset` | jobs, import_batches | settings/data, `/platform/jobs` |
| `update_platform_settings(key, value)` / `update_platform_org_settings(org, patch)` *re-auth* | `system.manage` / `platform.orgs.manage` | model id change bumps `prompt_version` pointer | `platform.settings_changed`, `platform.org_settings_changed` | platform_settings, platform_org_settings | `/platform/settings`, `/platform/organizations/[orgId]` |
| `build_metric_bundle(snapshot)` | `financials.view` | cached per snapshot; items from `evidence_query` only | — | evidence_bundles, evidence_items | evidence drawer |

### 14.2 Schema `api_server` — server-asserted functions (ADR-043; R2-A-01, R2-A-02, R2-A-05, R2-A-09)

Contract: identical hygiene to §14.1, but `REVOKE ALL FROM public, authenticated, anon` and `GRANT EXECUTE TO service_role` only. Called from `src/core/db/server-rpc.ts` (the third and last sanctioned request-path use of the service role, with the Storage signer and job workers; lint-confined to that file) and from job workers. Every function takes `actor_user_id` and `request_id` explicitly; it re-validates the actor with the actor-parameterised helpers `app.org_role_of(actor, org)` and `app.has_permission_of(actor, org, perm)`, and re-validates the actor's `aal` from `auth.mfa_amr_claims`/`auth.sessions` where MFA is required (platform users). `app.audit()` accepts an explicit actor only when `auth.role() = 'service_role'` and `current_setting('app.current_org', true)` equals the row's organization; `request_id` is taken from the argument, never from headers.

| Function | Actor requirement re-validated | Invariants enforced | Audit action(s) | Tables written | Called from |
|---|---|---|---|---|---|
| `finalize_upload(actor, org, document_id, storage_path, sha256, byte_size, mime, scan_result, status)` / `register_document(actor, org, meta)` | `imports.create` | `register_document` **generates** `id` and `storage_path` (`{org}/{id}/{sanitised filename}`), refuses any caller path, `UNIQUE (storage_bucket, storage_path)`, sha256 uniqueness (file duplicate → CONFLICT with the prior document id); `finalize_upload` verifies the object exists in `storage.objects` with the declared size before setting `status` (`ready`/`quarantined`/`unreadable`); upload order is signer-write → register → finalize, and on failure the signer deletes that key only (ADR-043.4) | `document.uploaded`, `document.quarantined` | source_documents | `/api/imports/upload` |
| `ai_persist_turn(actor, org, conversation, user_message?, assistant_payload?, tool_calls[], bundle?)` | `ai.use` + quota (`app.effective_quota`) + user-turn throttle 10/min | conversation belongs to `(org, actor)`; assistant rows have NULL `content`; `grounding_status`, `grounding_report`, token counts and model are server facts; tool calls belong to the message; bundle item ids ⊆ tool-returned ids/hashes carried in `tool_calls[]` of the same call; a user JWT cannot reach this function, so a fabricated "passed" answer is impossible (R2-A-01) | `ai.answered` / `ai.refused` / `ai.context_changed` | ai_conversations, ai_messages, ai_tool_calls, evidence_bundles, evidence_items | `/api/ai/chat` |
| `record_access_event(actor, org, action access_event_enum, target_table, target_id, metadata)` | per action: `document.downloaded` → `documents.view` and document in org; `report.downloaded` → `reports.view` and report in org; `export.created` → `data.export`; `evidence.viewed` → `financials.view`; `org.data_viewed` → `app.is_super_admin()` for the actor; `document.quarantined`/`document.sent_to_ai` → system; `auth.*`/`member.invitation_failed` → system | `action` restricted to the allow-list enum; `metadata` keys allow-listed per action (ids only); returns the `audit_events.id`, which the Storage signer verifies (row exists, same actor, same target, `created_at > now() − 30 s`) before minting (ADR-043.5) | the named action | audit_events | signer callers, layouts (super-admin views), export route, auth callbacks |
| `enqueue_job(actor, org, job_type, payload)` | type → permission of the actor: `document.extract`, `import.commit_large` → `imports.review`; `alerts.evaluate` → system (worker only); `calculation.run` with any trigger → system or `intelligence.recompute`; `report.render` → `reports.generate`; `org.purge` → refused (trigger only); `ai.eval`, `storage.cleanup_orphans`, `snapshots.compact` → system | `org` re-validated against the payload row (`batch_id` → `import_batches.organization_id`, `document_id`, `run_id`, `period_id`); payload keys allow-listed per type; `requested_by = actor`; idempotency merge on queued jobs (ADR-043.3) | `job.enqueued` | jobs | services via server-rpc, workers |
| `commit_batch_as(actor, batch)` | actor still holds `imports.review` in the batch's organization | runs `api.commit_import_batch` logic with the stored actor (`jobs.requested_by`) under the org lock; audited as that actor with `metadata.via_job` | `import.committed` | as `commit_import_batch` | `import.commit_large` worker |
| `set_conversation_archived(actor, conversation)` | system (assignment revocation) | archives an employee's conversations in a revoked organization | — | ai_conversations | `api.revoke_assignment` path via worker |

Internal `app.*` helpers (schema not exposed; `REVOKE ALL FROM public, anon, authenticated` except EXECUTE on the four read helpers referenced by RLS policies): `app.accessible_org_ids()`, `app.org_role(org)`, `app.is_super_admin()`, `app.has_permission(org, perm)` (the four RLS helpers, EXECUTE granted to `authenticated`), `app.is_platform_user()` (active `platform_users` row AND `aal2`), `app.org_role_of(actor, org)` / `app.has_permission_of(actor, org, perm)` (actor-parameterised variants for `api_server`), `app.throttle(actor, bucket, limit, window)`, `app.actor_type()`, `app.effective_quota(org)`, `app.audit(...)`, `app.aggregate_periods(org, from, to, as_of_ts)` (ADR-031.4; returns per-period × category × account × counterparty × bank-account sums over records accepted and non-superseded as of `as_of_ts` for the calculation job), `app.record_status_event(...)`, `app.supersede_rows(...)`, `app.commit_rows(...)`, `app.rerun_dedupe(batch)`, `app.reclaim_stale_jobs()`.
