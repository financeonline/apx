-- MOTION — a batch records how its rows were read (PDF slice 1, ADR-083).
--
-- `import_batches.extraction_method` defaulted to 'csv' and nothing set it: every XLSX batch was
-- stamped 'csv', and a text-layer PDF had no way to be stamped 'pdf_text' — which is what commit
-- reads to decide that PDF rows are `calculated` until reconciled (§11, ADR-033). The wizard now
-- says how it read the file. 'pdf_claude' stays the server's alone: an AI-read batch is created by
-- the `document.extract` job, never asserted by a browser (§5.4, ADR-043.3).

create or replace function api.start_import_batch(p_document uuid, p_import_type public.import_type_enum, p_opts jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_status public.document_status_enum; v_batch uuid; v_target public.import_target_enum;
        v_method public.extraction_method_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select d.organization_id, d.status into v_org, v_status
    from public.source_documents d where d.id = p_document and d.deleted_at is null;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.create');

  if v_status <> 'ready' then
    raise exception 'CONFLICT: this document is not ready to import' using errcode = '40001';
  end if;
  -- One active batch per document: two concurrent wizards over one file would produce two
  -- independent sets of records from the same source.
  if exists (select 1 from public.import_batches b
              where b.organization_id = v_org and b.source_document_id = p_document
                and b.status in ('created','parsing','mapping','validating','awaiting_review','committing')) then
    raise exception 'CONFLICT: an import of this document is already in progress' using errcode = '40001';
  end if;

  v_method := coalesce((p_opts ->> 'extraction_method')::public.extraction_method_enum, 'csv');
  if v_method not in ('csv', 'xlsx', 'pdf_text') then
    raise exception 'VALIDATION: an AI-read or manual batch is created by the server, not the wizard'
      using errcode = '22023';
  end if;

  v_target := case p_import_type
    when 'general_ledger' then 'ledger_entries'
    when 'receipts' then 'ledger_entries'
    when 'trial_balance' then 'period_balances'
    when 'pnl_report' then 'period_balances'
    when 'balance_sheet' then 'period_balances'
    when 'bank_statement' then 'bank_transactions'
    else 'invoices' end::public.import_target_enum;

  if v_target = 'bank_transactions' and (p_opts ->> 'bank_account_id') is null then
    raise exception 'VALIDATION: a bank statement import needs a bank account' using errcode = '22023';
  end if;

  insert into public.import_batches
         (organization_id, source_document_id, import_type, target_table, bank_account_id,
          period_start, period_end, balance_basis, created_by,
          fiscal_year_start_month_at_commit, extraction_method)
  select v_org, p_document, p_import_type, v_target,
         (p_opts ->> 'bank_account_id')::uuid,
         coalesce((p_opts ->> 'period_start')::date, date_trunc('month', now())::date),
         coalesce((p_opts ->> 'period_end')::date,
                  (date_trunc('month', now()) + interval '1 month - 1 day')::date),
         (p_opts ->> 'balance_basis')::public.balance_basis_enum,
         app.uid(), o.fiscal_year_start_month, v_method
    from public.organizations o where o.id = v_org
  returning id into v_batch;

  perform app.audit(v_org, 'import.started', 'import_batches', v_batch, null,
                    jsonb_build_object('import_type', p_import_type, 'document', p_document,
                                       'extraction_method', v_method),
                    '{}'::jsonb);
  return v_batch;
end $$;
