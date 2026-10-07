-- MOTION — The super admin decides each company's systems, creates companies, and lists staff (ADR-158).
-- Contract: ADR-158; DATABASE_ARCHITECTURE.md §14; RBAC_MATRIX.md (super admin).
--
-- Owner, 2026-10-07: "Only super admin can decide which systems they can use"; "in the super admin
-- panel the super admin can see all the companies"; "only a super admin can create a new admin user".
--
-- 1. api.set_org_module — one system switch for one company, MERGED into organizations.features
--    (api.update_organization replaces the whole object, so two admins saving at once could undo each
--    other). Only the switches MOTION knows are accepted. Turning Funding Readiness on still fires its
--    enablement trigger, exactly as before.
-- 2. api.platform_create_organization — the "platform path" create_organization has always pointed a
--    super admin to: the company is created and set up as any company is, WITHOUT the super admin
--    becoming a member (platform staff never are), and its owner is invited by email; the invitation
--    link is returned to share.
-- 3. api.platform_users_list — the staff list with emails and names, for the super admin's pages.

create function api.set_org_module(p_org uuid, p_feature_key text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  if p_feature_key is null or p_feature_key not in (
       'module_banking', 'module_customers', 'module_actions', 'module_reports', 'module_analyst',
       'module_planning', 'module_tax', 'funding_readiness', 'ai_pdf_extraction') then
    raise exception 'VALIDATION: that is not a system MOTION can switch' using errcode = '22023';
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
end $$;

alter function api.set_org_module(uuid, text, boolean) owner to motion_definer;
revoke all on function api.set_org_module(uuid, text, boolean) from public, anon;
grant execute on function api.set_org_module(uuid, text, boolean) to authenticated;

create function api.platform_create_organization(
  p_name text,
  p_country_code char(2),
  p_base_currency char(3),
  p_fiscal_year_start_month smallint,
  p_timezone text,
  p_owner_email text
) returns table (organization_id uuid, slug text, invitation_token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := app.uid();
  v_base  text;
  v_slug  text;
  v_n     integer := 0;
  v_org   uuid;
  v_token text;
begin
  perform app.throttle(v_actor, 'platform_create_organization', 30, interval '1 hour');
  perform app.require_super_admin(true);

  if coalesce(trim(p_name), '') = '' then
    raise exception 'VALIDATION: a name is required' using errcode = '22023';
  end if;
  if p_country_code not in ('GB', 'AE', 'IE', 'IN') then
    raise exception 'VALIDATION: country is one of GB, AE, IE or IN' using errcode = '22023';
  end if;
  if p_base_currency not in ('GBP', 'AED', 'EUR', 'USD', 'INR') then
    raise exception 'VALIDATION: currency is one of GBP, AED, EUR, USD or INR' using errcode = '22023';
  end if;
  if p_fiscal_year_start_month not between 1 and 12 then
    raise exception 'VALIDATION: fiscal year start month must be 1-12' using errcode = '22023';
  end if;
  if coalesce(trim(p_owner_email), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'VALIDATION: the owner''s email address is needed' using errcode = '22023';
  end if;

  v_base := app.slugify(p_name);
  if length(v_base) < 3 then v_base := v_base || '-org'; end if;
  v_slug := v_base;
  while exists (select 1 from public.organizations o where o.slug = v_slug::extensions.citext) loop
    v_n := v_n + 1;
    v_slug := left(v_base, 34) || '-' || v_n::text;
  end loop;

  insert into public.organizations
    (slug, name, country_code, base_currency, fiscal_year_start_month, timezone, created_by)
  values
    (v_slug::extensions.citext, trim(p_name), p_country_code, p_base_currency,
     p_fiscal_year_start_month, coalesce(nullif(trim(p_timezone), ''),
       case p_country_code when 'AE' then 'Asia/Dubai' when 'IN' then 'Asia/Kolkata' when 'IE' then 'Europe/Dublin' else 'Europe/London' end),
     v_actor)
  returning id into v_org;

  -- The same set-up every company gets (ADR-004 chart; periods twelve back, twelve forward).
  perform app.seed_standard_chart(v_org);
  perform app.ensure_periods(v_org,
                             (date_trunc('month', now()) - interval '12 months')::date,
                             (date_trunc('month', now()) + interval '11 months')::date);

  perform app.audit(v_org, 'org.created', 'organizations', v_org, null,
                    jsonb_build_object('slug', v_slug, 'name', trim(p_name), 'by', 'platform'), '{}'::jsonb);

  -- The owner is invited, never made a member by the super admin (platform staff are not members).
  select t.token into v_token
    from api.invite_member_with_token(v_org, p_owner_email, 'owner') t;

  return query select v_org, v_slug, v_token;
end $$;

alter function api.platform_create_organization(text, char, char, smallint, text, text) owner to motion_definer;
revoke all on function api.platform_create_organization(text, char, char, smallint, text, text) from public, anon;
grant execute on function api.platform_create_organization(text, char, char, smallint, text, text) to authenticated;

create function api.platform_users_list()
returns table (user_id uuid, email text, full_name text, platform_role text, status text, two_step boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_super_admin();
  return query
    select p.user_id, pr.email::text, pr.full_name, p.platform_role::text, p.status::text,
           pr.mfa_enrolled_at is not null, p.created_at
      from public.platform_users p
      left join public.profiles pr on pr.id = p.user_id
     order by p.platform_role, pr.email;
end $$;

alter function api.platform_users_list() owner to motion_definer;
revoke all on function api.platform_users_list() from public, anon;
grant execute on function api.platform_users_list() to authenticated;
