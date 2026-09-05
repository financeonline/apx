-- MOTION — Phase 3 (plan Phase 5) · The import commit gate.
-- Contract: IMPORT_ENGINE.md §11; ADR-026, ADR-029, ADR-034, ADR-047.
--
-- This is the function that turns a reviewed file into financial records, and it is the single
-- place where that can happen. Everything it checks is re-checked HERE, in SQL, and nothing is
-- trusted from the client: the review screen's opinion that a batch is ready is a suggestion, and
-- this function is the decision. A caller who forged every field of the request still cannot commit
-- a batch with an unresolved error, an unrecorded confirmation, or a row that duplicates data
-- committed thirty seconds ago by somebody else.

-- ---------------------------------------------------------------------------
-- Confirmations (§8.2). One call per confirmation, actor and instant recorded.
-- ---------------------------------------------------------------------------
create function api.record_batch_confirmation(p_batch uuid, p_code text, p_value jsonb default '{}'::jsonb)
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

-- ---------------------------------------------------------------------------
-- Reviewer edits and page confirmations (§10, §5.4)
-- ---------------------------------------------------------------------------
create function api.fix_import_row(p_batch uuid, p_row uuid, p_patch jsonb, p_review_token uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_status public.import_batch_status_enum; v_token uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, b.status, b.review_token into v_org, v_status, v_token
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');
  if v_status <> 'awaiting_review' then
    raise exception 'CONFLICT: this batch is not awaiting review' using errcode = '40001';
  end if;
  -- §16: two reviewers in two tabs. The second writer is told to reload rather than silently
  -- overwriting a decision made while their screen was stale.
  if p_review_token is not null and p_review_token <> v_token then
    raise exception 'CONFLICT: somebody else has changed this batch; reload to see their changes'
      using errcode = '40001';
  end if;

  -- raw_data is NEVER touched: it is the file as it arrived, and level-4 evidence depends on it.
  update public.import_rows r
     set mapped_data = coalesce(r.mapped_data, '{}'::jsonb) || p_patch,
         reviewer_decision = 'fixed',
         fixed_by = app.uid(),
         fixed_at = now(),
         -- The row must be re-validated before it can commit; `pending` is the state that says so.
         status = 'pending'
   where r.organization_id = v_org and r.batch_id = p_batch and r.id = p_row;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.import_batches
     set review_token = gen_random_uuid(), reviewed_by = app.uid()
   where organization_id = v_org and id = p_batch;

  perform app.audit(v_org, 'import.row_fixed', 'import_rows', p_row, null, p_patch, '{}'::jsonb);
  return p_row;
end $$;

create function api.confirm_pdf_page(p_batch uuid, p_page integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_method public.extraction_method_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, b.extraction_method into v_org, v_method
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');
  if v_method <> 'pdf_claude' then
    raise exception 'VALIDATION: page confirmation applies to AI-read documents only'
      using errcode = '22023';
  end if;

  update public.import_batches b
     set page_confirmations = b.page_confirmations
           || jsonb_build_object(p_page::text, jsonb_build_object('by', app.uid(), 'at', now())),
         reviewed_by = app.uid()
   where b.organization_id = v_org and b.id = p_batch;

  perform app.audit(v_org, 'import.page_confirmed', 'import_batches', p_batch, null,
                    jsonb_build_object('page', p_page), '{}'::jsonb);
  return p_batch;
end $$;

-- ---------------------------------------------------------------------------
-- The commit gate (§11.1)
-- ---------------------------------------------------------------------------
-- Split out so `api.commit_import_batch` and `api_server.commit_batch_as` (the large-batch worker
-- path) enforce exactly the same conditions. Two copies of a gate is one gate and one hole.
create function app.assert_batch_committable(p_org uuid, p_batch uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status    public.import_batch_status_enum;
  v_method    public.extraction_method_enum;
  v_required  text[];
  v_confirmed jsonb;
  v_pages     jsonb;
  v_errors    integer;
  v_batch_err integer;
  v_range     boolean;
  v_missing   text;
  v_unconfirmed integer;
begin
  select b.status, b.extraction_method, b.required_confirmations, b.confirmations,
         b.page_confirmations, (b.period_start is not null and b.period_end is not null)
    into v_status, v_method, v_required, v_confirmed, v_pages, v_range
    from public.import_batches b
   where b.organization_id = p_org and b.id = p_batch;

  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status <> 'awaiting_review' then
    raise exception 'CONFLICT: this batch is not awaiting review' using errcode = '40001';
  end if;

  -- 1. No unresolved error rows. A row in `error` must be fixed or skipped by a human first.
  select count(*) into v_errors
    from public.import_rows r
   where r.organization_id = p_org and r.batch_id = p_batch
     and r.status = 'error' and r.reviewer_decision <> 'skip';
  if v_errors > 0 then
    raise exception 'VALIDATION: % row(s) still have errors; fix or skip them first', v_errors
      using errcode = '22023';
  end if;

  -- A row still `pending` has been edited but not re-validated; committing it would bypass
  -- validation entirely.
  select count(*) into v_errors
    from public.import_rows r
   where r.organization_id = p_org and r.batch_id = p_batch and r.status = 'pending';
  if v_errors > 0 then
    raise exception 'VALIDATION: % row(s) have not been re-validated since they were edited', v_errors
      using errcode = '22023';
  end if;

  -- 2. No batch-level error (IMP-BAL-006, IMP-TB-011, IMP-TOT-014).
  select count(*) into v_batch_err
    from public.import_batches b,
         lateral jsonb_array_elements(b.batch_issues) i
   where b.organization_id = p_org and b.id = p_batch and i ->> 'severity' = 'error';
  if v_batch_err > 0 then
    raise exception 'VALIDATION: this file has % problem(s) that must be resolved before it can be imported', v_batch_err
      using errcode = '22023';
  end if;

  -- 3. Every required confirmation recorded.
  select c into v_missing
    from unnest(v_required) c
   where not (v_confirmed ? c)
   limit 1;
  if v_missing is not null then
    raise exception 'VALIDATION: confirmation % has not been recorded', v_missing
      using errcode = '22023';
  end if;

  -- 4. The declared export range, which coverage depends on (ADR-047.6).
  if not v_range then
    raise exception 'VALIDATION: confirm the period this export covers before importing it'
      using errcode = '22023';
  end if;

  -- 5. For an AI-read document, every page carrying rows must be confirmed (§5.4). A page the
  --    reviewer has not looked at cannot contribute rows to the ledger.
  if v_method = 'pdf_claude' then
    select count(distinct r.source_page) into v_unconfirmed
      from public.import_rows r
     where r.organization_id = p_org and r.batch_id = p_batch
       and r.source_page is not null
       and r.status in ('valid', 'warning', 'duplicate')
       and not (v_pages ? r.source_page::text);
    if v_unconfirmed > 0 then
      raise exception 'VALIDATION: % page(s) read by AI have not been confirmed', v_unconfirmed
        using errcode = '22023';
    end if;
  end if;
end $$;
