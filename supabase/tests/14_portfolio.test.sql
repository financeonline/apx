-- MOTION — pgTAP · Phase 15 Command Centre (ADR-112, ADR-113).
-- Contract: DATABASE_ARCHITECTURE.md §7 (portfolio_ai_turns), §14.2; ADR-026 (no user write
-- privileges on tenant tables); ADR-043 (api_server is service-role only).
begin;
create extension if not exists pgtap;
select plan(14);

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

select * from finish();
rollback;
