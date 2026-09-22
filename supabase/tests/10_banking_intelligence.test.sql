-- MOTION — pgTAP · Phase 13 Banking Intelligence (ADR-101).
-- Contract: DATABASE_ARCHITECTURE.md §14; SECURITY_MODEL.md §6; ADR-043 (server functions are not
-- reachable by a user JWT); ADR-028 (the transfer kind is derived, never asserted).
begin;
create extension if not exists pgtap;
select plan(9);

-- The pass writer exists, is owned by the definer role, and is NOT executable by a user session.
select has_function('api_server', 'apply_banking_pass', array['uuid', 'uuid', 'jsonb'],
                    'api_server.apply_banking_pass exists');
select ok(not has_function_privilege('authenticated', 'api_server.apply_banking_pass(uuid, uuid, jsonb)', 'execute'),
          'authenticated cannot execute api_server.apply_banking_pass');
select ok(not has_function_privilege('anon', 'api_server.apply_banking_pass(uuid, uuid, jsonb)', 'execute'),
          'anon cannot execute api_server.apply_banking_pass');
select ok(has_function_privilege('service_role', 'api_server.apply_banking_pass(uuid, uuid, jsonb)', 'execute'),
          'service_role can execute api_server.apply_banking_pass');
select is((select rolname::text from pg_roles r join pg_proc p on p.proowner = r.oid
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'api_server' and p.proname = 'apply_banking_pass'),
          'motion_definer', 'api_server.apply_banking_pass is owned by motion_definer');

-- The summary read exists and is reachable by a user session (it checks banking.view itself).
select has_function('api', 'bank_period_summary', array['uuid', 'uuid'], 'api.bank_period_summary exists');
select ok(has_function_privilege('authenticated', 'api.bank_period_summary(uuid, uuid)', 'execute'),
          'authenticated can execute api.bank_period_summary');
select ok(not has_function_privilege('anon', 'api.bank_period_summary(uuid, uuid)', 'execute'),
          'anon cannot execute api.bank_period_summary');

-- Nothing in the tenant tables gained a write privilege for users.
select ok(not has_table_privilege('authenticated', 'public.recurring_payment_groups', 'INSERT, UPDATE, DELETE'),
          'recurring_payment_groups stays read-only for authenticated');

select * from finish();
rollback;
