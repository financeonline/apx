-- MOTION — pgTAP · api.start_import_batch records the extraction method (PDF slice 1, ADR-083).

begin;
create extension if not exists pgtap;

select plan(5);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('fa000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','method-owner@test.motion','x',now(),now(),now());

create procedure pg_temp.act_as(p_user uuid)
language plpgsql as $$
declare v_email text;
begin
  perform set_config('role', 'postgres', true);
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'email', v_email, 'aal', 'aal1')::text, true);
end $$;
create procedure pg_temp.act_as_postgres()
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

call pg_temp.act_as('fa000000-0000-0000-0000-000000000001');
select lives_ok($$ select api.create_organization('PGT-Method Co') $$, 'fixture organisation');
call pg_temp.act_as_postgres();

create table pg_temp.fx (org uuid, doc1 uuid, doc2 uuid, doc3 uuid);
insert into pg_temp.fx (org) select m.organization_id from public.organization_memberships m where m.user_id = 'fa000000-0000-0000-0000-000000000001';
grant select on pg_temp.fx to authenticated;
with d as (
  insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
  select org, org || '/m/' || n || '.bin', n || '.bin', 'application/octet-stream', 1, decode('a' || n || 'a' || n, 'hex'), 'ready', 'general_ledger'
    from pg_temp.fx, generate_series(1, 3) n
  returning id, original_filename)
update pg_temp.fx set
  doc1 = (select id from d where original_filename = '1.bin'),
  doc2 = (select id from d where original_filename = '2.bin'),
  doc3 = (select id from d where original_filename = '3.bin');

call pg_temp.act_as('fa000000-0000-0000-0000-000000000001');
-- Captured once each: `where id = fn()` would call the volatile function per candidate row.
create table pg_temp.b1 as select api.start_import_batch((select doc1 from pg_temp.fx), 'general_ledger', '{}'::jsonb) as id;
create table pg_temp.b2 as select api.start_import_batch((select doc2 from pg_temp.fx), 'general_ledger', '{"extraction_method":"pdf_text"}'::jsonb) as id;
select is((select b.extraction_method::text from public.import_batches b join pg_temp.b1 t on t.id = b.id),
          'csv', 'a batch with no method named is csv, as before');
select is((select b.extraction_method::text from public.import_batches b join pg_temp.b2 t on t.id = b.id),
          'pdf_text', 'the wizard stamps a text-layer PDF batch pdf_text');
select throws_ok($$ select api.start_import_batch((select doc3 from pg_temp.fx), 'general_ledger', '{"extraction_method":"pdf_claude"}'::jsonb) $$,
                 '22023', null, 'a browser cannot assert an AI-read batch (§5.4, ADR-043.3)');
select throws_ok($$ select api.start_import_batch((select doc3 from pg_temp.fx), 'general_ledger', '{"extraction_method":"manual"}'::jsonb) $$,
                 '22023', null, 'nor a manual one');
call pg_temp.act_as_postgres();

select * from finish();
rollback;
