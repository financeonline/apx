-- MOTION — Phase 2 (plan Phase 4) · Banking.
-- Contract: DATABASE_ARCHITECTURE.md §4; ADR-028 (transfers), ADR-029.4 (masked identity),
-- ADR-038.4 (raw description is not readable through the table), ADR-047.12 (one transfer enum).

create table public.bank_accounts (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  name                    text not null constraint bank_accounts_name_len check (length(name) between 1 and 200),
  bank_name               text not null,
  -- Masked at rest, last four digits only. The full number is never stored: it is not needed for any
  -- metric, and storing it would put card-adjacent data inside a tenant table read by five roles.
  account_number_masked   text,
  sort_code_masked        text,
  currency                char(3) not null default 'GBP',
  account_type            public.bank_account_type_enum not null default 'current',
  ledger_account_id       uuid,                          -- the cash account in the chart
  opening_balance         numeric(18,2),
  opening_balance_date    date,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint bank_accounts_org_id_unique unique (organization_id, id),
  -- ADR-029.4: inline creation of an account whose masked identity already exists is refused and the
  -- existing account offered instead. Two rows for one real account would double every cash figure.
  constraint bank_identity_unique
    unique (organization_id, bank_name, sort_code_masked, account_number_masked),
  constraint bank_accounts_ledger_fk
    foreign key (organization_id, ledger_account_id) references public.accounts (organization_id, id),
  constraint bank_accounts_opening_pair
    check ((opening_balance is null) = (opening_balance_date is null))
);

create table public.bank_transactions (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete cascade,
  bank_account_id          uuid not null,
  transaction_date         date not null,
  posted_date              date,
  period_id                uuid not null,                -- derived by period_assign
  -- Signed here, unlike ledger_entries: a bank statement *is* a signed running list, and inflow /
  -- outflow is the statement's own semantics rather than a double-entry direction.
  amount                   numeric(18,2) not null,
  currency                 char(3) not null default 'GBP',
  -- Stored verbatim: it may carry a third party's sort code and account number. Column privileges
  -- below revoke SELECT on it from `authenticated`; only the definer view exposes it (ADR-038.4).
  description_raw          text,
  -- The masked derivation, and the ONLY description any client role, AI tool output or export sees.
  description_normalized   text,
  counterparty_name_raw    text,
  counterparty_id          uuid,
  category_account_id      uuid,
  category_source          public.category_source_enum not null default 'none',
  balance_after            numeric(18,2),
  reference                text,
  is_transfer              boolean not null default false,
  transfer_pair_id         uuid,
  -- ADR-028: only `cash_transfer` pairs are excluded from cash metrics. A card repayment or a loan
  -- drawdown is a real cash movement and must stay in.
  transfer_kind            public.transfer_kind_enum not null default 'none',
  recurring_group_id       uuid,
  matched_ledger_entry_id  uuid,                          -- post-MVP reconciliation
  source_document_id       uuid,
  import_batch_id          uuid,
  import_row_id            uuid,
  source_ref               text,
  record_status            public.record_status_enum not null default 'pending',
  assurance_level          public.assurance_level_enum not null default 'verified',
  dedupe_hash              bytea,
  duplicate_reviewed       boolean not null default false,
  superseded_by            uuid,
  superseded_at            timestamptz,
  promoted_from_batch_id   uuid,                          -- ADR-047.9
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint bank_transactions_org_id_unique unique (organization_id, id),
  constraint bank_transactions_account_fk
    foreign key (organization_id, bank_account_id) references public.bank_accounts (organization_id, id),
  constraint bank_transactions_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id),
  constraint bank_transactions_counterparty_fk
    foreign key (organization_id, counterparty_id) references public.counterparties (organization_id, id),
  constraint bank_transactions_category_fk
    foreign key (organization_id, category_account_id) references public.accounts (organization_id, id),
  constraint bank_transactions_pair_fk
    foreign key (organization_id, transfer_pair_id) references public.bank_transactions (organization_id, id),
  constraint bank_transactions_ledger_fk
    foreign key (organization_id, matched_ledger_entry_id) references public.ledger_entries (organization_id, id),
  constraint bank_transactions_superseded_fk
    foreign key (organization_id, superseded_by) references public.bank_transactions (organization_id, id),
  constraint bank_transactions_no_self_supersede check (superseded_by is null or superseded_by <> id),
  constraint bank_transactions_no_self_pair check (transfer_pair_id is null or transfer_pair_id <> id),
  -- The flag and the kind are one fact expressed twice, so they must agree. A row marked as a
  -- transfer with kind `none` would be excluded from nothing and counted as ordinary cash.
  constraint bank_transactions_transfer_consistent
    check (is_transfer = (transfer_kind <> 'none'))
);

create index bank_transactions_accepted_lookup
  on public.bank_transactions (organization_id, bank_account_id, transaction_date)
  where record_status = 'accepted';
create index bank_transactions_org_period on public.bank_transactions (organization_id, period_id);
create index bank_transactions_org_dedupe on public.bank_transactions (organization_id, dedupe_hash);
create index bank_transactions_org_recurring on public.bank_transactions (organization_id, recurring_group_id);
create index bank_transactions_org_category on public.bank_transactions (organization_id, category_account_id);

-- Detected recurring flows, used by four alert families and the Banking health dimension.
create table public.recurring_payment_groups (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete cascade,
  bank_account_id          uuid,
  counterparty_key         text not null,                -- normalised description signature
  direction                public.recurring_direction_enum not null,
  cadence                  public.recurring_cadence_enum not null,
  expected_amount          numeric(18,2) not null,
  amount_tolerance_ratio   numeric(20,6) not null default 0.1,
  first_seen               date not null,
  last_seen                date not null,
  occurrence_count         integer not null default 0,
  next_expected            date,
  status                   public.recurring_status_enum not null default 'active',
  detector_version         text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint recurring_groups_org_id_unique unique (organization_id, id),
  constraint recurring_groups_identity_unique
    unique (organization_id, bank_account_id, counterparty_key, direction),
  constraint recurring_groups_account_fk
    foreign key (organization_id, bank_account_id) references public.bank_accounts (organization_id, id) on delete cascade
);

alter table public.bank_transactions
  add constraint bank_transactions_recurring_fk
  foreign key (organization_id, recurring_group_id)
  references public.recurring_payment_groups (organization_id, id) on delete set null;

-- ADR-034 / F-C-07: append-only history of a bank row's category and transfer state, so a descriptor
-- resolved as-of an old run sees the categorisation in force then. Without it, re-categorising one
-- transaction would silently rewrite what every past metric appeared to be made of.
create table public.category_history (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  bank_transaction_id   uuid not null,
  category_account_id   uuid,
  is_transfer           boolean not null default false,
  transfer_kind         public.transfer_kind_enum not null default 'none',
  source                public.category_source_enum not null default 'none',
  valid_from            timestamptz not null default now(),
  valid_to              timestamptz,
  changed_by            uuid references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  constraint category_history_txn_fk
    foreign key (organization_id, bank_transaction_id)
    references public.bank_transactions (organization_id, id) on delete cascade,
  constraint category_history_category_fk
    foreign key (organization_id, category_account_id) references public.accounts (organization_id, id)
);

create index category_history_lookup
  on public.category_history (organization_id, bank_transaction_id, valid_from desc);
