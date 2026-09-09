-- MOTION — pgTAP · api.review_ai_feedback and the reviewer's reads (Phase 11 Slice 6, ADR-082).
-- Contract: AI_ARCHITECTURE.md §13; RBAC_MATRIX.md §2.1 (`platform.ai_feedback.review` ✓ super
-- admin, ◐ employee for assigned organisations); SECURITY_MODEL.md §14 (NOT_FOUND for a foreign id).

begin;
create extension if not exists pgtap;

select plan(14);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('f9000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fb-owner@test.motion','x',now(),now(),now()),
  ('f9000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fb-client@test.motion','x',now(),now(),now()),
  ('f9000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fb-employee@test.motion','x',now(),now(),now()),
  ('f9000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fb-stranger@test.motion','x',now(),now(),now()),
  ('f9000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fb-admin@test.motion','x',now(),now(),now());

create procedure pg_temp.act_as(p_user uuid, p_aal text default 'aal1')
language plpgsql as $$
declare v_email text;
begin
  perform set_config('role', 'postgres', true);
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'email', v_email, 'aal', p_aal,
                      'amr', json_build_array(json_build_object('method','password','timestamp', extract(epoch from now())::bigint)))::text,
    true);
end $$;

create procedure pg_temp.act_as_postgres()
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Fixtures: an organisation, a client member, an assigned employee, an unassigned employee, a super
-- admin; the owner's conversation with one assistant message and one open report on it.
call pg_temp.act_as('f9000000-0000-0000-0000-000000000001');
select lives_ok($$ select api.create_organization('PGT-Feedback Co') $$, 'fixture organisation');
call pg_temp.act_as_postgres();

create table pg_temp.fx (org uuid, conv uuid, msg uuid, fb uuid);
insert into pg_temp.fx (org) select m.organization_id from public.organization_memberships m where m.user_id = 'f9000000-0000-0000-0000-000000000001';
grant select on pg_temp.fx to authenticated;

insert into public.organization_memberships (organization_id, user_id, role, status)
values ((select org from pg_temp.fx), 'f9000000-0000-0000-0000-000000000002', 'client', 'active');
insert into public.platform_users (user_id, platform_role, status) values
  ('f9000000-0000-0000-0000-000000000003', 'employee', 'active'),
  ('f9000000-0000-0000-0000-000000000004', 'employee', 'active'),
  ('f9000000-0000-0000-0000-000000000005', 'super_admin', 'active');
insert into public.organization_assignments (organization_id, employee_user_id, assigned_by, status)
values ((select org from pg_temp.fx), 'f9000000-0000-0000-0000-000000000003', 'f9000000-0000-0000-0000-000000000005', 'active');

with c as (insert into public.ai_conversations (organization_id, user_id) values ((select org from pg_temp.fx), 'f9000000-0000-0000-0000-000000000001') returning id)
update pg_temp.fx set conv = c.id from c;
with m as (insert into public.ai_messages (organization_id, conversation_id, role, structured_response, grounding_status)
           values ((select org from pg_temp.fx), (select conv from pg_temp.fx), 'assistant', '{}'::jsonb, 'passed') returning id)
update pg_temp.fx set msg = m.id from m;
insert into public.ai_tool_calls (organization_id, message_id, sequence, tool_name, authorized, output_summary)
values ((select org from pg_temp.fx), (select msg from pg_temp.fx), 1, 'get_metric', true, '{}'::jsonb);
with f as (insert into public.ai_feedback (organization_id, message_id, user_id, feedback_type, comment)
           values ((select org from pg_temp.fx), (select msg from pg_temp.fx), 'f9000000-0000-0000-0000-000000000001', 'incorrect', 'wrong') returning id)
update pg_temp.fx set fb = f.id from f;

-- ---------------------------------------------------------------------------
-- 1. Who may review
-- ---------------------------------------------------------------------------
call pg_temp.act_as('f9000000-0000-0000-0000-000000000001');
select throws_ok($$ select api.review_ai_feedback((select fb from pg_temp.fx), 'reviewed', null) $$, '42501', null,
                 'an owner cannot review feedback — it is platform work (RBAC §2.1)');
call pg_temp.act_as('f9000000-0000-0000-0000-000000000002');
select throws_ok($$ select api.review_ai_feedback((select fb from pg_temp.fx), 'reviewed', null) $$, '42501', null,
                 'a client cannot review feedback');
call pg_temp.act_as('f9000000-0000-0000-0000-000000000004', 'aal2');
select throws_ok($$ select api.review_ai_feedback((select fb from pg_temp.fx), 'reviewed', null) $$, 'P0002', null,
                 'an employee not assigned to the organisation gets NOT_FOUND, never a denial (§14)');
call pg_temp.act_as('f9000000-0000-0000-0000-000000000003', 'aal1');
select throws_ok($$ select api.review_ai_feedback((select fb from pg_temp.fx), 'reviewed', null) $$, 'P0002', null,
                 'the assigned employee at aal1 reaches nothing (ADR-044.1)');

-- ---------------------------------------------------------------------------
-- 2. The assigned employee at aal2 reads and reviews
-- ---------------------------------------------------------------------------
call pg_temp.act_as('f9000000-0000-0000-0000-000000000003', 'aal2');
select is((select count(*)::int from public.ai_feedback f where f.id = (select fb from pg_temp.fx)), 1,
          'the assigned employee sees the organisation''s feedback (§13)');
select is((select count(*)::int from public.ai_tool_calls t where t.message_id = (select msg from pg_temp.fx)), 1,
          'and the tool calls behind the message');
select is((select count(*)::int from public.ai_messages m where m.id = (select msg from pg_temp.fx)), 1,
          'and the message itself');
select throws_ok($$ select api.review_ai_feedback((select fb from pg_temp.fx), 'open', null) $$, '22023', null,
                 'a review cannot set feedback back to open');
select lives_ok($$ select api.review_ai_feedback((select fb from pg_temp.fx), 'reviewed', '  looked at it  ') $$,
                'the assigned employee reviews it');
call pg_temp.act_as_postgres();
select is((select f.status::text || '|' || f.reviewed_by::text || '|' || f.resolution_note from public.ai_feedback f where f.id = (select fb from pg_temp.fx)),
          'reviewed|f9000000-0000-0000-0000-000000000003|looked at it',
          'the review records who, what and the trimmed note');
select is((select m.flagged from public.ai_messages m where m.id = (select msg from pg_temp.fx)), true,
          'a reviewed message wears the badge (§13)');

-- ---------------------------------------------------------------------------
-- 3. A super admin dismisses; the badge comes off; the audit trail says so
-- ---------------------------------------------------------------------------
call pg_temp.act_as('f9000000-0000-0000-0000-000000000005', 'aal2');
select lives_ok($$ select api.review_ai_feedback((select fb from pg_temp.fx), 'dismissed', 'not a defect') $$,
                'a super admin dismisses it');
call pg_temp.act_as_postgres();
select is((select (m.flagged::text || '|' || (select count(*) from public.audit_events a where a.organization_id = (select org from pg_temp.fx) and a.action = 'ai.feedback_reviewed'))
             from public.ai_messages m where m.id = (select msg from pg_temp.fx)),
          'false|2', 'dismissal takes the badge off, and every review is audited');

select * from finish();
rollback;
