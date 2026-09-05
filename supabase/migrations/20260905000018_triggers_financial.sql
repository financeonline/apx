-- MOTION — Phase 2 (plan Phase 4) · Triggers and guards for the financial schema.
-- Contract: DATABASE_ARCHITECTURE.md §12 (triggers and constraints checklist).
--
-- Everything here holds even when application code is wrong. A rule that lives only in TypeScript is
-- a rule that a direct PostgREST call, a job worker or a future refactor can walk straight past.

-- `app.set_updated_at()` already exists (created with the identity tables in Phase 1) and is reused
-- here; it is attached to the new mutable tables at the foot of this file.

-- ---------------------------------------------------------------------------------------------
-- Fiscal calendar helper
-- ---------------------------------------------------------------------------------------------
-- The fiscal year is labelled by the calendar year in which it STARTS: with a April start, April
-- 2026 through March 2027 is fiscal year 2026. The TypeScript twin in `core/periods` uses the same
-- convention and a parity test asserts the two agree; if they ever diverge, the metric for a month
-- would be filed under two different years depending on which side computed it.
create function app.fiscal_position(p_period_start date, p_fy_start_month smallint)
returns table (fiscal_year smallint, fiscal_quarter smallint)
language sql immutable strict parallel safe set search_path = '' as $$
  with m as (
    -- Months elapsed since the start of the fiscal year containing p_period_start, 0-11.
    select ((extract(month from p_period_start)::int - p_fy_start_month) + 12) % 12 as offset_months
  )
  select (extract(year from p_period_start)::int
            - case when m.offset_months > extract(month from p_period_start)::int - 1 then 1 else 0 end)::smallint,
         ((m.offset_months / 3) + 1)::smallint
    from m;
$$;

-- ---------------------------------------------------------------------------------------------
-- period_assign — derive period_id from the row's date, creating the fiscal period if missing
-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER because it inserts into fiscal_periods on behalf of a caller who holds no write
-- privilege on any table (ADR-026). Which column carries the date differs per table, so the column
-- name is passed as a trigger argument rather than guessed.
create function app.period_assign() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_date_col   text := tg_argv[0];
  v_date       date;
  v_start      date;
  v_period     uuid;
  v_fy_month   smallint;
  v_year       smallint;
  v_quarter    smallint;
begin
  v_date := (to_jsonb(new) ->> v_date_col)::date;
  if v_date is null then
    raise exception 'VALIDATION: % is required to assign a fiscal period', v_date_col
      using errcode = '22023';
  end if;

  v_start := date_trunc('month', v_date)::date;

  select o.fiscal_year_start_month into v_fy_month
    from public.organizations o where o.id = new.organization_id;
  if v_fy_month is null then
    raise exception 'NOT_FOUND: organization does not exist' using errcode = 'P0002';
  end if;

  select p.id into v_period
    from public.fiscal_periods p
   where p.organization_id = new.organization_id and p.period_start = v_start;

  if v_period is null then
    select f.fiscal_year, f.fiscal_quarter into v_year, v_quarter
      from app.fiscal_position(v_start, v_fy_month) f;

    insert into public.fiscal_periods
           (organization_id, period_start, period_end, fiscal_year, fiscal_quarter, label)
    values (new.organization_id, v_start,
            (v_start + interval '1 month - 1 day')::date,
            v_year, v_quarter, to_char(v_start, 'Mon YYYY'))
    -- Two rows of the same import can race for the same new month; the loser takes the winner's row.
    on conflict (organization_id, period_start) do update set period_start = excluded.period_start
    returning id into v_period;
  end if;

  new.period_id := v_period;
  return new;
end $$;

create trigger period_assign before insert or update of entry_date on public.ledger_entries
  for each row execute function app.period_assign('entry_date');
create trigger period_assign before insert or update of transaction_date on public.bank_transactions
  for each row execute function app.period_assign('transaction_date');
create trigger period_assign before insert or update of issue_date on public.invoices
  for each row execute function app.period_assign('issue_date');
-- ADR-027.1: balances carry their own period_start so a multi-period file fans out per month.
create trigger period_assign before insert or update of period_start on public.period_balances
  for each row execute function app.period_assign('period_start');

-- ---------------------------------------------------------------------------------------------
-- same_org_ref — the guard for polymorphic references (ADR-034, ADR-044.8; F-A-13, R2-A-12)
-- ---------------------------------------------------------------------------------------------
-- A composite foreign key cannot express "this id points at whichever table the discriminator names",
-- so those references would otherwise be the one place a row could reach across tenants. This
-- trigger resolves the target table from the discriminator and asserts organization_id equality.
--
-- Arguments: id_column, discriminator_column ('' when the target table is fixed), then either the
-- fixed table name or alternating discriminator-value/table-name pairs. A discriminator value with
-- no mapping is deliberately skipped: `none` and `standard_category` name no table at all.
create function app.same_org_ref() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_id_col   text := tg_argv[0];
  v_disc_col text := tg_argv[1];
  v_id       uuid;
  v_disc     text;
  v_table    text;
  v_owner    uuid;
  i          int;
begin
  v_id := (to_jsonb(new) ->> v_id_col)::uuid;
  if v_id is null then
    return new;                                  -- nothing to point at, nothing to check
  end if;

  if v_disc_col = '' then
    v_table := tg_argv[2];
  else
    v_disc := to_jsonb(new) ->> v_disc_col;
    i := 2;
    while i < tg_nargs loop
      if tg_argv[i] = v_disc then
        v_table := tg_argv[i + 1];
        exit;
      end if;
      i := i + 2;
    end loop;
    if v_table is null then
      return new;                                -- discriminator names no table (none, category)
    end if;
  end if;

  execute format('select organization_id from public.%I where id = $1', v_table)
    into v_owner using v_id;

  if v_owner is null then
    raise exception 'VALIDATION: %.% references a row that does not exist', tg_table_name, v_id_col
      using errcode = '22023';
  end if;
  if v_owner <> new.organization_id then
    raise exception 'VALIDATION: %.% references another organization', tg_table_name, v_id_col
      using errcode = '22023';
  end if;
  return new;
end $$;

create trigger same_org_ref_origin before insert or update on public.evidence_bundles
  for each row execute function app.same_org_ref('origin_id', '');
create trigger same_org_ref_item before insert or update on public.evidence_items
  for each row execute function app.same_org_ref(
    'ref_id', 'item_type',
    'metric_snapshot', 'metric_snapshots', 'calculation_run', 'calculation_runs',
    'ledger_entry', 'ledger_entries', 'bank_transaction', 'bank_transactions',
    'invoice', 'invoices', 'period_balance', 'period_balances',
    'counterparty', 'counterparties', 'account', 'accounts',
    'source_document', 'source_documents', 'fiscal_period', 'fiscal_periods',
    'alert', 'alerts');
create trigger same_org_ref_subject before insert or update on public.alerts
  for each row execute function app.same_org_ref(
    'subject_id', 'subject_type',
    'account', 'accounts', 'counterparty', 'counterparties',
    'bank_transaction', 'bank_transactions', 'recurring_group', 'recurring_payment_groups');
create trigger same_org_ref_source before insert or update on public.actions
  for each row execute function app.same_org_ref(
    'source_id', 'source_type',
    'alert', 'alerts', 'health_score', 'health_scores', 'report', 'report_files');
create trigger same_org_ref_trigger_ref before insert or update on public.calculation_runs
  for each row execute function app.same_org_ref('trigger_ref_id', '');
create trigger same_org_ref_duplicate before insert or update on public.import_rows
  for each row execute function app.same_org_ref(
    'duplicate_of_id', 'duplicate_of_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions',
    'invoices', 'invoices', 'period_balances', 'period_balances');
create trigger same_org_ref_committed before insert or update on public.import_rows
  for each row execute function app.same_org_ref(
    'committed_record_id', 'committed_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions',
    'invoices', 'invoices', 'period_balances', 'period_balances');
create trigger same_org_ref_record before insert on public.record_status_events
  for each row execute function app.same_org_ref(
    'record_id', 'record_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions',
    'invoices', 'invoices', 'period_balances', 'period_balances');
create trigger same_org_ref_related before insert on public.record_status_events
  for each row execute function app.same_org_ref(
    'related_record_id', 'record_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions',
    'invoices', 'invoices', 'period_balances', 'period_balances');
create trigger same_org_ref_dimension before insert or update on public.metric_snapshots
  for each row execute function app.same_org_ref(
    'dimension_id', 'dimension_type',
    'account', 'accounts', 'counterparty', 'counterparties', 'bank_account', 'bank_accounts');
create trigger same_org_ref_dimension before insert or update on public.metric_current
  for each row execute function app.same_org_ref(
    'dimension_id', 'dimension_type',
    'account', 'accounts', 'counterparty', 'counterparties', 'bank_account', 'bank_accounts');

-- `evidence_bundles.origin_id` has no single target table, so the fixed-table form above cannot
-- apply; the bundle's `origin_table` names it. Replace with the discriminated form.
drop trigger same_org_ref_origin on public.evidence_bundles;
create trigger same_org_ref_origin before insert or update on public.evidence_bundles
  for each row execute function app.same_org_ref(
    'origin_id', 'origin_table',
    'metric_snapshots', 'metric_snapshots', 'alerts', 'alerts', 'ai_messages', 'ai_messages',
    'health_scores', 'health_scores', 'actions', 'actions', 'report_files', 'report_files');

create trigger same_org_ref_feedback_message before insert or update on public.ai_feedback
  for each row execute function app.same_org_ref('message_id', '', 'ai_messages');
create trigger same_org_ref_feedback_alert before insert or update on public.ai_feedback
  for each row execute function app.same_org_ref('alert_id', '', 'alerts');

-- ---------------------------------------------------------------------------------------------
-- superseded_at_set — the column is current state, the events table is history (ADR-047.1)
-- ---------------------------------------------------------------------------------------------
-- Stamps the instant a row was superseded, and PERMITS the reset to NULL that
-- api.rollback_import_batch performs when a superseded row is restored. Forbidding the reset would
-- make a rollback unable to return the previous batch to current.
create function app.superseded_at_set() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.superseded_by is not null and old.superseded_by is distinct from new.superseded_by then
    new.superseded_at := now();
  elsif new.superseded_by is null then
    new.superseded_at := null;
  end if;
  return new;
end $$;

create trigger superseded_at_set before update of superseded_by on public.ledger_entries
  for each row execute function app.superseded_at_set();
create trigger superseded_at_set before update of superseded_by on public.period_balances
  for each row execute function app.superseded_at_set();
create trigger superseded_at_set before update of superseded_by on public.invoices
  for each row execute function app.superseded_at_set();
create trigger superseded_at_set before update of superseded_by on public.bank_transactions
  for each row execute function app.superseded_at_set();

-- ---------------------------------------------------------------------------------------------
-- mask_description — raw bank text never leaves the raw column unmasked (ADR-038.4)
-- ---------------------------------------------------------------------------------------------
-- `description_raw` routinely carries a third party's sort code and account number. The normalised
-- form is the only description a client role, an AI tool output or an export ever sees, so the
-- masking has to happen on write rather than at each read site, where one missed call would leak.
create function app.mask_description() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_text text;
begin
  v_text := coalesce(new.description_raw, '');
  -- Sort codes first: 12-34-56 would otherwise be partly eaten by the digit-run rule below.
  -- Both patterns collapse to the same shape, `****` plus the last four digits (ADR-038.4).
  v_text := regexp_replace(v_text, '\m(\d{2})-(\d{2})-(\d{2})\M', '****\2\3', 'g');
  -- Account numbers: any run of 6 to 8 digits keeps only its last four. A run of 5 or fewer is a
  -- reference or an amount, not an account number, and a run of 9+ is neither; both are left alone.
  v_text := regexp_replace(v_text, '\m\d{2,4}(\d{4})\M', '****\1', 'g');
  new.description_normalized := nullif(btrim(regexp_replace(v_text, '\s+', ' ', 'g')), '');
  return new;
end $$;

create trigger mask_description before insert or update of description_raw on public.bank_transactions
  for each row execute function app.mask_description();

-- ---------------------------------------------------------------------------------------------
-- record_superseded / counterparty_merged — a running calculation must notice the ground moving
-- ---------------------------------------------------------------------------------------------
-- ADR-046.2 / R2-C-10. Without these, a run that started before a commit would publish numbers
-- computed from data that has since changed, and nothing would ever correct them.
create function app.flag_runs_stale() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  v_org := coalesce(new.organization_id, old.organization_id);
  update public.calculation_runs
     set stale = true
   where organization_id = v_org and status = 'running';
  return coalesce(new, old);
end $$;

create trigger record_superseded after insert on public.record_status_events
  for each row execute function app.flag_runs_stale();
create trigger counterparty_merged after update of merged_into_id on public.counterparties
  for each row execute function app.flag_runs_stale();

-- ---------------------------------------------------------------------------------------------
-- append_only_guard on the eight immutable tables (ADR-046.1; R2-C-09)
-- ---------------------------------------------------------------------------------------------
-- The guard already exists from Phase 1 and refuses UPDATE and DELETE for every principal including
-- the table owner and the service role, lifting only inside org.purge.
create trigger append_only_guard before update or delete on public.evidence_bundles
  for each row execute function app.append_only_guard();
create trigger append_only_guard before update or delete on public.evidence_items
  for each row execute function app.append_only_guard();
create trigger append_only_guard before update or delete on public.alert_revisions
  for each row execute function app.append_only_guard();
create trigger append_only_guard before update or delete on public.record_status_events
  for each row execute function app.append_only_guard();
create trigger append_only_guard before update or delete on public.metric_snapshots
  for each row execute function app.append_only_guard();
create trigger append_only_guard before update or delete on public.health_scores
  for each row execute function app.append_only_guard();

-- category_history and account_category_history are append-only in their *rows*, but closing a
-- period of validity means writing valid_to on the row that is ending. Only that column may move.
create function app.history_close_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('app.purge', true), 'off') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: % is append-only', tg_table_name using errcode = '23514';
  end if;
  -- Everything except valid_to must be identical, and valid_to may only be set once.
  if old.valid_to is not null or new.valid_to is null then
    raise exception 'IMMUTABLE: % rows may only have valid_to set once', tg_table_name
      using errcode = '23514';
  end if;
  if to_jsonb(new) - 'valid_to' <> to_jsonb(old) - 'valid_to' then
    raise exception 'IMMUTABLE: only valid_to may change on %', tg_table_name using errcode = '23514';
  end if;
  return new;
end $$;

create trigger history_close_only before update or delete on public.category_history
  for each row execute function app.history_close_only();
create trigger history_close_only before update or delete on public.account_category_history
  for each row execute function app.history_close_only();

-- ---------------------------------------------------------------------------------------------
-- set_updated_at and audit_diff attachments
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'fiscal_periods', 'accounts', 'counterparties', 'ledger_entries', 'period_balances', 'invoices',
    'bank_accounts', 'bank_transactions', 'recurring_payment_groups', 'source_documents',
    'import_mappings', 'import_batches', 'import_rows', 'calculation_runs', 'alerts',
    'ai_conversations', 'ai_feedback', 'actions'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function app.set_updated_at()', t);
  end loop;

  -- audit_diff as the backstop on the four financial record tables (ADR-026.6), plus the two tables
  -- whose edits move every downstream figure: a re-mapped account changes every metric, and a bank
  -- opening balance changes every cash figure.
  foreach t in array array[
    'accounts', 'bank_accounts', 'ledger_entries', 'period_balances', 'invoices', 'bank_transactions'
  ] loop
    execute format(
      'create trigger audit_diff after insert or update or delete on public.%I
         for each row execute function app.audit_diff()', t);
  end loop;
end $$;

-- Ownership and grants for everything created here (ADR-044.3).
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public', f.sig);
  end loop;
end $$;

alter function public.standard_category_account_type(public.standard_category_enum)
  owner to motion_definer;
