-- MOTION — pgTAP · api.platform_audit_events (platform pages, ADR-088).
-- Contract: super admin at aal2 only; spans organisations and platform-level rows; names the actor.

begin;
create extension if not exists pgtap;

select plan(8);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('fc000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pa-owner@test.motion','x',now(),now(),now()),
  ('fc000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pa-admin@test.motion','x',now(),now(),now()),
  ('fc000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pa-employee@test.motion','x',now(),now(),now());

create procedure pg_temp.act_as(p_user uuid, p_aal text default 'aal1')
language plpgsql as $$
declare v_email text;
begin
  perform set_config('role', 'postgres', true);
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'email', v_email, 'aal', p_aal,
                      'amr', json_build_array(json_build_object('method','password','timestamp', extract(epoch from now())::bigint)))::text, true);
end $$;
create procedure pg_temp.act_as_postgres()
language plpgsql as $$ begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;

call pg_temp.act_as('fc000000-0000-0000-0000-000000000001');
select lives_ok($$ select api.create_organization('PGT-Audit Co') $$, 'fixture organisation');
call pg_temp.act_as_postgres();

create table pg_temp.fx (org uuid);
insert into pg_temp.fx select m.organization_id from public.organization_memberships m where m.user_id = 'fc000000-0000-0000-0000-000000000001';
grant select on pg_temp.fx to authenticated;
insert into public.platform_users (user_id, platform_role, status) values
  ('fc000000-0000-0000-0000-000000000002', 'super_admin', 'active'),
  ('fc000000-0000-0000-0000-000000000003', 'employee', 'active');
-- A platform-level event, which belongs to no organisation.
insert into public.audit_events (organization_id, actor_user_id, actor_type, action, target_table)
values (null, 'fc000000-0000-0000-0000-000000000002', 'platform_admin', 'platform.settings_changed', 'platform_settings');

-- 1. Who may search
call pg_temp.act_as('fc000000-0000-0000-0000-000000000001');
select throws_ok($$ select * from api.platform_audit_events() $$, '42501', null,
                 'an organisation owner cannot search the platform''s audit trail');
call pg_temp.act_as('fc000000-0000-0000-0000-000000000003', 'aal2');
select throws_ok($$ select * from api.platform_audit_events() $$, '42501', null,
                 'nor an employee, who holds audit.view for assigned organisations only (ADR-088)');
call pg_temp.act_as('fc000000-0000-0000-0000-000000000002', 'aal1');
select throws_ok($$ select * from api.platform_audit_events() $$, '42501', null,
                 'nor a super admin without a second factor (ADR-038.8)');

-- 2. What a super admin at aal2 sees
call pg_temp.act_as('fc000000-0000-0000-0000-000000000002', 'aal2');
select ok((select count(*) from api.platform_audit_events() where organization_id is null) >= 1,
          'platform-level events, which belong to no organisation, are in the search');
select ok((select count(*) from api.platform_audit_events(p_org => (select org from pg_temp.fx))) >= 1,
          'so are another organisation''s, filtered to it');
select is((select actor_name from api.platform_audit_events(p_action => 'platform.settings') limit 1),
          'pa-admin@test.motion',
          'the actor is named, which profiles'' own-row-only RLS would otherwise hide');
select is((select count(*)::int from api.platform_audit_events(p_action => 'nothing.matches.this')), 0,
          'the action filter is a prefix and finds nothing when nothing matches');
call pg_temp.act_as_postgres();

select * from finish();
rollback;
