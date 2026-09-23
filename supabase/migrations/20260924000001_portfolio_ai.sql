-- MOTION — Phase 15 · The adviser analyst's turn record (ADR-113).
-- Contract: SOW §18 (client AI analysis across a portfolio); AI_ARCHITECTURE.md §2 (every turn the
--           server runs is recorded with what the server observed); ADR-043 (api_server);
--           ADR-112 (who may open the Command Centre, and over which organisations).
--
-- Why a table of its own: `ai_conversations` and `ai_messages` are bound to ONE organisation —
-- their RLS, their quota and their evidence bundle all key on `organization_id` — and a portfolio
-- question spans several. Copying financial numbers into a Phase 15 table would be a second truth;
-- this table copies none. It records the question, the organisation ids the answer was scoped to,
-- the validated structured answer (references into those organisations' own alerts and actions,
-- never figures of its own), the grounding status and the token counts: the audit trail of a turn.
--
-- The scope is checked HERE, against the actor's rights, before the row exists: an id the actor may
-- not advise is refused by the database, whatever the server asked for.

create table public.portfolio_ai_turns (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete cascade,
  question               text not null constraint portfolio_ai_turns_question_len check (length(question) between 1 and 1000),
  scope_organization_ids uuid[] not null constraint portfolio_ai_turns_scope_nonempty check (cardinality(scope_organization_ids) >= 1),
  status                 text not null default 'pending' constraint portfolio_ai_turns_status check (status in ('pending', 'answered', 'failed')),
  answer                 jsonb,
  grounding_status       public.grounding_status_enum,
  model                  text,
  prompt_version         text not null,
  input_tokens           integer,
  output_tokens          integer,
  created_at             timestamptz not null default now(),
  finished_at            timestamptz,
  constraint portfolio_ai_turns_answered_pair check ((status = 'answered') = (answer is not null))
);

create index portfolio_ai_turns_by_user on public.portfolio_ai_turns (user_id, created_at desc);

alter table public.portfolio_ai_turns owner to motion_definer;
alter table public.portfolio_ai_turns enable row level security;
alter table public.portfolio_ai_turns force row level security;
revoke insert, update, delete, truncate on public.portfolio_ai_turns from authenticated, anon;
revoke select on public.portfolio_ai_turns from anon;
grant select on public.portfolio_ai_turns to authenticated;
grant all on public.portfolio_ai_turns to service_role;

-- The definer role writes through the two api_server functions below and nowhere else (ADR-043).
create policy definer_all on public.portfolio_ai_turns for all to motion_definer using (true) with check (true);
-- A person reads their own turns; a super admin at aal2 reads all (governance, as for ai_feedback).
create policy portfolio_ai_turns_select on public.portfolio_ai_turns for select to authenticated
  using (user_id = app.uid() or app.is_super_admin());

-- ---------------------------------------------------------------------------
-- The two writers: begin (throttle + scope check, before the model) and finish (what the server saw).
-- ---------------------------------------------------------------------------
create function api_server.portfolio_ai_begin_turn(
  p_actor    uuid,
  p_question text,
  p_scope    uuid[],
  p_prompt_version text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_role text;
  v_id   uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null then
    raise exception 'PERMISSION_DENIED: an actor is required' using errcode = '42501';
  end if;
  if p_scope is null or cardinality(p_scope) = 0 then
    raise exception 'VALIDATION: a portfolio turn needs at least one organisation' using errcode = '22023';
  end if;
  -- ADR-112 §2: every organisation in scope is one the actor advises, judged by the same resolver
  -- the RLS policies use. A client membership, a revoked assignment or an aal1 platform account
  -- resolves to no adviser role, and the turn is refused before anything is recorded.
  foreach v_org in array p_scope loop
    v_role := app.org_role_of(p_actor, v_org);
    if v_role is null or v_role not in ('super_admin', 'employee', 'owner', 'admin') then
      raise exception 'PERMISSION_DENIED: the actor does not advise every organisation in scope' using errcode = '42501';
    end if;
  end loop;

  perform app.throttle(p_actor, 'portfolio_ai', 10, interval '1 minute');

  insert into public.portfolio_ai_turns (user_id, question, scope_organization_ids, prompt_version)
  values (p_actor, p_question, p_scope, p_prompt_version)
  returning id into v_id;
  return v_id;
end $$;
alter function api_server.portfolio_ai_begin_turn(uuid, text, uuid[], text) owner to motion_definer;
revoke all on function api_server.portfolio_ai_begin_turn(uuid, text, uuid[], text) from public, anon, authenticated;
grant execute on function api_server.portfolio_ai_begin_turn(uuid, text, uuid[], text) to service_role;

create function api_server.portfolio_ai_finish_turn(
  p_actor     uuid,
  p_turn      uuid,
  p_answer    jsonb,
  p_grounding public.grounding_status_enum,
  p_model     text,
  p_tokens_in integer,
  p_tokens_out integer
)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  update public.portfolio_ai_turns
     set status = case when p_answer is null then 'failed' else 'answered' end,
         answer = p_answer,
         grounding_status = p_grounding,
         model = p_model,
         input_tokens = p_tokens_in,
         output_tokens = p_tokens_out,
         finished_at = now()
   where id = p_turn and user_id = p_actor and status = 'pending';
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
end $$;
alter function api_server.portfolio_ai_finish_turn(uuid, uuid, jsonb, public.grounding_status_enum, text, integer, integer) owner to motion_definer;
revoke all on function api_server.portfolio_ai_finish_turn(uuid, uuid, jsonb, public.grounding_status_enum, text, integer, integer) from public, anon, authenticated;
grant execute on function api_server.portfolio_ai_finish_turn(uuid, uuid, jsonb, public.grounding_status_enum, text, integer, integer) to service_role;
