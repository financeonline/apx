-- APX — Only the company's owner creates team members (ADR-174).
--
-- Owner, 2026-10-14: "Make sure the company or organization can only create their team member, none
-- of the other members can create any team member, accountant, or third-party users. Only the owner
-- … can generate a user for them."
--
-- 1. The admin role ("Team member (manages the team)") loses `users.invite`. An admin still manages
--    the people the owner created (roles, permission switches, departments, requests), but adds
--    nobody. `users.invite` is not a switch (`app.switchable_permissions`), so no override can give
--    it back to one person.
-- 2. `app.check_member_login_role`, which both `api.begin_member_login` and
--    `api.finish_member_login` call, now also refuses anyone who is not the owner — a second lock, so
--    re-granting `users.invite` to another role would still not let it create logins.
-- 3. Any invitation still pending that an admin sent is revoked (none existed when this was written;
--    the team page has not offered invitations since ADR-173's follow-up). The super admin's
--    invitation of a new company's owner is not touched: its sender is not a member of the company.

-- 1. -------------------------------------------------------------------------------------------------

delete from public.role_permissions where role = 'admin' and permission = 'users.invite';

-- 2. -------------------------------------------------------------------------------------------------

create or replace function app.check_member_login_role(p_actor_role text, p_role text) returns void
language plpgsql immutable security definer set search_path = '' as $$
begin
  if p_actor_role is distinct from 'owner' then
    raise exception 'PERMISSION_DENIED: only the company''s owner can create team members'
      using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'accountant', 'client', 'third_party') then
    raise exception 'VALIDATION: a login can be created for a team member, an accountant or a 3rd party'
      using errcode = '22023';
  end if;
  if not app.ceiling_allows(p_actor_role, p_role) then
    raise exception 'PERMISSION_DENIED: you cannot create a login with that access' using errcode = '42501';
  end if;
end $$;
alter function app.check_member_login_role(text, text) owner to motion_definer;
revoke all on function app.check_member_login_role(text, text) from public, anon, authenticated;

-- 3. -------------------------------------------------------------------------------------------------

update public.invitations i
   set status = 'revoked', updated_at = now()
 where i.status = 'pending'
   and exists (
     select 1 from public.organization_memberships m
      where m.organization_id = i.organization_id and m.user_id = i.invited_by and m.role <> 'owner'
   );
