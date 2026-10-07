-- MOTION — The super admin chooses the AI model and its effort (ADR-163).
--
-- Owner, 2026-10-07: "add option to select AI models here" and "effort also" (the AI provider key
-- card on Account). The choice is `platform_settings.ai_model` = {"model": "<id>", "effort": "<level>"|null}.
-- Absent means the server's configuration (ANTHROPIC_MODEL, else the built-in default, ADR-162) at
-- the model's own default effort.
--
-- api.set_ai_model — the super admin with a recent sign-in, audited; a NULL model clears the choice.
--   Shapes are checked here; the server checks, against the provider's model list for the stored
--   key, that the model is offered and supports that effort before calling this.
-- api_server.ai_model — the service role's read, for the server that calls the model.

create function api.set_ai_model(p_model text, p_effort text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  if p_model is not null and p_model !~ '^claude-[a-z0-9][a-z0-9.-]{2,80}$' then
    raise exception 'VALIDATION: that is not a Claude model id' using errcode = '22023';
  end if;
  if p_effort is not null and p_effort not in ('low', 'medium', 'high', 'xhigh', 'max') then
    raise exception 'VALIDATION: effort is low, medium, high, xhigh or max' using errcode = '22023';
  end if;
  if p_model is null and p_effort is not null then
    raise exception 'VALIDATION: choose a model to set its effort' using errcode = '22023';
  end if;

  select s.value into v_before from public.platform_settings s where s.key = 'ai_model';
  if p_model is null then
    delete from public.platform_settings where key = 'ai_model';
  else
    v_after := jsonb_build_object('model', p_model, 'effort', p_effort);
    insert into public.platform_settings (key, value, updated_by)
    values ('ai_model', v_after, app.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  end if;

  perform app.audit(null, 'platform.ai_model_changed', 'platform_settings', null,
                    jsonb_build_object('ai_model', v_before), jsonb_build_object('ai_model', v_after), '{}'::jsonb);
  return v_after;
end $$;

alter function api.set_ai_model(text, text) owner to motion_definer;
revoke all on function api.set_ai_model(text, text) from public, anon;
grant execute on function api.set_ai_model(text, text) to authenticated;

create function api_server.ai_model()
returns jsonb language sql stable security definer set search_path = '' as $$
  select s.value from public.platform_settings s where s.key = 'ai_model';
$$;

alter function api_server.ai_model() owner to motion_definer;
revoke all on function api_server.ai_model() from public, anon, authenticated;
grant execute on function api_server.ai_model() to service_role;
