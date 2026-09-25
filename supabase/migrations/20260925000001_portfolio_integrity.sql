-- MOTION — Phase 15 · Portfolio integrity closure (ADR-114).
-- Contract: ADR-112 (who advises what), ADR-113 (the adviser analyst); audit of bab3a68 findings
--           HIGH-A (counts from capped rows), HIGH-B (health truncated by max_rows), HIGH-C (stored
--           turns readable after revocation).
--
-- 1. `app.adviser_org_ids()` — the organisations the CALLER advises right now: the rows of
--    `app.accessible_org_roles()` (the one resolver every RLS policy reads) whose role is an adviser
--    role. A client membership, a suspended membership, a revoked or expired assignment and an aal1
--    platform session are not in it.
-- 2. `api.portfolio_summary(orgs, today, due_soon_until)` — every figure the Command Centre counts, computed over
--    the FULL population in one statement: standing alerts by severity, open actions by the Action
--    Centre's own lenses, and the latest two complete scored months of health per organisation.
--    Nothing is capped here; detail lists are capped separately and say so. Restricted to
--    `orgs ∩ app.adviser_org_ids()`, so a forged id returns no row.
-- 3. `portfolio_ai_turns` is readable by its author only while the author CURRENTLY advises every
--    organisation in the turn's scope — the same effect `ai_*` RLS has through `accessible_org_ids()`.

create function app.adviser_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select r.organization_id
    from app.accessible_org_roles() r
   where r.role in ('super_admin', 'employee', 'owner', 'admin');
$$;
alter function app.adviser_org_ids() owner to motion_definer;
revoke all on function app.adviser_org_ids() from public, anon;
grant execute on function app.adviser_org_ids() to authenticated;

create function api.portfolio_summary(p_orgs uuid[], p_today date, p_due_soon_until date)
returns table (
  organization_id        uuid,
  alerts_standing        integer,
  alerts_critical        integer,
  alerts_high            integer,
  actions_open           integer,
  actions_overdue        integer,
  actions_due_soon       integer,
  actions_urgent         integer,   -- critical/high priority, open (the Action Centre's `high` lens)
  actions_urgent_on_time integer,   -- the same, not overdue (the attention queue's `urgent_action`)
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
    select o from unnest(p_orgs) o
    intersect
    select app.adviser_org_ids()
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
alter function api.portfolio_summary(uuid[], date, date) owner to motion_definer;
revoke all on function api.portfolio_summary(uuid[], date, date) from public, anon;
grant execute on function api.portfolio_summary(uuid[], date, date) to authenticated;

-- HIGH-C: current access, not authorship alone.
drop policy portfolio_ai_turns_select on public.portfolio_ai_turns;
create policy portfolio_ai_turns_select on public.portfolio_ai_turns for select to authenticated
  using (
    app.is_super_admin()
    or (user_id = app.uid()
        and scope_organization_ids <@ array(select app.adviser_org_ids()))
  );
