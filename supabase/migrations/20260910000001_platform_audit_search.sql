-- MOTION — the global audit search (platform pages, ADR-088).
--
-- ROUTE_ARCHITECTURE.md §155 gives `/platform/audit` a global search; `api.org_audit_events` is
-- per-organisation, and `profiles` is own-row-only under RLS (a page cannot name an actor by
-- reading it). This is the cross-organisation reader: super admin at aal2 only — an EMPLOYEE holds
-- `audit.view` for the organisations assigned to them and must not read the whole platform's trail,
-- which is exactly the distinction `/platform/jobs` and `platform_settings` already draw.
--
-- Filters are narrow and typed. `p_action` matches a prefix ('member.' finds every membership
-- event) so the page can offer families without a free-text query over an append-only table.

create function api.platform_audit_events(
  p_org       uuid        default null,
  p_action    text        default null,
  p_actor     uuid        default null,
  p_from      timestamptz default null,
  p_to        timestamptz default null,
  p_limit     integer     default 100,
  p_offset    integer     default 0
)
returns table (
  id                bigint,
  organization_id   uuid,
  organization_name text,
  action            text,
  actor_type        text,
  actor_name        text,
  target_table      text,
  target_id         uuid,
  metadata          jsonb,
  created_at        timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- No throttle: this function is STABLE, and a stable function cannot write the counter (25006).
  -- The read surface (`org_members`, `org_audit_events`) is consistent in this; the paging cap
  -- below is what bounds a caller.
  perform app.require_super_admin(true);

  return query
    select a.id,
           a.organization_id,
           o.name,
           a.action,
           a.actor_type::text,
           -- The actor's own name, resolved here because `profiles` is own-row-only (ADR-044).
           coalesce(p.full_name, p.email, case when a.actor_user_id is null then 'system' else null end),
           a.target_table,
           a.target_id,
           a.metadata,
           a.created_at
      from public.audit_events a
      left join public.organizations o on o.id = a.organization_id
      left join public.profiles p on p.id = a.actor_user_id
     where (p_org is null or a.organization_id = p_org)
       and (p_action is null or a.action like p_action || '%')
       and (p_actor is null or a.actor_user_id = p_actor)
       and (p_from is null or a.created_at >= p_from)
       and (p_to is null or a.created_at < p_to)
     order by a.created_at desc, a.id desc
     limit greatest(least(coalesce(p_limit, 100), 500), 1)
    offset greatest(coalesce(p_offset, 0), 0);
end $$;

alter function api.platform_audit_events(uuid, text, uuid, timestamptz, timestamptz, integer, integer) owner to motion_definer;
revoke all on function api.platform_audit_events(uuid, text, uuid, timestamptz, timestamptz, integer, integer) from public, anon;
grant execute on function api.platform_audit_events(uuid, text, uuid, timestamptz, timestamptz, integer, integer) to authenticated;
