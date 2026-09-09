-- MOTION — Claude-assisted PDF extraction, the server side (PDF slice 2a, ADR-084).
-- IMPORT_ENGINE.md §5.4; AI_ARCHITECTURE.md §11, §14; ADR-033; CD-11; CD-35.
--
-- Three server functions carry the job's writes, so the job holds no rule of its own:
--   * begin_extraction  — the failed pdf_text batch becomes a pdf_claude batch that is parsing, and
--                         the consent audit `document.sent_to_ai` is written before any page is sent;
--   * charge_extraction_page — BEFORE every model call: the flag, the daily page budget (a page
--                         that fails eight times costs eight, R2-C-11) and the monthly token ceiling;
--   * record_extraction_page — what one page attempt cost and how it ended, on the batch.
-- Extraction tokens count under the same monthly ceiling as the analyst's (§11): one helper sums
-- both, and the analyst's persistence and quota functions are re-created to read it.

alter table public.import_batches
  add column if not exists extraction_stats jsonb not null default '{}'::jsonb;
comment on column public.import_batches.extraction_stats is
  '§5.4 per-page completion: {pages_total, pages_extracted[], pages_failed[], pages_deferred[], attempts{page:n}, tokens_in, tokens_out, confidence{page}, line_counts{page}, balances_read{opening,closing}}';

create function app.ai_tokens_used_this_month(p_org uuid)
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0))
                     from public.ai_messages m
                    where m.organization_id = p_org
                      and m.created_at >= date_trunc('month', now() at time zone 'utc')), 0)
       + coalesce((select sum(coalesce((b.extraction_stats ->> 'tokens_in')::bigint, 0)
                            + coalesce((b.extraction_stats ->> 'tokens_out')::bigint, 0))
                     from public.import_batches b
                    where b.organization_id = p_org
                      and b.updated_at >= date_trunc('month', now() at time zone 'utc')), 0);
$$;
alter function app.ai_tokens_used_this_month(uuid) owner to motion_definer;
revoke all on function app.ai_tokens_used_this_month(uuid) from public, anon, authenticated;

create function api_server.begin_extraction(p_actor uuid, p_org uuid, p_batch uuid, p_document uuid, p_pages_total integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_status public.import_batch_status_enum; v_method public.extraction_method_enum; v_text boolean; v_flag boolean;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null or not app.has_permission_of(p_actor, p_org, 'imports.review') then
    raise exception 'PERMISSION_DENIED: imports.review required' using errcode = '42501';
  end if;
  select (o.features ->> 'ai_pdf_extraction')::boolean into v_flag from public.organizations o where o.id = p_org;
  if coalesce(v_flag, false) is not true then
    raise exception 'PERMISSION_DENIED: AI reading of documents is not enabled for this organisation' using errcode = '42501';
  end if;
  select b.status, b.extraction_method into v_status, v_method
    from public.import_batches b where b.organization_id = p_org and b.id = p_batch and b.source_document_id = p_document;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- §5.4: only after the deterministic parse failed, and only for a document with a text layer.
  if not (v_status = 'failed' and v_method = 'pdf_text') then
    raise exception 'CONFLICT: AI reading is offered only for a PDF the deterministic parser could not read' using errcode = '40001';
  end if;
  select d.has_text_layer into v_text from public.source_documents d where d.organization_id = p_org and d.id = p_document and d.deleted_at is null;
  if coalesce(v_text, false) is not true then
    raise exception 'CONFLICT: this document has no text layer to read' using errcode = '40001';
  end if;

  update public.import_batches
     set extraction_method = 'pdf_claude', status = 'parsing', error_summary = null,
         pages_extracted = 0, pages_failed = array[]::integer[],
         extraction_stats = jsonb_build_object('pages_total', p_pages_total, 'pages_extracted', '[]'::jsonb,
                                               'pages_failed', '[]'::jsonb, 'pages_deferred', '[]'::jsonb,
                                               'attempts', '{}'::jsonb, 'tokens_in', 0, 'tokens_out', 0,
                                               'confidence', '{}'::jsonb, 'line_counts', '{}'::jsonb),
         updated_at = now()
   where organization_id = p_org and id = p_batch;
  delete from public.import_rows r where r.organization_id = p_org and r.batch_id = p_batch;

  -- F-A-15, CD-35: the text of this document is about to be sent to the provider, with the reviewer
  -- who consented as the actor.
  insert into public.audit_events (organization_id, actor_user_id, actor_type, action, target_table, target_id, metadata)
  values (p_org, p_actor, 'user', 'document.sent_to_ai', 'source_documents', p_document,
          jsonb_build_object('document_id', p_document, 'pages', p_pages_total, 'batch_id', p_batch));
  return p_batch;
end $$;

create function api_server.charge_extraction_page(p_actor uuid, p_org uuid, p_document uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_flag boolean; v_pages bigint; v_ceiling bigint;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null or not app.has_permission_of(p_actor, p_org, 'imports.review') then
    raise exception 'PERMISSION_DENIED: imports.review required' using errcode = '42501';
  end if;
  select (o.features ->> 'ai_pdf_extraction')::boolean into v_flag from public.organizations o where o.id = p_org;
  if coalesce(v_flag, false) is not true then
    raise exception 'PERMISSION_DENIED: AI reading of documents is not enabled for this organisation' using errcode = '42501';
  end if;
  if not exists (select 1 from public.source_documents d where d.organization_id = p_org and d.id = p_document and d.deleted_at is null) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- ADR-033: the daily page budget is charged per model call, first attempts and retries alike.
  v_pages := app.effective_quota(p_org, 'ai_extraction_pages_per_day');
  if v_pages is not null then
    perform app.throttle(p_org, 'ai_extraction_page', v_pages::integer, interval '1 day');
  end if;
  v_ceiling := app.effective_quota(p_org, 'ai_token_ceiling_monthly');
  if v_ceiling is not null and app.ai_tokens_used_this_month(p_org) >= v_ceiling then
    raise exception 'QUOTA: this organisation has reached its monthly AI allowance' using errcode = '53400';
  end if;
end $$;

create function api_server.record_extraction_page(
  p_actor uuid, p_org uuid, p_batch uuid, p_page integer, p_outcome text,
  p_tokens_in integer default 0, p_tokens_out integer default 0, p_confidence text default null,
  p_line_count integer default null, p_error text default null, p_balances_read jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_stats jsonb; v_attempts integer;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_outcome not in ('extracted', 'failed', 'deferred') then
    raise exception 'VALIDATION: a page attempt is extracted, failed or deferred' using errcode = '22023';
  end if;
  select b.extraction_stats into v_stats from public.import_batches b where b.organization_id = p_org and b.id = p_batch;
  if v_stats is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_attempts := coalesce((v_stats -> 'attempts' ->> p_page::text)::integer, 0) + 1;
  v_stats := jsonb_set(v_stats, array['attempts', p_page::text], to_jsonb(v_attempts), true);
  v_stats := jsonb_set(v_stats, '{tokens_in}', to_jsonb(coalesce((v_stats ->> 'tokens_in')::bigint, 0) + p_tokens_in), true);
  v_stats := jsonb_set(v_stats, '{tokens_out}', to_jsonb(coalesce((v_stats ->> 'tokens_out')::bigint, 0) + p_tokens_out), true);
  if p_line_count is not null then
    v_stats := jsonb_set(v_stats, array['line_counts', p_page::text], to_jsonb(p_line_count), true);
  end if;
  -- A page leaves the failed/deferred lists when it succeeds, and the extracted list holds it once.
  v_stats := jsonb_set(v_stats, '{pages_failed}', coalesce((select jsonb_agg(e) from jsonb_array_elements(v_stats -> 'pages_failed') e where e <> to_jsonb(p_page)), '[]'::jsonb), true);
  v_stats := jsonb_set(v_stats, '{pages_deferred}', coalesce((select jsonb_agg(e) from jsonb_array_elements(v_stats -> 'pages_deferred') e where e <> to_jsonb(p_page)), '[]'::jsonb), true);
  if p_outcome = 'extracted' then
    if not (v_stats -> 'pages_extracted') @> to_jsonb(array[p_page]) then
      v_stats := jsonb_set(v_stats, '{pages_extracted}', (v_stats -> 'pages_extracted') || to_jsonb(p_page), true);
    end if;
    if p_confidence is not null then
      v_stats := jsonb_set(v_stats, array['confidence', p_page::text], to_jsonb(p_confidence), true);
    end if;
  elsif p_outcome = 'failed' then
    v_stats := jsonb_set(v_stats, '{pages_failed}', (v_stats -> 'pages_failed') || to_jsonb(p_page), true);
  else
    v_stats := jsonb_set(v_stats, '{pages_deferred}', (v_stats -> 'pages_deferred') || to_jsonb(p_page), true);
  end if;
  if p_error is not null then
    v_stats := jsonb_set(v_stats, array['errors', p_page::text], to_jsonb(left(p_error, 300)), true);
  end if;
  -- F-C-03: what the model READ as the balances is kept for the reviewer's "matches / differs"
  -- line only. It is never written to statement_opening/closing_balance, which the gate reads.
  if p_balances_read is not null then
    v_stats := jsonb_set(v_stats, '{balances_read}', coalesce(v_stats -> 'balances_read', '{}'::jsonb) || p_balances_read, true);
  end if;

  update public.import_batches
     set extraction_stats = v_stats,
         pages_extracted = jsonb_array_length(v_stats -> 'pages_extracted'),
         pages_failed = coalesce((select array_agg((e)::integer order by (e)::integer) from jsonb_array_elements_text(v_stats -> 'pages_failed') e), array[]::integer[]),
         updated_at = now()
   where organization_id = p_org and id = p_batch;
end $$;

-- Ownership and grants: server only (ADR-043).
do $$
declare f text;
begin
  foreach f in array array[
    'api_server.begin_extraction(uuid, uuid, uuid, uuid, integer)',
    'api_server.charge_extraction_page(uuid, uuid, uuid)',
    'api_server.record_extraction_page(uuid, uuid, uuid, integer, text, integer, integer, text, integer, text, jsonb)'
  ] loop
    execute format('alter function %s owner to motion_definer', f);
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- The analyst's two readers of the monthly ceiling, re-created on the shared sum (AI_ARCHITECTURE.md §11).
create or replace function api_server.ai_persist_turn(
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

    v_used_month := app.ai_tokens_used_this_month(p_org);
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

create or replace function api.ai_quota_status(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_daily      bigint;
  v_ceiling    bigint;
  v_used_today bigint;
  v_used_month bigint;
  v_day_start  timestamptz;
begin
  if p_org is null or p_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(p_org, 'ai.use');

  v_daily     := app.effective_quota(p_org, 'ai_quota_daily');
  v_ceiling   := app.effective_quota(p_org, 'ai_token_ceiling_monthly');
  v_day_start := date_trunc('day', now() at time zone 'utc') at time zone 'utc';

  -- Identical to the user half of api_server.ai_persist_turn: user turns since UTC midnight, and
  -- every token this month.
  select count(*) into v_used_today
    from public.ai_messages m
   where m.organization_id = p_org and m.role = 'user'
     and m.created_at >= date_trunc('day', now() at time zone 'utc');

  v_used_month := app.ai_tokens_used_this_month(p_org);

  return jsonb_build_object(
    'used_today',       v_used_today,
    'daily_limit',      v_daily,
    'remaining_today',  case when v_daily is null then null else greatest(v_daily - v_used_today, 0) end,
    'tokens_month',     v_used_month,
    'monthly_ceiling',  v_ceiling,
    'monthly_exhausted', (v_ceiling is not null and v_used_month >= v_ceiling),
    'resets_at',        v_day_start + interval '1 day');
end $$;

alter function api.ai_quota_status(uuid) owner to motion_definer;
revoke all on function api.ai_quota_status(uuid) from public, anon;
grant execute on function api.ai_quota_status(uuid) to authenticated;
