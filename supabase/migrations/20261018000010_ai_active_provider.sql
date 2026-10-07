-- MOTION — One AI provider is active at a time (ADR-165).
--
-- Owner, 2026-10-07: "Add a button to activate or inactivate the OpenAI key and the AI provider key.
-- Only one should be active ... If OpenAI is active, the AI provider key will be inactive", and the
-- OpenAI card gets its own model and effort choice.
--
-- platform_settings.ai_model becomes
--   {"active": "anthropic"|"openai",
--    "anthropic": {"model": .., "effort": ..} | null,    -- null: the server's default model
--    "openai":    {"model": .., "effort": ..} | null}
-- so each provider remembers its own model, and switching the active one never loses the other's.
-- An ADR-163/164 row ({provider, model, effort}) is converted here.
--
-- api.set_ai_model(p_model, p_effort, p_provider) — that provider's model and effort; it does NOT
--   change which provider is active. A NULL model clears that provider's choice.
-- api.set_ai_active_provider(p_provider) — makes one provider active, so the other is inactive.
--   OpenAI needs its key stored and a model chosen first. Super admin, recent sign-in, audited.
-- api_server.ai_model() — still returns {provider, model, effort} for the ACTIVE provider (NULL for
--   Anthropic with no choice: the server's default), so the server is unchanged.

update public.platform_settings s
   set value = jsonb_build_object(
         'active', coalesce(s.value ->> 'provider', 'anthropic'),
         'anthropic', case when coalesce(s.value ->> 'provider', 'anthropic') = 'anthropic'
                           then jsonb_build_object('model', s.value -> 'model', 'effort', s.value -> 'effort') end,
         'openai', case when s.value ->> 'provider' = 'openai'
                        then jsonb_build_object('model', s.value -> 'model', 'effort', s.value -> 'effort') end)
 where s.key = 'ai_model' and s.value ? 'model';

drop function api.set_ai_model(text, text, text);
create function api.set_ai_model(p_model text, p_effort text, p_provider text default 'anthropic')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  if p_provider is null or p_provider not in ('anthropic', 'openai') then
    raise exception 'VALIDATION: the provider is anthropic or openai' using errcode = '22023';
  end if;
  if p_model is not null and (
       (p_provider = 'anthropic' and p_model !~ '^claude-[a-z0-9][a-z0-9.-]{2,80}$')
    or (p_provider = 'openai' and p_model !~ '^[a-z0-9][a-z0-9.:_-]{1,80}$')) then
    raise exception 'VALIDATION: that is not a model id for that provider' using errcode = '22023';
  end if;
  if p_effort is not null and (
       (p_provider = 'anthropic' and p_effort not in ('low', 'medium', 'high', 'xhigh', 'max'))
    or (p_provider = 'openai' and p_effort not in ('low', 'medium', 'high'))) then
    raise exception 'VALIDATION: that effort is not one this provider accepts' using errcode = '22023';
  end if;
  if p_model is null and p_effort is not null then
    raise exception 'VALIDATION: choose a model to set its effort' using errcode = '22023';
  end if;
  if p_model is null and p_provider = 'openai' and exists (
       select 1 from public.platform_settings s where s.key = 'ai_model' and s.value ->> 'active' = 'openai') then
    raise exception 'CONFLICT: OpenAI is active; make Anthropic active before clearing its model' using errcode = '23505';
  end if;

  select s.value into v_before from public.platform_settings s where s.key = 'ai_model';
  v_after := coalesce(v_before, jsonb_build_object('active', 'anthropic', 'anthropic', null, 'openai', null))
             || jsonb_build_object(p_provider,
                  case when p_model is null then null else jsonb_build_object('model', p_model, 'effort', p_effort) end);

  insert into public.platform_settings (key, value, updated_by)
  values ('ai_model', v_after, app.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;

  perform app.audit(null, 'platform.ai_model_changed', 'platform_settings', null,
                    jsonb_build_object('ai_model', v_before), jsonb_build_object('ai_model', v_after), '{}'::jsonb);
  return v_after;
end $$;

alter function api.set_ai_model(text, text, text) owner to motion_definer;
revoke all on function api.set_ai_model(text, text, text) from public, anon;
grant execute on function api.set_ai_model(text, text, text) to authenticated;

create function api.set_ai_active_provider(p_provider text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  if p_provider is null or p_provider not in ('anthropic', 'openai') then
    raise exception 'VALIDATION: the provider is anthropic or openai' using errcode = '22023';
  end if;
  select s.value into v_before from public.platform_settings s where s.key = 'ai_model';
  if p_provider = 'openai' then
    if not exists (select 1 from vault.secrets v where v.name = 'openai_api_key') then
      raise exception 'VALIDATION: store an OpenAI key first' using errcode = '22023';
    end if;
    if v_before -> 'openai' ->> 'model' is null then
      raise exception 'VALIDATION: choose an OpenAI model first' using errcode = '22023';
    end if;
  end if;

  v_after := coalesce(v_before, jsonb_build_object('anthropic', null, 'openai', null))
             || jsonb_build_object('active', p_provider);
  insert into public.platform_settings (key, value, updated_by)
  values ('ai_model', v_after, app.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;

  perform app.audit(null, 'platform.ai_provider_activated', 'platform_settings', null,
                    jsonb_build_object('active', v_before ->> 'active'), jsonb_build_object('active', p_provider), '{}'::jsonb);
  return v_after;
end $$;

alter function api.set_ai_active_provider(text) owner to motion_definer;
revoke all on function api.set_ai_active_provider(text) from public, anon;
grant execute on function api.set_ai_active_provider(text) to authenticated;

-- The server's read: the ACTIVE provider's choice, in the shape it already understands.
create or replace function api_server.ai_model()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case
           when s.value ->> 'active' = 'openai' and s.value -> 'openai' ->> 'model' is not null
             then jsonb_build_object('provider', 'openai', 'model', s.value -> 'openai' -> 'model', 'effort', s.value -> 'openai' -> 'effort')
           when s.value -> 'anthropic' ->> 'model' is not null
             then jsonb_build_object('provider', 'anthropic', 'model', s.value -> 'anthropic' -> 'model', 'effort', s.value -> 'anthropic' -> 'effort')
         end
    from public.platform_settings s where s.key = 'ai_model';
$$;

-- Removing the OpenAI key while OpenAI is active makes Anthropic active, in the same transaction:
-- the AI never points at a key that is gone.
create or replace function api.clear_openai_api_key()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_desc text;
begin
  perform app.throttle(app.uid(), 'rpc', 30, interval '1 minute');
  perform app.require_super_admin(true);

  delete from vault.secrets s where s.name = 'openai_api_key' returning s.description into v_desc;
  if v_desc is null then
    return false;
  end if;
  update public.platform_settings s
     set value = s.value || jsonb_build_object('active', 'anthropic'), updated_by = app.uid()
   where s.key = 'ai_model' and s.value ->> 'active' = 'openai';
  perform app.audit(null, 'platform.openai_key_removed', 'platform_settings', null,
                    jsonb_build_object('key', v_desc), null, '{}'::jsonb);
  return true;
end $$;
