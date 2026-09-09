-- MOTION — AI Analyst · The server persists a turn; a browser never can (ADR-076).
-- Contract: AI_ARCHITECTURE.md §2 steps 4, 10, 11; §4; §11; §14.14; DATABASE_ARCHITECTURE.md §7
--           (ai_* tables), §14.2 `ai_persist_turn`; ADR-043 (api_server), ADR-045.9 (server-owned
--           fields), R2-A-01 (no forged "passed" turn); MVP_SCOPE.md §2.10.
--
-- Every document that names the analyst names this function, and it did not exist. `ai_messages`,
-- `ai_tool_calls` and the `ai_response` bundle are the AI audit trail: `grounding_status`, the
-- tool-call log and the token counts are facts the SERVER observed, and the whole of R2-A-01 is
-- that a user JWT cannot write them. So they are written here, behind the service-role guard, with
-- the human actor passed explicitly and re-validated — the same shape as every `api_server.*`.
--
-- Two calls per turn (§2):
--   * user half — `p_user_message` set: the quota and the 10/min throttle are charged HERE, before
--     the model is called, so an exhausted organisation never pays for a model call it will not get;
--   * assistant half — `p_assistant` set: one transaction writes the message row, every tool call,
--     and the evidence bundle whose items are drawn ONLY from ids the tool calls of this same call
--     carried (`bundle item ids ⊆ tool-returned ids/hashes`, §14.2) — the model cannot cite what no
--     tool returned, and the database, not the loop, is what refuses it.
--
-- Quotas resolve through `app.effective_quota`: a per-organisation override in `platform_org_settings`
-- (platform-writable only, ADR-038.5) else the platform default. `organizations.settings` cannot
-- raise a quota (F-A-09).

-- ---------------------------------------------------------------------------
-- The quota resolver.
-- ---------------------------------------------------------------------------
create function app.effective_quota(p_org uuid, p_key text)
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select case p_key
              when 'ai_quota_daily'              then s.ai_quota_daily::bigint
              when 'ai_token_ceiling_monthly'    then s.ai_token_ceiling_monthly
              when 'ai_extraction_pages_per_day' then s.ai_extraction_pages_per_day::bigint
            end
       from public.platform_org_settings s where s.organization_id = p_org),
    (select (ps.value #>> '{}')::bigint from public.platform_settings ps where ps.key = p_key));
$$;
alter function app.effective_quota(uuid, text) owner to motion_definer;
revoke all on function app.effective_quota(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The one writer of a turn.
-- ---------------------------------------------------------------------------
create function api_server.ai_persist_turn(
  p_actor        uuid,
  p_org          uuid,
  p_conversation uuid,
  p_user_message text    default null,
  p_assistant    jsonb   default null,
  p_tool_calls   jsonb   default '[]'::jsonb,
  p_bundle       jsonb   default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_message    uuid;
  v_bundle     uuid;
  v_status     public.grounding_status_enum;
  v_daily      bigint;
  v_ceiling    bigint;
  v_used_today bigint;
  v_used_month bigint;
  v_tokens_in  integer;
  v_tokens_out integer;
  v_call       jsonb;
  v_item       jsonb;
  v_sort       integer := 0;
  v_returned   uuid[];
  v_hashes     bytea[];
  v_type       public.evidence_item_enum;
  v_ref        uuid;
  v_hash       bytea;
  v_audit      text;
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
  -- §2 step 3 / F-C-11: the conversation belongs to (org, actor), or it does not exist.
  if not exists (select 1 from public.ai_conversations c
                  where c.organization_id = p_org and c.id = p_conversation
                    and c.user_id = p_actor and c.status = 'active') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if (p_user_message is null) = (p_assistant is null) then
    raise exception 'VALIDATION: exactly one of a user message or an assistant payload is persisted per call'
      using errcode = '22023';
  end if;

  -- ------------------------------------------------------------------------
  -- The user half: charge the quota and the throttle BEFORE the model is called.
  -- ------------------------------------------------------------------------
  if p_user_message is not null then
    perform app.throttle(p_actor, 'ai_turn', 10, interval '1 minute');

    v_daily   := app.effective_quota(p_org, 'ai_quota_daily');
    v_ceiling := app.effective_quota(p_org, 'ai_token_ceiling_monthly');

    select count(*) into v_used_today
      from public.ai_messages m
     where m.organization_id = p_org and m.role = 'user'
       and m.created_at >= date_trunc('day', now() at time zone 'utc');
    if v_daily is not null and v_used_today >= v_daily then
      raise exception 'QUOTA: this organisation has used its % analyst questions for today', v_daily
        using errcode = '53400';
    end if;

    select coalesce(sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0)), 0) into v_used_month
      from public.ai_messages m
     where m.organization_id = p_org
       and m.created_at >= date_trunc('month', now() at time zone 'utc');
    if v_ceiling is not null and v_used_month >= v_ceiling then
      raise exception 'QUOTA: this organisation has reached its monthly analyst allowance'
        using errcode = '53400';
    end if;

    insert into public.ai_messages (organization_id, conversation_id, role, content)
    values (p_org, p_conversation, 'user', p_user_message)
    returning id into v_message;

    update public.ai_conversations
       set last_message_at = now()
     where organization_id = p_org and id = p_conversation;

    return jsonb_build_object('message_id', v_message,
                              'quota', jsonb_build_object(
                                'daily', v_daily, 'used_today', v_used_today + 1,
                                'monthly_tokens', v_ceiling, 'used_month_tokens', v_used_month));
  end if;

  -- ------------------------------------------------------------------------
  -- The assistant half: message, tool calls, bundle — one transaction.
  -- ------------------------------------------------------------------------
  v_status     := (p_assistant ->> 'grounding_status')::public.grounding_status_enum;
  v_tokens_in  := (p_assistant ->> 'input_tokens')::integer;
  v_tokens_out := (p_assistant ->> 'output_tokens')::integer;
  if v_status is null then
    raise exception 'VALIDATION: an assistant turn carries a grounding_status' using errcode = '22023';
  end if;

  -- `content` is NULL for an assistant row by constraint (`ai_messages_channel`): nothing the model
  -- wrote outside `submit_answer` is stored (§14.11, F-C-08).
  insert into public.ai_messages
         (organization_id, conversation_id, role, content, structured_response, prompt_version,
          model, input_tokens, output_tokens, latency_ms, grounding_status, grounding_report,
          period_context)
  values (p_org, p_conversation, 'assistant', null,
          p_assistant -> 'structured_response',
          p_assistant ->> 'prompt_version',
          p_assistant ->> 'model',
          v_tokens_in, v_tokens_out,
          (p_assistant ->> 'latency_ms')::integer,
          v_status,
          p_assistant -> 'grounding_report',
          -- §8: the period context is stored on every assistant row. A turn that failed before
          -- resolution has none; an empty object records that fact rather than refusing the row
          -- that exists to record the failure.
          coalesce(p_assistant -> 'period_context', '{}'::jsonb))
  returning id into v_message;

  -- Tool calls, in sequence. What each returned is what the bundle may cite.
  v_returned := array[]::uuid[];
  v_hashes   := array[]::bytea[];
  for v_call in select * from jsonb_array_elements(coalesce(p_tool_calls, '[]'::jsonb)) loop
    insert into public.ai_tool_calls
           (organization_id, message_id, sequence, tool_name, input, authorized, denial_reason,
            output_hash, output_summary, duration_ms, error)
    values (p_org, v_message,
            (v_call ->> 'sequence')::smallint,
            v_call ->> 'tool_name',
            coalesce(v_call -> 'input', '{}'::jsonb),
            coalesce((v_call ->> 'authorized')::boolean, true),
            v_call ->> 'denial_reason',
            case when v_call ->> 'output_hash' is null then null else decode(v_call ->> 'output_hash', 'hex') end,
            v_call -> 'output_summary',
            (v_call ->> 'duration_ms')::integer,
            v_call ->> 'error');

    select v_returned || coalesce(array(select (e #>> '{}')::uuid
                                          from jsonb_array_elements(v_call -> 'returned_ids') e), array[]::uuid[])
      into v_returned;
    select v_hashes || coalesce(array(select decode(e #>> '{}', 'hex')
                                        from jsonb_array_elements(v_call -> 'returned_hashes') e), array[]::bytea[])
      into v_hashes;
  end loop;

  -- The bundle, only for a passed or degraded answer, and only from what the tools returned.
  if p_bundle is not null and v_status in ('passed', 'degraded') then
    if jsonb_typeof(p_bundle -> 'items') <> 'array' or jsonb_array_length(p_bundle -> 'items') = 0 then
      raise exception 'VALIDATION: an evidence bundle needs at least one item' using errcode = '22023';
    end if;

    insert into public.evidence_bundles
           (organization_id, kind, origin_table, origin_id, calculation_run_id,
            created_by_type, created_by)
    values (p_org, 'ai_response', 'ai_messages', v_message,
            (p_bundle ->> 'calculation_run_id')::uuid, 'ai', p_actor)
    returning id into v_bundle;

    for v_item in select * from jsonb_array_elements(p_bundle -> 'items') loop
      v_type := (v_item ->> 'item_type')::public.evidence_item_enum;
      v_ref  := nullif(v_item ->> 'ref_id', '')::uuid;
      v_hash := case when v_item ->> 'descriptor_hash' is null then null
                     else decode(v_item ->> 'descriptor_hash', 'hex') end;

      -- §14.2: bundle item ids ⊆ tool-returned ids/hashes of THIS call. The database refuses a
      -- citation the model invented, whatever the loop believed.
      if v_type = 'query' then
        if v_hash is null or not (v_hash = any (v_hashes)) then
          raise exception 'VALIDATION: evidence cites a descriptor no tool returned this turn'
            using errcode = '22023';
        end if;
      elsif v_ref is null or not (v_ref = any (v_returned)) then
        raise exception 'VALIDATION: evidence cites % which no tool returned this turn', v_ref
          using errcode = '22023';
      end if;

      insert into public.evidence_items
             (organization_id, bundle_id, sort_order, item_type, ref_id, ref_revision_no,
              query_descriptor, descriptor_hash, label, claim, assurance_level)
      values (p_org, v_bundle, v_sort, v_type, v_ref,
              (v_item ->> 'ref_revision_no')::integer,
              case when v_type = 'query' then v_item -> 'query_descriptor' else null end,
              v_hash,
              v_item ->> 'label',
              nullif(v_item ->> 'claim', ''),
              (v_item ->> 'assurance_level')::public.assurance_level_enum);
      v_sort := v_sort + 1;
    end loop;

    update public.ai_messages set evidence_bundle_id = v_bundle
     where organization_id = p_org and id = v_message;
  end if;

  update public.ai_conversations
     set last_message_at = now(),
         title = coalesce(title, left(p_assistant ->> 'title', 120))
   where organization_id = p_org and id = p_conversation;

  v_audit := case
    when v_status = 'not_applicable' then 'ai.refused'
    when (p_assistant ->> 'context_changed')::boolean then 'ai.context_changed'
    else 'ai.answered' end;
  perform app.audit(p_org, v_audit, 'ai_messages', v_message, null,
                    jsonb_build_object('grounding_status', v_status,
                                       'tool_calls', jsonb_array_length(coalesce(p_tool_calls, '[]'::jsonb)),
                                       'input_tokens', v_tokens_in, 'output_tokens', v_tokens_out),
                    '{}'::jsonb, p_actor);

  return jsonb_build_object('message_id', v_message, 'evidence_bundle_id', v_bundle);
end $$;

alter function api_server.ai_persist_turn(uuid, uuid, uuid, text, jsonb, jsonb, jsonb) owner to motion_definer;
revoke all on function api_server.ai_persist_turn(uuid, uuid, uuid, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function api_server.ai_persist_turn(uuid, uuid, uuid, text, jsonb, jsonb, jsonb) to service_role;
