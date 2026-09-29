-- MOTION — pgTAP · Phase 15 Command Centre (ADR-112, ADR-113).
-- Contract: DATABASE_ARCHITECTURE.md §7 (portfolio_ai_turns), §14.2; ADR-026 (no user write
-- privileges on tenant tables); ADR-043 (api_server is service-role only).
begin;
create extension if not exists pgtap;
select plan(29);

select has_table('public', 'portfolio_ai_turns', 'portfolio_ai_turns exists');
select ok(not has_table_privilege('authenticated', 'public.portfolio_ai_turns', 'INSERT, UPDATE, DELETE'),
          'portfolio_ai_turns is read-only for authenticated');
select ok(not has_table_privilege('anon', 'public.portfolio_ai_turns', 'SELECT'),
          'anon cannot read portfolio_ai_turns');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.portfolio_ai_turns'::regclass),
          'RLS is enabled and forced on portfolio_ai_turns');
select policies_are('public', 'portfolio_ai_turns', array['definer_all', 'portfolio_ai_turns_select'],
          'exactly two policies: the definer write and the own-rows select');

select has_function('api_server', 'portfolio_ai_begin_turn', 'api_server.portfolio_ai_begin_turn exists');
select has_function('api_server', 'portfolio_ai_finish_turn', 'api_server.portfolio_ai_finish_turn exists');
select ok(not has_function_privilege('authenticated', 'api_server.portfolio_ai_begin_turn(uuid, text, uuid[], text)', 'execute'),
          'authenticated cannot begin a portfolio turn directly');
select ok(not has_function_privilege('anon', 'api_server.portfolio_ai_finish_turn(uuid, uuid, jsonb, public.grounding_status_enum, text, integer, integer)', 'execute'),
          'anon cannot finish a portfolio turn');

-- ADR-114: the aggregate read and the current-access helper.
select has_function('api', 'portfolio_summary', array['uuid[]', 'date', 'date'], 'api.portfolio_summary exists');
select ok(not has_function_privilege('anon', 'api.portfolio_summary(uuid[], date, date)', 'execute'),
          'anon cannot execute api.portfolio_summary');
select ok(has_function_privilege('authenticated', 'api.portfolio_summary(uuid[], date, date)', 'execute'),
          'authenticated may execute api.portfolio_summary (it scopes to the caller itself)');
select has_function('app', 'adviser_org_ids', 'app.adviser_org_ids exists');
select ok((select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'portfolio_ai_turns_select') like '%adviser_org_ids%',
          'the turn read policy checks CURRENT adviser access, not authorship alone');

-- ADR-117 (audit F-5): the detail reads are RPCs over a scope the database derives — SECURITY DEFINER
-- like every api.* function (R2-A-06), reading only rows of app.portfolio_scope; no id list in a URL.
select has_function('app', 'portfolio_scope', array['uuid[]'], 'app.portfolio_scope exists');
select ok((select prosecdef from pg_proc where oid = 'app.portfolio_scope(uuid[])'::regprocedure),
          'app.portfolio_scope is security definer (it reads the resolver)');
select ok(pg_get_functiondef('app.portfolio_scope(uuid[])'::regprocedure) like '%adviser_org_ids%',
          'the portfolio scope is the CURRENT adviser organisations, only ever narrowed by the argument');
select ok(pg_get_functiondef('api.portfolio_summary(uuid[], date, date)'::regprocedure) like '%portfolio_scope%',
          'api.portfolio_summary reads through the same scope (a NULL list is the whole adviser scope)');
select has_function('api', 'portfolio_standing_alerts', array['uuid[]', 'integer'], 'api.portfolio_standing_alerts exists');
select has_function('api', 'portfolio_recent_alerts', array['uuid[]', 'timestamp with time zone', 'integer'], 'api.portfolio_recent_alerts exists');
select has_function('api', 'portfolio_open_actions', array['uuid[]', 'text', 'date', 'date', 'integer'], 'api.portfolio_open_actions exists');
select has_function('api', 'portfolio_finished_actions', array['uuid[]', 'timestamp with time zone', 'integer'], 'api.portfolio_finished_actions exists');
select ok(bool_and(prosecdef and proconfig @> array['search_path=""']), 'the four detail reads are definers with an empty search_path (R2-A-06)')
  from pg_proc where oid in ('api.portfolio_standing_alerts(uuid[], integer)'::regprocedure, 'api.portfolio_recent_alerts(uuid[], timestamptz, integer)'::regprocedure,
                             'api.portfolio_open_actions(uuid[], text, date, date, integer)'::regprocedure, 'api.portfolio_finished_actions(uuid[], timestamptz, integer)'::regprocedure);
select ok(bool_and(pg_get_functiondef(oid) like '%app.portfolio_scope(p_orgs)%'), 'every detail read is restricted to the portfolio scope')
  from pg_proc where oid in ('api.portfolio_standing_alerts(uuid[], integer)'::regprocedure, 'api.portfolio_recent_alerts(uuid[], timestamptz, integer)'::regprocedure,
                             'api.portfolio_open_actions(uuid[], text, date, date, integer)'::regprocedure, 'api.portfolio_finished_actions(uuid[], timestamptz, integer)'::regprocedure);
select ok(bool_and(pg_get_functiondef(oid) like '%least(greatest(%500)%'), 'every detail read caps its rows at 500 in the statement')
  from pg_proc where oid in ('api.portfolio_standing_alerts(uuid[], integer)'::regprocedure, 'api.portfolio_recent_alerts(uuid[], timestamptz, integer)'::regprocedure,
                             'api.portfolio_open_actions(uuid[], text, date, date, integer)'::regprocedure, 'api.portfolio_finished_actions(uuid[], timestamptz, integer)'::regprocedure);
select ok(not bool_or(has_function_privilege('anon', oid, 'execute')), 'anon cannot execute any detail read')
  from pg_proc where oid in ('api.portfolio_standing_alerts(uuid[], integer)'::regprocedure, 'api.portfolio_recent_alerts(uuid[], timestamptz, integer)'::regprocedure,
                             'api.portfolio_open_actions(uuid[], text, date, date, integer)'::regprocedure, 'api.portfolio_finished_actions(uuid[], timestamptz, integer)'::regprocedure);
select ok(bool_and(has_function_privilege('authenticated', oid, 'execute')), 'authenticated may execute the detail reads (they scope to the caller)')
  from pg_proc where oid in ('api.portfolio_standing_alerts(uuid[], integer)'::regprocedure, 'api.portfolio_recent_alerts(uuid[], timestamptz, integer)'::regprocedure,
                             'api.portfolio_open_actions(uuid[], text, date, date, integer)'::regprocedure, 'api.portfolio_finished_actions(uuid[], timestamptz, integer)'::regprocedure);
select ok(not has_function_privilege('anon', 'app.portfolio_scope(uuid[])', 'execute'), 'anon cannot execute app.portfolio_scope');
select is((select count(*)::integer from app.portfolio_scope(null)), 0, 'with no signed-in caller the portfolio scope is empty');

select * from finish();
rollback;
