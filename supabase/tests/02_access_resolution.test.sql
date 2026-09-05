-- MOTION — pgTAP · Access resolution.
-- Contract: TENANCY_MODEL.md §4, RBAC_MATRIX.md §1, ADR-044.1 (MFA at the database for every
--           platform user), ADR-044.4 (one suspension semantic), R2-A-03, F-A-06.
--
-- This is the function every RLS policy depends on. If app.accessible_org_roles() is wrong,
-- every other control is wrong.

begin;
create extension if not exists pgtap;

select plan(27);

-- ---------------------------------------------------------------------------
-- Fixtures. Written as postgres (bypasses RLS) so we can build states the API forbids.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-a@test.motion','x',now(),now(),now()),
  ('a0000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin-a@test.motion','x',now(),now(),now()),
  ('a0000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','client-a@test.motion','x',now(),now(),now()),
  ('b0000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-b@test.motion','x',now(),now(),now()),
  ('e0000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','employee@test.motion','x',now(),now(),now()),
  ('e0000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','employee2@test.motion','x',now(),now(),now()),
  ('50000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','super@test.motion','x',now(),now(),now()),
  ('50000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','suspended-member@test.motion','x',now(),now(),now());

insert into public.organizations (id, slug, name) values
  ('0a000000-0000-0000-0000-00000000000a','org-a','Org A'),
  ('0b000000-0000-0000-0000-00000000000b','org-b','Org B'),
  ('05000000-0000-0000-0000-000000000005','org-susp','Suspended Org'),
  ('0d000000-0000-0000-0000-00000000000d','org-del','Deleted Org');

insert into public.organization_memberships (organization_id, user_id, role, status) values
  ('0a000000-0000-0000-0000-00000000000a','a0000000-0000-0000-0000-000000000001','owner','active'),
  ('0a000000-0000-0000-0000-00000000000a','a0000000-0000-0000-0000-000000000002','admin','active'),
  ('0a000000-0000-0000-0000-00000000000a','a0000000-0000-0000-0000-000000000003','client','active'),
  ('0b000000-0000-0000-0000-00000000000b','b0000000-0000-0000-0000-000000000001','owner','active'),
  ('05000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000002','owner','active'),
  -- A SUSPENDED membership in an ACTIVE organization: must resolve to nothing at all.
  ('0b000000-0000-0000-0000-00000000000b','a0000000-0000-0000-0000-000000000003','client','suspended');

insert into public.platform_users (user_id, platform_role) values
  ('e0000000-0000-0000-0000-000000000001','employee'),
  ('e0000000-0000-0000-0000-000000000002','employee'),
  ('50000000-0000-0000-0000-000000000001','super_admin');

insert into public.organization_assignments (organization_id, employee_user_id, status, ends_at) values
  ('0a000000-0000-0000-0000-00000000000a','e0000000-0000-0000-0000-000000000001','active', now() + interval '6 months'),
  -- expired window, and a revoked assignment: neither grants anything
  ('0b000000-0000-0000-0000-00000000000b','e0000000-0000-0000-0000-000000000002','active', now() - interval '1 day');

update public.organizations set status = 'suspended' where id = '05000000-0000-0000-0000-000000000005';
update public.organizations set status = 'deleted'   where id = '0d000000-0000-0000-0000-00000000000d';

-- Helper: run app.org_role as a given subject, at a given assurance level.
create function pg_temp.role_as(p_user uuid, p_org uuid, p_aal text default 'aal1')
returns text language plpgsql as $$
declare v text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  v := app.org_role(p_org);
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create function pg_temp.count_as(p_user uuid, p_aal text default 'aal1')
returns integer language plpgsql as $$
declare v integer;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  select count(*) into v from app.accessible_org_roles();
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create function pg_temp.perm_as(p_user uuid, p_org uuid, p_perm text, p_aal text default 'aal1')
returns boolean language plpgsql as $$
declare v boolean;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  v := app.has_permission(p_org, p_perm);
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Membership resolution
-- ---------------------------------------------------------------------------
select is(pg_temp.role_as('a0000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a'),
          'owner', 'member with role owner resolves to owner');
select is(pg_temp.role_as('a0000000-0000-0000-0000-000000000002','0a000000-0000-0000-0000-00000000000a'),
          'admin', 'member with role admin resolves to admin');
select is(pg_temp.role_as('a0000000-0000-0000-0000-000000000003','0a000000-0000-0000-0000-00000000000a'),
          'client', 'member with role client resolves to client');
select is(pg_temp.role_as('b0000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a'),
          null, 'a member of another organization resolves to nothing');
select is(pg_temp.count_as('a0000000-0000-0000-0000-000000000001'), 1,
          'an owner of one organization sees exactly one');

-- ---------------------------------------------------------------------------
-- 2. Suspended membership and suspended organization (ADR-044.4)
-- ---------------------------------------------------------------------------
select is(pg_temp.role_as('a0000000-0000-0000-0000-000000000003','0b000000-0000-0000-0000-00000000000b'),
          null, 'a SUSPENDED membership resolves to nothing at all');
select is(pg_temp.role_as('50000000-0000-0000-0000-000000000002','05000000-0000-0000-0000-000000000005'),
          'suspended_member', 'an owner of a SUSPENDED organization degrades to suspended_member');
select ok(pg_temp.perm_as('50000000-0000-0000-0000-000000000002','05000000-0000-0000-0000-000000000005','dashboard.view'),
          'suspended_member keeps dashboard.view');
select ok(not pg_temp.perm_as('50000000-0000-0000-0000-000000000002','05000000-0000-0000-0000-000000000005','financials.view'),
          'suspended_member loses financials.view');
select ok(not pg_temp.perm_as('50000000-0000-0000-0000-000000000002','05000000-0000-0000-0000-000000000005','settings.manage'),
          'suspended_member loses settings.manage');
select is(pg_temp.count_as('50000000-0000-0000-0000-000000000002'), 1,
          'a suspended organization stays in the accessible set (frozen Home)');

-- ---------------------------------------------------------------------------
-- 3. Deleted organization is invisible to everyone
-- ---------------------------------------------------------------------------
select is(pg_temp.role_as('a0000000-0000-0000-0000-000000000001','0d000000-0000-0000-0000-00000000000d'),
          null, 'a deleted organization resolves to nothing for a member');
select is(pg_temp.role_as('50000000-0000-0000-0000-000000000001','0d000000-0000-0000-0000-00000000000d','aal2'),
          null, 'a deleted organization is invisible even to a super admin');

-- ---------------------------------------------------------------------------
-- 4. Platform employee: MFA is a database fact (ADR-044.1; R2-A-03)
-- ---------------------------------------------------------------------------
select is(pg_temp.role_as('e0000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a','aal1'),
          null, 'an assigned employee at aal1 resolves to NOTHING');
select is(pg_temp.count_as('e0000000-0000-0000-0000-000000000001','aal1'), 0,
          'an employee at aal1 sees zero organizations');
select is(pg_temp.role_as('e0000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a','aal2'),
          'employee', 'the same employee at aal2 resolves to employee');
select is(pg_temp.count_as('e0000000-0000-0000-0000-000000000001','aal2'), 1,
          'an employee at aal2 sees only the organization they are assigned to');
select is(pg_temp.role_as('e0000000-0000-0000-0000-000000000001','0b000000-0000-0000-0000-00000000000b','aal2'),
          null, 'an employee has no access to an organization they are not assigned to');

-- expired assignment window
select is(pg_temp.role_as('e0000000-0000-0000-0000-000000000002','0b000000-0000-0000-0000-00000000000b','aal2'),
          null, 'an assignment whose ends_at has passed grants nothing (no cleanup job needed)');

-- revoked assignment
update public.organization_assignments set status = 'revoked'
 where employee_user_id = 'e0000000-0000-0000-0000-000000000001';
select is(pg_temp.role_as('e0000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a','aal2'),
          null, 'a revoked assignment grants nothing on the very next request');
update public.organization_assignments set status = 'active'
 where employee_user_id = 'e0000000-0000-0000-0000-000000000001';

-- employee permissions match the matrix exactly (RBAC_MATRIX.md §2.1)
select ok(pg_temp.perm_as('e0000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a','imports.review','aal2'),
          'employee has imports.review');
select ok(not pg_temp.perm_as('e0000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a','users.view','aal2'),
          'employee does NOT have users.view (ADR-037)');
select ok(not pg_temp.perm_as('e0000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a','settings.manage','aal2'),
          'employee does NOT govern: no settings.manage');
select ok(not pg_temp.perm_as('e0000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a','audit.view','aal2'),
          'employee does NOT have audit.view');

-- ---------------------------------------------------------------------------
-- 5. Super admin
-- ---------------------------------------------------------------------------
select is(pg_temp.count_as('50000000-0000-0000-0000-000000000001','aal1'), 0,
          'a super admin at aal1 sees nothing (MFA is a database fact)');
select is(pg_temp.role_as('50000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-00000000000a','aal2'),
          'super_admin', 'a super admin at aal2 resolves to super_admin in any organization');
-- Counted over the fixture organizations only, so the assertion does not depend on whatever else
-- happens to exist in the database.
create function pg_temp.fixture_orgs_visible_to(p_user uuid, p_aal text)
returns integer language plpgsql as $$
declare v integer;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  select count(*) into v from app.accessible_org_roles() r
   where r.organization_id in ('0a000000-0000-0000-0000-00000000000a',
                               '0b000000-0000-0000-0000-00000000000b',
                               '05000000-0000-0000-0000-000000000005',
                               '0d000000-0000-0000-0000-00000000000d');
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

select is(pg_temp.fixture_orgs_visible_to('50000000-0000-0000-0000-000000000001','aal2'), 3,
          'a super admin at aal2 sees every fixture organization except the deleted one');

select * from finish();
rollback;
