-- MOTION — Two corrections to 20260908000008, learned from the structure it has to live in (ADR-075).
--
-- 1. Session revocation cannot be motion_definer's. Supabase's `postgres` role holds the auth tables
--    with grant option on SELECT only (`postgres=ar*wdDxtm`), so `grant select, delete … to
--    motion_definer` conferred `r` and silently nothing else: motion_definer could never delete a
--    session, locally or hosted. `postgres` itself holds DELETE. The function is therefore owned by
--    `postgres` — the ONE definer function in the database that is, allow-listed by name in
--    00_structure.test.sql — guarded by the service-role check like every api_server function, and
--    touching two tables in `auth` and nothing in `public`. The stray SELECT grant is revoked.
--
-- 2. `api.fix_import_row` is dropped, not withheld. ADR-026's invariant — every api.* function is
--    executable by `authenticated` (00_structure #245) — is worth more than a function nobody can
--    call. It returns with the review UI's in-place edit, which must re-validate the row
--    (IMPORT_ENGINE.md §10).

revoke all on auth.sessions, auth.refresh_tokens from motion_definer;

drop function api_server.revoke_user_sessions(uuid);

create function api_server.revoke_user_sessions(p_user uuid)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_sessions integer;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'VALIDATION: a user is required' using errcode = '22023';
  end if;
  delete from auth.refresh_tokens where user_id = p_user::text;
  delete from auth.sessions where user_id = p_user;
  get diagnostics v_sessions = row_count;
  return v_sessions;
end $$;

alter function api_server.revoke_user_sessions(uuid) owner to postgres;
revoke all on function api_server.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function api_server.revoke_user_sessions(uuid) to service_role;

drop function api.fix_import_row(uuid, uuid, jsonb, uuid);
