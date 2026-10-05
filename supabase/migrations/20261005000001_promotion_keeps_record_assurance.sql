-- MOTION — Imports · a promoted row keeps what its own batch's commit would have stamped (ADR-130).
-- Contract: IMPORT_ENGINE.md §11 step 4, §12.1; ADR-033; ADR-047.9.
--
-- Rollback PROMOTES the rows another batch skipped as duplicates of the batch being rolled back
-- (`app.promote_dependants`). It inserted every one as `verified`, whatever that batch was: a row an AI
-- read from a PDF (`inferred`), or one from a PDF statement that did not reconcile (`calculated`), came
-- back looking firmer than it had ever been. It also re-inserted fewer columns than commit writes —
-- an invoice lost its subtotal, tax and payment date (so `app.invoice_net` fell back to the gross and
-- the figures moved), a bank line its counterparty and running balance, a ledger line its
-- counterparty and opening-balance flag.
--
-- `app.batch_record_assurance` is commit's `v_assurance` CASE (migration 20260908000006, lines
-- 75-84), by name, so the promotion asks the SAME question of the dependant's own batch. The commit
-- function itself is left as it is; pgTAP 18 checks the two agree on every method.

create function app.batch_record_assurance(p_org uuid, p_batch uuid)
returns public.assurance_level_enum language sql stable security definer set search_path = '' as $$
  select case b.extraction_method
           when 'pdf_claude' then 'inferred'::public.assurance_level_enum
           when 'pdf_text' then
             case when exists (
                    select 1 from jsonb_array_elements(coalesce(b.batch_issues, '[]'::jsonb)) i
                     where i ->> 'code' in ('IMP-BAL-006', 'IMP-BAL-007'))
                  then 'calculated'::public.assurance_level_enum
                  else 'verified'::public.assurance_level_enum end
           else 'verified'::public.assurance_level_enum
         end
    from public.import_batches b
   where b.organization_id = p_org and b.id = p_batch;
$$;

alter function app.batch_record_assurance(uuid, uuid) owner to motion_definer;
revoke all on function app.batch_record_assurance(uuid, uuid) from public, authenticated, anon;

create or replace function app.promote_dependants(p_org uuid, p_batch uuid, p_actor uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_target     public.import_target_enum;
  v_rec_table  public.financial_record_table_enum;
  v_doc        uuid;
  v_bank       uuid;
  v_record_id  uuid;
  v_assurance  public.assurance_level_enum;
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
    -- What the DEPENDANT batch's commit would have stamped on this row, not 'verified' (ADR-130).
    v_assurance := app.batch_record_assurance(p_org, r.batch_id);

    if v_target = 'bank_transactions' then
      insert into public.bank_transactions
        (organization_id, bank_account_id, transaction_date, posted_date, period_id, amount,
         currency, description_raw, counterparty_name_raw, counterparty_id, reference,
         balance_after, source_document_id, import_batch_id, import_row_id, source_ref,
         record_status, assurance_level, dedupe_hash, promoted_from_batch_id)
      values (p_org, v_bank, (r.mapped_data ->> 'transaction_date')::date,
              (r.mapped_data ->> 'posted_date')::date,
              '00000000-0000-0000-0000-000000000000',
              (r.mapped_data ->> 'amount')::numeric,
              coalesce(r.mapped_data ->> 'currency', 'GBP'),
              r.mapped_data ->> 'description', r.mapped_data ->> 'counterparty_name',
              (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'reference',
              (r.mapped_data ->> 'balance_after')::numeric,
              v_doc, r.batch_id, r.id, r.source_ref, 'accepted', v_assurance,
              r.dedupe_hash, p_batch)
      returning id into v_record_id;

    elsif v_target = 'ledger_entries' then
      insert into public.ledger_entries
        (organization_id, entry_date, period_id, account_id, direction, amount, currency,
         description, reference, counterparty_id, journal_ref, source_document_id, import_batch_id,
         import_row_id, source_ref, record_status, assurance_level, dedupe_hash,
         is_opening_balance, promoted_from_batch_id)
      values (p_org, (r.mapped_data ->> 'entry_date')::date,
              '00000000-0000-0000-0000-000000000000',
              (r.mapped_data ->> 'account_id')::uuid,
              (r.mapped_data ->> 'direction')::public.entry_direction_enum,
              (r.mapped_data ->> 'amount')::numeric,
              coalesce(r.mapped_data ->> 'currency', 'GBP'),
              r.mapped_data ->> 'description', r.mapped_data ->> 'reference',
              (r.mapped_data ->> 'counterparty_id')::uuid,
              r.mapped_data ->> 'journal_ref', v_doc, r.batch_id, r.id, r.source_ref,
              'accepted', v_assurance, r.dedupe_hash,
              coalesce((r.mapped_data ->> 'is_opening_balance')::boolean, false), p_batch)
      returning id into v_record_id;

    elsif v_target = 'invoices' then
      insert into public.invoices
        (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date,
         period_id, subtotal, tax_amount, total_amount, amount_paid, currency, status, paid_date,
         description, source_document_id, import_batch_id, import_row_id, source_ref,
         record_status, assurance_level, dedupe_hash, promoted_from_batch_id)
      values (p_org, (r.mapped_data ->> 'invoice_type')::public.invoice_type_enum,
              (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'invoice_number',
              (r.mapped_data ->> 'issue_date')::date, (r.mapped_data ->> 'due_date')::date,
              '00000000-0000-0000-0000-000000000000',
              (r.mapped_data ->> 'subtotal')::numeric, (r.mapped_data ->> 'tax_amount')::numeric,
              (r.mapped_data ->> 'total_amount')::numeric,
              coalesce((r.mapped_data ->> 'amount_paid')::numeric, 0),
              coalesce(r.mapped_data ->> 'currency', 'GBP'),
              coalesce((r.mapped_data ->> 'status')::public.invoice_status_enum, 'open'),
              (r.mapped_data ->> 'paid_date')::date, r.mapped_data ->> 'description',
              v_doc, r.batch_id, r.id, r.source_ref, 'accepted', v_assurance,
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

alter function app.promote_dependants(uuid, uuid, uuid) owner to motion_definer;
revoke all on function app.promote_dependants(uuid, uuid, uuid) from public, authenticated, anon;
