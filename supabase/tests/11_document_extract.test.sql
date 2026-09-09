-- MOTION — pgTAP · the extraction job's three server functions (PDF slice 2a, ADR-084).
-- Contract: IMPORT_ENGINE.md §5.4 (flag, failed-parse precondition, consent audit, per-call budget);
-- ADR-033 (a page costs every attempt); F-C-03 (AI-read balances never reach the gate).

begin;
create extension if not exists pgtap;

select plan(13);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('fb000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','ext-owner@test.motion','x',now(),now(),now());

create procedure pg_temp.act_as(p_user uuid)
language plpgsql as $$
declare v_email text;
begin
  perform set_config('role', 'postgres', true);
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'email', v_email, 'aal', 'aal1')::text, true);
end $$;
create procedure pg_temp.act_as_postgres()
language plpgsql as $$ begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create procedure pg_temp.act_as_service()
language plpgsql as $$ begin perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;

call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select lives_ok($$ select api.create_organization('PGT-Extract Co') $$, 'fixture organisation');
call pg_temp.act_as_postgres();

create table pg_temp.fx (org uuid, doc uuid, batch uuid);
insert into pg_temp.fx (org) select m.organization_id from public.organization_memberships m where m.user_id = 'fb000000-0000-0000-0000-000000000001';
grant select on pg_temp.fx to authenticated, service_role;
with d as (insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind, has_text_layer, page_count)
           select org, org || '/x/s.pdf', 's.pdf', 'application/pdf', 1, decode('bb','hex'), 'ready', 'bank_statement', true, 2 from pg_temp.fx returning id)
update pg_temp.fx set doc = d.id from d;
with b as (insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, created_by, error_summary)
           select org, doc, 'bank_statement', 'bank_transactions', 'failed', 'pdf_text', '2026-03-01', '2026-03-31', 'fb000000-0000-0000-0000-000000000001', '{"stage":"parsing"}'::jsonb from pg_temp.fx returning id)
update pg_temp.fx set batch = b.id from b;

-- 1. Service role only; the flag gates everything.
call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select throws_ok($$ select api_server.begin_extraction('fb000000-0000-0000-0000-000000000001', (select org from pg_temp.fx), (select batch from pg_temp.fx), (select doc from pg_temp.fx), 2) $$,
                 '42501', null, 'a user token cannot begin an extraction (ADR-043)');
call pg_temp.act_as_service();
select throws_ok($$ select api_server.begin_extraction('fb000000-0000-0000-0000-000000000001', (select org from pg_temp.fx), (select batch from pg_temp.fx), (select doc from pg_temp.fx), 2) $$,
                 '42501', null, 'with the flag off, AI reading is refused (CD-35)');
select throws_ok($$ select api_server.charge_extraction_page('fb000000-0000-0000-0000-000000000001', (select org from pg_temp.fx), (select doc from pg_temp.fx)) $$,
                 '42501', null, 'and no page can be charged');
call pg_temp.act_as_postgres();
update public.organizations set features = features || '{"ai_pdf_extraction": true}'::jsonb where id = (select org from pg_temp.fx);

-- 2. Begin: precondition, state change, consent audit.
call pg_temp.act_as_service();
select lives_ok($$ select api_server.begin_extraction('fb000000-0000-0000-0000-000000000001', (select org from pg_temp.fx), (select batch from pg_temp.fx), (select doc from pg_temp.fx), 2) $$,
                'a failed pdf_text batch of a text-layer document may be read by AI');
call pg_temp.act_as_postgres();
select is((select b.extraction_method::text || '|' || b.status::text || '|' || (b.extraction_stats ->> 'pages_total') from public.import_batches b where b.id = (select batch from pg_temp.fx)),
          'pdf_claude|parsing|2', 'the batch becomes pdf_claude and is parsing again');
select is((select count(*)::int from public.audit_events a where a.organization_id = (select org from pg_temp.fx) and a.action = 'document.sent_to_ai'
             and a.actor_user_id = 'fb000000-0000-0000-0000-000000000001' and (a.metadata ->> 'pages')::int = 2),
          1, 'document.sent_to_ai is written with the reviewer as actor before any page is sent (F-A-15)');
call pg_temp.act_as_service();
select throws_ok($$ select api_server.begin_extraction('fb000000-0000-0000-0000-000000000001', (select org from pg_temp.fx), (select batch from pg_temp.fx), (select doc from pg_temp.fx), 2) $$,
                 '40001', null, 'a batch that is no longer a failed pdf_text batch cannot be begun again');

-- 3. Charge: every call counts, and the budget is the organisation's.
call pg_temp.act_as_postgres();
insert into public.platform_org_settings (organization_id, ai_extraction_pages_per_day) values ((select org from pg_temp.fx), 2)
  on conflict (organization_id) do update set ai_extraction_pages_per_day = 2;
call pg_temp.act_as_service();
select lives_ok($$ select api_server.charge_extraction_page('fb000000-0000-0000-0000-000000000001', (select org from pg_temp.fx), (select doc from pg_temp.fx)) $$, 'page 1 charged');
select lives_ok($$ select api_server.charge_extraction_page('fb000000-0000-0000-0000-000000000001', (select org from pg_temp.fx), (select doc from pg_temp.fx)) $$, 'page 2 charged');
select throws_ok($$ select api_server.charge_extraction_page('fb000000-0000-0000-0000-000000000001', (select org from pg_temp.fx), (select doc from pg_temp.fx)) $$,
                 '53400', null, 'the third call in a day is over the organisation''s budget (ADR-033)');

-- 4. Record: per-page stats, and AI-read balances never touch the gate's columns.
select lives_ok($$ select api_server.record_extraction_page('fb000000-0000-0000-0000-000000000001', (select org from pg_temp.fx), (select batch from pg_temp.fx), 1, 'extracted', 800, 300, 'high', 16, null, '{"opening":"1000.00"}'::jsonb) $$,
                'a page attempt is recorded');
call pg_temp.act_as_postgres();
select is((select (b.extraction_stats -> 'pages_extracted')::text || '|' || (b.extraction_stats -> 'attempts' ->> '1') || '|' || (b.extraction_stats ->> 'tokens_in') || '|' || (b.extraction_stats -> 'balances_read' ->> 'opening') || '|' || coalesce(b.statement_opening_balance::text, 'null')
             from public.import_batches b where b.id = (select batch from pg_temp.fx)),
          '[1]|1|800|1000.00|null', 'stats carry the page, attempt, tokens and what was read; the gate''s balance column stays empty (F-C-03)');

select * from finish();
rollback;
