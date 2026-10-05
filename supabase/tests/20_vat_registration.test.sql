-- MOTION — pgTAP · the VAT status is set on purpose, merged, audited and recalculated (ADR-133).
-- Contract: migration 20261005000004; RBAC_MATRIX.md (settings.manage).
begin;
create extension if not exists pgtap;
select plan(19);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('fb000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','vat-owner@test.motion','x',now(),now(),now()),
  ('fb000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','vat-client@test.motion','x',now(),now(),now()),
  ('fb000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','vat-out@test.motion','x',now(),now(),now());
insert into public.organizations (id, slug, name, settings) values
  ('eb000000-0000-0000-0000-0000000000eb', 'pgt-vat', 'PGT VAT', '{"default_vat_rate":"0.20","alerts":{"email":true}}'),
  ('ec000000-0000-0000-0000-0000000000ec', 'pgt-vat-other', 'PGT VAT Other', '{}');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('eb000000-0000-0000-0000-0000000000eb', 'fb000000-0000-0000-0000-000000000001', 'owner'),
  ('eb000000-0000-0000-0000-0000000000eb', 'fb000000-0000-0000-0000-000000000002', 'client'),
  ('ec000000-0000-0000-0000-0000000000ec', 'fb000000-0000-0000-0000-000000000003', 'owner');

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

select has_function('api', 'set_vat_registration', array['uuid', 'text'], 'api.set_vat_registration exists');
select ok(not has_function_privilege('anon', 'api.set_vat_registration(uuid, text)', 'execute'), 'anon cannot execute it');

call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select is(api.set_vat_registration('eb000000-0000-0000-0000-0000000000eb', 'registered'), 'registered', 'the owner sets registered');
call pg_temp.act_as_postgres();
select is((select settings::text from public.organizations where id = 'eb000000-0000-0000-0000-0000000000eb'),
          '{"alerts": {"email": true}, "vat_registered": true, "default_vat_rate": "0.20"}',
          'only its own key is written: the other settings survive');
select is((select count(*)::int from public.jobs where organization_id = 'eb000000-0000-0000-0000-0000000000eb'
             and job_type = 'calculation.run' and status = 'queued' and payload ->> 'trigger' = 'settings_changed'), 1,
          'a change queues a full recalculation');
select is((select after ->> 'vat_status' from public.audit_events where organization_id = 'eb000000-0000-0000-0000-0000000000eb'
             and action = 'org.vat_status_changed' order by id desc limit 1), 'registered', 'the change is audited');

call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select is(api.set_vat_registration('eb000000-0000-0000-0000-0000000000eb', 'registered'), 'registered', 'setting the same status again');
call pg_temp.act_as_postgres();
select is((select count(*)::int from public.audit_events where organization_id = 'eb000000-0000-0000-0000-0000000000eb'
             and action = 'org.vat_status_changed'), 1, '… is a no-op: no second audit row');

call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select is(api.set_vat_registration('eb000000-0000-0000-0000-0000000000eb', 'unknown'), 'unknown', 'unknown is a state');
call pg_temp.act_as_postgres();
select ok(not ((select settings from public.organizations where id = 'eb000000-0000-0000-0000-0000000000eb') ? 'vat_registered'),
          'unknown REMOVES the key — never stored as false');

call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select throws_ok($$ select api.set_vat_registration('eb000000-0000-0000-0000-0000000000eb', 'maybe') $$, '22023', null, 'any other value is refused');
call pg_temp.act_as('fb000000-0000-0000-0000-000000000002');
select throws_ok($$ select api.set_vat_registration('eb000000-0000-0000-0000-0000000000eb', 'registered') $$, '42501', null,
                 'a client cannot change it (settings.manage)');
call pg_temp.act_as('fb000000-0000-0000-0000-000000000003');
select throws_ok($$ select api.set_vat_registration('eb000000-0000-0000-0000-0000000000eb', 'registered') $$, null, null,
                 'an outsider cannot change another organisation''s status');
call pg_temp.act_as_postgres();

-- The other writer: api.update_organization cannot set the status, cannot erase it, refuses an
-- unknown timezone, and recalculates when a figure-changing setting moves.
call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select api.set_vat_registration('eb000000-0000-0000-0000-0000000000eb', 'not_registered');
select throws_ok($$ select api.update_organization('eb000000-0000-0000-0000-0000000000eb', '{"settings":{"vat_registered":true}}') $$,
                 '22023', null, 'a settings patch cannot set the VAT status');
select lives_ok($$ select api.update_organization('eb000000-0000-0000-0000-0000000000eb', '{"settings":{"default_vat_rate":"0.05"}}') $$,
                'a settings patch without it is accepted');
call pg_temp.act_as_postgres();
select is((select settings -> 'vat_registered' from public.organizations where id = 'eb000000-0000-0000-0000-0000000000eb'), 'false'::jsonb,
          'replacing the settings keeps the VAT status');
call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select throws_ok($$ select api.update_organization('eb000000-0000-0000-0000-0000000000eb', '{"timezone":"London"}') $$,
                 '22023', null, 'an unknown timezone is refused on write');
call pg_temp.act_as_postgres();
delete from public.jobs where organization_id = 'eb000000-0000-0000-0000-0000000000eb';
call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select api.update_organization('eb000000-0000-0000-0000-0000000000eb', '{"timezone":"Asia/Dubai"}');
call pg_temp.act_as_postgres();
select is((select count(*)::int from public.jobs where organization_id = 'eb000000-0000-0000-0000-0000000000eb'
             and job_type = 'calculation.run' and status = 'queued'), 1, 'a timezone change queues a recalculation');
call pg_temp.act_as('fb000000-0000-0000-0000-000000000001');
select api.update_organization('eb000000-0000-0000-0000-0000000000eb', '{"name":"PGT VAT renamed"}');
call pg_temp.act_as_postgres();
select is((select count(*)::int from public.jobs where organization_id = 'eb000000-0000-0000-0000-0000000000eb'
             and job_type = 'calculation.run' and status = 'queued'), 1, 'a rename does not queue another');

select * from finish();
rollback;
