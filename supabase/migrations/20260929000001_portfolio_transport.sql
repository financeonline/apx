-- MOTION — Phase 15 · Portfolio transport closure (ADR-117).
-- Contract: ADR-112 (who advises what), ADR-114 (aggregates vs capped detail); final release audit
--           of 33a182f, finding F-5.
--
-- F-5: the Command Centre's four detail reads were PostgREST GETs carrying every organisation id in
-- the URL (`organization_id=in.(…)`). At 201 organisations the gateway answered 414 URI Too Long and
-- /portfolio, its alerts, actions, client pages and the analyst all failed for any adviser that large
-- — any super admin once the platform passed 200 organisations.
--
-- The reads become functions that take NO list of organisations to trust:
--   * the scope is the caller's CURRENT adviser organisations, `app.adviser_org_ids()` — the resolver
--     every RLS policy reads — narrowed to `p_orgs` only when the caller asks about fewer (one client's
--     page). A forged or foreign id in `p_orgs` narrows the scope to nothing; it never widens it;
--   * they are SECURITY DEFINER with an empty search_path, as every `api.*` function is (R2-A-06), and
--     read ONLY rows of organisations in that scope. The scope is `app.adviser_org_ids()`, which is
--     `app.accessible_org_roles()` — the function every RLS policy reads — so the boundary is the
--     one the database already enforces, bound to the caller's own identity (`app.uid()`), exactly as
--     `api.portfolio_summary` (ADR-114) does;
--   * they are called as RPCs (POST), so nothing grows with the portfolio in a URL;
--   * each is ordered and capped in the statement (at most 500 rows, below PostgREST's max_rows).
-- `api.portfolio_summary` keeps its signature and gains the same rule for a NULL `p_orgs`: the whole
-- adviser scope, so the overview sends no list at all.

-- The scope every Command Centre read uses: what the caller advises now, optionally narrowed.
create function app.portfolio_scope(p_orgs uuid[]) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select o from app.adviser_org_ids() o
   where p_orgs is null or o = any (p_orgs);
$$;
alter function app.portfolio_scope(uuid[]) owner to motion_definer;
revoke all on function app.portfolio_scope(uuid[]) from public, anon;
grant execute on function app.portfolio_scope(uuid[]) to authenticated;

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
           hs.score, hs.dimensions_used, hs.dimensions_total,
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
    left join h h2 on h2.organization_id = s.o and h2.rn = 2
   order by s.o;
$$;

-- Standing alerts to SHOW, worst first: severity (the enum orders critical first), oldest, id.
create function api.portfolio_standing_alerts(p_orgs uuid[], p_limit integer)
returns table (
  id uuid, organization_id uuid, rule_key text, severity text, status text, title text, period_id uuid,
  first_seen_at timestamptz, last_evaluated_at timestamptz, action_id uuid, evidence_bundle_id uuid
)
language sql stable security definer set search_path = '' as $$
  select al.id, al.organization_id, al.rule_key, al.severity::text, al.status::text, al.title, al.period_id,
         al.first_seen_at, al.last_evaluated_at, al.action_id, ar.evidence_bundle_id
    from public.alerts al
    left join public.alert_revisions ar
      on ar.organization_id = al.organization_id and ar.id = al.current_revision_id
   where al.organization_id in (select app.portfolio_scope(p_orgs))
     and al.status in ('open', 'acknowledged')
   order by al.severity asc, al.first_seen_at asc, al.id asc
   limit least(greatest(coalesce(p_limit, 500), 0), 500);
$$;

-- Alerts first seen since `p_since`, newest first: the "recent changes" feed only.
create function api.portfolio_recent_alerts(p_orgs uuid[], p_since timestamptz, p_limit integer)
returns table (
  id uuid, organization_id uuid, rule_key text, severity text, status text, title text, period_id uuid,
  first_seen_at timestamptz, last_evaluated_at timestamptz, action_id uuid, evidence_bundle_id uuid
)
language sql stable security definer set search_path = '' as $$
  select al.id, al.organization_id, al.rule_key, al.severity::text, al.status::text, al.title, al.period_id,
         al.first_seen_at, al.last_evaluated_at, al.action_id, ar.evidence_bundle_id
    from public.alerts al
    left join public.alert_revisions ar
      on ar.organization_id = al.organization_id and ar.id = al.current_revision_id
   where al.organization_id in (select app.portfolio_scope(p_orgs))
     and al.status in ('open', 'acknowledged')
     and al.first_seen_at >= p_since
   order by al.first_seen_at desc, al.id asc
   limit least(greatest(coalesce(p_limit, 50), 0), 500);
$$;

-- Open actions in one of the Action Centre's lenses, in `byUrgency` order (priority, due date with
-- undated last, oldest, id). The lens predicates are the ones `api.portfolio_summary` counts with.
create function api.portfolio_open_actions(
  p_orgs uuid[], p_lens text, p_today date, p_due_soon_until date, p_limit integer
)
returns table (
  id uuid, organization_id uuid, title text, priority text, status text, owner_user_id uuid, due_date date,
  source_type text, evidence_bundle_id uuid, created_at timestamptz, completed_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select ac.id, ac.organization_id, ac.title, ac.priority::text, ac.status::text, ac.owner_user_id, ac.due_date,
         ac.source_type::text, ac.evidence_bundle_id, ac.created_at, ac.completed_at, ac.updated_at
    from public.actions ac
   where ac.organization_id in (select app.portfolio_scope(p_orgs))
     and ac.status in ('open', 'in_progress')
     and case p_lens
           when 'attention' then true
           when 'overdue'   then ac.due_date is not null and ac.due_date < p_today
           when 'due_soon'  then ac.due_date is not null and ac.due_date >= p_today and ac.due_date <= p_due_soon_until
           when 'high'      then ac.priority in ('critical', 'high')
           when 'mine'      then ac.owner_user_id = app.uid()
           else false
         end
   order by ac.priority asc, ac.due_date asc nulls last, ac.created_at asc, ac.id asc
   limit least(greatest(coalesce(p_limit, 500), 0), 500);
$$;

-- Work finished since `p_since`, newest first, for "recent changes".
create function api.portfolio_finished_actions(p_orgs uuid[], p_since timestamptz, p_limit integer)
returns table (
  id uuid, organization_id uuid, title text, priority text, status text, owner_user_id uuid, due_date date,
  source_type text, evidence_bundle_id uuid, created_at timestamptz, completed_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select ac.id, ac.organization_id, ac.title, ac.priority::text, ac.status::text, ac.owner_user_id, ac.due_date,
         ac.source_type::text, ac.evidence_bundle_id, ac.created_at, ac.completed_at, ac.updated_at
    from public.actions ac
   where ac.organization_id in (select app.portfolio_scope(p_orgs))
     and ac.status in ('completed', 'dismissed')
     and ac.updated_at >= p_since
   order by ac.updated_at desc, ac.id asc
   limit least(greatest(coalesce(p_limit, 50), 0), 500);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'api.portfolio_standing_alerts(uuid[], integer)',
    'api.portfolio_recent_alerts(uuid[], timestamptz, integer)',
    'api.portfolio_open_actions(uuid[], text, date, date, integer)',
    'api.portfolio_finished_actions(uuid[], timestamptz, integer)'
  ] loop
    execute format('alter function %s owner to motion_definer', f);
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
