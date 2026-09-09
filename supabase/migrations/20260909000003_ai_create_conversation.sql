-- MOTION — a conversation opened by the server on a member's behalf (Phase 11 Slice 5, ADR-081).
--
-- api.create_conversation derives its owner from app.uid(): the session's user. The nightly live
-- evaluation (AI_ARCHITECTURE.md §12) runs as a job with no session, acting AS the person who
-- requested it, and needs a conversation that person owns — bound to (org, actor) exactly as
-- api_server.ai_persist_turn will require on every turn (F-C-11). Same guards as that function:
-- service role only, an actor is required, and the actor must hold `ai.use` in the organisation.

create function api_server.ai_create_conversation(p_actor uuid, p_org uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null then
    raise exception 'PERMISSION_DENIED: an actor is required' using errcode = '42501';
  end if;
  if not app.has_permission_of(p_actor, p_org, 'ai.use') then
    raise exception 'PERMISSION_DENIED: ai.use required' using errcode = '42501';
  end if;

  insert into public.ai_conversations (organization_id, user_id)
  values (p_org, p_actor)
  returning id into v_id;
  return v_id;
end $$;

alter function api_server.ai_create_conversation(uuid, uuid) owner to motion_definer;
revoke all on function api_server.ai_create_conversation(uuid, uuid) from public, anon, authenticated;
grant execute on function api_server.ai_create_conversation(uuid, uuid) to service_role;
