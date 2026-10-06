-- MOTION — health.config.v5 (ADR-147): two new Health dimensions and rescaled weights. Every
-- existing score can move, so history is re-scored, and nothing compares scores across versions.
--
-- 1. `api_server.enqueue_health_upgrade(config)` queues a full recalculation for every organisation
--    that has Health Scores and none under `config` — the engine-upgrade pattern (ADR-120), keyed on
--    the Health config. The run itself recomputes the whole history when the organisation's latest
--    score was made under another config (financial-engine/services/run.ts).
-- 2. `api.portfolio_summary` returns the previous month's score only when it was worked out under
--    the same config as the latest (ADR-119 §5): a band "falling" because the rules changed is not a
--    reason to look at a client.

create function api_server.enqueue_health_upgrade(p_config_version text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org   uuid;
  v_job   uuid;
  v_count integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_config_version is null or p_config_version !~ '^health\.config\.v[0-9]+$' then
    raise exception 'VALIDATION: a health config version is health.config.vN' using errcode = '22023';
  end if;

  for v_org in
    select o.id
      from public.organizations o
     where o.status in ('active', 'suspended')
       and exists (select 1 from public.health_scores h where h.organization_id = o.id)
       and not exists (select 1 from public.health_scores h
                        where h.organization_id = o.id and h.config_version = p_config_version)
     order by o.id
  loop
    v_job := app.enqueue_recalculation(v_org, 'recalc_manual');
    perform app.audit(v_org, 'job.enqueued', 'jobs', v_job, null,
                      jsonb_build_object('job_type', 'calculation.run', 'reason', 'health_config_upgrade',
                                         'config_version', p_config_version),
                      '{}'::jsonb, null);
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

alter function api_server.enqueue_health_upgrade(text) owner to motion_definer;
revoke all on function api_server.enqueue_health_upgrade(text) from public, anon, authenticated;
grant execute on function api_server.enqueue_health_upgrade(text) to service_role;


-- The previous month only when scored under the same config as the latest (ADR-119 §5). Redefined
-- from its latest form (20260929000001_portfolio_transport.sql); only those two lines change.
create or replace function api.portfolio_summary(p_orgs uuid[], p_today date, p_due_soon_until date)
returns table (
  organization_id        uuid,
  alerts_standing        integer,
  alerts_critical        integer,
  alerts_high            integer,
  actions_open           integer,
  actions_overdue        integer,
  actions_due_soon       integer,
  actions_urgent         integer,
  actions_urgent_on_time integer,
  actions_mine           integer,
  health_score_id        uuid,
  health_period_id       uuid,
  health_period_start    date,
  health_period_label    text,
  health_score           smallint,
  health_dimensions_used  smallint,
  health_dimensions_total smallint,
  previous_period_start  date,
  previous_period_label  text,
  previous_score         smallint
)
language sql stable security definer set search_path = '' as $$
  with scope as (
    select s as o from app.portfolio_scope(p_orgs) s
  ),
  a as (
    select al.organization_id,
           count(*)::integer                                        as standing,
           count(*) filter (where al.severity = 'critical')::integer as critical,
           count(*) filter (where al.severity = 'high')::integer     as high
      from public.alerts al
     where al.organization_id in (select o from scope)
       and al.status in ('open', 'acknowledged')
     group by al.organization_id
  ),
  x as (
    select ac.organization_id,
           count(*)::integer as open,
           count(*) filter (where ac.due_date is not null and ac.due_date < p_today)::integer as overdue,
           count(*) filter (where ac.due_date is not null and ac.due_date >= p_today
                                  and ac.due_date <= p_due_soon_until)::integer            as due_soon,
           count(*) filter (where ac.priority in ('critical', 'high'))::integer          as urgent,
           count(*) filter (where ac.priority in ('critical', 'high')
                                  and not (ac.due_date is not null and ac.due_date < p_today))::integer as urgent_on_time,
           count(*) filter (where ac.owner_user_id = app.uid())::integer                  as mine
      from public.actions ac
     where ac.organization_id in (select o from scope)
       and ac.status in ('open', 'in_progress')
     group by ac.organization_id
  ),
  h as (
    select hc.organization_id, hs.id as score_id, p.id as period_id, p.period_start, p.label,
           hs.score, hs.dimensions_used, hs.dimensions_total, hs.config_version,
           row_number() over (partition by hc.organization_id order by p.period_start desc) as rn
      from public.health_current hc
      join public.health_scores hs
        on hs.organization_id = hc.organization_id and hs.id = hc.health_score_id
      join public.fiscal_periods p
        on p.organization_id = hc.organization_id and p.id = hc.period_id
     where hc.organization_id in (select o from scope)
       and p.is_complete
  )
  select s.o,
         coalesce(a.standing, 0), coalesce(a.critical, 0), coalesce(a.high, 0),
         coalesce(x.open, 0), coalesce(x.overdue, 0), coalesce(x.due_soon, 0),
         coalesce(x.urgent, 0), coalesce(x.urgent_on_time, 0), coalesce(x.mine, 0),
         h1.score_id, h1.period_id, h1.period_start, h1.label, h1.score,
         h1.dimensions_used, h1.dimensions_total,
         h2.period_start, h2.label, h2.score
    from scope s
    left join a  on a.organization_id  = s.o
    left join x  on x.organization_id  = s.o
    left join h h1 on h1.organization_id = s.o and h1.rn = 1
    left join h h2 on h2.organization_id = s.o and h2.rn = 2 and h2.config_version = h1.config_version
   order by s.o;
$$;
