-- MOTION — Phase 2 (plan Phase 4) · Standard chart of accounts and forward fiscal periods.
-- Contract: ADR-004 ("every organization is seeded with one system account per standard category so
-- bank-only organizations still get a P&L"); IMPLEMENTATION_PLAN.md Phase 4 slice 1 ("creating an
-- org seeds 26 system accounts"); DATABASE_ARCHITECTURE.md §14.1 (create_organization writes
-- accounts and fiscal_periods).
--
-- This closes the deferral recorded in api.create_organization by migration ..._008.

-- Display names for the 26 standard categories. Kept in one function so the seeding routine and any
-- future re-seed cannot drift apart, and so a customer renaming their own copy of an account never
-- changes what the category means to the engine.
create function app.standard_category_label(p_category public.standard_category_enum)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select case p_category
    when 'revenue'                 then 'Revenue'
    when 'other_income'            then 'Other Income'
    when 'cost_of_sales'           then 'Cost of Sales'
    when 'operating_expense'       then 'Operating Expenses'
    when 'payroll'                 then 'Payroll'
    when 'marketing'               then 'Marketing'
    when 'interest_expense'        then 'Interest Expense'
    when 'tax_expense'             then 'Tax Expense'
    when 'depreciation'            then 'Depreciation'
    when 'other_expense'           then 'Other Expenses'
    when 'cash'                    then 'Cash'
    when 'receivables'             then 'Accounts Receivable'
    when 'inventory'               then 'Inventory'
    when 'other_current_asset'     then 'Other Current Assets'
    when 'fixed_asset'             then 'Fixed Assets'
    when 'other_asset'             then 'Other Assets'
    when 'payables'                then 'Accounts Payable'
    when 'credit_card'             then 'Credit Cards'
    when 'loan'                    then 'Loans'
    when 'tax_liability'           then 'Tax Liabilities'
    when 'other_current_liability' then 'Other Current Liabilities'
    when 'long_term_liability'     then 'Long-Term Liabilities'
    when 'equity'                  then 'Equity'
    when 'drawings'                then 'Drawings'
    when 'transfer'                then 'Transfers'
    when 'uncategorised'           then 'Uncategorised'
  end;
$$;

-- Seeds one system account per standard category. `is_system` marks them so the import mapper can
-- offer them as targets and `api.remap_account` can refuse to re-categorise them: a system account's
-- whole purpose is to BE its category.
create function app.seed_standard_chart(p_org uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.accounts
    (organization_id, name, normalized_name, account_type, standard_category,
     is_system, source, mapping_confidence)
  select p_org,
         app.standard_category_label(c),
         app.normalize_name(app.standard_category_label(c)),
         public.standard_category_account_type(c),
         c,
         true, 'seeded', 'confirmed'
    from unnest(enum_range(null::public.standard_category_enum)) as c
  on conflict (organization_id, normalized_name) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The shared name normaliser. Imports arrive with "Bank  Charges", "bank charges" and "Bank Charges."
-- meaning one account; creating three would split every metric that reads it.
create function app.normalize_name(p_name text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select btrim(regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', ' ', 'g'));
$$;

-- Materialises the fiscal periods covering a date range, so the dashboard has months to render
-- before any data is imported. `period_assign` creates them on demand too; this just means the
-- common case does not depend on the trigger.
create function app.ensure_periods(p_org uuid, p_from date, p_to date)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_fy_month smallint;
  v_count    integer;
begin
  select o.fiscal_year_start_month into v_fy_month
    from public.organizations o where o.id = p_org;
  if v_fy_month is null then
    raise exception 'NOT_FOUND: organization does not exist' using errcode = 'P0002';
  end if;

  insert into public.fiscal_periods
         (organization_id, period_start, period_end, fiscal_year, fiscal_quarter, label)
  select p_org,
         m::date,
         (m + interval '1 month - 1 day')::date,
         f.fiscal_year,
         f.fiscal_quarter,
         to_char(m, 'Mon YYYY')
    from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') as m
    cross join lateral app.fiscal_position(m::date, v_fy_month) f
  on conflict (organization_id, period_start) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Wire both into api.create_organization, replacing the Phase 1 deferral marker.
-- ---------------------------------------------------------------------------
create or replace function api.create_organization(
  p_name text,
  p_country_code char(2) default 'GB',
  p_base_currency char(3) default 'GBP',
  p_fiscal_year_start_month smallint default 1,
  p_timezone text default 'Europe/London'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := app.uid();
  v_base  text;
  v_slug  text;
  v_n     integer := 0;
  v_org   uuid;
  v_owned integer;
begin
  perform app.throttle(v_actor, 'create_organization', 3, interval '1 day');

  if v_actor is null then
    raise exception 'PERMISSION_DENIED: sign in required' using errcode = '42501';
  end if;
  -- Platform staff are never members of a customer organization (RBAC_MATRIX.md §3.5); a super
  -- admin creating an organization for a customer uses the platform path and invites the owner.
  if exists (select 1 from public.platform_users p where p.user_id = v_actor) then
    raise exception 'PERMISSION_DENIED: platform accounts cannot own customer organizations'
      using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'VALIDATION: a name is required' using errcode = '22023';
  end if;
  if p_fiscal_year_start_month not between 1 and 12 then
    raise exception 'VALIDATION: fiscal year start month must be 1-12' using errcode = '22023';
  end if;

  -- ADR-044.5: at most five owned organizations on the trial plan.
  select count(*) into v_owned
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
   where m.user_id = v_actor and m.role = 'owner' and m.status = 'active'
     and o.status <> 'deleted' and o.plan = 'trial';
  if v_owned >= 5 then
    raise exception 'QUOTA: trial accounts may own at most five organizations'
      using errcode = '53400';
  end if;

  v_base := app.slugify(p_name);
  if length(v_base) < 3 then v_base := v_base || '-org'; end if;
  v_slug := v_base;
  while exists (select 1 from public.organizations o where o.slug = v_slug::extensions.citext) loop
    v_n := v_n + 1;
    v_slug := left(v_base, 34) || '-' || v_n::text;
  end loop;

  -- The creator is not yet a member, so the audit guard is told this is a bootstrap (see app.audit).
  perform set_config('app.bootstrap', 'on', true);

  insert into public.organizations
    (slug, name, country_code, base_currency, fiscal_year_start_month, timezone, created_by)
  values
    (v_slug::extensions.citext, trim(p_name), p_country_code, p_base_currency,
     p_fiscal_year_start_month, p_timezone, v_actor)
  returning id into v_org;

  insert into public.organization_memberships (organization_id, user_id, role, status)
  values (v_org, v_actor, 'owner', 'active');

  update public.profiles set last_active_org_id = v_org where id = v_actor;

  -- ADR-004: one system account per standard category, so a bank-only organization still gets a P&L
  -- without importing a chart of accounts at all.
  perform app.seed_standard_chart(v_org);
  -- Twelve months back and twelve forward, so the period selector and the coverage strip have
  -- something to show on day one (IMPLEMENTATION_PLAN.md Phase 4 slice 1).
  perform app.ensure_periods(v_org,
                             (date_trunc('month', now()) - interval '12 months')::date,
                             (date_trunc('month', now()) + interval '11 months')::date);

  perform app.audit(v_org, 'org.created', 'organizations', v_org, null,
                    jsonb_build_object('slug', v_slug, 'name', trim(p_name)), '{}'::jsonb);

  perform set_config('app.bootstrap', 'off', true);
  return v_org;
exception
  when unique_violation then
    raise exception 'CONFLICT: that organization already exists' using errcode = '23505';
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname in
           ('standard_category_label', 'seed_standard_chart', 'normalize_name', 'ensure_periods')
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public', f.sig);
  end loop;
end $$;

alter function api.create_organization(text, char, char, smallint, text) owner to motion_definer;
revoke all on function api.create_organization(text, char, char, smallint, text) from public;
grant execute on function api.create_organization(text, char, char, smallint, text) to authenticated;
