-- MOTION — Phase 3 (plan Phase 5) · Rolling back and replacing a committed batch.
-- Contract: IMPORT_ENGINE.md §12; ADR-029.3, ADR-047.1, ADR-047.9 (R2-B-01, R2-B-09).
--
-- Nothing is ever hard-deleted (ADR-012). A rollback marks records `rejected` and writes the
-- lifecycle events that let evidence still explain a figure published last month.
--
-- The subtle part is dependants. Statement exports overlap: batch B skipped four rows because
-- batch A already held them. If A is now rolled back, those four rows exist nowhere — the figures
-- would quietly lose them. So the rollback PROMOTES them into B from their stored `mapped_data`
-- instead of refusing (ADR-047.9). Refusing until B and C are also rolled back, the earlier design,
-- made a correction to January impossible once February had been imported.

create function app.promote_dependants(p_org uuid, p_batch uuid, p_actor uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_target     public.import_target_enum;
  v_rec_table  public.financial_record_table_enum;
  v_doc        uuid;
  v_bank       uuid;
  v_record_id  uuid;
  v_promoted   integer := 0;
  r            record;
begin
  for r in
    -- Rows of OTHER committed batches that were skipped because this batch already held them.
    select dep.id, dep.batch_id, dep.mapped_data, dep.source_ref, dep.dedupe_hash,
           depb.target_table, depb.source_document_id, depb.bank_account_id
      from public.import_rows dep
      join public.import_batches depb
        on depb.organization_id = dep.organization_id and depb.id = dep.batch_id
      join public.import_rows src
        on src.organization_id = dep.organization_id and src.batch_id = p_batch
       and src.committed_record_id = dep.duplicate_of_id
     where dep.organization_id = p_org
       and dep.batch_id <> p_batch
       and depb.status = 'committed'
       and dep.reviewer_decision = 'skip'
       and dep.duplicate_of_id is not null
  loop
    -- The refusal condition (ADR-047.9): a dependant with nothing to promote FROM cannot be saved,
    -- and losing it silently is the one outcome that is not acceptable.
    if r.mapped_data is null then
      raise exception 'CONFLICT: a row of batch % depends on this batch and cannot be recovered; roll that batch back first', r.batch_id
        using errcode = '40001';
    end if;

    v_target := r.target_table;
    v_rec_table := v_target::text::public.financial_record_table_enum;
    v_doc := r.source_document_id;
    v_bank := r.bank_account_id;

    if v_target = 'bank_transactions' then
      insert into public.bank_transactions
        (organization_id, bank_account_id, transaction_date, period_id, amount, currency,
         description_raw, reference, source_document_id, import_batch_id, import_row_id,
         source_ref, record_status, assurance_level, dedupe_hash, promoted_from_batch_id)
      values (p_org, v_bank, (r.mapped_data ->> 'transaction_date')::date,
              '00000000-0000-0000-0000-000000000000',
              (r.mapped_data ->> 'amount')::numeric,
              coalesce(r.mapped_data ->> 'currency', 'GBP'),
              r.mapped_data ->> 'description', r.mapped_data ->> 'reference',
              v_doc, r.batch_id, r.id, r.source_ref, 'accepted', 'verified',
              r.dedupe_hash, p_batch)
      returning id into v_record_id;

    elsif v_target = 'ledger_entries' then
      insert into public.ledger_entries
        (organization_id, entry_date, period_id, account_id, direction, amount, currency,
         description, reference, journal_ref, source_document_id, import_batch_id, import_row_id,
         source_ref, record_status, assurance_level, dedupe_hash, promoted_from_batch_id)
      values (p_org, (r.mapped_data ->> 'entry_date')::date,
              '00000000-0000-0000-0000-000000000000',
              (r.mapped_data ->> 'account_id')::uuid,
              (r.mapped_data ->> 'direction')::public.entry_direction_enum,
              (r.mapped_data ->> 'amount')::numeric,
              coalesce(r.mapped_data ->> 'currency', 'GBP'),
              r.mapped_data ->> 'description', r.mapped_data ->> 'reference',
              r.mapped_data ->> 'journal_ref', v_doc, r.batch_id, r.id, r.source_ref,
              'accepted', 'verified', r.dedupe_hash, p_batch)
      returning id into v_record_id;

    elsif v_target = 'invoices' then
      insert into public.invoices
        (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date,
         period_id, total_amount, amount_paid, currency, status, source_document_id,
         import_batch_id, import_row_id, source_ref, record_status, assurance_level,
         dedupe_hash, promoted_from_batch_id)
      values (p_org, (r.mapped_data ->> 'invoice_type')::public.invoice_type_enum,
              (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'invoice_number',
              (r.mapped_data ->> 'issue_date')::date, (r.mapped_data ->> 'due_date')::date,
              '00000000-0000-0000-0000-000000000000',
              (r.mapped_data ->> 'total_amount')::numeric,
              coalesce((r.mapped_data ->> 'amount_paid')::numeric, 0),
              coalesce(r.mapped_data ->> 'currency', 'GBP'),
              coalesce((r.mapped_data ->> 'status')::public.invoice_status_enum, 'open'),
              v_doc, r.batch_id, r.id, r.source_ref, 'accepted', 'verified',
              r.dedupe_hash, p_batch)
      returning id into v_record_id;

    else
      -- Balance rows supersede at batch scope rather than row scope, so a skipped balance row has
      -- no independent existence to promote; the batch-scoped restore below covers them.
      continue;
    end if;

    perform app.record_status_event(p_org, v_rec_table, v_record_id, 'accepted', null, r.batch_id);

    update public.import_rows
       set status = 'committed', committed_table = v_rec_table, committed_record_id = v_record_id,
           reviewer_decision = 'keep',
           reviewer_reason = coalesce(reviewer_reason, '') ||
             ' (kept automatically when the batch it duplicated was rolled back)'
     where organization_id = p_org and id = r.id;

    v_promoted := v_promoted + 1;
  end loop;

  return v_promoted;
end $$;

create function app.rollback_import_batch(p_org uuid, p_batch uuid, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_target    public.import_target_enum;
  v_rec_table public.financial_record_table_enum;
  v_status    public.import_batch_status_enum;
  v_promoted  integer;
  v_rejected  integer := 0;
  v_restored  integer := 0;
  r           record;
begin
  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));

  select b.target_table, b.status into v_target, v_status
    from public.import_batches b where b.organization_id = p_org and b.id = p_batch;
  if v_target is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status <> 'committed' then
    raise exception 'CONFLICT: only a committed batch can be rolled back' using errcode = '40001';
  end if;
  v_rec_table := v_target::text::public.financial_record_table_enum;

  -- Step 1: dependants are promoted, not refused (ADR-047.9).
  v_promoted := app.promote_dependants(p_org, p_batch, p_actor);

  -- Step 3 (before 2, because the chain is read from rows that are about to be rejected):
  -- re-link supersession chains IN THE COLUMN (ADR-047.1). If this batch's row B superseded A and
  -- was itself superseded by C, then A.superseded_by ← C. If B was current, A becomes current again
  -- and a `restored` event is written; the engine keys on the column and sees A immediately, while
  -- evidence as-of resolution reads the events.
  for r in
    execute format($f$
      select old.id as old_id, mine.superseded_by as next_id
        from public.%I mine
        join public.%I old
          on old.organization_id = mine.organization_id and old.superseded_by = mine.id
       where mine.organization_id = $1 and mine.import_batch_id = $2
      $f$, v_rec_table::text, v_rec_table::text)
    using p_org, p_batch
  loop
    execute format('update public.%I set superseded_by = $1 where organization_id = $2 and id = $3',
                   v_rec_table::text)
      using r.next_id, p_org, r.old_id;

    if r.next_id is null then
      -- A restored row is current again. `superseded_at_set` permits the reset to NULL precisely so
      -- this can happen (ADR-047.1).
      perform app.record_status_event(p_org, v_rec_table, r.old_id, 'restored', null, p_batch);
    else
      perform app.record_status_event(p_org, v_rec_table, r.old_id, 'unsuperseded', r.next_id, p_batch);
    end if;
    v_restored := v_restored + 1;
  end loop;

  -- Step 2: this batch's records are soft-rejected. Never deleted (ADR-012).
  for r in
    -- The cast is required: a text parameter cannot be compared with an enum column, and the
    -- failure is a runtime error inside dynamic SQL rather than anything the parser would catch.
    execute format($f$select id from public.%I
                       where organization_id = $1 and import_batch_id = $2
                         and record_status = 'accepted'::public.record_status_enum$f$,
                   v_rec_table::text)
    using p_org, p_batch
  loop
    execute format($f$update public.%I set record_status = 'rejected', rejected_reason = $1
                      where organization_id = $2 and id = $3$f$, v_rec_table::text)
      using coalesce(p_reason, 'batch rolled back'), p_org, r.id;
    perform app.record_status_event(p_org, v_rec_table, r.id, 'rejected', null, p_batch);
    v_rejected := v_rejected + 1;
  end loop;

  update public.import_rows
     set status = 'rejected'
   where organization_id = p_org and batch_id = p_batch and status = 'committed';

  update public.import_batches
     set status = 'rolled_back', rolled_back_at = now(), rolled_back_reason = p_reason
   where organization_id = p_org and id = p_batch;

  perform app.enqueue_recalculation(p_org, 'import_rollback', p_batch);

  perform app.audit(p_org, 'import.rolled_back', 'import_batches', p_batch, null,
                    jsonb_build_object('reason', p_reason, 'rejected', v_rejected,
                                       'promoted', v_promoted, 'restored', v_restored),
                    '{}'::jsonb, p_actor);

  return jsonb_build_object('rejected', v_rejected, 'promoted', v_promoted, 'restored', v_restored);
end $$;

create function api.rollback_import_batch(p_batch uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'VALIDATION: a reason is required to roll back an import' using errcode = '22023';
  end if;

  select b.organization_id into v_org from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');

  return app.rollback_import_batch(v_org, p_batch, p_reason, app.uid());
end $$;

-- §12 Replace: the normal corrected-file path. Roll back the old batch and commit the new one in
-- ONE transaction, so the organization is never briefly missing a month of data.
create function api.replace_import_batch(p_old_batch uuid, p_new_batch uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_new_org  uuid;
  v_old_type public.import_type_enum;
  v_new_type public.import_type_enum;
  v_rollback jsonb;
  v_commit   jsonb;
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

  -- Replacing a trial balance with a bank statement is not a replacement; it is two mistakes.
  if v_old_type <> v_new_type then
    raise exception 'VALIDATION: a batch can only be replaced by one of the same type'
      using errcode = '22023';
  end if;
  if p_old_batch = p_new_batch then
    raise exception 'VALIDATION: a batch cannot replace itself' using errcode = '22023';
  end if;

  v_rollback := app.rollback_import_batch(v_org, p_old_batch, p_reason, app.uid());

  -- The new batch's rows were marked duplicate against records that are now rejected, so they must
  -- be released before the commit's own re-check runs (§12).
  update public.import_rows r
     set status = 'valid', duplicate_of_table = null, duplicate_of_id = null
   where r.organization_id = v_org and r.batch_id = p_new_batch
     and r.status = 'duplicate'
     and exists (
       select 1 from public.import_rows old
        where old.organization_id = v_org and old.batch_id = p_old_batch
          and old.committed_record_id = r.duplicate_of_id);

  v_commit := app.commit_import_batch(v_org, p_new_batch, app.uid());

  update public.import_batches
     set replaced_batch_id = p_old_batch
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
