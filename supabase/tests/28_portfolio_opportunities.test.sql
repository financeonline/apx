-- MOTION — pgTAP · Advisory opportunities (SOW §20; ADR-148), migration 20261016000001. Scope and
-- isolation through real advisers are in test/integration/portfolio.test.ts.
begin;
create extension if not exists pgtap;
select plan(4);

select has_function('api', 'portfolio_health_breakdowns', array['uuid[]'], 'the breakdown read exists');
select ok((select prosecdef from pg_proc where oid = 'api.portfolio_health_breakdowns(uuid[])'::regprocedure), 'it runs as its owner');
select ok(not has_function_privilege('anon', 'api.portfolio_health_breakdowns(uuid[])', 'execute'), 'not for anonymous callers');
select ok(position('app.portfolio_scope' in pg_get_functiondef('api.portfolio_health_breakdowns(uuid[])'::regprocedure)) > 0,
          'it reads only what the caller advises (app.portfolio_scope, ADR-117)');

select * from finish();
rollback;
