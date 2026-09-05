-- MOTION — Phase 1 · Triggers and constraint enforcement.
-- Contract: DATABASE_ARCHITECTURE.md §12; RBAC_MATRIX.md §3.1/§3.5; ADR-015, ADR-026.4, ADR-046.1.
-- These hold even when application code is wrong and, for append_only_guard, even under the
-- service role.

-- ---------------------------------------------------------------------------
-- profiles_from_auth — every auth user gets a profile (DATABASE_ARCHITECTURE.md §12)
-- ---------------------------------------------------------------------------
create function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, email_confirmed_at)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    new.email_confirmed_at
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger profiles_from_auth
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- Keep profiles.email in step with the authentication fact. profiles.email is never user-writable
-- (ADR-038.3): api.update_profile rejects it and this is the only writer.
create function app.sync_auth_user_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is distinct from old.email
     or new.email_confirmed_at is distinct from old.email_confirmed_at then
    update public.profiles
       set email = new.email, email_confirmed_at = new.email_confirmed_at
     where id = new.id;
  end if;
  return new;
end $$;

create trigger profiles_email_sync
  after update of email, email_confirmed_at on auth.users
  for each row execute function app.sync_auth_user_email();

-- ---------------------------------------------------------------------------
-- last_owner_guard — an organization always has at least one active owner (CD-14)
-- ---------------------------------------------------------------------------
create function app.last_owner_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_was_active_owner boolean;
  v_still_owner      boolean;
  v_remaining        integer;
begin
  -- The guard protects a LIVING organization from losing its last owner. When the organization
  -- itself is going away — a cascade delete, or the org.purge job — there is nothing left to
  -- protect, and refusing here would make an organization impossible to delete at all.
  if coalesce(current_setting('app.purge', true), 'off') = 'on'
     or not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_was_active_owner := (old.role = 'owner' and old.status = 'active');
  if not v_was_active_owner then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_still_owner := (tg_op = 'UPDATE' and new.role = 'owner' and new.status = 'active');
  if v_still_owner then
    return new;
  end if;

  select count(*) into v_remaining
    from public.organization_memberships m
   where m.organization_id = old.organization_id
     and m.role = 'owner' and m.status = 'active'
     and m.id <> old.id;

  if v_remaining = 0 then
    raise exception 'CONFLICT: an organization must keep at least one active owner'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger last_owner_guard
  before update or delete on public.organization_memberships
  for each row execute function app.last_owner_guard();

-- ---------------------------------------------------------------------------
-- platform_user_exclusivity — platform staff are never members of a customer organization
-- (RBAC_MATRIX.md §3.5). Enforced from both sides.
-- ---------------------------------------------------------------------------
create function app.membership_excludes_platform_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.platform_users p where p.user_id = new.user_id) then
    raise exception 'CONFLICT: a platform user cannot hold an organization membership'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger platform_user_exclusivity
  before insert or update on public.organization_memberships
  for each row execute function app.membership_excludes_platform_user();

create function app.platform_user_excludes_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.organization_memberships m where m.user_id = new.user_id) then
    raise exception 'CONFLICT: this user is a member of an organization and cannot hold a platform role'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger membership_exclusivity
  before insert or update on public.platform_users
  for each row execute function app.platform_user_excludes_membership();

-- ---------------------------------------------------------------------------
-- audit_diff — trigger-level row diffs as a backstop to the function-level events (ADR-015)
-- ---------------------------------------------------------------------------
create function app.audit_diff() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_after  jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row    jsonb := coalesce(v_after, v_before);
  v_org    uuid;
  v_target uuid;
begin
  if tg_table_name = 'organizations' then
    v_org := (v_row ->> 'id')::uuid;
  else
    v_org := nullif(v_row ->> 'organization_id', '')::uuid;
  end if;

  v_target := coalesce(
    nullif(v_row ->> 'id', '')::uuid,
    nullif(v_row ->> 'user_id', '')::uuid,
    nullif(v_row ->> 'organization_id', '')::uuid
  );

  perform app.audit(
    v_org,
    'db.' || tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    v_target,
    v_before,
    v_after,
    jsonb_build_object('source', 'trigger')
  );

  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger audit_diff after insert or update or delete on public.organizations
  for each row execute function app.audit_diff();
create trigger audit_diff after insert or update or delete on public.organization_memberships
  for each row execute function app.audit_diff();
create trigger audit_diff after insert or update or delete on public.organization_assignments
  for each row execute function app.audit_diff();
create trigger audit_diff after insert or update or delete on public.invitations
  for each row execute function app.audit_diff();
create trigger audit_diff after insert or update or delete on public.ownership_transfers
  for each row execute function app.audit_diff();
create trigger audit_diff after insert or update or delete on public.platform_users
  for each row execute function app.audit_diff();
create trigger audit_diff after insert or update or delete on public.platform_settings
  for each row execute function app.audit_diff();
create trigger audit_diff after insert or update or delete on public.platform_org_settings
  for each row execute function app.audit_diff();

-- ---------------------------------------------------------------------------
-- append_only_guard — audit_events is immutable for every principal, including the table owner
-- and the service role, except inside org.purge redaction (ADR-046.1; R2-C-09).
-- Phase 4 attaches the same guard to the evidence, snapshot and history tables.
-- ---------------------------------------------------------------------------
create function app.append_only_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('app.purge', true), 'off') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'IMMUTABLE: % is append-only', tg_table_name using errcode = '23514';
end $$;

create trigger append_only_guard
  before update or delete on public.audit_events
  for each row execute function app.append_only_guard();

-- ---------------------------------------------------------------------------
-- enqueue_purge_on_deletion — status → pending_deletion queues org.purge with a 30-day delay.
-- The job is the ONLY path that hard-deletes tenant rows, and it re-verifies status and age
-- (ADR-026.4, ADR-038.12). api.cancel_deletion marks the queued job cancelled.
-- ---------------------------------------------------------------------------
create function app.enqueue_purge_on_deletion() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'pending_deletion' and old.status is distinct from 'pending_deletion' then
    insert into public.jobs (organization_id, job_type, payload, run_after, idempotency_key)
    values (new.id, 'org.purge', '{}'::jsonb, now() + interval '30 days',
            'org.purge:' || new.id::text)
    on conflict do nothing;
  end if;
  return new;
end $$;

create trigger enqueue_purge_on_deletion
  after update of status on public.organizations
  for each row execute function app.enqueue_purge_on_deletion();

-- Ownership and grants for the trigger functions created here.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public', f.sig);
  end loop;
end $$;

grant execute on function app.accessible_org_ids() to authenticated;
grant execute on function app.accessible_org_roles() to authenticated;
grant execute on function app.org_role(uuid) to authenticated;
grant execute on function app.is_super_admin() to authenticated;
grant execute on function app.has_permission(uuid, text) to authenticated;
