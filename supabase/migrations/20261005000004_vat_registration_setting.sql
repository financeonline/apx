-- MOTION — Settings · the organisation's VAT status, set on purpose and recalculated (ADR-133).
-- Contract: ADR-129 (FU-9), FINANCIAL_ENGINE.md §3.4; RBAC_MATRIX.md (settings.manage).
--
-- The days figures compare a VAT-inclusive balance with a flow, and only the business's VAT status
-- says whether a ledger's flows include VAT (ADR-129). `organizations.settings.vat_registered` existed
-- and nothing set it, so every organisation was "unknown". This is the one path that sets it:
--   - three states: 'registered', 'not_registered', and 'unknown' (the key ABSENT). Unknown is never
--     written as false — a business nobody asked is not "not registered".
--   - merges its own key only. `api.update_organization` replaces the whole `settings` object, so
--     using it here would have erased every other setting.
--   - `settings.manage`, throttled, audited with before and after;
--   - a change queues a full recalculation (`settings_changed`): the VAT status changes which days
--     figures exist in every period, and the fingerprint carries it.

create function api.set_vat_registration(p_org uuid, p_status text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_before text;
  v_after  jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_org(p_org);
  perform app.require_permission(p_org, 'settings.manage');

  if p_status is null or p_status not in ('registered', 'not_registered', 'unknown') then
    raise exception 'VALIDATION: VAT status is registered, not_registered or unknown' using errcode = '22023';
  end if;

  select case o.settings -> 'vat_registered'
           when 'true'::jsonb then 'registered'
           when 'false'::jsonb then 'not_registered'
           else 'unknown' end
    into v_before
    from public.organizations o where o.id = p_org
   for update;

  if v_before = p_status then
    return p_status;
  end if;

  update public.organizations o
     set settings = case p_status
           when 'unknown' then o.settings - 'vat_registered'
           else jsonb_set(o.settings, '{vat_registered}', to_jsonb(p_status = 'registered'))
         end
   where o.id = p_org
  returning o.settings into v_after;

  perform app.audit(p_org, 'org.vat_status_changed', 'organizations', p_org,
                    jsonb_build_object('vat_status', v_before),
                    jsonb_build_object('vat_status', p_status), '{}'::jsonb);
  perform app.enqueue_recalculation(p_org, 'settings_changed');
  return p_status;
end $$;

alter function api.set_vat_registration(uuid, text) owner to motion_definer;
revoke all on function api.set_vat_registration(uuid, text) from public, anon;
grant execute on function api.set_vat_registration(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The other writers of the settings that change figures (ADR-133; Step 0C review findings 4, 10).
-- ---------------------------------------------------------------------------------------------

-- A timezone the database does not know is refused on write. The hourly enqueue computes every
-- organisation's local date in one statement, so one unknown name used to stop it for every tenant.
create function app.validate_timezone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = new.timezone) then
    raise exception 'VALIDATION: % is not a timezone MOTION recognises (for example Europe/London)', new.timezone
      using errcode = '22023';
  end if;
  return new;
end $$;
alter function app.validate_timezone() owner to motion_definer;
revoke all on function app.validate_timezone() from public, authenticated, anon;
create trigger organizations_timezone_valid
  before insert or update of timezone on public.organizations
  for each row execute function app.validate_timezone();

create or replace function api.update_organization(p_org uuid, p_patch jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_role     text;
  v_before   jsonb;
  v_keys     text[] := array(select jsonb_object_keys(p_patch));
  v_tenant   text[] := array['name','legal_name','fiscal_year_start_month','timezone','industry','settings'];
  v_platform text[] := array['plan','features','kind','industry','status'];
  v_allowed  text[];
  v_k        text;
  v_status   text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  v_role := app.require_org(p_org);

  if app.is_super_admin() then
    v_allowed := v_tenant || v_platform;
  else
    perform app.require_permission(p_org, 'settings.manage');
    v_allowed := v_tenant;
  end if;

  foreach v_k in array v_keys loop
    if not (v_k = any (v_allowed)) then
      -- slug, created_by, deletion_requested_at, id and the deletion statuses are never patchable
      -- (ADR-044.6; R2-A-10).
      raise exception 'VALIDATION: % cannot be changed here', v_k using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'status' then
    v_status := p_patch ->> 'status';
    if v_status not in ('active', 'suspended') then
      raise exception 'VALIDATION: status may only move between active and suspended; deletion goes through api.request_deletion'
        using errcode = '22023';
    end if;
  end if;

  -- ADR-133: the VAT status has its own audited path, which recalculates; a settings patch cannot
  -- set it (and cannot erase it — see the update below).
  if p_patch ? 'settings' and (p_patch -> 'settings') ? 'vat_registered' then
    raise exception 'VALIDATION: set the VAT status with api.set_vat_registration' using errcode = '22023';
  end if;

  -- Quota keys live in platform_org_settings and are not tenant-editable (ADR-038.5; F-A-09).
  if p_patch ? 'settings' then
    if (p_patch -> 'settings') ?| array['ai_quota_daily','ai_token_ceiling_monthly',
                                        'ai_extraction_pages_per_day','model_overrides'] then
      raise exception 'VALIDATION: quota settings are platform-controlled' using errcode = '22023';
    end if;
  end if;

  select to_jsonb(o) into v_before from public.organizations o where o.id = p_org;

  update public.organizations o set
    name                    = coalesce(p_patch ->> 'name', o.name),
    legal_name              = coalesce(p_patch ->> 'legal_name', o.legal_name),
    fiscal_year_start_month = coalesce((p_patch ->> 'fiscal_year_start_month')::smallint, o.fiscal_year_start_month),
    timezone                = coalesce(p_patch ->> 'timezone', o.timezone),
    industry                = coalesce(p_patch ->> 'industry', o.industry),
    settings                = case when p_patch ? 'settings'
                                then (p_patch -> 'settings')
                                     || case when o.settings ? 'vat_registered'
                                             then jsonb_build_object('vat_registered', o.settings -> 'vat_registered')
                                             else '{}'::jsonb end
                                else o.settings end,
    plan                    = coalesce((p_patch ->> 'plan')::public.org_plan_enum, o.plan),
    features                = coalesce(p_patch -> 'features', o.features),
    kind                    = coalesce((p_patch ->> 'kind')::public.org_kind_enum, o.kind),
    status                  = coalesce((p_patch ->> 'status')::public.org_status_enum, o.status)
  where o.id = p_org;

  perform app.audit(p_org, 'org.updated', 'organizations', p_org, v_before, p_patch, '{}'::jsonb);

  -- ADR-133: the fiscal year, the timezone (today's date) and the settings (VAT rate, taxable
  -- categories) all change figures; a change to any of them recalculates, as a remap does.
  if exists (select 1 from public.organizations o
              where o.id = p_org
                and (o.fiscal_year_start_month is distinct from (v_before ->> 'fiscal_year_start_month')::smallint
                     or o.timezone is distinct from v_before ->> 'timezone'
                     or o.settings is distinct from v_before -> 'settings')) then
    perform app.enqueue_recalculation(p_org, 'settings_changed');
  end if;
  return p_org;
end $$;

alter function api.update_organization(uuid, jsonb) owner to motion_definer;
