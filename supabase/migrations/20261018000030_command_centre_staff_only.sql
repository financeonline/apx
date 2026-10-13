-- MOTION — The Command Centre is APX staff only (owner, 2026-10-14; ADR-112 addendum).
--
-- Owner, 2026-10-14: "only the app owner can see everything". The Command Centre (`/portfolio`) is
-- for APX's own staff — the super admin over every organisation, and the Financial Analysts
-- (platform `employee`) over the organisations assigned to them. Company logins (owner, admin,
-- client, and any company role added later) see only their own company, through `/app/[orgSlug]`,
-- with no cross-company view. ADR-112 §2 had opened the Command Centre to a company's owners and
-- admins over their own organisations; that is withdrawn.
--
-- The application already refuses them (`ADVISER_ROLES = ['super_admin', 'employee']`,
-- portfolio/domain/types.ts: the resolver drops their rows and they get the uniform 404). This makes
-- the database agree, for defence in depth (ADR-112 §4: nothing decided in TypeScript is relied on
-- alone). An owner or admin reaching the portfolio reads with their own JWT could only ever have read
-- their OWN organisations — nothing new was exposed — but the portfolio's own functions should not
-- answer a caller the product no longer gives a portfolio.
--
-- Exactly two definitions name the adviser roles, and both are re-created here exactly as live
-- (pg_get_functiondef, 2026-10-14) except for that list:
--
--   1. `app.adviser_org_ids()` — the one helper every portfolio read goes through:
--      `app.portfolio_scope` (and so `api.portfolio_summary`, `api.portfolio_standing_alerts`,
--      `api.portfolio_recent_alerts`, `api.portfolio_open_actions`, `api.portfolio_finished_actions`,
--      `api.portfolio_health_breakdowns`) and the `portfolio_ai_turns_select` RLS policy. None of
--      those functions names a role itself, so none of them changes: for a company login the scope
--      is now empty, every read returns no row, and a turn they stored earlier is no longer readable
--      (the policy reads CURRENT adviser access — HIGH-C, 20260925000001).
--   2. `api_server.portfolio_ai_begin_turn` — the adviser analyst's scope check (ADR-113), which
--      judges each organisation with `app.org_role_of` (an out-of-session actor) and so lists the
--      roles itself. A turn for a company owner or admin is now refused before anything is recorded.
--
-- `create or replace` keeps each function's owner and grants; they are restated anyway, as the
-- migrations that created them wrote them, so this file alone says what the function may be called by.

-- 1. The organisations the CALLER advises right now — staff rows of the one resolver only.
create or replace function app.adviser_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select r.organization_id
    from app.accessible_org_roles() r
   where r.role in ('super_admin', 'employee');
$$;
alter function app.adviser_org_ids() owner to motion_definer;
revoke all on function app.adviser_org_ids() from public, anon;
grant execute on function app.adviser_org_ids() to authenticated;

-- 2. The adviser analyst's turn opens only for staff who advise every organisation in scope.
create or replace function api_server.portfolio_ai_begin_turn(p_actor uuid, p_question text, p_scope uuid[], p_prompt_version text)
returns uuid
language plpgsql security definer set search_path = '' as $function$
declare
  v_org  uuid;
  v_role text;
  v_id   uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null then
    raise exception 'PERMISSION_DENIED: an actor is required' using errcode = '42501';
  end if;
  if p_scope is null or cardinality(p_scope) = 0 then
    raise exception 'VALIDATION: a portfolio turn needs at least one organisation' using errcode = '22023';
  end if;
  -- ADR-112 §2: every organisation in scope is one the actor advises, judged by the same resolver
  -- the RLS policies use. A client membership, a revoked assignment or an aal1 platform account
  -- resolves to no adviser role, and the turn is refused before anything is recorded.
  foreach v_org in array p_scope loop
    v_role := app.org_role_of(p_actor, v_org);
    if v_role is null or v_role not in ('super_admin', 'employee') then
      raise exception 'PERMISSION_DENIED: the actor does not advise every organisation in scope' using errcode = '42501';
    end if;
  end loop;

  perform app.throttle(p_actor, 'portfolio_ai', 10, interval '1 minute');

  insert into public.portfolio_ai_turns (user_id, question, scope_organization_ids, prompt_version)
  values (p_actor, p_question, p_scope, p_prompt_version)
  returning id into v_id;
  return v_id;
end $function$;
alter function api_server.portfolio_ai_begin_turn(uuid, text, uuid[], text) owner to motion_definer;
revoke all on function api_server.portfolio_ai_begin_turn(uuid, text, uuid[], text) from public, anon, authenticated;
grant execute on function api_server.portfolio_ai_begin_turn(uuid, text, uuid[], text) to service_role;
