-- MOTION — Imports · An invoice re-export updates by supersession, at commit (ADR-073).
-- Contract: IMPORT_ENGINE.md §9.2 pass 1, §9.3, §11; ADR-029.1 (F-B-03), ADR-029.4;
--           PRODUCTION_AUDIT.md M3.
--
-- Two defects, one seam. `app.commit_import_batch` inserted an update candidate's new invoice as
-- `accepted` and THEN superseded the old one; `invoices_identity_unique` is partial on
-- `accepted and superseded_by is null`, so the insert collided with the row it was replacing —
-- on every re-exported invoice, not only the concurrent case the audit described. Executed with
-- the real function: a validated update candidate failed with "duplicate key value violates unique
-- constraint invoices_identity_unique". Nothing tested the path. And `app.rerun_dedupe` re-ran only
-- pass 2 (byte-identical rows) though §9.3 promises passes 1 and 2, so an invoice re-exported by
-- somebody else between validation and commit surfaced as the same Postgres sentence.
--
-- The new row is inserted `pending` (outside the index), the old row is superseded (and leaves the
-- index), then the new row becomes `accepted`. The re-check gains pass 1 for invoices: a fresh
-- identity match becomes an update candidate, not a collision, and a candidate whose target was
-- itself updated meanwhile follows the chain to the row that is current now.

create or replace function app.commit_import_batch(p_org uuid, p_batch uuid, p_actor uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $function$
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
  v_update      boolean;
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
      v_update := r.duplicate_of_table = 'invoices' and r.duplicate_of_id is not null;

      -- ADR-073: an update candidate is inserted OUTSIDE the identity index first. The index is
      -- partial on `record_status = 'accepted' and superseded_by is null`, and the row it must
      -- replace is still in it; inserting the new row as `accepted` collided with the old one on
      -- every re-exported invoice, so ADR-029.1's supersession never reached commit. The new row
      -- starts `pending`, the old row is superseded (and leaves the index), and only then does the
      -- new row become `accepted` — three statements, one transaction, no moment at which two
      -- accepted rows share an identity or a figure reads a half-committed invoice.
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
         v_doc, p_batch, r.id, r.source_ref,
         case when v_update then 'pending' else 'accepted' end::public.record_status_enum,
         v_assurance, r.dedupe_hash, r.reviewer_decision = 'keep')
      returning id into v_record_id;

      if v_update then
        perform app.supersede_row(p_org, 'invoices', r.duplicate_of_id, v_record_id, p_batch);
        update public.invoices set record_status = 'accepted'
         where organization_id = p_org and id = v_record_id;
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
end $function$;

-- ---------------------------------------------------------------------------
-- The commit-time re-check gets its missing pass (IMPORT_ENGINE.md §9.3: "re-runs passes 1 and 2").
-- ---------------------------------------------------------------------------
create or replace function app.rerun_dedupe(p_org uuid, p_batch uuid, p_target public.financial_record_table_enum)
returns integer
language plpgsql security definer
set search_path = ''
as $function$
declare v_collisions integer;
begin
  -- Pass 2: the same row, byte for byte, committed since this file was checked. A collision: the
  -- row is re-flagged and the batch goes back to review (the caller decides that on the count).
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

  if p_target = 'invoices' then
    -- Pass 1 (ADR-073): the same invoice IDENTITY — type, customer, number — committed since this
    -- file was checked, with different figures. Not a collision: this row UPDATES it, exactly as it
    -- would have had the other batch been there at validation (§9.2 pass 1, F-B-03). Left as it was,
    -- the insert would have hit `invoices_identity_unique` and the whole commit would have died with
    -- a Postgres sentence on screen.
    update public.import_rows r
       set duplicate_of_table = 'invoices',
           duplicate_of_id = fresh.existing_id,
           issues = r.issues || jsonb_build_array(jsonb_build_object(
             'code', 'IMP-INV-010', 'severity', 'warning',
             'message', 'An invoice with this number for this customer was committed since this file was checked; this row updates it.'))
      from (
        select r2.id, i.id as existing_id
          from public.import_rows r2
          join public.invoices i
            on i.organization_id = r2.organization_id
           and i.invoice_type = (r2.mapped_data ->> 'invoice_type')::public.invoice_type_enum
           and i.counterparty_id = (r2.mapped_data ->> 'counterparty_id')::uuid
           and i.invoice_number = r2.mapped_data ->> 'invoice_number'
           and i.record_status = 'accepted'
           and i.superseded_by is null
           and i.import_batch_id is distinct from r2.batch_id
         where r2.organization_id = p_org
           and r2.batch_id = p_batch
           and r2.status in ('valid', 'warning')
           and r2.reviewer_decision <> 'skip'
           and r2.duplicate_of_id is null) fresh
     where r.id = fresh.id;

    -- An update candidate whose target was itself updated since validation follows the chain to
    -- the row that is current now, rather than failing at commit with "already superseded".
    update public.import_rows r
       set duplicate_of_id = cur.id
      from public.invoices old
      join public.invoices cur
        on cur.organization_id = old.organization_id
       and cur.invoice_type = old.invoice_type
       and cur.counterparty_id is not distinct from old.counterparty_id
       and cur.invoice_number = old.invoice_number
       and cur.record_status = 'accepted'
       and cur.superseded_by is null
     where r.organization_id = p_org
       and r.batch_id = p_batch
       and r.duplicate_of_table = 'invoices'
       and r.duplicate_of_id = old.id
       and old.organization_id = p_org
       and old.superseded_by is not null;
  end if;

  return v_collisions;
end $function$;

alter function app.rerun_dedupe(uuid, uuid, public.financial_record_table_enum) owner to motion_definer;
alter function app.commit_import_batch(uuid, uuid, uuid) owner to motion_definer;
