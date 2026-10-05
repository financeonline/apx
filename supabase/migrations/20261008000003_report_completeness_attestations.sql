-- MOTION — Step 0F follow-up · report completeness for EXISTING imports, by owner attestation.
--
-- Owner decision (after the N-1 re-review): a trial balance or P&L report imported before the
-- completeness question existed may be confirmed complete by an organisation OWNER or ADMIN who has
-- reviewed the stored source — per import and per month, without re-uploading it. Never in bulk,
-- never inferred from a balancing total, always recorded (who, when, which import and month, what
-- scope, why) and correctable. Completeness is not accuracy: an attestation never raises a figure's
-- assurance (the engine takes the weakest of the report's own record assurance, `record_assurance`).
--
--   * `public.report_completeness_attestations` — append-only. One row per attestation; the current
--     answer for (import, month) is the latest row. A correction is a new row naming the one it
--     supersedes; nothing is overwritten.
--   * `api.attest_report_completeness(batch, month, coverage, reason)` — owner/admin only; the batch
--     must be a committed trial balance or P&L report that still states that month; a reason is
--     required. Audited `report.completeness_attested` with the previous and new answer; queues a
--     recalculation of the batch's periods (and, through the run's range, everything after).
--   * `app.batch_coverage` now returns, per batch, `completeness_by_month` ({month: complete |
--     partial}; a month with no answer is absent = unconfirmed) and `record_assurance`.
--   * `api.record_batch_confirmation`: IMP-TB-016's stored value gains the scope the report type
--     answers for (`all_accounts` | `income_and_expense`), set by the server.

create table public.report_completeness_attestations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  import_batch_id uuid not null,
  period_start    date not null
                  constraint report_completeness_month check (period_start = date_trunc('month', period_start)::date),
  coverage        text not null constraint report_completeness_coverage check (coverage in ('complete', 'partial')),
  scope           text not null constraint report_completeness_scope check (scope in ('all_accounts', 'income_and_expense')),
  origin          text not null default 'owner_review' constraint report_completeness_origin check (origin in ('owner_review')),
  reason          text not null constraint report_completeness_reason check (length(btrim(reason)) between 1 and 2000),
  attested_by     uuid not null references public.profiles (id),
  attested_role   text not null constraint report_completeness_role check (attested_role in ('owner', 'admin')),
  attested_at     timestamptz not null default now(),
  supersedes_id   uuid,
  constraint report_completeness_org_id_unique unique (organization_id, id),
  constraint report_completeness_batch_fk
    foreign key (organization_id, import_batch_id) references public.import_batches (organization_id, id),
  constraint report_completeness_supersedes_fk
    foreign key (organization_id, supersedes_id) references public.report_completeness_attestations (organization_id, id)
);

create index report_completeness_current
  on public.report_completeness_attestations (organization_id, import_batch_id, period_start, attested_at desc, id desc);

alter table public.report_completeness_attestations owner to motion_definer;
alter table public.report_completeness_attestations enable row level security;
alter table public.report_completeness_attestations force row level security;
revoke insert, update, delete, truncate on public.report_completeness_attestations from authenticated, anon;
revoke select on public.report_completeness_attestations from anon;
grant select on public.report_completeness_attestations to authenticated;
grant all on public.report_completeness_attestations to service_role;

create policy definer_all on public.report_completeness_attestations for all to motion_definer using (true) with check (true);
-- Part of the import's review record: readable where the import itself is (ADR-038.4).
create policy report_completeness_attestations_select on public.report_completeness_attestations
  for select to authenticated using (app.has_permission(organization_id, 'imports.review'));

-- Append-only, like every other record of who decided what (ADR-046.1).
-- The cascadable form: rows stand down only when their organisation is being deleted (purge).
create trigger append_only_guard before update or delete on public.report_completeness_attestations
  for each row execute function app.append_only_guard_cascadable();

create function api.attest_report_completeness(
  p_batch uuid, p_period_start date, p_coverage text, p_reason text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_type     public.import_type_enum;
  v_target   public.import_target_enum;
  v_status   public.import_batch_status_enum;
  v_answer   text;
  v_role     text;
  v_prev     public.report_completeness_attestations;
  v_previous text;
  v_scope    text;
  v_id       uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 60, interval '1 minute');

  select b.organization_id, b.import_type, b.target_table, b.status,
         b.confirmations -> 'IMP-TB-016' -> 'value' ->> 'report_complete'
    into v_org, v_type, v_target, v_status, v_answer
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_role := app.require_permission(v_org, 'imports.review');
  if v_role not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED: only an owner or admin can confirm what a report covers'
      using errcode = '42501';
  end if;

  if v_target <> 'period_balances' or v_type not in ('trial_balance', 'pnl_report') then
    raise exception 'VALIDATION: only a trial balance or P&L report has a completeness answer' using errcode = '22023';
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
  -- One import, one month, and only a month this import still states (its lines are current).
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date
     or not exists (select 1 from public.period_balances pb
                     where pb.organization_id = v_org and pb.import_batch_id = p_batch
                       and pb.period_start = p_period_start
                       and pb.record_status = 'accepted' and pb.superseded_by is null) then
    raise exception 'VALIDATION: this import does not state that month' using errcode = '22023';
  end if;

  -- Serialised per import and month, so two corrections cannot both name the same predecessor.
  perform pg_advisory_xact_lock(hashtext('completeness:' || p_batch::text || ':' || p_period_start::text));

  select * into v_prev from public.report_completeness_attestations a
   where a.organization_id = v_org and a.import_batch_id = p_batch and a.period_start = p_period_start
   order by a.attested_at desc, a.id desc limit 1;
  v_previous := coalesce(v_prev.coverage,
                         case when v_answer in ('complete', 'partial') then v_answer end, 'unconfirmed');
  v_scope := case v_type when 'trial_balance' then 'all_accounts' else 'income_and_expense' end;

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
grant execute on function api.attest_report_completeness(uuid, date, text, text) to authenticated;

drop function api_server.batch_coverage(uuid, date, date);
drop function app.batch_coverage(uuid, date, date);

create function app.batch_coverage(p_org uuid, p_from date, p_to date)
returns table (
  target_table    public.import_target_enum,
  import_type     public.import_type_enum,
  balance_kind    public.balance_kind_enum,
  bank_account_id uuid,
  invoice_list_kind public.invoice_list_kind_enum,
  period_start    date,
  period_end      date,
  committed_at    timestamptz,
  batch_id        uuid,
  balance_basis   public.balance_basis_enum,
  fiscal_year_start_month_at_commit smallint,
  row_months      date[],
  completeness_by_month jsonb,
  record_assurance public.assurance_level_enum
)
language sql stable security definer set search_path = '' as $$
  select b.target_table,
         b.import_type,
         case b.import_type
           when 'trial_balance' then 'trial_balance'
           when 'pnl_report'    then 'pnl_report'
           when 'balance_sheet' then 'balance_sheet'
         end::public.balance_kind_enum,
         b.bank_account_id,
         b.invoice_list_kind,
         b.period_start,
         b.period_end,
         b.committed_at,
         b.id,
         b.balance_basis,
         b.fiscal_year_start_month_at_commit,
         case when b.target_table = 'period_balances' then
           coalesce((select array_agg(distinct pb.period_start order by pb.period_start)
                       from public.period_balances pb
                      where pb.organization_id = b.organization_id and pb.import_batch_id = b.id
                        and pb.record_status = 'accepted' and pb.superseded_by is null), '{}'::date[])
         end,
         -- Per month the batch states: the latest owner attestation for that month, else the answer
         -- given at import (IMP-TB-016); a month with neither is absent (unconfirmed).
         case when b.target_table = 'period_balances' then
           coalesce((select jsonb_object_agg(to_char(m, 'YYYY-MM-DD'), c)
                       from (select distinct pb.period_start as m
                               from public.period_balances pb
                              where pb.organization_id = b.organization_id and pb.import_batch_id = b.id
                                and pb.record_status = 'accepted' and pb.superseded_by is null) months
                       cross join lateral (
                         select coalesce(
                           (select a.coverage from public.report_completeness_attestations a
                             where a.organization_id = b.organization_id and a.import_batch_id = b.id
                               and a.period_start = months.m
                             order by a.attested_at desc, a.id desc limit 1),
                           case when b.confirmations -> 'IMP-TB-016' -> 'value' ->> 'report_complete' in ('complete', 'partial')
                                then b.confirmations -> 'IMP-TB-016' -> 'value' ->> 'report_complete' end) as c) answer
                      where answer.c is not null), '{}'::jsonb)
         end,
         case when b.target_table = 'period_balances' then app.batch_record_assurance(b.organization_id, b.id) end
    from public.import_batches b
   where b.organization_id = p_org
     and b.status = 'committed'
     and b.period_start is not null
     and b.period_end is not null
     and b.period_end >= date_trunc('month', p_from)::date
     and b.period_start <= (date_trunc('month', p_to) + interval '1 month - 1 day')::date
   order by b.committed_at desc;
$$;

create function api_server.batch_coverage(
  p_org uuid, p_from date, p_to date
) returns table (
  target_table public.import_target_enum, import_type public.import_type_enum,
  balance_kind public.balance_kind_enum, bank_account_id uuid,
  invoice_list_kind public.invoice_list_kind_enum, period_start date, period_end date,
  committed_at timestamptz, batch_id uuid,
  balance_basis public.balance_basis_enum, fiscal_year_start_month_at_commit smallint, row_months date[],
  completeness_by_month jsonb, record_assurance public.assurance_level_enum
)
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  return query select * from app.batch_coverage(p_org, p_from, p_to);
end $$;

alter function app.batch_coverage(uuid, date, date) owner to motion_definer;
revoke all on function app.batch_coverage(uuid, date, date) from public, authenticated, anon;
alter function api_server.batch_coverage(uuid, date, date) owner to motion_definer;
revoke all on function api_server.batch_coverage(uuid, date, date) from public, authenticated, anon;
grant execute on function api_server.batch_coverage(uuid, date, date) to service_role;

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
  -- …and what it covers is a fact of the report type, stored by the server, never taken from the
  -- client: a trial balance answers for every account, a P&L report for income and expenses only.
  if p_code = 'IMP-TB-016' then
    select p_value || jsonb_build_object('scope',
             case b.import_type when 'trial_balance' then 'all_accounts' else 'income_and_expense' end)
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
