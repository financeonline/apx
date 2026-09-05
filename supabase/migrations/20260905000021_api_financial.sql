-- MOTION — Phase 2 (plan Phase 4) · api.* functions for the financial schema.
-- Contract: DATABASE_ARCHITECTURE.md §14.1; ADR-026, ADR-028, ADR-034, ADR-044.3/5, ADR-046, ADR-047.
--
-- Every function here follows the §14.1 common contract: SECURITY DEFINER owned by motion_definer,
-- `search_path = ''` with schema-qualified references, throttle first, actor from app.uid() and
-- never a parameter, organization validated against the accessible set, permission checked with
-- app.has_permission, invariants enforced in SQL, audit written in the same transaction, ids
-- returned, and a foreign or missing id raising NOT_FOUND rather than PERMISSION_DENIED so the
-- surface cannot be used to enumerate other tenants' rows.

-- ---------------------------------------------------------------------------
-- Shared write primitives (app.*)
-- ---------------------------------------------------------------------------

-- The one place a lifecycle event is appended. Writing this by hand at each call site is how a
-- rollback ends up unable to reconstruct what it undid (ADR-034).
create function app.record_status_event(
  p_org       uuid,
  p_table     public.financial_record_table_enum,
  p_record    uuid,
  p_event     public.record_status_event_enum,
  p_related   uuid default null,
  p_batch     uuid default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.record_status_events
         (organization_id, record_table, record_id, event, related_record_id,
          import_batch_id, actor_user_id)
  values (p_org, p_table, p_record, p_event, p_related, p_batch, app.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Points `p_record` at `p_replacement` and logs it. The `superseded_at_set` trigger stamps the
-- instant; this function exists so the column write and the event can never happen apart.
create function app.supersede_row(
  p_org         uuid,
  p_table       public.financial_record_table_enum,
  p_record      uuid,
  p_replacement uuid,
  p_batch       uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_updated integer;
begin
  execute format(
    'update public.%I set superseded_by = $1 where organization_id = $2 and id = $3
       and superseded_by is null', p_table::text)
    using p_replacement, p_org, p_record;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'CONFLICT: that record is already superseded or does not exist'
      using errcode = '40001';
  end if;
  perform app.record_status_event(p_org, p_table, p_record, 'superseded', p_replacement, p_batch);
end $$;

-- Queues a recalculation. Every mutation that can move a published figure calls this, so the
-- dashboard is never left showing a number derived from data that has since changed (ADR-031).
create function app.enqueue_recalculation(
  p_org     uuid,
  p_trigger public.calculation_trigger_enum,
  p_ref     uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_job uuid;
begin
  insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
  values (p_org, 'calculation.run',
          jsonb_build_object('trigger', p_trigger::text, 'triggerRefId', p_ref),
          app.uid(), 'calculation.run:' || p_org::text)
  -- ADR-031.1: the idempotency index covers queued jobs only, so a run already in flight does not
  -- swallow this request — a second job is queued behind it.
  on conflict do nothing
  returning id into v_job;
  return v_job;
end $$;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create function api.remap_account(p_account uuid, p_category public.standard_category_enum)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_old public.standard_category_enum;
  v_sys boolean;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.standard_category, a.is_system
    into v_org, v_old, v_sys
    from public.accounts a where a.id = p_account;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'financials.edit');

  -- A seeded account IS its category (ADR-004). Re-categorising one would leave the organization
  -- without a target for that category and silently strand every metric that reads it.
  if v_sys then
    raise exception 'VALIDATION: a system account cannot be re-categorised' using errcode = '22023';
  end if;
  if v_old = p_category then
    return p_account;
  end if;

  perform pg_advisory_xact_lock(hashtext('org:' || v_org::text));

  -- ADR-034: close the old history row and open a new one, so a descriptor resolved as-of an earlier
  -- run still sees the category that produced those numbers.
  update public.account_category_history
     set valid_to = now()
   where organization_id = v_org and account_id = p_account and valid_to is null;

  update public.accounts
     set standard_category = p_category,
         account_type = public.standard_category_account_type(p_category),
         mapping_confidence = 'confirmed'
   where organization_id = v_org and id = p_account;

  insert into public.account_category_history
         (organization_id, account_id, standard_category, changed_by)
  values (v_org, p_account, p_category, app.uid());

  perform app.audit(v_org, 'account.remapped', 'accounts', p_account,
                    jsonb_build_object('standard_category', v_old),
                    jsonb_build_object('standard_category', p_category), '{}'::jsonb);
  -- A remap changes every metric that reads this account, so the recalculation is not optional.
  perform app.enqueue_recalculation(v_org, 'account_remapped', p_account);
  return p_account;
end $$;

-- ---------------------------------------------------------------------------
-- Counterparties
-- ---------------------------------------------------------------------------

create function api.update_counterparty(p_counterparty uuid, p_patch jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org    uuid;
  v_before jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select c.organization_id, to_jsonb(c) into v_org, v_before
    from public.counterparties c where c.id = p_counterparty;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'customers.edit');

  -- An allow-list, not a merge: a patch must never be able to move organization_id, the normalised
  -- name that uniqueness depends on, or the merge pointer.
  update public.counterparties c
     set name = coalesce(p_patch ->> 'name', c.name),
         kind = coalesce((p_patch ->> 'kind')::public.counterparty_kind_enum, c.kind),
         default_expense_category = case
           when p_patch ? 'default_expense_category'
             then (p_patch ->> 'default_expense_category')::public.standard_category_enum
           else c.default_expense_category end,
         email = coalesce((p_patch ->> 'email')::extensions.citext, c.email),
         notes = case when p_patch ? 'notes' then p_patch ->> 'notes' else c.notes end,
         is_active = coalesce((p_patch ->> 'is_active')::boolean, c.is_active),
         normalized_name = case when p_patch ? 'name'
                                then app.normalize_name(p_patch ->> 'name')
                                else c.normalized_name end
   where c.organization_id = v_org and c.id = p_counterparty;

  perform app.audit(v_org, 'counterparty.updated', 'counterparties', p_counterparty,
                    v_before, p_patch, '{}'::jsonb);
  return p_counterparty;
end $$;

create function api.merge_counterparties(p_from uuid, p_into uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_target_org uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select c.organization_id into v_org from public.counterparties c where c.id = p_from;
  select c.organization_id into v_target_org from public.counterparties c where c.id = p_into;
  if v_org is null or v_target_org is null or v_org <> v_target_org
     or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'customers.edit');
  if p_from = p_into then
    raise exception 'VALIDATION: a counterparty cannot be merged into itself' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('org:' || v_org::text));

  -- Merging is a pointer, not a delete: every invoice and transaction keeps naming the row it was
  -- imported against, and the engine follows merged_into_id. Deleting would break the evidence trail.
  update public.counterparties
     set merged_into_id = p_into, is_active = false
   where organization_id = v_org and id = p_from and merged_into_id is null;
  if not found then
    raise exception 'CONFLICT: that counterparty is already merged' using errcode = '40001';
  end if;

  perform app.audit(v_org, 'counterparty.merged', 'counterparties', p_from, null,
                    jsonb_build_object('merged_into', p_into), '{}'::jsonb);
  perform app.enqueue_recalculation(v_org, 'counterparty_merged', p_from);
  return p_into;
end $$;

-- ---------------------------------------------------------------------------
-- Bank accounts
-- ---------------------------------------------------------------------------

create function api.create_bank_account(p_org uuid, p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'financials.edit');

  if coalesce(trim(p_input ->> 'name'), '') = ''
     or coalesce(trim(p_input ->> 'bank_name'), '') = '' then
    raise exception 'VALIDATION: a name and bank name are required' using errcode = '22023';
  end if;

  insert into public.bank_accounts
         (organization_id, name, bank_name, account_number_masked, sort_code_masked,
          currency, account_type, ledger_account_id)
  values (p_org, trim(p_input ->> 'name'), trim(p_input ->> 'bank_name'),
          p_input ->> 'account_number_masked', p_input ->> 'sort_code_masked',
          coalesce(p_input ->> 'currency', 'GBP'),
          coalesce((p_input ->> 'account_type')::public.bank_account_type_enum, 'current'),
          (p_input ->> 'ledger_account_id')::uuid)
  returning id into v_id;

  perform app.audit(p_org, 'bank_account.created', 'bank_accounts', v_id, null, p_input, '{}'::jsonb);
  return v_id;
exception
  -- ADR-029.4: a second account with the same masked identity is refused, and the UI offers the
  -- existing one. Two rows for one real account would double every cash figure.
  when unique_violation then
    raise exception 'CONFLICT: an account with those details already exists' using errcode = '23505';
end $$;

create function api.set_opening_balance(p_account uuid, p_amount numeric, p_date date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_before jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, to_jsonb(b) into v_org, v_before
    from public.bank_accounts b where b.id = p_account;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'financials.edit');
  if (p_amount is null) <> (p_date is null) then
    raise exception 'VALIDATION: an opening balance needs both an amount and a date'
      using errcode = '22023';
  end if;

  update public.bank_accounts
     set opening_balance = p_amount, opening_balance_date = p_date
   where organization_id = v_org and id = p_account;

  perform app.audit(v_org, 'bank_account.opening_balance_set', 'bank_accounts', p_account,
                    v_before, jsonb_build_object('opening_balance', p_amount,
                                                 'opening_balance_date', p_date), '{}'::jsonb);
  -- An opening balance moves every cash figure from that date forward.
  perform app.enqueue_recalculation(v_org, 'banking_edit', p_account);
  return p_account;
end $$;

-- ---------------------------------------------------------------------------
-- Bank categorisation and transfers (ADR-028, ADR-034)
-- ---------------------------------------------------------------------------

-- Closes the open category_history row and opens a new one. Both callers below need it, and doing it
-- in one place is what guarantees exactly one open row per transaction at any instant.
create function app.write_category_history(
  p_org uuid, p_txn uuid, p_category uuid,
  p_is_transfer boolean, p_kind public.transfer_kind_enum, p_source public.category_source_enum
) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.category_history
     set valid_to = now()
   where organization_id = p_org and bank_transaction_id = p_txn and valid_to is null;

  insert into public.category_history
         (organization_id, bank_transaction_id, category_account_id, is_transfer,
          transfer_kind, source, changed_by)
  values (p_org, p_txn, p_category, p_is_transfer, p_kind, p_source, app.uid());
end $$;

create function api.override_bank_category(p_txn uuid, p_account uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_before jsonb; v_is_transfer boolean; v_kind public.transfer_kind_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select t.organization_id, to_jsonb(t), t.is_transfer, t.transfer_kind
    into v_org, v_before, v_is_transfer, v_kind
    from public.bank_transactions t where t.id = p_txn;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'banking.reconcile');

  if p_account is not null
     and not exists (select 1 from public.accounts a
                      where a.organization_id = v_org and a.id = p_account) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext('org:' || v_org::text));

  update public.bank_transactions
     set category_account_id = p_account, category_source = 'user'
   where organization_id = v_org and id = p_txn;

  perform app.write_category_history(v_org, p_txn, p_account, v_is_transfer, v_kind, 'user');
  perform app.audit(v_org, 'bank_txn.recategorised', 'bank_transactions', p_txn, v_before,
                    jsonb_build_object('category_account_id', p_account), '{}'::jsonb);
  perform app.enqueue_recalculation(v_org, 'banking_edit', p_txn);
  return p_txn;
end $$;

create function api.mark_transfer(p_txn uuid, p_pair uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org       uuid;
  v_pair_org  uuid;
  v_kind      public.transfer_kind_enum;
  v_this_type public.bank_account_type_enum;
  v_pair_type public.bank_account_type_enum;
  v_category  uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select t.organization_id, t.category_account_id into v_org, v_category
    from public.bank_transactions t where t.id = p_txn;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'banking.reconcile');

  if p_pair is null then
    -- Unmarking: the row returns to ordinary cash and re-enters every cash metric.
    v_kind := 'none';
  else
    select t.organization_id into v_pair_org from public.bank_transactions t where t.id = p_pair;
    if v_pair_org is distinct from v_org then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    if p_pair = p_txn then
      raise exception 'VALIDATION: a transaction cannot be its own transfer pair'
        using errcode = '22023';
    end if;

    -- ADR-028: the kind is DERIVED from the two account types, never taken from the caller. Only
    -- `cash_transfer` is excluded from cash metrics, so letting a user assert the kind would let
    -- them make a real outflow disappear from the cash figures.
    select b.account_type into v_this_type
      from public.bank_transactions t join public.bank_accounts b
        on b.organization_id = t.organization_id and b.id = t.bank_account_id
     where t.organization_id = v_org and t.id = p_txn;
    select b.account_type into v_pair_type
      from public.bank_transactions t join public.bank_accounts b
        on b.organization_id = t.organization_id and b.id = t.bank_account_id
     where t.organization_id = v_org and t.id = p_pair;

    v_kind := case
      when v_this_type in ('current', 'savings') and v_pair_type in ('current', 'savings')
        then 'cash_transfer'
      when v_pair_type = 'credit_card' or v_this_type = 'credit_card' then 'card_repayment'
      when v_pair_type = 'loan' or v_this_type = 'loan' then 'loan_repayment'
      else 'other_transfer' end;
  end if;

  perform pg_advisory_xact_lock(hashtext('org:' || v_org::text));

  update public.bank_transactions
     set transfer_pair_id = p_pair, transfer_kind = v_kind, is_transfer = (v_kind <> 'none')
   where organization_id = v_org and id = p_txn;
  -- Both legs describe one movement, so both must carry the same verdict.
  if p_pair is not null then
    update public.bank_transactions
       set transfer_pair_id = p_txn, transfer_kind = v_kind, is_transfer = true
     where organization_id = v_org and id = p_pair;
    perform app.write_category_history(v_org, p_pair, null, true, v_kind, 'user');
  end if;

  perform app.write_category_history(v_org, p_txn, v_category, (v_kind <> 'none'), v_kind, 'user');
  perform app.audit(v_org, 'bank_txn.transfer_marked', 'bank_transactions', p_txn, null,
                    jsonb_build_object('pair', p_pair, 'transfer_kind', v_kind), '{}'::jsonb);
  perform app.enqueue_recalculation(v_org, 'banking_edit', p_txn);
  return p_txn;
end $$;

-- ---------------------------------------------------------------------------
-- Corrections: supersession, never in-place amendment (ADR-026.6)
-- ---------------------------------------------------------------------------

create function api.supersede_record(
  p_table       public.financial_record_table_enum,
  p_record      uuid,
  p_replacement uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_replacement_org uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  execute format('select organization_id from public.%I where id = $1', p_table::text)
    into v_org using p_record;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'financials.edit');

  execute format('select organization_id from public.%I where id = $1', p_table::text)
    into v_replacement_org using p_replacement;
  if v_replacement_org is distinct from v_org then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext('org:' || v_org::text));
  perform app.supersede_row(v_org, p_table, p_record, p_replacement);

  perform app.audit(v_org, 'record.superseded', p_table::text, p_record, null,
                    jsonb_build_object('replacement', p_replacement), '{}'::jsonb);
  perform app.enqueue_recalculation(v_org, 'record_superseded', p_record);
  return p_replacement;
end $$;

-- ADR-047.4 / IMP-GL-011: an opening-balance journal is not P&L activity. The flag applies to every
-- line of the journal, because a journal is one economic event however many lines express it.
create function api.set_opening_balance_flag(p_entry uuid, p_flag boolean)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_journal text; v_count integer;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select e.organization_id, e.journal_ref into v_org, v_journal
    from public.ledger_entries e where e.id = p_entry;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'financials.edit');

  update public.ledger_entries
     set is_opening_balance = p_flag
   where organization_id = v_org
     and (journal_ref is not null and journal_ref = v_journal or id = p_entry);
  get diagnostics v_count = row_count;

  perform app.audit(v_org, 'ledger.opening_flag_changed', 'ledger_entries', p_entry, null,
                    jsonb_build_object('is_opening_balance', p_flag, 'lines', v_count), '{}'::jsonb);
  perform app.enqueue_recalculation(v_org, 'import_commit', p_entry);
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Ownership and grants (ADR-044.3)
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, n.nspname
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'api')
       and pg_catalog.pg_get_userbyid(p.proowner) <> 'motion_definer'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public', f.sig);
    if f.nspname = 'api' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
