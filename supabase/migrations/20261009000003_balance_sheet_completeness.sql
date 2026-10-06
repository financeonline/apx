-- MOTION — owner decision (2026-10-06): a balance SHEET is asked whether it lists every account too.
--
-- A balance sheet's missing receivables or payables line was read as 0.00 (re-review NF-2's balance-
-- sheet case), because balance sheets were never asked IMP-TB-016. Now they are — "every asset,
-- liability and equity account with a balance" (scope `assets_and_liabilities`, set by the server) —
-- and an owner or admin can confirm an existing one per month. Unanswered or partial: a missing line
-- is unknown, never 0.00 (engine 14.0.0's NF-2 rule now covers balance sheets as well as trial
-- balances). A balance sheet is not required to balance to count as complete (it is attested only).

alter table public.report_completeness_attestations drop constraint report_completeness_scope;
alter table public.report_completeness_attestations add constraint report_completeness_scope
  check (scope in ('all_accounts', 'income_and_expense', 'open_invoices', 'assets_and_liabilities'));

create or replace function api.attest_report_completeness(
  p_batch uuid, p_period_start date, p_coverage text, p_reason text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_type     public.import_type_enum;
  v_target   public.import_target_enum;
  v_status   public.import_batch_status_enum;
  v_answer   text;
  v_kind     public.invoice_list_kind_enum;
  v_start    date;
  v_role     text;
  v_prev     public.report_completeness_attestations;
  v_previous text;
  v_scope    text;
  v_id       uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 60, interval '1 minute');

  select b.organization_id, b.import_type, b.target_table, b.status,
         case when b.target_table = 'invoices'
              then b.confirmations -> 'IMP-INV-013' -> 'value' ->> 'opening'
              else b.confirmations -> 'IMP-TB-016' -> 'value' ->> 'report_complete' end,
         b.invoice_list_kind, b.period_start
    into v_org, v_type, v_target, v_status, v_answer, v_kind, v_start
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_role := app.require_permission(v_org, 'imports.review');
  if v_role not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED: only an owner or admin can confirm what a report covers'
      using errcode = '42501';
  end if;

  -- Two kinds of import have a completeness answer: a trial balance or P&L report (does it list every
  -- account — N-1), and a FULL invoice list (does it hold every invoice still unpaid at its start — R-2).
  if not ((v_target = 'period_balances' and v_type in ('trial_balance', 'pnl_report', 'balance_sheet'))
          or (v_target = 'invoices' and coalesce(v_kind, 'full') = 'full')) then
    raise exception 'VALIDATION: only a trial balance, a P&L report, a balance sheet or a full invoice list has a completeness answer' using errcode = '22023';
  end if;
  if v_status <> 'committed' then
    raise exception 'VALIDATION: confirm completeness on an imported report; answer the import''s own question while reviewing it'
      using errcode = '22023';
  end if;
  if coalesce(p_coverage, '') not in ('complete', 'partial') then
    raise exception 'VALIDATION: the answer must be complete or partial' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'VALIDATION: say what you checked in the report' using errcode = '22023';
  end if;
  -- NF-5: the organisation lock commit and rollback hold. A confirmation never interleaves with a
  -- report that is replacing this one; once the lock is ours, what we read below is what was committed.
  perform pg_advisory_xact_lock(hashtext('org:' || v_org::text));

  -- A report replaced for that month is refused in words, not attached to rows nobody reads any more.
  if v_target = 'period_balances' and exists (
       select 1 from public.period_balances pb
        where pb.organization_id = v_org and pb.import_batch_id = p_batch and pb.period_start = p_period_start
          and pb.superseded_by is not null)
     and not exists (
       select 1 from public.period_balances pb
        where pb.organization_id = v_org and pb.import_batch_id = p_batch and pb.period_start = p_period_start
          and pb.record_status = 'accepted' and pb.superseded_by is null) then
    raise exception 'CONFLICT: this report was replaced by a newer one for that month; confirm the newer import instead'
      using errcode = '40001';
  end if;

  -- One import, one month, and only a month this import still states (its lines are current). An
  -- invoice list's opening is a fact about its START: the month it starts in.
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date
     or (v_target = 'period_balances' and not exists (
           select 1 from public.period_balances pb
            where pb.organization_id = v_org and pb.import_batch_id = p_batch
              and pb.period_start = p_period_start
              and pb.record_status = 'accepted' and pb.superseded_by is null))
     or (v_target = 'invoices' and p_period_start <> date_trunc('month', v_start)::date) then
    raise exception 'VALIDATION: this import does not state that month' using errcode = '22023';
  end if;

  -- Serialised per import and month, so two corrections cannot both name the same predecessor.
  perform pg_advisory_xact_lock(hashtext('completeness:' || p_batch::text || ':' || p_period_start::text));

  select * into v_prev from public.report_completeness_attestations a
   where a.organization_id = v_org and a.import_batch_id = p_batch and a.period_start = p_period_start
   order by a.attested_at desc, a.id desc limit 1;
  v_previous := coalesce(v_prev.coverage,
                         case when v_answer in ('complete', 'partial') then v_answer end, 'unconfirmed');
  v_scope := case when v_target = 'invoices' then 'open_invoices'
                  when v_type = 'trial_balance' then 'all_accounts'
                  when v_type = 'balance_sheet' then 'assets_and_liabilities'
                  else 'income_and_expense' end;

  insert into public.report_completeness_attestations
    (organization_id, import_batch_id, period_start, coverage, scope, reason, attested_by, attested_role, supersedes_id)
  values (v_org, p_batch, p_period_start, p_coverage, v_scope, btrim(p_reason), app.uid(), v_role, v_prev.id)
  returning id into v_id;

  perform app.audit(v_org, 'report.completeness_attested', 'import_batches', p_batch,
                    jsonb_build_object('period_start', p_period_start, 'coverage', v_previous,
                                       'attestation_id', v_prev.id),
                    jsonb_build_object('period_start', p_period_start, 'coverage', p_coverage, 'scope', v_scope,
                                       'reason', btrim(p_reason), 'attestation_id', v_id, 'role', v_role),
                    '{}'::jsonb);

  -- The figures that rest on this report are recalculated from its periods onward.
  perform app.enqueue_recalculation(v_org, 'recalc_manual', p_batch);
  return v_id;
end $$;

alter function api.attest_report_completeness(uuid, date, text, text) owner to motion_definer;
revoke all on function api.attest_report_completeness(uuid, date, text, text) from public, anon;

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
  -- R-2: whether a full invoice list holds every invoice still unpaid at its start is an answer too.
  if p_code = 'IMP-INV-013' and coalesce(p_value ->> 'opening', '') not in ('complete', 'partial') then
    raise exception 'VALIDATION: say whether the list includes every invoice still unpaid at its start (complete or partial)'
      using errcode = '22023';
  end if;
  -- …and what it covers is a fact of the report type, stored by the server, never taken from the
  -- client: a trial balance answers for every account, a P&L report for income and expenses only.
  if p_code = 'IMP-TB-016' then
    select p_value || jsonb_build_object('scope',
             case b.import_type when 'trial_balance' then 'all_accounts'
                                when 'balance_sheet' then 'assets_and_liabilities' else 'income_and_expense' end)
      into p_value
      from public.import_batches b where b.id = p_batch;
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
