-- MOTION — pgTAP · api.ai_quota_status (Phase 11 Slice 4, ADR-079) and
--                   api_server.ai_create_conversation (Phase 11 Slice 5, ADR-081).
-- Contract: the function counts exactly what api_server.ai_persist_turn counts, is NOT_FOUND for
-- an organisation the caller cannot reach (SECURITY_MODEL.md §14), and needs `ai.use`.

begin;
create extension if not exists pgtap;

select plan(11);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('f8000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','quota-owner@test.motion','x',now(),now(),now()),
  ('f8000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','quota-other@test.motion','x',now(),now(),now());

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

create procedure pg_temp.act_as_service()
language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

call pg_temp.act_as('f8000000-0000-0000-0000-000000000001');
select lives_ok($$ select api.create_organization('PGT-Quota Co') $$, 'fixture organisation');
call pg_temp.act_as_postgres();

create table pg_temp.fx (org uuid, conv uuid, daily int);
insert into pg_temp.fx (org)
  select m.organization_id from public.organization_memberships m where m.user_id = 'f8000000-0000-0000-0000-000000000001';
-- The expected limit is read as postgres: platform_settings is hidden from a member by RLS, and
-- the function reads it through a definer. The two sides of each assertion must not differ by role.
update pg_temp.fx set daily = (select (ps.value #>> '{}')::int from public.platform_settings ps where ps.key = 'ai_quota_daily');
grant select on pg_temp.fx to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Shape and the unused state
-- ---------------------------------------------------------------------------
call pg_temp.act_as('f8000000-0000-0000-0000-000000000001');

select is((select (api.ai_quota_status((select org from pg_temp.fx)) ->> 'used_today')::int), 0,
          'nothing asked yet: used_today is 0');
select is((select (api.ai_quota_status((select org from pg_temp.fx)) ->> 'daily_limit')::int),
          (select daily from pg_temp.fx),
          'the daily limit is the platform default when the organisation has no override');
select is((select (api.ai_quota_status((select org from pg_temp.fx)) ->> 'resets_at')::timestamptz),
          (date_trunc('day', now() at time zone 'utc') at time zone 'utc') + interval '1 day',
          'the reset is the next UTC midnight, the same day boundary the refusal uses');

-- ---------------------------------------------------------------------------
-- 2. The count is the one ai_persist_turn charges: user turns today, tokens this month
-- ---------------------------------------------------------------------------
call pg_temp.act_as_postgres();
with c as (
  insert into public.ai_conversations (organization_id, user_id)
  values ((select org from pg_temp.fx), 'f8000000-0000-0000-0000-000000000001') returning id)
update pg_temp.fx set conv = c.id from c;
insert into public.ai_messages (organization_id, conversation_id, role, content)
values ((select org from pg_temp.fx), (select conv from pg_temp.fx), 'user', 'one'),
       ((select org from pg_temp.fx), (select conv from pg_temp.fx), 'user', 'two');
insert into public.ai_messages (organization_id, conversation_id, role, structured_response, grounding_status, input_tokens, output_tokens)
values ((select org from pg_temp.fx), (select conv from pg_temp.fx), 'assistant', '{}'::jsonb, 'failed', 300, 100);

call pg_temp.act_as('f8000000-0000-0000-0000-000000000001');
select is((select (api.ai_quota_status((select org from pg_temp.fx)) ->> 'used_today')::int), 2,
          'two user turns today count; the assistant row does not');
select is((select (api.ai_quota_status((select org from pg_temp.fx)) ->> 'tokens_month')::int), 400,
          'tokens this month are input plus output over every row');
select is((select (api.ai_quota_status((select org from pg_temp.fx)) ->> 'remaining_today')::int),
          (select daily from pg_temp.fx) - 2,
          'remaining_today is the limit less what was used');

-- ---------------------------------------------------------------------------
-- 3. A stranger gets NOT_FOUND, never a count
-- ---------------------------------------------------------------------------
call pg_temp.act_as('f8000000-0000-0000-0000-000000000002');
select throws_ok($$ select api.ai_quota_status((select org from pg_temp.fx)) $$, 'P0002', null,
                 'an organisation the caller cannot reach is NOT_FOUND');
call pg_temp.act_as_postgres();

-- ---------------------------------------------------------------------------
-- 4. api_server.ai_create_conversation: the server opens a conversation AS a member (ADR-081)
-- ---------------------------------------------------------------------------
call pg_temp.act_as('f8000000-0000-0000-0000-000000000001');
select throws_ok($$ select api_server.ai_create_conversation('f8000000-0000-0000-0000-000000000001', (select org from pg_temp.fx)) $$,
                 '42501', null, 'a user token cannot open a conversation through api_server (ADR-043)');
call pg_temp.act_as_postgres();

call pg_temp.act_as_service();
select throws_ok($$ select api_server.ai_create_conversation('f8000000-0000-0000-0000-000000000002', (select org from pg_temp.fx)) $$,
                 '42501', null, 'the actor must hold ai.use in the organisation');
-- Opened ONCE, into a table: `where id = fn()` would call the volatile opener per candidate row.
create table pg_temp.opened as
  select api_server.ai_create_conversation('f8000000-0000-0000-0000-000000000001', (select org from pg_temp.fx)) as id;
select is((select c.user_id from public.ai_conversations c join pg_temp.opened o on o.id = c.id),
          'f8000000-0000-0000-0000-000000000001'::uuid,
          'the conversation belongs to the actor, in the organisation, like every turn after it (F-C-11)');
call pg_temp.act_as_postgres();

select * from finish();
rollback;
