-- MOTION — Phase 2 (plan Phase 4) · Fiscal periods, chart of accounts, counterparties and the three
-- financial record tables.
-- Contract: DATABASE_ARCHITECTURE.md §2 (fiscal_periods), §3 (Financials), §12 (triggers/constraints).
--
-- Two conventions run through every table in this file and the next three.
--
-- 1. COMPOSITE FOREIGN KEYS (ADR-044.8). A tenant→tenant reference is never a plain `references
--    other (id)`. It carries `organization_id` into the key, so Postgres itself refuses a row that
--    points at another organization's data. That is why every table declares
--    `unique (organization_id, id)` even though `id` is already the primary key: it is the target of
--    somebody else's composite key. Polymorphic references (a discriminator column plus an id) cannot
--    be expressed this way and are guarded by the `same_org_ref` trigger instead.
--
-- 2. SUPERSESSION, NEVER MUTATION. The four financial record tables have no in-place amendment path.
--    A correction inserts a replacement and points the old row at it through `superseded_by`
--    (ADR-026.6). `superseded_by`/`superseded_at` are the *current state*; `record_status_events` is
--    the *history*, which is what lets evidence reconstruct any past instant (ADR-047.1).

-- ---------------------------------------------------------------------------------------------
-- Fiscal periods (ADR-007)
-- ---------------------------------------------------------------------------------------------
-- Materialised calendar months. They exist as rows rather than being derived on the fly because
-- every financial record, metric snapshot, health score and alert keys to one, and a foreign key to
-- a real row is what stops a metric being attributed to a month that does not belong to the
-- organization's fiscal calendar.
create table public.fiscal_periods (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  period_start     date not null,
  period_end       date not null,
  fiscal_year      smallint not null,
  fiscal_quarter   smallint not null constraint fiscal_periods_quarter check (fiscal_quarter between 1 and 4),
  label            text not null,                        -- "Mar 2026"
  -- ADR-030.1: maintained by the calculation run, never by an import. True when period_end is within
  -- the declared export range of the chosen P&L source AND cash coverage is full (ADR-047.6).
  -- Health scores are not written for an incomplete period (ADR-030.4).
  is_complete      boolean not null default false,
  is_locked        boolean not null default false,        -- post-MVP close
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint fiscal_periods_month check (period_start = date_trunc('month', period_start)::date
                                     and period_end = (date_trunc('month', period_start) + interval '1 month - 1 day')::date),
  constraint fiscal_periods_org_start_unique unique (organization_id, period_start),
  constraint fiscal_periods_org_id_unique unique (organization_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- The category → account-type pairing, stated once (ADR-004)
-- ---------------------------------------------------------------------------------------------
-- DATABASE_ARCHITECTURE.md §3 requires "check that account_type is consistent with standard_category
-- (lookup function)". Writing the pairing as a function rather than a 26-branch CHECK expression
-- means `api.remap_account` and the seeding routine consult exactly the same table of truth as the
-- constraint, so a remap cannot produce a row the constraint would have refused on insert.
-- IMMUTABLE because a CHECK constraint may only call immutable functions, and because the pairing is
-- a fact about the accounting model, not about data.
create function public.standard_category_account_type(p_category public.standard_category_enum)
returns public.account_type_enum
language sql immutable strict parallel safe set search_path = '' as $$
  select case p_category
    when 'revenue'                  then 'income'
    when 'other_income'             then 'income'
    when 'cost_of_sales'            then 'expense'
    when 'operating_expense'        then 'expense'
    when 'payroll'                  then 'expense'
    when 'marketing'                then 'expense'
    when 'interest_expense'         then 'expense'
    when 'tax_expense'              then 'expense'
    when 'depreciation'             then 'expense'
    when 'other_expense'            then 'expense'
    when 'cash'                     then 'asset'
    when 'receivables'              then 'asset'
    when 'inventory'                then 'asset'
    when 'other_current_asset'      then 'asset'
    when 'fixed_asset'              then 'asset'
    when 'other_asset'              then 'asset'
    when 'payables'                 then 'liability'
    when 'credit_card'              then 'liability'
    when 'loan'                     then 'liability'
    when 'tax_liability'            then 'liability'
    when 'other_current_liability'  then 'liability'
    when 'long_term_liability'      then 'liability'
    when 'equity'                   then 'equity'
    when 'drawings'                 then 'equity'
    -- `transfer` and `uncategorised` are holding categories, not statement lines. They are assets so
    -- that a bank-side transfer or an unmapped cash movement never lands in income or expense and
    -- silently moves a profit figure; the engine excludes both from P&L explicitly.
    when 'transfer'                 then 'asset'
    when 'uncategorised'            then 'asset'
  end::public.account_type_enum;
$$;

-- ---------------------------------------------------------------------------------------------
-- Chart of accounts (ADR-004, CD-04)
-- ---------------------------------------------------------------------------------------------
create table public.accounts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  code                text,
  name                text not null constraint accounts_name_len check (length(name) between 1 and 200),
  -- Lower-cased, punctuation- and whitespace-collapsed name. It is the uniqueness key rather than
  -- `name` because imports arrive with "Bank  Charges", "bank charges" and "Bank Charges." meaning
  -- one account, and creating three would split every metric.
  normalized_name     text not null,
  account_type        public.account_type_enum not null,
  standard_category   public.standard_category_enum not null default 'uncategorised',
  is_system           boolean not null default false,     -- part of the seeded standard chart
  is_active           boolean not null default true,
  source              public.account_source_enum not null default 'imported',
  external_ref        text,
  mapping_confidence  public.mapping_confidence_enum not null default 'unmapped',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- An account's type and its standard category must agree: `revenue` is not a liability. The check
  -- calls a lookup function so the pairing is stated once and reused by api.remap_account.
  constraint accounts_type_matches_category
    check (public.standard_category_account_type(standard_category) = account_type),
  constraint accounts_org_normalized_unique unique (organization_id, normalized_name),
  constraint accounts_org_id_unique unique (organization_id, id)
);

create unique index accounts_org_code_unique
  on public.accounts (organization_id, code) where code is not null;
create index accounts_org_category on public.accounts (organization_id, standard_category);

-- ADR-034: append-only history of accounts.standard_category, so a descriptor resolved as-of an old
-- calculation run sees the category that was in force then, not the category after a later remap.
create table public.account_category_history (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  account_id         uuid not null,
  standard_category  public.standard_category_enum not null,
  valid_from         timestamptz not null default now(),
  valid_to           timestamptz,
  changed_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint account_category_history_account_fk
    foreign key (organization_id, account_id) references public.accounts (organization_id, id) on delete cascade
);

create index account_category_history_lookup
  on public.account_category_history (organization_id, account_id, valid_from desc);

-- ---------------------------------------------------------------------------------------------
-- Counterparties (ADR-004, ADR-016)
-- ---------------------------------------------------------------------------------------------
create table public.counterparties (
  id                         uuid primary key default gen_random_uuid(),
  organization_id            uuid not null references public.organizations (id) on delete cascade,
  name                       text not null constraint counterparties_name_len check (length(name) between 1 and 300),
  normalized_name            text not null,
  kind                       public.counterparty_kind_enum not null default 'unknown',
  -- ADR-027.4: the category applied to purchase invoices from this supplier when the file carries no
  -- line-level account mapping. Without it every supplier invoice would land in `uncategorised`.
  default_expense_category   public.standard_category_enum,
  external_ref               text,
  email                      extensions.citext,
  notes                      text,
  is_active                  boolean not null default true,
  merged_into_id             uuid,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint counterparties_org_normalized_unique unique (organization_id, normalized_name),
  constraint counterparties_org_id_unique unique (organization_id, id),
  constraint counterparties_merged_into_fk
    foreign key (organization_id, merged_into_id) references public.counterparties (organization_id, id),
  constraint counterparties_no_self_merge check (merged_into_id is null or merged_into_id <> id)
);

create index counterparties_org_kind on public.counterparties (organization_id, kind);

-- ---------------------------------------------------------------------------------------------
-- Ledger entries — transaction-level accounting lines
-- ---------------------------------------------------------------------------------------------
create table public.ledger_entries (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  entry_date              date not null,
  period_id               uuid not null,                 -- derived by the period_assign trigger
  account_id              uuid not null,
  direction               public.entry_direction_enum not null,
  -- Unsigned. The sign lives in `direction`, so a debit and a credit of the same size cannot cancel
  -- through a data-entry error in the sign column.
  amount                  numeric(18,2) not null constraint ledger_entries_amount_nonneg check (amount >= 0),
  currency                char(3) not null default 'GBP',
  description             text,
  reference               text,
  counterparty_id         uuid,
  journal_ref             text,                          -- groups the lines of one journal
  source_document_id      uuid,
  import_batch_id         uuid,
  import_row_id           uuid,
  source_ref              text,                          -- sheet!row, or page:line
  record_status           public.record_status_enum not null default 'pending',
  assurance_level         public.assurance_level_enum not null default 'verified',
  dedupe_hash             bytea,
  duplicate_reviewed      boolean not null default false,          -- ADR-029.6
  -- ADR-027.3 / IMP-GL-011: an opening-balance journal is not P&L activity. Excluded from P&L,
  -- used as the opening balance under `movement` basis.
  is_opening_balance      boolean not null default false,
  rejected_reason         text,
  superseded_by           uuid,
  superseded_at           timestamptz,
  -- ADR-047.9: set when a row skipped as a duplicate of a rolled-back batch is committed into its
  -- own batch by api.rollback_import_batch.
  promoted_from_batch_id  uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint ledger_entries_org_id_unique unique (organization_id, id),
  constraint ledger_entries_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id),
  constraint ledger_entries_account_fk
    foreign key (organization_id, account_id) references public.accounts (organization_id, id),
  constraint ledger_entries_counterparty_fk
    foreign key (organization_id, counterparty_id) references public.counterparties (organization_id, id),
  constraint ledger_entries_superseded_fk
    foreign key (organization_id, superseded_by) references public.ledger_entries (organization_id, id),
  constraint ledger_entries_no_self_supersede check (superseded_by is null or superseded_by <> id)
);

create index ledger_entries_accepted_lookup
  on public.ledger_entries (organization_id, period_id, account_id) where record_status = 'accepted';
create index ledger_entries_org_date on public.ledger_entries (organization_id, entry_date);
create index ledger_entries_org_dedupe on public.ledger_entries (organization_id, dedupe_hash);
create index ledger_entries_org_counterparty on public.ledger_entries (organization_id, counterparty_id);
create index ledger_entries_org_batch on public.ledger_entries (organization_id, import_batch_id);

-- ---------------------------------------------------------------------------------------------
-- Period balances — summary-level figures from trial balance, P&L and balance-sheet imports (CD-03)
-- ---------------------------------------------------------------------------------------------
create table public.period_balances (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  -- ADR-027.1: the row carries its own period_start so a multi-period file fans out into one row per
  -- month; period_id is derived from it by period_assign.
  period_start            date not null,
  period_id               uuid not null,
  account_id              uuid not null,
  opening_balance         numeric(18,2),
  debit_total             numeric(18,2),
  credit_total            numeric(18,2),
  -- Natural sign (debit − credit), computed as such when the file supplies debit/credit columns.
  closing_balance         numeric(18,2) not null,
  currency                char(3) not null default 'GBP',
  balance_kind            public.balance_kind_enum not null,
  balance_basis           public.balance_basis_enum not null,      -- copied from the batch (ADR-027.2)
  source_document_id      uuid,
  import_batch_id         uuid,
  import_row_id           uuid,
  source_ref              text,
  record_status           public.record_status_enum not null default 'pending',
  assurance_level         public.assurance_level_enum not null default 'verified',
  duplicate_reviewed      boolean not null default false,
  superseded_by           uuid,
  superseded_at           timestamptz,
  promoted_from_batch_id  uuid,                                    -- ADR-047.9
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint period_balances_org_id_unique unique (organization_id, id),
  constraint period_balances_batch_cell_unique
    unique (organization_id, period_id, account_id, import_batch_id),
  constraint period_balances_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id),
  constraint period_balances_account_fk
    foreign key (organization_id, account_id) references public.accounts (organization_id, id),
  constraint period_balances_superseded_fk
    foreign key (organization_id, superseded_by) references public.period_balances (organization_id, id),
  constraint period_balances_no_self_supersede check (superseded_by is null or superseded_by <> id)
);

-- ADR-029.2 `single_current_balance`: at most one accepted, non-superseded row per cell and kind.
-- Supersession is batch-scoped, so committing kind K for period P supersedes every accepted row of
-- kind K for P from other batches and this index is what proves the rule held.
create unique index single_current_balance
  on public.period_balances (organization_id, period_id, account_id, balance_kind)
  where record_status = 'accepted' and superseded_by is null;

create index period_balances_current_lookup
  on public.period_balances (organization_id, period_id, balance_kind)
  where record_status = 'accepted' and superseded_by is null;

-- ---------------------------------------------------------------------------------------------
-- Invoices — sales/purchase invoices and credit notes (CD-07, CD-28)
-- ---------------------------------------------------------------------------------------------
create table public.invoices (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  invoice_type            public.invoice_type_enum not null,
  counterparty_id         uuid not null,
  invoice_number          text not null,
  issue_date              date not null,
  due_date                date,
  period_id               uuid not null,                 -- by issue date
  subtotal                numeric(18,2),
  tax_amount              numeric(18,2),
  total_amount            numeric(18,2) not null,
  amount_paid             numeric(18,2) not null default 0,
  -- Generated rather than written: an import that supplies an inconsistent balance cannot introduce
  -- a receivables figure that disagrees with the invoice it came from.
  balance_due             numeric(18,2) generated always as (total_amount - amount_paid) stored,
  currency                char(3) not null default 'GBP',
  status                  public.invoice_status_enum not null default 'open',
  paid_date               date,
  description             text,
  source_document_id      uuid,
  import_batch_id         uuid,
  import_row_id           uuid,
  source_ref              text,
  record_status           public.record_status_enum not null default 'pending',
  assurance_level         public.assurance_level_enum not null default 'verified',
  dedupe_hash             bytea,
  duplicate_reviewed      boolean not null default false,
  superseded_by           uuid,
  superseded_at           timestamptz,
  promoted_from_batch_id  uuid,                                    -- ADR-047.9
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint invoices_org_id_unique unique (organization_id, id),
  constraint invoices_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id),
  constraint invoices_counterparty_fk
    foreign key (organization_id, counterparty_id) references public.counterparties (organization_id, id),
  constraint invoices_superseded_fk
    foreign key (organization_id, superseded_by) references public.invoices (organization_id, id),
  constraint invoices_no_self_supersede check (superseded_by is null or superseded_by <> id)
);

-- The invoice identity. A re-import with the same key and a changed total, payment or status is an
-- *update candidate* (IMP-INV-010): commit supersedes the prior row rather than rejecting the new
-- one as a duplicate (ADR-029.1), which is why the index is restricted to current rows.
create unique index invoices_identity_unique
  on public.invoices (organization_id, invoice_type, counterparty_id, invoice_number)
  where record_status = 'accepted' and superseded_by is null;

create index invoices_aging on public.invoices (organization_id, invoice_type, status, due_date);
create index invoices_counterparty_issue on public.invoices (organization_id, counterparty_id, issue_date);
create index invoices_org_period on public.invoices (organization_id, period_id);
create index invoices_org_dedupe on public.invoices (organization_id, dedupe_hash);
