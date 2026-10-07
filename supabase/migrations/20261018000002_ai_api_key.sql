-- MOTION — The AI provider key, set by the app's owner in Platform → Settings (ADR-157).
-- Contract: ADR-157; DATABASE_ARCHITECTURE.md §14; RBAC_MATRIX.md (super admin).
--
-- Owner, 2026-10-07: "add an API key in Settings for the owner of this app; to change it, remove the
-- old one, add the new one and save." One key for the whole platform (owner decision: app-wide).
--
--   - Stored ENCRYPTED in Supabase Vault (`vault.secrets`, name `anthropic_api_key`), never in a
--     plain table, never in `platform_settings` (whose rows the settings page shows and edits).
--   - Set and removed only by a super admin (with two-step sign-in, `app.require_super_admin(true)`),
--     audited with the last four characters only — the key itself is never logged or returned.
--   - Read back in clear ONLY by the server (`api_server.anthropic_api_key`, service role), when it
--     calls the model. When no key is stored the server falls back to its ANTHROPIC_API_KEY setting.

-- motion_definer owns the functions below; it needs Vault to store and remove the secret.
grant usage on schema vault to motion_definer;
grant select, delete on vault.secrets to motion_definer;
grant select on vault.decrypted_secrets to motion_definer;
grant execute on function vault.create_secret(text, text, text, uuid) to motion_definer;
grant execute on function vault.update_secret(uuid, text, text, text, uuid) to motion_definer;
-- Reading `vault.decrypted_secrets` runs Vault's decrypt function as the caller.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'vault' and p.proname = '_crypto_aead_det_decrypt' loop
    execute format('grant execute on function %s to motion_definer', f);
  end loop;
end $$;

create function api.set_ai_api_key(p_key text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_key  text := btrim(coalesce(p_key, ''));
  v_id   uuid;
  v_last text;
begin
  perform app.throttle(app.uid(), 'rpc', 30, interval '1 minute');
  perform app.require_super_admin(true);

  if v_key !~ '^sk-ant-[A-Za-z0-9_-]{20,}$' then
    raise exception 'VALIDATION: that does not look like an Anthropic API key (it starts sk-ant-)' using errcode = '22023';
  end if;
  v_last := right(v_key, 4);

  select s.id into v_id from vault.secrets s where s.name = 'anthropic_api_key';
  if v_id is null then
    perform vault.create_secret(v_key, 'anthropic_api_key', 'ending ' || v_last);
  else
    perform vault.update_secret(v_id, v_key, 'anthropic_api_key', 'ending ' || v_last);
  end if;

  perform app.audit(null, 'platform.ai_key_set', 'platform_settings', null, null,
                    jsonb_build_object('ending', v_last), '{}'::jsonb);
  return v_last;
end $$;

alter function api.set_ai_api_key(text) owner to motion_definer;
revoke all on function api.set_ai_api_key(text) from public, anon;
grant execute on function api.set_ai_api_key(text) to authenticated;

create function api.clear_ai_api_key()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_desc text;
begin
  perform app.throttle(app.uid(), 'rpc', 30, interval '1 minute');
  perform app.require_super_admin(true);

  delete from vault.secrets s where s.name = 'anthropic_api_key' returning s.description into v_desc;
  if v_desc is null then
    return false;
  end if;
  perform app.audit(null, 'platform.ai_key_removed', 'platform_settings', null,
                    jsonb_build_object('key', v_desc), null, '{}'::jsonb);
  return true;
end $$;

alter function api.clear_ai_api_key() owner to motion_definer;
revoke all on function api.clear_ai_api_key() from public, anon;
grant execute on function api.clear_ai_api_key() to authenticated;

-- What the settings page may show: whether a key is stored, its last four characters, and when.
create function api.ai_api_key_status()
returns table (configured boolean, ending text, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Reading the status needs a super admin, not a fresh sign-in: the page shows it on every visit.
  perform app.require_super_admin();
  return query
    select true, right(s.description, 4), s.updated_at
      from vault.secrets s where s.name = 'anthropic_api_key'
    union all
    select false, null::text, null::timestamptz
     where not exists (select 1 from vault.secrets s where s.name = 'anthropic_api_key');
end $$;

alter function api.ai_api_key_status() owner to motion_definer;
revoke all on function api.ai_api_key_status() from public, anon;
grant execute on function api.ai_api_key_status() to authenticated;

-- The key in clear, for the server's model calls only.
create function api_server.anthropic_api_key()
returns text language sql stable security definer set search_path = '' as $$
  select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'anthropic_api_key' limit 1;
$$;

alter function api_server.anthropic_api_key() owner to motion_definer;
revoke all on function api_server.anthropic_api_key() from public, anon, authenticated;
grant execute on function api_server.anthropic_api_key() to service_role;

comment on function api_server.anthropic_api_key() is
  'ADR-157: the AI provider key from Vault, for the server''s model calls only (service role).';
