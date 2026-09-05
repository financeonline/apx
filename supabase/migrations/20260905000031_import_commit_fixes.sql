-- MOTION — Phase 3 (plan Phase 5) · Two corrections to the commit path, both found by the
-- integration suite rather than by inspection.
--
-- 1. A COALESCED RECALCULATION LEFT THE BATCH UNLINKED.
--    `app.enqueue_recalculation` used `on conflict do nothing`, so when a run was already queued for
--    the organization it returned NULL and `import_batches.calculation_job_id` was left empty. The
--    coalescing is correct (ADR-031.1: one queued run per organization), but the batch must still
--    name the job that will do its work, or the review screen cannot say "figures updating" and
--    §11.6 has nothing to store. It now returns the existing queued job.
--
-- 2. RAISING ON A DUPLICATE COLLISION UNDID THE RE-FLAGGING.
--    §9.3 requires that a commit which collides "returns the batch to `awaiting_review` and
--    re-flags the affected rows", so the reviewer sees "N rows now duplicate a batch committed at
--    {time}". The function raised an exception to abort — which rolled back the whole transaction,
--    including the re-flagging and the status change, leaving the reviewer with a batch that looked
--    untouched and an error they could only retry into. A single transaction cannot both abort and
--    leave a trace. The re-check therefore runs BEFORE any record is written and RETURNS a conflict
--    result instead of raising; the flagging persists, no records exist, and the service layer turns
--    the result into a ConflictError for the caller.

create or replace function app.enqueue_recalculation(
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
  on conflict do nothing
  returning id into v_job;

  if v_job is null then
    -- ADR-031.1: the idempotency index covers QUEUED jobs only, so a collision means a run is
    -- already waiting and will pick this change up. Return it, so the caller can link to it.
    select j.id into v_job
      from public.jobs j
     where j.organization_id = p_org and j.job_type = 'calculation.run' and j.status = 'queued'
     order by j.created_at desc
     limit 1;
  end if;

  return v_job;
end $$;

create or replace function app.commit_import_batch(p_org uuid, p_batch uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_target      public.import_target_enum;
  v_rec_table   public.financial_record_table_enum;
  v_type        public.import_type_enum;
  v_method      public.extraction_method_enum;
  v_doc         uuid;
  v_bank        uuid;
  v_sign        public.balance_sign_enum;
  v_basis       public.balance_basis_enum;
  v_kind        public.balance_kind_enum;
  v_assurance   public.assurance_level_enum;
  v_reconciled  boolean;
  v_collisions  integer;
  v_committed   integer := 0;
  v_superseded  integer := 0;
  v_job         uuid;
  v_record_id   uuid;
  r             record;
begin
  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));
  perform app.assert_batch_committable(p_org, p_batch);

  select b.target_table, b.import_type, b.extraction_method, b.source_document_id, b.bank_account_id,
         b.balance_sign, b.balance_basis
    into v_target, v_type, v_method, v_doc, v_bank, v_sign, v_basis
    from public.import_batches b where b.organization_id = p_org and b.id = p_batch;

  v_rec_table := v_target::text::public.financial_record_table_enum;

  -- §9.3, BEFORE anything is written. On a collision the batch goes back to review with the rows
  -- re-flagged and the function RETURNS — it does not raise, because raising would roll back the
  -- very evidence the reviewer needs.
  v_collisions := app.rerun_dedupe(p_org, p_batch, v_rec_table);
  if v_collisions > 0 then
    update public.import_batches
       set status = 'awaiting_review',
           error_summary = jsonb_build_object(
             'stage', 'dedupe', 'collisions', v_collisions, 'at', now())
     where organization_id = p_org and id = p_batch;

    perform app.audit(p_org, 'import.commit_conflicted', 'import_batches', p_batch, null,
                      jsonb_build_object('collisions', v_collisions), '{}'::jsonb, p_actor);

    return jsonb_build_object('status', 'conflict', 'collisions', v_collisions,
                              'committed', 0, 'superseded', 0);
  end if;

  update public.import_batches set status = 'committing'
   where organization_id = p_org and id = p_batch;

  v_reconciled := not exists (
    select 1 from public.import_batches b, lateral jsonb_array_elements(b.batch_issues) i
     where b.organization_id = p_org and b.id = p_batch
       and i ->> 'code' in ('IMP-BAL-006', 'IMP-BAL-007'));

  v_assurance := case v_method
    when 'pdf_claude' then 'inferred'::public.assurance_level_enum
    when 'pdf_text'   then case when v_reconciled then 'verified' else 'calculated' end::public.assurance_level_enum
    else 'verified'::public.assurance_level_enum
  end;

  if v_target = 'period_balances' then
    v_kind := case v_type
      when 'trial_balance' then 'trial_balance'
      when 'pnl_report'    then 'pnl_report'
      else 'balance_sheet' end::public.balance_kind_enum;
  end if;

  for r in
    select * from public.import_rows ir
     where ir.organization_id = p_org and ir.batch_id = p_batch
       and (ir.status in ('valid', 'warning')
            or (ir.status = 'duplicate' and ir.reviewer_decision = 'keep'))
       and ir.reviewer_decision <> 'skip'
     order by ir.row_number
  loop
    if v_target = 'ledger_entries' then
      insert into public.ledger_entries
        (organization_id, entry_date, period_id, account_id, direction, amount, currency,
         description, reference, counterparty_id, journal_ref, source_document_id,
         import_batch_id, import_row_id, source_ref, record_status, assurance_level,
         dedupe_hash, duplicate_reviewed, is_opening_balance)
      values
        (p_org, (r.mapped_data ->> 'entry_date')::date, '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'account_id')::uuid,
         (r.mapped_data ->> 'direction')::public.entry_direction_enum,
         (r.mapped_data ->> 'amount')::numeric, coalesce(r.mapped_data ->> 'currency', 'GBP'),
         r.mapped_data ->> 'description', r.mapped_data ->> 'reference',
         (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'journal_ref',
         v_doc, p_batch, r.id, r.source_ref, 'accepted', v_assurance,
         r.dedupe_hash, r.reviewer_decision = 'keep',
         coalesce((r.mapped_data ->> 'is_opening_balance')::boolean, false))
      returning id into v_record_id;

    elsif v_target = 'bank_transactions' then
      insert into public.bank_transactions
        (organization_id, bank_account_id, transaction_date, posted_date, period_id, amount,
         currency, description_raw, counterparty_name_raw, counterparty_id, reference,
         balance_after, source_document_id, import_batch_id, import_row_id, source_ref,
         record_status, assurance_level, dedupe_hash, duplicate_reviewed)
      values
        (p_org, v_bank, (r.mapped_data ->> 'transaction_date')::date,
         (r.mapped_data ->> 'posted_date')::date, '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'amount')::numeric, coalesce(r.mapped_data ->> 'currency', 'GBP'),
         r.mapped_data ->> 'description', r.mapped_data ->> 'counterparty_name',
         (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'reference',
         (r.mapped_data ->> 'balance_after')::numeric,
         v_doc, p_batch, r.id, r.source_ref, 'accepted', v_assurance,
         r.dedupe_hash, r.reviewer_decision = 'keep')
      returning id into v_record_id;

    elsif v_target = 'invoices' then
      insert into public.invoices
        (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date,
         period_id, subtotal, tax_amount, total_amount, amount_paid, currency, status, paid_date,
         description, source_document_id, import_batch_id, import_row_id, source_ref,
         record_status, assurance_level, dedupe_hash, duplicate_reviewed)
      values
        (p_org, (r.mapped_data ->> 'invoice_type')::public.invoice_type_enum,
         (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'invoice_number',
         (r.mapped_data ->> 'issue_date')::date, (r.mapped_data ->> 'due_date')::date,
         '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'subtotal')::numeric, (r.mapped_data ->> 'tax_amount')::numeric,
         (r.mapped_data ->> 'total_amount')::numeric,
         coalesce((r.mapped_data ->> 'amount_paid')::numeric, 0),
         coalesce(r.mapped_data ->> 'currency', 'GBP'),
         coalesce((r.mapped_data ->> 'status')::public.invoice_status_enum, 'open'),
         (r.mapped_data ->> 'paid_date')::date, r.mapped_data ->> 'description',
         v_doc, p_batch, r.id, r.source_ref, 'accepted', v_assurance,
         r.dedupe_hash, r.reviewer_decision = 'keep')
      returning id into v_record_id;

      if r.duplicate_of_table = 'invoices' and r.duplicate_of_id is not null then
        perform app.supersede_row(p_org, 'invoices', r.duplicate_of_id, v_record_id, p_batch);
        v_superseded := v_superseded + 1;
      end if;

    elsif v_target = 'period_balances' then
      insert into public.period_balances
        (organization_id, period_start, period_id, account_id, opening_balance, debit_total,
         credit_total, closing_balance, currency, balance_kind, balance_basis,
         source_document_id, import_batch_id, import_row_id, source_ref,
         record_status, assurance_level, duplicate_reviewed)
      values
        (p_org, (r.mapped_data ->> 'period_start')::date, '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'account_id')::uuid,
         (r.mapped_data ->> 'opening_balance')::numeric,
         (r.mapped_data ->> 'debit_total')::numeric, (r.mapped_data ->> 'credit_total')::numeric,
         case when v_sign = 'reporting'
                and public.standard_category_account_type(
                      (select a.standard_category from public.accounts a
                        where a.organization_id = p_org
                          and a.id = (r.mapped_data ->> 'account_id')::uuid))
                    in ('income', 'liability', 'equity')
              then -((r.mapped_data ->> 'closing_balance')::numeric)
              else (r.mapped_data ->> 'closing_balance')::numeric end,
         coalesce(r.mapped_data ->> 'currency', 'GBP'), v_kind, coalesce(v_basis, 'movement'),
         v_doc, p_batch, r.id, r.source_ref, 'accepted', v_assurance, r.reviewer_decision = 'keep')
      returning id into v_record_id;
    end if;

    perform app.record_status_event(p_org, v_rec_table, v_record_id, 'accepted', null, p_batch);

    update public.import_rows
       set status = 'committed', committed_table = v_rec_table, committed_record_id = v_record_id
     where organization_id = p_org and id = r.id;

    v_committed := v_committed + 1;
  end loop;

  if v_target = 'period_balances' then
    for r in
      select old.id as old_id, old.period_id, old.balance_kind
        from public.period_balances old
       where old.organization_id = p_org
         and old.balance_kind = v_kind
         and old.record_status = 'accepted'
         and old.superseded_by is null
         and old.import_batch_id is distinct from p_batch
         and old.period_id in (select distinct nb.period_id from public.period_balances nb
                                where nb.organization_id = p_org and nb.import_batch_id = p_batch)
    loop
      perform app.supersede_row(
        p_org, 'period_balances', r.old_id,
        (select nw.id from public.period_balances nw
          where nw.organization_id = p_org and nw.import_batch_id = p_batch
            and nw.period_id = r.period_id and nw.balance_kind = r.balance_kind
          limit 1),
        p_batch);
      v_superseded := v_superseded + 1;
    end loop;
  end if;

  update public.import_rows
     set status = 'skipped'
   where organization_id = p_org and batch_id = p_batch
     and (reviewer_decision = 'skip' or status in ('duplicate', 'error'))
     and status <> 'committed';

  update public.import_batches
     set status = 'committed', committed_at = now(), reviewed_by = p_actor,
         row_counts = jsonb_build_object(
           'committed', v_committed, 'superseded', v_superseded,
           'total', (select count(*) from public.import_rows ir
                      where ir.organization_id = p_org and ir.batch_id = p_batch)),
         fiscal_year_start_month_at_commit =
           (select o.fiscal_year_start_month from public.organizations o where o.id = p_org)
   where organization_id = p_org and id = p_batch;

  v_job := app.enqueue_recalculation(p_org, 'import_commit', p_batch);
  update public.import_batches set calculation_job_id = v_job
   where organization_id = p_org and id = p_batch and v_job is not null;

  perform app.audit(p_org, 'import.committed', 'import_batches', p_batch, null,
                    jsonb_build_object('committed', v_committed, 'superseded', v_superseded,
                                       'assurance', v_assurance, 'method', v_method),
                    '{}'::jsonb, p_actor);

  return jsonb_build_object('status', 'committed', 'committed', v_committed,
                            'superseded', v_superseded, 'job', v_job);
end $$;

-- Replace must not proceed when the new batch's commit conflicted: the old batch has already been
-- rolled back at that point, so silently returning would leave the organization with neither.
create or replace function api.replace_import_batch(p_old_batch uuid, p_new_batch uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid; v_new_org uuid;
  v_old_type public.import_type_enum; v_new_type public.import_type_enum;
  v_rollback jsonb; v_commit jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'VALIDATION: a reason is required to replace an import' using errcode = '22023';
  end if;

  select b.organization_id, b.import_type into v_org, v_old_type
    from public.import_batches b where b.id = p_old_batch;
  select b.organization_id, b.import_type into v_new_org, v_new_type
    from public.import_batches b where b.id = p_new_batch;

  if v_org is null or v_new_org is distinct from v_org
     or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');

  if v_old_type <> v_new_type then
    raise exception 'VALIDATION: a batch can only be replaced by one of the same type'
      using errcode = '22023';
  end if;
  if p_old_batch = p_new_batch then
    raise exception 'VALIDATION: a batch cannot replace itself' using errcode = '22023';
  end if;

  v_rollback := app.rollback_import_batch(v_org, p_old_batch, p_reason, app.uid());

  update public.import_rows r
     set status = 'valid', duplicate_of_table = null, duplicate_of_id = null
   where r.organization_id = v_org and r.batch_id = p_new_batch
     and r.status = 'duplicate'
     and exists (select 1 from public.import_rows old
                  where old.organization_id = v_org and old.batch_id = p_old_batch
                    and old.committed_record_id = r.duplicate_of_id);

  v_commit := app.commit_import_batch(v_org, p_new_batch, app.uid());

  -- Both halves are one transaction, so a conflict must abort the whole thing rather than leave the
  -- old batch rolled back and the new one uncommitted.
  if (v_commit ->> 'status') = 'conflict' then
    raise exception 'CONFLICT: the replacement file collides with data committed since it was checked'
      using errcode = '40001';
  end if;

  update public.import_batches set replaced_batch_id = p_old_batch
   where organization_id = v_org and id = p_new_batch;

  perform app.audit(v_org, 'import.replaced', 'import_batches', p_new_batch, null,
                    jsonb_build_object('replaced', p_old_batch, 'reason', p_reason,
                                       'rollback', v_rollback, 'commit', v_commit), '{}'::jsonb);

  return jsonb_build_object('rolledBack', v_rollback, 'committed', v_commit);
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, n.nspname
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'api', 'api_server')
       and pg_catalog.pg_get_userbyid(p.proowner) <> 'motion_definer'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public, authenticated, anon', f.sig);
    if f.nspname = 'api' then
      execute format('grant execute on function %s to authenticated', f.sig);
    elsif f.nspname = 'api_server' then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
