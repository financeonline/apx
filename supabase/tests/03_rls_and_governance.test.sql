-- MOTION — pgTAP · RLS reads, governance invariants inside api.*, and audit immutability.
-- Contract: TEST_STRATEGY.md §2 and §3; RBAC_MATRIX.md §3; ADR-026 (writes only via api.*),
--           ADR-044.6/.7 (organization state machine, ownership transfer), ADR-046.1 (append-only),
--           findings F-A-02, F-A-05, F-D-14, R2-A-10, R2-A-11.

begin;
create extension if not exists pgtap;

select plan(40);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('c1000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','g-owner@test.motion','x',now(),now(),now()),
  ('c1000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','g-owner2@test.motion','x',now(),now(),now()),
  ('c1000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','g-admin@test.motion','x',now(),now(),now()),
  ('c1000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','g-client@test.motion','x',now(),now(),now()),
  ('c2000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','g-outsider@test.motion','x',now(),now(),now()),
  ('c5000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','g-super@test.motion','x',now(),now(),now());

insert into public.organizations (id, slug, name) values
  ('c0a00000-0000-0000-0000-00000000000a','gov-org-a','Gov Org A'),
  ('c0b00000-0000-0000-0000-00000000000b','gov-org-b','Gov Org B');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('c0a00000-0000-0000-0000-00000000000a','c1000000-0000-0000-0000-000000000001','owner'),
  ('c0a00000-0000-0000-0000-00000000000a','c1000000-0000-0000-0000-000000000003','admin'),
  ('c0a00000-0000-0000-0000-00000000000a','c1000000-0000-0000-0000-000000000004','client'),
  ('c0b00000-0000-0000-0000-00000000000b','c2000000-0000-0000-0000-000000000001','owner'),
  -- a client that no later test promotes, reserved for the ownership-transfer invariant
  ('c0a00000-0000-0000-0000-00000000000a','c1000000-0000-0000-0000-000000000002','client');

insert into public.platform_users (user_id, platform_role) values
  ('c5000000-0000-0000-0000-000000000001','super_admin');

-- Become a user for the statements that follow.
create procedure pg_temp.act_as(p_user uuid, p_aal text default 'aal1')
language plpgsql as $$
declare v_email text;
begin
  -- Read the fixture email as postgres BEFORE impersonating: `authenticated` has no access to
  -- auth.users, and this procedure may be called while already impersonating someone.
  perform set_config('role', 'postgres', true);
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated',
                      'email', v_email,
                      'aal', p_aal,
                      'amr', json_build_array(json_build_object('method','password',
                                                                'timestamp', extract(epoch from now())::bigint)))::text,
    true);
end $$;

create procedure pg_temp.act_as_postgres()
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

create function pg_temp.visible_rows(p_user uuid, p_sql text, p_aal text default 'aal1')
returns integer language plpgsql as $$
declare v integer;
begin
  call pg_temp.act_as(p_user, p_aal);
  execute p_sql into v;
  call pg_temp.act_as_postgres();
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- 1. RLS reads — tenant isolation
-- ---------------------------------------------------------------------------
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000001',
       'select count(*) from public.organizations where id = ''c0b00000-0000-0000-0000-00000000000b'''),
       0, 'owner of A sees zero rows of organization B');
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000001',
       'select count(*) from public.organization_memberships where organization_id = ''c0b00000-0000-0000-0000-00000000000b'''),
       0, 'owner of A sees zero memberships of organization B');
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000001',
       'select count(*) from public.organization_memberships where organization_id = ''c0a00000-0000-0000-0000-00000000000a'''),
       4, 'owner of A sees every member of A');
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000004',
       'select count(*) from public.organization_memberships where organization_id = ''c0a00000-0000-0000-0000-00000000000a'''),
       1, 'a client sees only their own membership row');
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000004',
       'select count(*) from public.invitations'),
       0, 'a client sees no invitations (governance table)');

-- Platform-class tables
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000001','select count(*) from public.jobs'),
       0, 'an owner sees no rows of jobs');
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000001','select count(*) from public.platform_settings'),
       0, 'an owner sees no rows of platform_settings');
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000001','select count(*) from public.api_rate_limits'),
       0, 'an owner sees no rows of api_rate_limits');
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000001','select count(*) from public.platform_org_settings'),
       0, 'an owner sees no rows of platform_org_settings');
select ok(pg_temp.visible_rows('c5000000-0000-0000-0000-000000000001','select count(*) from public.platform_settings','aal2') > 0,
       'a super admin at aal2 sees platform_settings');

-- profiles is own-row only
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000001','select count(*) from public.profiles'),
       1, 'profiles is own-row only, even for an owner');

-- audit log visibility
call pg_temp.act_as_postgres();
select is(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000004',
       'select count(*) from public.audit_events where organization_id = ''c0a00000-0000-0000-0000-00000000000a'''),
       0, 'a client cannot read the audit log (no audit.view)');
select ok(pg_temp.visible_rows('c1000000-0000-0000-0000-000000000001',
       'select count(*) from public.audit_events where organization_id = ''c0a00000-0000-0000-0000-00000000000a''') > 0,
       'an owner can read their organization''s audit log');

-- ---------------------------------------------------------------------------
-- 2. No table writes for `authenticated` (ADR-026)
-- ---------------------------------------------------------------------------
call pg_temp.act_as('c1000000-0000-0000-0000-000000000001');
select throws_ok('update public.organizations set name = ''hijacked''', '42501',
                 null, 'an owner cannot UPDATE organizations directly');
select throws_ok('insert into public.organization_memberships (organization_id, user_id, role)
                  values (''c0a00000-0000-0000-0000-00000000000a'',''c2000000-0000-0000-0000-000000000001'',''owner'')',
                 '42501', null, 'an owner cannot INSERT a membership directly');
select throws_ok('delete from public.organization_memberships', '42501',
                 null, 'an owner cannot DELETE a membership directly');
select throws_ok('insert into public.audit_events (actor_type, action) values (''user'', ''forged'')',
                 '42501', null, 'nobody can INSERT an audit event directly (F-A-05)');
select throws_ok('select app.audit(null, ''forged.event'')', '42501',
                 null, 'app.audit is not executable by authenticated (F-A-05)');

-- ---------------------------------------------------------------------------
-- 3. Governance invariants live inside api.* (F-A-02)
-- ---------------------------------------------------------------------------
call pg_temp.act_as('c1000000-0000-0000-0000-000000000003');  -- admin of A
select throws_ok(
  'select api.change_member_role(''c0a00000-0000-0000-0000-00000000000a'',
                                 ''c1000000-0000-0000-0000-000000000001'', ''client'')',
  '42501', null, 'an admin cannot change an OWNER''s role');
select throws_ok(
  'select api.set_member_status(''c0a00000-0000-0000-0000-00000000000a'',
                                ''c1000000-0000-0000-0000-000000000001'', ''suspended'')',
  '42501', null, 'an admin cannot suspend an OWNER');
select throws_ok(
  'select api.remove_member(''c0a00000-0000-0000-0000-00000000000a'',
                            ''c1000000-0000-0000-0000-000000000001'')',
  '42501', null, 'an admin cannot remove an OWNER');
select throws_ok(
  'select api.invite_member(''c0a00000-0000-0000-0000-00000000000a'', ''x@test.motion'', ''owner'')',
  '42501', null, 'an admin cannot invite an OWNER (ceiling)');
select throws_ok(
  'select api.change_member_role(''c0a00000-0000-0000-0000-00000000000a'',
                                 ''c1000000-0000-0000-0000-000000000003'', ''owner'')',
  '42501', null, 'an admin cannot elevate THEMSELVES to owner');
select lives_ok(
  'select api.change_member_role(''c0a00000-0000-0000-0000-00000000000a'',
                                 ''c1000000-0000-0000-0000-000000000004'', ''admin'')',
  'an admin may change a CLIENT to admin (within ceiling)');

-- last-owner guard
call pg_temp.act_as('c1000000-0000-0000-0000-000000000001');  -- the sole owner of A
select throws_ok(
  'select api.remove_member(''c0a00000-0000-0000-0000-00000000000a'',
                            ''c1000000-0000-0000-0000-000000000001'')',
  '23514', null, 'the sole owner cannot be removed (last-owner guard)');
-- ADR-172 hardening (2026-10-14, migration 20261018000032): nobody changes their OWN role any more,
-- so api.change_member_role refuses the sole owner's self-demotion before the trigger is reached;
-- the trigger itself is then exercised directly and still refuses a change that leaves no owner.
select throws_ok(
  'select api.change_member_role(''c0a00000-0000-0000-0000-00000000000a'',
                                 ''c1000000-0000-0000-0000-000000000001'', ''admin'')',
  '42501', null, 'the sole owner cannot demote themselves (no change of one''s own role)');
call pg_temp.act_as_postgres();
select throws_ok(
  'update public.organization_memberships set role = ''admin''
    where organization_id = ''c0a00000-0000-0000-0000-00000000000a''
      and user_id = ''c1000000-0000-0000-0000-000000000001''',
  '23514', null, 'the sole owner cannot be demoted (last-owner guard)');
call pg_temp.act_as('c1000000-0000-0000-0000-000000000001');

-- organization state machine (R2-A-10)
select throws_ok(
  'select api.update_organization(''c0a00000-0000-0000-0000-00000000000a'', ''{"status":"deleted"}''::jsonb)',
  '22023', null, 'status cannot be set to deleted through update_organization');
select throws_ok(
  'select api.update_organization(''c0a00000-0000-0000-0000-00000000000a'', ''{"slug":"new-slug"}''::jsonb)',
  '22023', null, 'the slug is never patchable');
select throws_ok(
  'select api.update_organization(''c0a00000-0000-0000-0000-00000000000a'',
                                  ''{"settings":{"ai_quota_daily":99999}}''::jsonb)',
  '22023', null, 'a tenant cannot set a quota through settings (F-A-09)');

-- profile column limits (F-A-07)
select throws_ok('select api.update_profile(''{"email":"new@test.motion"}''::jsonb)', '22023',
                 null, 'api.update_profile refuses email');
select throws_ok('select api.update_profile(''{"disabled_at":"2020-01-01"}''::jsonb)', '22023',
                 null, 'api.update_profile refuses disabled_at');
select lives_ok('select api.update_profile(''{"full_name":"Real Name"}''::jsonb)',
                'api.update_profile accepts full_name');

-- user-requestable jobs only (R2-A-05)
select throws_ok(
  'select api.enqueue_job(''c0a00000-0000-0000-0000-00000000000a'', ''org.purge'', ''{}''::jsonb)',
  '42501', null, 'a user cannot enqueue org.purge');

-- ownership transfer invariants (R2-A-11)
select throws_ok(
  'select api.initiate_ownership_transfer(''c0a00000-0000-0000-0000-00000000000a'',
                                          ''c1000000-0000-0000-0000-000000000002'', false)',
  '22023', null, 'ownership cannot be transferred to a CLIENT — only to an active admin');
select throws_ok(
  'select api.initiate_ownership_transfer(''c0a00000-0000-0000-0000-00000000000a'',
                                          ''c2000000-0000-0000-0000-000000000001'', false)',
  'P0002', null, 'ownership cannot be transferred to a non-member (NOT_FOUND, no enumeration)');

-- ---------------------------------------------------------------------------
-- 4. Platform-user exclusivity (RBAC_MATRIX.md §3.5)
-- ---------------------------------------------------------------------------
call pg_temp.act_as_postgres();
select throws_ok(
  'insert into public.organization_memberships (organization_id, user_id, role)
   values (''c0a00000-0000-0000-0000-00000000000a'',''c5000000-0000-0000-0000-000000000001'',''client'')',
  '23514', null, 'a platform user cannot be given an organization membership');
select throws_ok(
  'insert into public.platform_users (user_id, platform_role)
   values (''c1000000-0000-0000-0000-000000000001'',''employee'')',
  '23514', null, 'an organization member cannot be given a platform role');

-- ---------------------------------------------------------------------------
-- 5. Audit is append-only for every principal (ADR-046.1)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok('update public.audit_events set action = ''tampered''', '23514',
                 null, 'service_role cannot UPDATE an audit event');
select throws_ok('delete from public.audit_events', '23514',
                 null, 'service_role cannot DELETE an audit event');
reset role;

select * from finish();
rollback;
