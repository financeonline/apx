-- MOTION — ADR-124 · Per-account cash histories and a version sweep that cannot miss a stale engine.
-- Contract: FINANCIAL_ENGINE.md §3.3, §6; ADR-124 D-1, D-6.
--
-- 1. ONE ACCOUNT'S ROWS, DAY BY DAY.
--
--    The cash chain is now solved per bank account, over days rather than months (ADR-124 D-1): a
--    statement's printed balance anchors the account's history at the close of a DAY, and the rows
--    of the days after it move it on. `app.aggregate_periods` sums a month at a time, which cannot
--    say what the balance was on the 4th, so the engine reads one account-day at a time. The size
--    is bounded by accounts × days (a year of one account is at most 366 rows), never by rows.
--
--    Every row counts here, transfers included: a transfer between two of the organisation's own
--    accounts moves BOTH balances. ADR-028's exclusion is a rule about cash movement metrics, and
--    `aggregate_periods` still applies it there.
--
-- 2. THE ENGINE-UPGRADE SWEEP KEYS ON THE LATEST RUN.
--
--    `enqueue_engine_upgrade` skipped an organisation that had EVER succeeded on the version. The
--    second independent audit of ADR-120 found the cost of that (N-6): ADR-123 changed figures
--    without a version bump, and organisations `7a139b8` had computed on 2.0.0 were never queued
--    again. The version is now bumped (3.0.0), and the sweep asks the question the engine's own
--    version gate asks (`loadLatestEngineVersion`): is the organisation's LATEST succeeded run on
--    this version? An organisation whose latest figures came from another engine — older, or newer
--    after a rollback — is queued.

-- ---------------------------------------------------------------------------------------------
-- 1. Daily movements per account
-- ---------------------------------------------------------------------------------------------

create function app.bank_daily_movements(
  p_org uuid, p_to date, p_aggregated_at timestamptz default now()
) returns table (bank_account_id uuid, transaction_date date, amount numeric, row_count bigint)
language sql stable security definer set search_path = '' as $$
  -- The same row filter as `app.aggregate_periods`' bank branch: accepted, current, visible at the
  -- aggregation instant. A superseded row belongs to a statement a re-upload replaced.
  select t.bank_account_id, t.transaction_date, sum(t.amount), count(*)
    from public.bank_transactions t
   where t.organization_id = p_org
     and t.record_status = 'accepted'
     and t.superseded_by is null
     and t.created_at <= p_aggregated_at
     and t.transaction_date <= p_to
   group by t.bank_account_id, t.transaction_date
   order by 1, 2;
$$;

alter function app.bank_daily_movements(uuid, date, timestamptz) owner to motion_definer;
revoke all on function app.bank_daily_movements(uuid, date, timestamptz) from public, authenticated, anon;

create function api_server.bank_daily_movements(
  p_org uuid, p_to date, p_aggregated_at timestamptz default now()
) returns table (bank_account_id uuid, transaction_date date, amount numeric, row_count bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  return query select * from app.bank_daily_movements(p_org, p_to, p_aggregated_at);
end $$;

alter function api_server.bank_daily_movements(uuid, date, timestamptz) owner to motion_definer;
revoke all on function api_server.bank_daily_movements(uuid, date, timestamptz) from public, authenticated, anon;
grant execute on function api_server.bank_daily_movements(uuid, date, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. The upgrade sweep: the LATEST succeeded run decides
-- ---------------------------------------------------------------------------------------------

create or replace function api_server.enqueue_engine_upgrade(p_engine_version text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org     uuid;
  v_job     uuid;
  v_waiting boolean;
  v_count   integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_engine_version is null or p_engine_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$' then
    raise exception 'VALIDATION: an engine version is major.minor.patch' using errcode = '22023';
  end if;

  for v_org in
    select o.id
      from public.organizations o
      join lateral (
        select r.engine_version
          from public.calculation_runs r
         where r.organization_id = o.id and r.status = 'succeeded'
         order by r.finished_at desc nulls last, r.id desc
         limit 1
      ) latest on true
     where o.status in ('active', 'suspended')
       and latest.engine_version is distinct from p_engine_version
     order by o.id
  loop
    v_waiting := exists (select 1 from public.jobs j
                          where j.organization_id = v_org and j.job_type = 'calculation.run'
                            and j.status = 'queued');
    v_job := app.enqueue_recalculation(v_org, 'recalc_manual');
    if not v_waiting then
      perform app.audit(v_org, 'job.enqueued', 'jobs', v_job, null,
                        jsonb_build_object('job_type', 'calculation.run', 'reason', 'engine_upgrade',
                                           'engine_version', p_engine_version),
                        '{}'::jsonb, null);
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

alter function api_server.enqueue_engine_upgrade(text) owner to motion_definer;
revoke all on function api_server.enqueue_engine_upgrade(text) from public, anon, authenticated;
grant execute on function api_server.enqueue_engine_upgrade(text) to service_role;
