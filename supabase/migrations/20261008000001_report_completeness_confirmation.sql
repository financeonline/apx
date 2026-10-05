-- MOTION — Step 0F · N-1: the reviewer's attestation that a report lists every account (IMP-TB-016).
--
-- A trial balance's or P&L report's category with no line is a zero ONLY when the report lists every
-- account for its period (FINANCIAL_ENGINE §3, ADR-139). Nothing in a file proves that — rows, a
-- balancing total and a declared range all exist in partial extracts too — so the reviewer is asked
-- at import (`requiredConfirmations`, IMP-TB-016) and the answer is stored with who and when in
-- `import_batches.confirmations`, audited as `import.confirmed`. `app.batch_coverage` returns it.
--
-- This migration makes the answer an answer: `report_complete` must be `complete` or `partial`. A
-- blank or unrecognised value is refused rather than stored, so an attestation is never recorded by
-- a form default or a client that sent `{answer: yes}`. Otherwise the function is unchanged.

create or replace function api.record_batch_confirmation(p_batch uuid, p_code text, p_value jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_status public.import_batch_status_enum; v_required text[];
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, b.status, b.required_confirmations
    into v_org, v_status, v_required
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');

  if v_status not in ('mapping', 'validating', 'awaiting_review') then
    raise exception 'CONFLICT: this batch is not open for review' using errcode = '40001';
  end if;
  -- A confirmation this batch's shape does not call for is refused rather than stored: otherwise a
  -- client could pre-record confirmations for gates that have not been evaluated yet.
  if not (p_code = any (v_required)) then
    raise exception 'VALIDATION: % is not a confirmation this batch requires', p_code
      using errcode = '22023';
  end if;

  -- Step 0F (N-1): completeness is the reviewer's explicit answer, one of two.
  if p_code = 'IMP-TB-016' and coalesce(p_value ->> 'report_complete', '') not in ('complete', 'partial') then
    raise exception 'VALIDATION: say whether the report lists every account (complete or partial)'
      using errcode = '22023';
  end if;

  update public.import_batches b
     set confirmations = b.confirmations || jsonb_build_object(
           p_code, jsonb_build_object('by', app.uid(), 'at', now(), 'value', p_value)),
         reviewed_by = app.uid()
   where b.organization_id = v_org and b.id = p_batch;

  -- The declared export range is not merely confirmed, it is SET here (ADR-047.6). Coverage in the
  -- engine reads these two columns, so they must come from a human decision, not from a default.
  if p_code = 'IMP-RANGE-015' then
    if (p_value ->> 'period_start') is null or (p_value ->> 'period_end') is null then
      raise exception 'VALIDATION: confirming the export range needs both a start and an end'
        using errcode = '22023';
    end if;
    update public.import_batches
       set period_start = (p_value ->> 'period_start')::date,
           period_end   = (p_value ->> 'period_end')::date
     where organization_id = v_org and id = p_batch;
  end if;

  if p_code = 'IMP-TB-012' then
    update public.import_batches
       set balance_basis = (p_value ->> 'balance_basis')::public.balance_basis_enum
     where organization_id = v_org and id = p_batch;
  end if;

  if p_code = 'IMP-TB-013' then
    update public.import_batches
       set balance_sign = (p_value ->> 'balance_sign')::public.balance_sign_enum
     where organization_id = v_org and id = p_batch;
  end if;

  if p_code = 'IMP-INV-012' then
    update public.import_batches
       set invoice_list_kind = (p_value ->> 'invoice_list_kind')::public.invoice_list_kind_enum
     where organization_id = v_org and id = p_batch;
  end if;

  perform app.audit(v_org, 'import.confirmed', 'import_batches', p_batch, null,
                    jsonb_build_object('code', p_code, 'value', p_value), '{}'::jsonb);
  return p_batch;
end $$;
