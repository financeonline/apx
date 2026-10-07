-- MOTION — OpenAI as a second AI provider (ADR-164).
--
-- Owner, 2026-10-07: "make sure it's compatible with an OpenAI API key". The super admin may store an
-- OpenAI key beside the Anthropic one and choose a model from either provider.
--
-- 1. The OpenAI key: exactly the Anthropic key's rules (ADR-157) under the Vault name
--    `openai_api_key` — encrypted, set and removed by the super admin with a recent sign-in, audited
--    with the last four characters only, readable in clear by the service role alone.
-- 2. The model choice gains its provider: platform_settings.ai_model = {provider, model, effort}.
--    A stored choice without a provider is Anthropic (ADR-163 rows).

create function api.set_openai_api_key(p_key text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_key  text := btrim(coalesce(p_key, ''));
  v_id   uuid;
  v_last text;
begin
  perform app.throttle(app.uid(), 'rpc', 30, interval '1 minute');
  perform app.require_super_admin(true);

  if v_key !~ '^sk-[A-Za-z0-9_-]{20,}$' or v_key ~ '^sk-ant-' then
    raise exception 'VALIDATION: that does not look like an OpenAI API key (it starts sk-)' using errcode = '22023';
  end if;
  v_last := right(v_key, 4);

  select s.id into v_id from vault.secrets s where s.name = 'openai_api_key';
  if v_id is null then
    perform vault.create_secret(v_key, 'openai_api_key', 'ending ' || v_last);
  else
    perform vault.update_secret(v_id, v_key, 'openai_api_key', 'ending ' || v_last);
  end if;

  perform app.audit(null, 'platform.openai_key_set', 'platform_settings', null, null,
                    jsonb_build_object('ending', v_last), '{}'::jsonb);
  return v_last;
end $$;

alter function api.set_openai_api_key(text) owner to motion_definer;
revoke all on function api.set_openai_api_key(text) from public, anon;
grant execute on function api.set_openai_api_key(text) to authenticated;

create function api.clear_openai_api_key()
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
  perform app.audit(null, 'platform.openai_key_removed', 'platform_settings', null,
                    jsonb_build_object('key', v_desc), null, '{}'::jsonb);
  return true;
end $$;

alter function api.clear_openai_api_key() owner to motion_definer;
revoke all on function api.clear_openai_api_key() from public, anon;
grant execute on function api.clear_openai_api_key() to authenticated;

create function api.openai_api_key_status()
returns table (configured boolean, ending text, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_super_admin();
  return query
    select true, right(s.description, 4), s.updated_at
      from vault.secrets s where s.name = 'openai_api_key'
    union all
    select false, null::text, null::timestamptz
     where not exists (select 1 from vault.secrets s where s.name = 'openai_api_key');
end $$;

alter function api.openai_api_key_status() owner to motion_definer;
revoke all on function api.openai_api_key_status() from public, anon;
grant execute on function api.openai_api_key_status() to authenticated;

create function api_server.openai_api_key()
returns text language sql stable security definer set search_path = '' as $$
  select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'openai_api_key' limit 1;
$$;

alter function api_server.openai_api_key() owner to motion_definer;
revoke all on function api_server.openai_api_key() from public, anon, authenticated;
grant execute on function api_server.openai_api_key() to service_role;

-- 2. The choice with its provider.
drop function api.set_ai_model(text, text);
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

  select s.value into v_before from public.platform_settings s where s.key = 'ai_model';
  if p_model is null then
    delete from public.platform_settings where key = 'ai_model';
  else
    v_after := jsonb_build_object('provider', p_provider, 'model', p_model, 'effort', p_effort);
    insert into public.platform_settings (key, value, updated_by)
    values ('ai_model', v_after, app.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  end if;

  perform app.audit(null, 'platform.ai_model_changed', 'platform_settings', null,
                    jsonb_build_object('ai_model', v_before), jsonb_build_object('ai_model', v_after), '{}'::jsonb);
  return v_after;
end $$;

alter function api.set_ai_model(text, text, text) owner to motion_definer;
revoke all on function api.set_ai_model(text, text, text) from public, anon;
grant execute on function api.set_ai_model(text, text, text) to authenticated;
