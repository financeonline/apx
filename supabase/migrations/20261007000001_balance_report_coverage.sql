-- MOTION — Step 0E · H-2: the engine reads each balance report's BASIS and frozen FISCAL YEAR.
--
-- §3 states a trial balance's or P&L report's P&L from `closing_balance`: as is on a movement report,
-- and as closing(P) − closing(P_prev) on a cumulative one, resetting in the fiscal year's first month
-- as FROZEN on the batch at commit (`fiscal_year_start_month_at_commit`). `app.batch_coverage` did not
-- return either fact, and the engine hard-coded the basis to NULL ("movement"), so a cumulative trial
-- balance's year to date would have been read as the month. The two columns are appended; nothing
-- else about the function changes. Its only caller is `financial-engine/data/repository.ts`.
--
-- A third column, `row_months`, lists the months in which a balance batch has accepted rows: a batch
-- whose declared range spans a month but holds no row for it states nothing about that month (a
-- year-to-date report as at August, declared June–August, says nothing about June), so it must not
-- cover it. NULL for every other target.

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
  row_months      date[]
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
         end
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
  balance_basis public.balance_basis_enum, fiscal_year_start_month_at_commit smallint, row_months date[]
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
