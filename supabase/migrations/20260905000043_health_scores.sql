-- MOTION — Phase 6 (plan Phase 8) · Writing the Business Health Score.
-- Contract: FINANCIAL_ENGINE.md §7; DATABASE_ARCHITECTURE.md §6 (`health_scores`, `health_current`);
-- ADR-030.4, ADR-031.5, ADR-035, ADR-055.
--
-- Three things this migration establishes.
--
-- 1. `health_current` gains the two columns `metric_current` already had: the run that wrote the
--    pointer, and the pointer it replaced. Without them a failed run leaves an organization reading
--    METRICS from the last good run and a HEALTH SCORE from the run that failed — the mixed state
--    §2.4 step 12 exists to prevent, and the more misleading half of it, because the score is the
--    headline number.
--
-- 2. `health_scores` gets the same in-flight retry rule as `metric_snapshots` (ADR-051.4): a run may
--    delete its OWN rows while it is still `running`, and nothing may touch them afterwards. A
--    worker that dies mid-chunk must be able to redo that chunk; a score anybody has been shown must
--    never change under them.
--
-- 3. `api_server.finish_health` writes the scores and repoints `health_current` in one statement per
--    chunk, so a reader never sees a period with two current scores or none.

-- ---------------------------------------------------------------------------------------------
-- 1. The pointer columns
-- ---------------------------------------------------------------------------------------------

alter table public.health_current
  add column calculation_run_id uuid,
  add column previous_health_score_id uuid;

alter table public.health_current
  add constraint health_current_previous_fk
    foreign key (organization_id, previous_health_score_id)
    references public.health_scores (organization_id, id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- 2. The in-flight retry rule, mirroring app.metric_snapshot_guard (ADR-051.4)
-- ---------------------------------------------------------------------------------------------

create function app.health_score_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status public.calculation_status_enum;
begin
  if coalesce(current_setting('app.purge', true), 'off') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- The organization is going away; the cascade is the intended lifecycle (ADR-049.2).
  if tg_op = 'DELETE'
     and not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return old;
  end if;

  if tg_op = 'DELETE' then
    select r.status into v_status
      from public.calculation_runs r
     where r.organization_id = old.organization_id and r.id = old.calculation_run_id;
    if v_status = 'running' then
      return old;
    end if;
  end if;

  raise exception 'IMMUTABLE: % is append-only', tg_table_name using errcode = '23514';
end $$;

drop trigger append_only_guard on public.health_scores;
create trigger append_only_guard before update or delete on public.health_scores
  for each row execute function app.health_score_guard();

alter function app.health_score_guard() owner to motion_definer;
revoke all on function app.health_score_guard() from public;

-- ---------------------------------------------------------------------------------------------
-- 3. api_server.finish_health
-- ---------------------------------------------------------------------------------------------

-- `p_scores` is an array of
--   { period_id, score (null allowed), dimensions_used, dimensions_total, breakdown, config_version }
-- for the periods of ONE chunk. A period whose `is_complete` is false must not appear: the engine
-- returns no score for it (ADR-030.4), and this function refuses one defensively, because a score on
-- a partial month is a wrong number rather than a missing one.
create function api_server.finish_health(
  p_org       uuid,
  p_run       uuid,
  p_scores    jsonb,
  p_period_ids uuid[]
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_written integer := 0;
  v_incomplete integer;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  if not exists (select 1 from public.calculation_runs r
                  where r.organization_id = p_org and r.id = p_run and r.status = 'running') then
    raise exception 'NOT_FOUND: no running calculation run' using errcode = 'P0002';
  end if;

  select count(*) into v_incomplete
    from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb)) s
    join public.fiscal_periods f
      on f.organization_id = p_org and f.id = (s->>'period_id')::uuid
   where f.is_complete is not true;
  if v_incomplete > 0 then
    raise exception 'INVALID: a health score was offered for an incomplete period (ADR-030.4)'
      using errcode = '23514';
  end if;

  -- Idempotent retry of this run's own chunk (ADR-051.4): the guard permits it while `running`.
  delete from public.health_scores h
   where h.organization_id = p_org and h.calculation_run_id = p_run
     and h.period_id = any(p_period_ids);

  insert into public.health_scores
         (organization_id, calculation_run_id, period_id, score,
          dimensions_used, dimensions_total, breakdown, config_version)
  select p_org, p_run, (s->>'period_id')::uuid,
         nullif(s->>'score', '')::smallint,
         (s->>'dimensions_used')::smallint,
         (s->>'dimensions_total')::smallint,
         coalesce(s->'breakdown', '[]'::jsonb),
         s->>'config_version'
    from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb)) s;

  get diagnostics v_written = row_count;

  -- Repoint. The previous pointer is captured in the same statement that replaces it, so a failed
  -- run has something to put back (the defect ADR-051.3 corrected on the metric side).
  insert into public.health_current
         (organization_id, period_id, health_score_id, calculation_run_id,
          previous_health_score_id, updated_at)
  select p_org, h.period_id, h.id, p_run, null, now()
    from public.health_scores h
   where h.organization_id = p_org and h.calculation_run_id = p_run
     and h.period_id = any(p_period_ids)
  on conflict (organization_id, period_id) do update
     set previous_health_score_id =
           case when public.health_current.calculation_run_id is distinct from p_run
                then public.health_current.health_score_id
                else public.health_current.previous_health_score_id end,
         health_score_id = excluded.health_score_id,
         calculation_run_id = p_run,
         updated_at = now();

  return v_written;
end $$;

alter function api_server.finish_health(uuid, uuid, jsonb, uuid[]) owner to motion_definer;
revoke all on function api_server.finish_health(uuid, uuid, jsonb, uuid[])
  from public, authenticated, anon;
grant execute on function api_server.finish_health(uuid, uuid, jsonb, uuid[]) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. A failed run restores the health pointers it replaced, exactly as it does the metric pointers
-- ---------------------------------------------------------------------------------------------

create or replace function api_server.finish_calculation_run(
  p_org    uuid,
  p_run    uuid,
  p_status public.calculation_status_enum,
  p_stats  jsonb default '{}'::jsonb,
  p_error  jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_started timestamptz;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  select r.started_at into v_started
    from public.calculation_runs r where r.organization_id = p_org and r.id = p_run;
  if v_started is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_status = 'failed' then
    -- Capture first, delete second. A reader must never be left with this month from a failed run
    -- and last month from the previous one — nor with no pointer at all.
    create temporary table if not exists _restore_pointers (
      period_id uuid, metric_key text, dimension_type public.metric_dimension_enum,
      dimension_id uuid, dimension_key text, snapshot_id uuid, calculation_run_id uuid
    ) on commit drop;
    delete from _restore_pointers;

    insert into _restore_pointers
    select prev.period_id, prev.metric_key, prev.dimension_type, prev.dimension_id,
           prev.dimension_key, prev.id, prev.calculation_run_id
      from public.metric_current c
      join public.metric_snapshots prev
        on prev.organization_id = c.organization_id and prev.id = c.previous_snapshot_id
     where c.organization_id = p_org and c.calculation_run_id = p_run
       and c.previous_snapshot_id is not null;

    delete from public.metric_current c
     where c.organization_id = p_org and c.calculation_run_id = p_run;

    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id, dimension_key,
            snapshot_id, calculation_run_id)
    select p_org, period_id, metric_key, dimension_type, dimension_id, dimension_key,
           snapshot_id, calculation_run_id
      from _restore_pointers
    on conflict do nothing;

    -- The same restoration for the health pointer. A score is one row per period rather than one
    -- per metric cell, so it needs no temporary table: the previous id is on the row being replaced.
    create temporary table if not exists _restore_health (
      period_id uuid, health_score_id uuid, calculation_run_id uuid
    ) on commit drop;
    delete from _restore_health;

    insert into _restore_health
    select c.period_id, prev.id, prev.calculation_run_id
      from public.health_current c
      join public.health_scores prev
        on prev.organization_id = c.organization_id and prev.id = c.previous_health_score_id
     where c.organization_id = p_org and c.calculation_run_id = p_run
       and c.previous_health_score_id is not null;

    delete from public.health_current c
     where c.organization_id = p_org and c.calculation_run_id = p_run;

    insert into public.health_current
           (organization_id, period_id, health_score_id, calculation_run_id, updated_at)
    select p_org, period_id, health_score_id, calculation_run_id, now()
      from _restore_health
    on conflict do nothing;
  end if;

  update public.calculation_runs r
     set status = p_status,
         finished_at = now(),
         duration_ms = (extract(epoch from (now() - v_started)) * 1000)::integer,
         stats = coalesce(p_stats, '{}'::jsonb),
         error = p_error,
         failure_reason = case when p_status = 'failed' then 'error'::public.calculation_failure_enum end
   where r.organization_id = p_org and r.id = p_run;

  return p_run;
end $$;

alter function api_server.finish_calculation_run(uuid, uuid, public.calculation_status_enum, jsonb, jsonb)
  owner to motion_definer;
revoke all on function api_server.finish_calculation_run(uuid, uuid, public.calculation_status_enum, jsonb, jsonb)
  from public, authenticated, anon;
grant execute on function api_server.finish_calculation_run(uuid, uuid, public.calculation_status_enum, jsonb, jsonb)
  to service_role;
