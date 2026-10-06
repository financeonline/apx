-- MOTION — pgTAP · health.config.v5 (ADR-147), migration 20261015000001. The re-score through real
-- calculation runs is in test/integration/health-v5.test.ts.
begin;
create extension if not exists pgtap;
select plan(6);

select has_function('api_server', 'enqueue_health_upgrade', array['text'], 'the health re-score queue exists');
select ok((select prosecdef from pg_proc where oid = 'api_server.enqueue_health_upgrade(text)'::regprocedure),
          'it runs as its owner');
select ok(not has_function_privilege('authenticated', 'api_server.enqueue_health_upgrade(text)', 'execute'),
          'no signed-in user can call it');
select ok(not has_function_privilege('anon', 'api_server.enqueue_health_upgrade(text)', 'execute'),
          'nor can an anonymous caller');
select throws_ok($$ select api_server.enqueue_health_upgrade('health.config.v5') $$, '42501', null,
                 'it refuses anyone but the server');
select ok(position('h2.config_version = h1.config_version' in pg_get_functiondef('api.portfolio_summary(uuid[], date, date)'::regprocedure)) > 0,
          'the Command Centre never compares a month with one scored under another config (ADR-119 §5)');

select * from finish();
rollback;
