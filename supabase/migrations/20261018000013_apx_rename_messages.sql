-- ADR-169: the product is now APX. Three messages these functions raise can reach a user and still
-- named MOTION. Each function is re-created exactly as it stands, with only that message changed;
-- CREATE OR REPLACE keeps its owner and grants.

CREATE OR REPLACE FUNCTION api.invite_member_with_token(p_org uuid, p_email text, p_role membership_role_enum)
 RETURNS TABLE(invitation_id uuid, token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role  text;
  v_email extensions.citext := lower(trim(p_email))::extensions.citext;
  v_token text;
  v_id    uuid;
begin
  perform app.throttle(app.uid(), 'invite_member', 20, interval '1 hour');
  v_role := app.require_permission(p_org, 'users.invite');

  if not app.ceiling_allows(v_role, p_role::text) then
    raise exception 'PERMISSION_DENIED: you cannot invite someone as %', p_role using errcode = '42501';
  end if;
  if position('@' in v_email::text) = 0 then
    raise exception 'VALIDATION: a valid email address is required' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.organization_memberships m
      join public.profiles pr on pr.id = m.user_id
     where m.organization_id = p_org and pr.email = v_email
  ) then
    raise exception 'CONFLICT: that person is already a member' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.platform_users p
      join public.profiles pr on pr.id = p.user_id
     where pr.email = v_email
  ) then
    raise exception 'CONFLICT: that address belongs to an APX platform account' using errcode = '23505';
  end if;

  -- The raw token is returned once to the caller and never stored; only its SHA-256 is persisted
  -- (SECURITY_MODEL.md §3).
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.invitations (organization_id, email, role, token_hash, invited_by)
  values (p_org, v_email, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), app.uid())
  returning id into v_id;

  perform app.audit(p_org, 'member.invited', 'invitations', v_id, null,
                    jsonb_build_object('role', p_role), jsonb_build_object('invitation_id', v_id));

  invitation_id := v_id;
  token := v_token;
  return next;
exception
  when unique_violation then
    raise exception 'CONFLICT: an invitation for that address is already pending' using errcode = '23505';
end $function$
;

CREATE OR REPLACE FUNCTION app.validate_timezone()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = new.timezone) then
    raise exception 'VALIDATION: % is not a timezone APX recognises (for example Europe/London)', new.timezone
      using errcode = '22023';
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION api.set_org_module(p_org uuid, p_feature_key text, p_on boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  if p_feature_key is null or p_feature_key not in (
       'module_banking', 'module_customers', 'module_actions', 'module_reports', 'module_analyst',
       'module_planning', 'module_tax', 'funding_readiness', 'ai_pdf_extraction') then
    raise exception 'VALIDATION: that is not a system APX can switch' using errcode = '22023';
  end if;
  if p_on is null then
    raise exception 'VALIDATION: on or off is required' using errcode = '22023';
  end if;

  select o.features into v_before from public.organizations o where o.id = p_org for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.organizations o
     set features = o.features || jsonb_build_object(p_feature_key, p_on)
   where o.id = p_org
  returning o.features into v_after;

  if v_before -> p_feature_key is distinct from v_after -> p_feature_key then
    perform app.audit(p_org, 'platform.org_module_changed', 'organizations', p_org,
                      jsonb_build_object(p_feature_key, v_before -> p_feature_key),
                      jsonb_build_object(p_feature_key, p_on), '{}'::jsonb);
  end if;
  return v_after;
end $function$
;

