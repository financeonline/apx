-- MOTION — Phase 3 (plan Phase 5) · Committing a batch into financial records.
-- Contract: IMPORT_ENGINE.md §9.3, §11; ADR-029.1/2, ADR-034, ADR-047.3/9.

-- ---------------------------------------------------------------------------
-- §9.3 Duplicate re-check, inside the commit transaction.
-- ---------------------------------------------------------------------------
-- Validation-time results go stale: another batch may have committed in the meantime, or the same
-- statement may be open in a second tab. Comparing STORED hashes means there is no second
-- implementation of the §9.1 recipe to drift from the TypeScript one.
create function app.rerun_dedupe(p_org uuid, p_batch uuid, p_target public.financial_record_table_enum)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_collisions integer;
begin
  execute format($f$
    with fresh as (
      select r.id, r.dedupe_hash, t.id as existing_id
        from public.import_rows r
        join public.%I t
          on t.organization_id = r.organization_id
         and t.dedupe_hash = r.dedupe_hash
         and t.record_status = 'accepted'
         and t.superseded_by is null
         and t.import_batch_id is distinct from r.batch_id
       where r.organization_id = $1
         and r.batch_id = $2
         and r.status in ('valid', 'warning')
         and r.reviewer_decision <> 'skip'
         and r.dedupe_hash is not null)
    update public.import_rows r
       set status = 'duplicate',
           duplicate_of_table = $3,
           duplicate_of_id = fresh.existing_id,
           reviewer_decision = 'none',
           issues = r.issues || jsonb_build_array(jsonb_build_object(
             'code', 'IMP-DUP-001', 'severity', 'duplicate',
             'message', 'This row duplicates a record committed since this file was checked.'))
      from fresh
     where r.id = fresh.id
    $f$, p_target::text)
  using p_org, p_batch, p_target;

  get diagnostics v_collisions = row_count;
  return v_collisions;
end $$;

-- ---------------------------------------------------------------------------
-- The commit body, shared by the user path and the large-batch worker path.
-- ---------------------------------------------------------------------------
create function app.commit_import_batch(p_org uuid, p_batch uuid, p_actor uuid)
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
  v_snapshot    jsonb;
  v_assurance   public.assurance_level_enum;
  v_reconciled  boolean;
  v_collisions  integer;
  v_committed   integer := 0;
  v_superseded  integer := 0;
  v_job         uuid;
  v_record_id   uuid;
  r             record;
begin
  -- The organization advisory lock. Two reviewers committing overlapping statements at the same
  -- instant would otherwise both pass their duplicate re-check (§11.2).
  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));

  perform app.assert_batch_committable(p_org, p_batch);

  select b.target_table, b.import_type, b.extraction_method, b.source_document_id, b.bank_account_id,
         b.balance_sign, b.balance_basis, b.mapping_snapshot
    into v_target, v_type, v_method, v_doc, v_bank, v_sign, v_basis, v_snapshot
    from public.import_batches b where b.organization_id = p_org and b.id = p_batch;

  v_rec_table := v_target::text::public.financial_record_table_enum;
  update public.import_batches set status = 'committing'
   where organization_id = p_org and id = p_batch;

  -- §9.3: abort on any collision that appeared since validation.
  v_collisions := app.rerun_dedupe(p_org, p_batch, v_rec_table);
  if v_collisions > 0 then
    update public.import_batches
       set status = 'awaiting_review',
           error_summary = jsonb_build_object('stage', 'dedupe', 'collisions', v_collisions)
     where organization_id = p_org and id = p_batch;
    raise exception 'CONFLICT: % row(s) now duplicate a batch committed since this file was checked', v_collisions
      using errcode = '40001';
  end if;

  -- Assurance follows the extraction method (§11.4). Positional PDF parsing is heuristic, so it is
  -- `calculated` unless the statement reconciled; an AI reading is always `inferred`.
  v_reconciled := not exists (
    select 1 from public.import_batches b, lateral jsonb_array_elements(b.batch_issues) i
     where b.organization_id = p_org and b.id = p_batch
       and i ->> 'code' in ('IMP-BAL-006', 'IMP-BAL-007'));

  v_assurance := case v_method
    when 'pdf_claude' then 'inferred'::public.assurance_level_enum
    when 'pdf_text'   then case when v_reconciled then 'verified' else 'calculated' end::public.assurance_level_enum
    else 'verified'::public.assurance_level_enum
  end;

  -- The balance kind this batch writes. Needed before the insert loop, and again for the
  -- batch-scoped supersession that follows it (ADR-029.2).
  if v_target = 'period_balances' then
    v_kind := case v_type
      when 'trial_balance' then 'trial_balance'
      when 'pnl_report'    then 'pnl_report'
      else 'balance_sheet' end::public.balance_kind_enum;
  end if;

  -- ---------------------------------------------------------------------------
  -- Insert the records. One row of import_rows becomes one record, and the link is kept in both
  -- directions so a reviewer can ask "what did this row become?" and a reader can ask "where did
  -- this figure come from?" (§13).
  -- ---------------------------------------------------------------------------
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
        (p_org, (r.mapped_data ->> 'entry_date')::date,
         '00000000-0000-0000-0000-000000000000',           -- period_assign replaces this
         (r.mapped_data ->> 'account_id')::uuid,
         (r.mapped_data ->> 'direction')::public.entry_direction_enum,
         (r.mapped_data ->> 'amount')::numeric,
         coalesce(r.mapped_data ->> 'currency', 'GBP'),
         r.mapped_data ->> 'description', r.mapped_data ->> 'reference',
         (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'journal_ref',
         v_doc, p_batch, r.id, r.source_ref, 'accepted', v_assurance,
         r.dedupe_hash,
         r.reviewer_decision = 'keep',
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
         (r.mapped_data ->> 'posted_date')::date,
         '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'amount')::numeric,
         coalesce(r.mapped_data ->> 'currency', 'GBP'),
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

      -- ADR-029.1: a re-exported invoice with a payment applied SUPERSEDES the earlier row rather
      -- than colliding with the unique index. This is the normal monthly path.
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
        (p_org, (r.mapped_data ->> 'period_start')::date,
         '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'account_id')::uuid,
         (r.mapped_data ->> 'opening_balance')::numeric,
         (r.mapped_data ->> 'debit_total')::numeric,
         (r.mapped_data ->> 'credit_total')::numeric,
         -- ADR-047.3: `reporting` sign is negated to natural HERE, so nothing downstream ever sees
         -- income as a positive number. The engine is defined over natural sign only.
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

    -- ADR-034: the lifecycle event, which evidence as-of resolution reads.
    perform app.record_status_event(p_org, v_rec_table, v_record_id, 'accepted', null, p_batch);

    update public.import_rows
       set status = 'committed',
           committed_table = v_rec_table,
           committed_record_id = v_record_id
     where organization_id = p_org and id = r.id;

    v_committed := v_committed + 1;
  end loop;

  -- Batch-scoped balance supersession, now that the replacements exist (ADR-029.2).
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

  -- Rows the reviewer chose not to import are marked, with their reason preserved. Nothing is
  -- deleted: "why is this row not in my figures?" must always have an answer (§13).
  update public.import_rows
     set status = 'skipped'
   where organization_id = p_org and batch_id = p_batch
     and (reviewer_decision = 'skip' or status in ('duplicate', 'error'))
     and status <> 'committed';

  update public.import_batches
     set status = 'committed',
         committed_at = now(),
         reviewed_by = p_actor,
         row_counts = jsonb_build_object(
           'committed', v_committed,
           'superseded', v_superseded,
           'total', (select count(*) from public.import_rows ir
                      where ir.organization_id = p_org and ir.batch_id = p_batch)),
         fiscal_year_start_month_at_commit =
           (select o.fiscal_year_start_month from public.organizations o where o.id = p_org)
   where organization_id = p_org and id = p_batch;

  -- §11.6: the figures must catch up with the data.
  v_job := app.enqueue_recalculation(p_org, 'import_commit', p_batch);
  update public.import_batches set calculation_job_id = v_job
   where organization_id = p_org and id = p_batch and v_job is not null;

  perform app.audit(p_org, 'import.committed', 'import_batches', p_batch, null,
                    jsonb_build_object('committed', v_committed, 'superseded', v_superseded,
                                       'assurance', v_assurance, 'method', v_method),
                    '{}'::jsonb, p_actor);

  return jsonb_build_object('committed', v_committed, 'superseded', v_superseded, 'job', v_job);
end $$;

create function api.commit_import_batch(p_batch uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id into v_org from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');

  return app.commit_import_batch(v_org, p_batch, app.uid());
end $$;

-- §11.7: the large-batch path. The worker acts AS the reviewer who requested it and the actor's
-- permission is re-checked, so a reviewer who lost access between enqueue and execution cannot have
-- a batch committed in their name (ADR-043.3; R2-A-05).
create function api_server.commit_batch_as(p_actor uuid, p_batch uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  select b.organization_id into v_org from public.import_batches b where b.id = p_batch;
  if v_org is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not app.has_permission_of(p_actor, v_org, 'imports.review') then
    raise exception 'PERMISSION_DENIED: the requester no longer has permission to import'
      using errcode = '42501';
  end if;

  return app.commit_import_batch(v_org, p_batch, p_actor);
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
