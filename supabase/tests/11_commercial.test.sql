-- MOTION — pgTAP · Phase 14 Commercial Intelligence (ADR-102).
-- Contract: DATABASE_ARCHITECTURE.md §3a, §14; RBAC_MATRIX.md §2.1 (customers.view reads,
-- customers.edit writes); ADR-026 (no user write privileges on tenant tables).
begin;
create extension if not exists pgtap;
select plan(20);

select has_table('public', t, 'table ' || t || ' exists')
  from unnest(array['products', 'invoice_lines', 'marketing_channels', 'campaigns', 'campaign_spend', 'opportunities']) t;

select ok(not has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE'),
          t || ' is read-only for authenticated')
  from unnest(array['products', 'invoice_lines', 'marketing_channels', 'campaigns', 'campaign_spend', 'opportunities']) t;

select has_function('api', f, 'api.' || f || ' exists')
  from unnest(array['upsert_product', 'upsert_channel', 'upsert_campaign', 'set_campaign_spend', 'upsert_opportunity', 'set_invoice_lines', 'product_period_summary']) f;

select ok(not has_function_privilege('anon', 'api.product_period_summary(uuid, uuid[])', 'execute'),
          'anon cannot execute api.product_period_summary');

select * from finish();
rollback;
