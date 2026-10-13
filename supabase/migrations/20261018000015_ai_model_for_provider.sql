-- APX — One provider's own model choice, whichever provider is active (ADR-170).
--
-- Owner, 2026-10-13: the Marketing report (and later the Investment report) is written by ChatGPT
-- through the OpenAI key, whichever provider is active for the rest of the app. ADR-165 stores each
-- provider's model and effort separately in platform_settings.ai_model
--   {"active": "anthropic"|"openai", "anthropic": {model, effort}|null, "openai": {model, effort}|null}
-- but the server's only read, api_server.ai_model(), returns the ACTIVE provider's choice. The report
-- needs the OpenAI card's model while Anthropic is active, so:
--
-- api_server.ai_model_for(p_provider) — that provider's choice in the shape api_server.ai_model()
--   already returns ({provider, model, effort}), or NULL when the provider has no model chosen. It
--   never looks at which provider is active, and it changes nothing. A provider other than
--   'anthropic' or 'openai' is refused (VALIDATION). Service role only, like ai_model() and the keys:
--   the browser never reads which model the server calls.
--
-- api_server.ai_model() is unchanged, so the analyst and the readers still follow the active provider.

create function api_server.ai_model_for(p_provider text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_choice jsonb;
begin
  if p_provider is null or p_provider not in ('anthropic', 'openai') then
    raise exception 'VALIDATION: the provider is anthropic or openai' using errcode = '22023';
  end if;

  select s.value -> p_provider into v_choice from public.platform_settings s where s.key = 'ai_model';
  if v_choice is null or jsonb_typeof(v_choice) <> 'object' or v_choice ->> 'model' is null then
    return null;
  end if;
  return jsonb_build_object('provider', p_provider, 'model', v_choice -> 'model', 'effort', v_choice -> 'effort');
end $$;

alter function api_server.ai_model_for(text) owner to motion_definer;
revoke all on function api_server.ai_model_for(text) from public, anon, authenticated;
grant execute on function api_server.ai_model_for(text) to service_role;
