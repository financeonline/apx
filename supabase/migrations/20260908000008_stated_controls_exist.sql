-- MOTION — Four stated controls that did not exist, made to exist or withdrawn (ADR-075).
-- Contract: SECURITY_MODEL.md §4 (session revocation semantics), TENANCY_MODEL.md §5.4,
--           IMPORT_ENGINE.md §10 (in-place row edits re-validate), DATABASE_ARCHITECTURE.md §14;
--           PRODUCTION_AUDIT.md L2, L3, L5.
--
-- L3. `api.remove_member` said "session revocation is performed by tenancy.removeMember in
--     application code", and `api.revoke_platform_role`'s catalogue row said "revoke invalidates
--     sessions". Neither happened anywhere. And SECURITY_MODEL.md §4's mechanism — "via the Auth
--     admin API" — does not exist: GoTrue v2.196 exposes no admin endpoint that ends another
--     user's sessions (DELETE /admin/users/{id}/sessions, POST …/logout: 404). The primitive that
--     does exist is the session itself: `auth.sessions` and `auth.refresh_tokens`. Deleting them
--     ends every refresh immediately and makes the next `getUser()` fail (the session id in the
--     JWT no longer resolves), which is exactly "invalidated".
-- L5. `api.revoke_assignment` promised to archive the employee's conversations "once
--     ai_conversations exists". It exists.
-- L2. `api.fix_import_row` sets a row `pending` and nothing re-validates it; the commit gate
--     rightly refuses a pending row, so a fix parked the batch until it was rejected or replaced.
--     The review UI's in-place edit (IMPORT_ENGINE.md §10) is not built. Until the re-validation
--     slice exists the function is withheld from `authenticated`, not left as a trap.

-- ---------------------------------------------------------------------------
-- L3. Session revocation, at the database.
-- ---------------------------------------------------------------------------
grant select, delete on auth.sessions, auth.refresh_tokens to motion_definer;

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

alter function api_server.revoke_user_sessions(uuid) owner to motion_definer;
revoke all on function api_server.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function api_server.revoke_user_sessions(uuid) to service_role;

-- The comment in the function body said the application revoked sessions. Now it does.
create or replace function api.remove_member(p_org uuid, p_user uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $function$
declare
  v_role    text;
  v_current text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  v_role := app.require_permission(p_org, 'users.manage');

  select m.role::text into v_current from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = p_user;
  if v_current is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not app.ceiling_allows(v_role, v_current) then
    raise exception 'PERMISSION_DENIED: you cannot remove a %', v_current using errcode = '42501';
  end if;

  -- The last-owner guard is a trigger, so it holds even if this check is ever wrong.
  delete from public.organization_memberships
   where organization_id = p_org and user_id = p_user;

  perform app.audit(p_org, 'member.removed', 'organization_memberships', p_user,
                    jsonb_build_object('role', v_current), null, '{}'::jsonb);
  -- Access ends on the next request regardless (RLS re-resolves per request). When the remover is
  -- an owner, tenancy.removeMember additionally ends the removed member's sessions through
  -- api_server.revoke_user_sessions (SECURITY_MODEL.md §4; ADR-075) — a defence against a
  -- long-lived tab, not the control itself.
  return p_user;
end $function$;

-- ---------------------------------------------------------------------------
-- L5. Revoking an assignment archives the employee's conversations for that organisation.
-- ---------------------------------------------------------------------------
create or replace function api.revoke_assignment(p_assignment uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $function$
declare
  v_a        public.organization_assignments%rowtype;
  v_role     text;
  v_archived integer;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  select * into v_a from public.organization_assignments where id = p_assignment;
  if v_a.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  -- Super admin, or an OWNER of that organization: the tenant can always revoke adviser access
  -- (TENANCY_MODEL.md §5.4).
  if not app.is_super_admin() then
    v_role := app.require_org(v_a.organization_id);
    if v_role <> 'owner' then
      raise exception 'PERMISSION_DENIED: only an owner or a super admin can revoke adviser access'
        using errcode = '42501';
    end if;
  end if;

  update public.organization_assignments
     set status = 'revoked', revoked_by = app.uid(), revoked_reason = p_reason
   where id = p_assignment and status = 'active';
  if not found then
    raise exception 'CONFLICT: that assignment is not active' using errcode = '23514';
  end if;

  -- SECURITY_MODEL.md §4: the employee's open conversations for this organisation are archived.
  -- Their access to the organisation ends with the assignment; a live conversation about it would
  -- be a thread they can no longer stand behind.
  update public.ai_conversations
     set status = 'archived'
   where organization_id = v_a.organization_id
     and user_id = v_a.employee_user_id
     and status = 'active';
  get diagnostics v_archived = row_count;

  perform app.audit(v_a.organization_id, 'assignment.revoked', 'organization_assignments',
                    p_assignment, null,
                    jsonb_build_object('reason', p_reason, 'conversations_archived', v_archived),
                    '{}'::jsonb);
  perform app.audit(null, 'assignment.revoked', 'organization_assignments', p_assignment, null,
                    jsonb_build_object('organization_id', v_a.organization_id), '{}'::jsonb);
  return p_assignment;
end $function$;

-- ---------------------------------------------------------------------------
-- L2. Withheld until the re-validation slice exists.
-- ---------------------------------------------------------------------------
revoke execute on function api.fix_import_row(uuid, uuid, jsonb, uuid) from authenticated;
comment on function api.fix_import_row(uuid, uuid, jsonb, uuid) is
  'Withheld from authenticated (ADR-075): it sets a row pending and nothing re-validates it yet, '
  'so a fix parked the batch until it was rejected or replaced. Re-grant with the review UI''s '
  'in-place edit (IMPORT_ENGINE.md §10), which must re-validate the row.';
