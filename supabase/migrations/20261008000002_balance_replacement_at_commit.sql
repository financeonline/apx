-- MOTION — Step 0F · N-3 (and N-6): a corrected balance report replaces the previous one, atomically.
--
-- N-3 (re-review of 39711f5). A corrected trial balance or P&L report for a month already imported
-- could not be committed: `app.commit_import_batch` inserted the new rows as `accepted` while the old
-- report's rows were still current, so `single_current_balance` (one accepted, unsuperseded row per
-- period × account × kind, 20260905000013) rejected the insert with a raw "duplicate key" error, and
-- the batch-scope supersession after the loop (ADR-029.2) was never reached. The wrong month stayed,
-- and on a cumulative report its error carried into the next month's difference.
--
-- Now, exactly as an invoice update candidate (ADR-073): the new rows are inserted `pending` (outside
-- the index), the old report's rows are superseded (they leave the index, keep their history and
-- their `record_status_events`), then the new rows become `accepted` — one transaction under the
-- organisation lock, so a failure anywhere leaves the previous accepted report exactly as it was,
-- and two corrections committed at once are applied one after the other.
--
-- Replacement is never silent: the first commit that would replace accepted balances returns
-- `needs_confirmation` and adds IMP-COV-013 to the batch's required confirmations (the code the
-- import spec already reserved for this, never raised until now). The reviewer confirms and commits
-- again.
--
-- N-6. The reporting-sign flip (income, liability, equity negated) applied whenever the batch said
-- `balance_sign = 'reporting'`, even to a Debit / Credit layout whose closing balance is debit −
-- credit and so natural by construction; the review page does not ask IMP-TB-013 for that layout,
-- but `api.save_import_mapping` could still set it. The flip now applies only to a row with no debit
-- or credit total.
--
-- Everything else in the function is unchanged from 20260908000006.

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
  v_replaces    integer;
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

  if v_target = 'period_balances' then
    v_kind := case v_type
      when 'trial_balance' then 'trial_balance'
      when 'pnl_report'    then 'pnl_report'
      else 'balance_sheet' end::public.balance_kind_enum;

    -- Step 0F (N-3): a balance report REPLACES the accepted report of its kind for every month it
    -- states (batch scope, ADR-029.2). That is never silent: the first time a commit finds it would
    -- replace accepted balances, the reviewer is asked (IMP-COV-013) and nothing is written. Checked
    -- HERE, under the organisation lock, so a report committed by someone else after this one was
    -- checked is caught too. Like a dedupe collision it RETURNS rather than raises, so the newly
    -- required confirmation survives.
    select count(*) into v_replaces
      from public.period_balances old
     where old.organization_id = p_org
       and old.balance_kind = v_kind
       and old.record_status = 'accepted'
       and old.superseded_by is null
       and old.import_batch_id is distinct from p_batch
       and old.period_start in (
             select distinct (ir.mapped_data ->> 'period_start')::date
               from public.import_rows ir
              where ir.organization_id = p_org and ir.batch_id = p_batch
                and (ir.status in ('valid', 'warning')
                     or (ir.status = 'duplicate' and ir.reviewer_decision = 'keep'))
                and ir.reviewer_decision <> 'skip');
    if v_replaces > 0 and not exists (
         select 1 from public.import_batches b
          where b.organization_id = p_org and b.id = p_batch and b.confirmations ? 'IMP-COV-013') then
      update public.import_batches
         set required_confirmations = case when 'IMP-COV-013' = any (required_confirmations)
                                           then required_confirmations
                                           else required_confirmations || 'IMP-COV-013'::text end
       where organization_id = p_org and id = p_batch;
      perform app.audit(p_org, 'import.replacement_unconfirmed', 'import_batches', p_batch, null,
                        jsonb_build_object('replaces', v_replaces), '{}'::jsonb, p_actor);
      return jsonb_build_object('status', 'needs_confirmation', 'code', 'IMP-COV-013',
                                'replaces', v_replaces, 'committed', 0, 'superseded', 0);
    end if;
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
      -- Step 0F (N-3): inserted OUTSIDE `single_current_balance` (`pending`), exactly as an invoice
      -- update candidate is (ADR-073). The accepted rows this report replaces are still in that
      -- index; inserting `accepted` collided with them, so a corrected report could never be
      -- committed. After the loop the old rows are superseded and only then are these promoted.
      --
      -- N-6: the reporting-sign flip applies only to a ONE-column layout. A row that carries debit or
      -- credit totals was computed as debit − credit — natural by construction — whatever sign a
      -- saved mapping or an API call put on the batch.
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
                and (r.mapped_data ->> 'debit_total') is null
                and (r.mapped_data ->> 'credit_total') is null
                and public.standard_category_account_type(
                      (select a.standard_category from public.accounts a
                        where a.organization_id = p_org
                          and a.id = (r.mapped_data ->> 'account_id')::uuid))
                    in ('income', 'liability', 'equity')
              then -((r.mapped_data ->> 'closing_balance')::numeric)
              else (r.mapped_data ->> 'closing_balance')::numeric end,
         coalesce(r.mapped_data ->> 'currency', 'GBP'), v_kind, coalesce(v_basis, 'movement'),
         v_doc, p_batch, r.id, r.source_ref, 'pending', v_assurance, r.reviewer_decision = 'keep')
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
      select old.id as old_id, old.period_id, old.balance_kind, old.account_id
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
        -- The same account's new line where the report has one; else the report's line for the month.
        (select nw.id from public.period_balances nw
          where nw.organization_id = p_org and nw.import_batch_id = p_batch
            and nw.period_id = r.period_id and nw.balance_kind = r.balance_kind
          order by (nw.account_id = r.account_id) desc, nw.id
          limit 1),
        p_batch);
      v_superseded := v_superseded + 1;
    end loop;

    -- Step 0F (N-3): the old report has left the index; the new one takes its place. One
    -- transaction: no reader ever sees both reports, or neither, as current.
    update public.period_balances
       set record_status = 'accepted'
     where organization_id = p_org and import_batch_id = p_batch and record_status = 'pending';
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


alter function app.commit_import_batch(uuid, uuid, uuid) owner to motion_definer;
