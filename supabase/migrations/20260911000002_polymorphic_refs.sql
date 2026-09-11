-- MOTION — Phase 1–7 remediation · M3: the polymorphic reference guard, closed.
-- Contract: ADR-034, ADR-044.8; F-A-13, R2-A-12; PHASE_1_7_INTEGRATION_AUDIT.md finding M2.
--
-- WHAT WAS BROKEN. `app.same_org_ref` resolves the target table from a discriminator column and
-- asserts organization_id equality, because a composite foreign key cannot express "this id points
-- at whichever table the discriminator names". A discriminator value with NO mapping was treated as
-- "nothing to check" and returned `new`.
--
-- That is the right behaviour for `none`, `standard_category`, `user` and `query`, which name no
-- table. It is the wrong behaviour for `actions.source_type = 'ai'`, which names `ai_messages` and
-- was never mapped — so the one polymorphic column in the schema that points at an AI message had
-- no database check at all. The invariant survived only because both writers re-read the message
-- scoped to the organisation themselves; a third writer would have lost it silently.
--
-- The two cases are indistinguishable to the trigger, and that is the actual defect: "not listed"
-- meant both "deliberately points at no table" and "somebody forgot".
--
-- WHAT CHANGES.
--   1. A value that names no table is mapped EXPLICITLY, to the reserved token '-'. An id is then
--      refused outright: a row that names no table must name no row.
--   2. A value that is in neither list raises. Adding an enum value without saying what it points
--      at is now a failure at the first write, not a silently unguarded column.
--   3. `actions.source_type = 'ai'` maps to `ai_messages`.
--   4. `evidence_bundles.origin_table` is plain `text` and had no constraint of any kind — the
--      trigger's argument list was the only thing restricting it, and an unlisted value passed. It
--      gets the CHECK the documentation always implied.
--   5. `evidence_items` ties `item_type = 'query'` to the descriptor form, so a `query` row cannot
--      carry a `ref_id` that nothing resolves.
--
-- `scripts/check-schema-drift.ts` now asserts that every value of every discriminator enum has a
-- mapping in its trigger, so requirement 2 is caught in CI rather than by a customer's first write.

-- ---------------------------------------------------------------------------
-- 1. The guard.
-- ---------------------------------------------------------------------------
create or replace function app.same_org_ref() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_id_col   text := tg_argv[0];
  v_disc_col text := tg_argv[1];
  v_id       uuid;
  v_disc     text;
  v_table    text;
  v_mapped   boolean := false;
  v_owner    uuid;
  i          int;
begin
  v_id := (to_jsonb(new) ->> v_id_col)::uuid;

  if v_disc_col = '' then
    -- A fixed target: the table is the third argument and there is nothing to resolve.
    v_table := tg_argv[2];
    if v_table is null then
      raise exception 'CONFIGURATION: the same_org_ref trigger on % names no target table', tg_table_name
        using errcode = '22023';
    end if;
  else
    v_disc := to_jsonb(new) ->> v_disc_col;

    -- A NULL discriminator names nothing yet — `import_rows.committed_table` before the row is
    -- committed, `duplicate_of_table` on a row that duplicates nothing. There is no table to
    -- resolve, so the only thing to assert is that no id is claiming otherwise.
    if v_disc is null then
      if v_id is not null then
        raise exception 'VALIDATION: %.% is set although %.% is null',
          tg_table_name, v_id_col, tg_table_name, v_disc_col using errcode = '22023';
      end if;
      return new;
    end if;

    i := 2;
    while i < tg_nargs loop
      if tg_argv[i] is not distinct from v_disc then
        v_table  := tg_argv[i + 1];
        v_mapped := true;
        exit;
      end if;
      i := i + 2;
    end loop;

    -- The change. An unmapped value is a mistake, not a pass.
    if not v_mapped then
      raise exception
        'CONFIGURATION: %.% = % has no table mapping on %; add it to the same_org_ref trigger (''-'' if it names no table)',
        tg_table_name, v_disc_col, coalesce(v_disc, '<null>'), tg_table_name
        using errcode = '22023';
    end if;

    -- '-' is the reserved token for "names no table". Such a row must name no row either: an id
    -- beside it points at something nothing can resolve, which is the invalid reference this
    -- trigger exists to prevent.
    if v_table = '-' then
      if v_id is not null then
        raise exception 'VALIDATION: %.% is set although %.% = % names no table',
          tg_table_name, v_id_col, tg_table_name, v_disc_col, v_disc
          using errcode = '22023';
      end if;
      return new;
    end if;
  end if;

  if v_id is null then
    return new;                                  -- nothing to point at, nothing to check
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

alter function app.same_org_ref() owner to motion_definer;

-- ---------------------------------------------------------------------------
-- 2. Every discriminator, completely mapped. '-' means "names no table".
-- ---------------------------------------------------------------------------

-- actions.source_type — action_source_enum: ai, alert, health_score, user, report.
-- `ai` is the gap this migration exists for; `user` is an action somebody typed, which has no source row.
drop trigger same_org_ref_source on public.actions;
create trigger same_org_ref_source before insert or update on public.actions
  for each row execute function app.same_org_ref(
    'source_id', 'source_type',
    'ai', 'ai_messages', 'alert', 'alerts', 'health_score', 'health_scores',
    'report', 'report_files', 'user', '-');

-- alerts.subject_type — alert_subject_enum. `standard_category` has no row id (ADR-053): the
-- category's NAME identifies it, and it lives in `subject_key`.
drop trigger same_org_ref_subject on public.alerts;
create trigger same_org_ref_subject before insert or update on public.alerts
  for each row execute function app.same_org_ref(
    'subject_id', 'subject_type',
    'account', 'accounts', 'counterparty', 'counterparties',
    'bank_transaction', 'bank_transactions', 'recurring_group', 'recurring_payment_groups',
    'none', '-', 'standard_category', '-');

-- calculation_runs.trigger — calculation_trigger_enum. Four triggers name the row that caused the
-- run; the other five are a person or a clock and name nothing.
drop trigger same_org_ref_trigger_ref on public.calculation_runs;
create trigger same_org_ref_trigger_ref before insert or update on public.calculation_runs
  for each row execute function app.same_org_ref(
    'trigger_ref_id', 'trigger',
    'import_commit', 'import_batches', 'import_rollback', 'import_batches',
    'account_remapped', 'accounts', 'counterparty_merged', 'counterparties',
    'recalc_manual', '-', 'scheduled', '-', 'settings_changed', '-',
    'banking_edit', '-', 'record_superseded', '-');

-- evidence_items.item_type — evidence_item_enum. `query` carries a descriptor and its RFC 8785
-- hash instead of an id (ADR-032.6).
drop trigger same_org_ref_item on public.evidence_items;
create trigger same_org_ref_item before insert or update on public.evidence_items
  for each row execute function app.same_org_ref(
    'ref_id', 'item_type',
    'metric_snapshot', 'metric_snapshots', 'calculation_run', 'calculation_runs',
    'ledger_entry', 'ledger_entries', 'bank_transaction', 'bank_transactions',
    'invoice', 'invoices', 'period_balance', 'period_balances',
    'counterparty', 'counterparties', 'account', 'accounts',
    'source_document', 'source_documents', 'fiscal_period', 'fiscal_periods',
    'alert', 'alerts', 'query', '-');

-- metric_snapshots / metric_current.dimension_type — metric_dimension_enum. `none` and
-- `standard_category` are already held to a NULL id by `*_dimension_shape`; stating them here means
-- the trigger and the constraint agree rather than one of them being the only reader.
drop trigger same_org_ref_dimension on public.metric_snapshots;
create trigger same_org_ref_dimension before insert or update on public.metric_snapshots
  for each row execute function app.same_org_ref(
    'dimension_id', 'dimension_type',
    'account', 'accounts', 'counterparty', 'counterparties', 'bank_account', 'bank_accounts',
    'none', '-', 'standard_category', '-');

drop trigger same_org_ref_dimension on public.metric_current;
create trigger same_org_ref_dimension before insert or update on public.metric_current
  for each row execute function app.same_org_ref(
    'dimension_id', 'dimension_type',
    'account', 'accounts', 'counterparty', 'counterparties', 'bank_account', 'bank_accounts',
    'none', '-', 'standard_category', '-');

-- The four financial_record_table_enum discriminators were already complete; they are re-registered
-- only so that every polymorphic column in the schema is declared in one place.
drop trigger same_org_ref_duplicate on public.import_rows;
create trigger same_org_ref_duplicate before insert or update on public.import_rows
  for each row execute function app.same_org_ref(
    'duplicate_of_id', 'duplicate_of_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions',
    'invoices', 'invoices', 'period_balances', 'period_balances');

drop trigger same_org_ref_committed on public.import_rows;
create trigger same_org_ref_committed before insert or update on public.import_rows
  for each row execute function app.same_org_ref(
    'committed_record_id', 'committed_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions',
    'invoices', 'invoices', 'period_balances', 'period_balances');

-- ---------------------------------------------------------------------------
-- 3. evidence_bundles.origin_table: `text` with nothing restricting it.
-- ---------------------------------------------------------------------------
-- The trigger already resolves the six origins EVIDENCE_MODEL.md §5 names, but an unlisted value
-- used to slip past it, and nothing else in the schema had an opinion. Now the column cannot hold a
-- seventh value at all, and the trigger and the constraint list the same six.
alter table public.evidence_bundles
  add constraint evidence_bundles_origin_table_known check (
    origin_table in ('metric_snapshots', 'alerts', 'ai_messages',
                     'health_scores', 'actions', 'report_files'));

drop trigger same_org_ref_origin on public.evidence_bundles;
create trigger same_org_ref_origin before insert or update on public.evidence_bundles
  for each row execute function app.same_org_ref(
    'origin_id', 'origin_table',
    'metric_snapshots', 'metric_snapshots', 'alerts', 'alerts', 'ai_messages', 'ai_messages',
    'health_scores', 'health_scores', 'actions', 'actions', 'report_files', 'report_files');

-- ---------------------------------------------------------------------------
-- 4. A `query` item is the descriptor form, and only that.
-- ---------------------------------------------------------------------------
-- `evidence_item_xor` already says a row carries a ref_id or a descriptor and not both. It did not
-- say WHICH item_type takes which form, so `item_type = 'query'` with a `ref_id` satisfied the xor
-- and then skipped the trigger, since `query` names no table. Both halves are now stated.
alter table public.evidence_items
  add constraint evidence_items_query_is_descriptor check (
    (item_type = 'query') = (query_descriptor is not null));
