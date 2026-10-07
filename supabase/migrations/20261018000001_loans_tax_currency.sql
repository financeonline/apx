-- MOTION — Loans by security, tax settings, and currency/country after creation (ADR-156).
-- Contract: ADR-156; DATABASE_ARCHITECTURE.md §14; RBAC_MATRIX.md (financials.edit, settings.manage).
--
-- 1. A loan account can be marked secured or unsecured. Nothing in the imported data says which,
--    so the business says it: unmarked stays NULL and is shown as "not yet marked" — never guessed
--    (owner decision, 2026-10-07). The engine reads it for the loans-by-security figures, so a change
--    queues a recalculation, exactly as a re-mapping does.
-- 2. Tax settings for the indicative VAT return and Corporation Tax estimate: the VAT quarters (which
--    month the first quarter ends in), the VAT scheme, and the number of associated companies (it
--    divides the Corporation Tax thresholds). Read when the reports are drawn; no figure the engine
--    stores depends on them, so no recalculation.
-- 3. Currency and country after creation (owner, 2026-10-07: UK and UAE businesses). Country decides
--    which tax rules apply and can change at any time. Currency can change ONLY while the organisation
--    holds no financial records: amounts are stored as stated and never converted, so changing the
--    currency of existing figures would relabel every pound as a dirham.

-- ---------------------------------------------------------------------------------------------
-- 1. Loans by security
-- ---------------------------------------------------------------------------------------------

create type public.loan_security_enum as enum ('secured', 'unsecured');

alter table public.accounts add column loan_security public.loan_security_enum;

comment on column public.accounts.loan_security is
  'ADR-156: secured / unsecured for a loan or long-term liability account, as the business marked it; NULL = not yet marked (never inferred).';

create function api.set_account_loan_security(p_account uuid, p_security text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_category public.standard_category_enum;
  v_before   public.loan_security_enum;
  v_after    public.loan_security_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.standard_category, a.loan_security
    into v_org, v_category, v_before
    from public.accounts a where a.id = p_account;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'financials.edit');

  if p_security is null or p_security not in ('secured', 'unsecured', 'unmarked') then
    raise exception 'VALIDATION: a loan is secured, unsecured or unmarked' using errcode = '22023';
  end if;
  if v_category not in ('loan', 'long_term_liability') then
    raise exception 'VALIDATION: only a loan or long-term borrowing account can be marked secured or unsecured'
      using errcode = '22023';
  end if;

  v_after := case p_security when 'unmarked' then null else p_security::public.loan_security_enum end;
  if v_before is not distinct from v_after then
    return p_security;
  end if;

  perform pg_advisory_xact_lock(hashtext('org:' || v_org::text));
  update public.accounts set loan_security = v_after where organization_id = v_org and id = p_account;

  perform app.audit(v_org, 'account.loan_security_changed', 'accounts', p_account,
                    jsonb_build_object('loan_security', coalesce(v_before::text, 'unmarked')),
                    jsonb_build_object('loan_security', p_security), '{}'::jsonb);
  perform app.enqueue_recalculation(v_org, 'account_remapped', p_account);
  return p_security;
end $$;

alter function api.set_account_loan_security(uuid, text) owner to motion_definer;
revoke all on function api.set_account_loan_security(uuid, text) from public, anon;
grant execute on function api.set_account_loan_security(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Tax settings
-- ---------------------------------------------------------------------------------------------

create function api.set_tax_settings(
  p_org uuid, p_vat_quarter_end_month smallint, p_vat_scheme text, p_ct_associated_companies smallint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_org(p_org);
  perform app.require_permission(p_org, 'settings.manage');

  -- The month the first VAT quarter of the calendar year ends in: 1 (Jan/Apr/Jul/Oct),
  -- 2 (Feb/May/Aug/Nov) or 3 (Mar/Jun/Sep/Dec) — the three UK stagger groups.
  if p_vat_quarter_end_month is null or p_vat_quarter_end_month not in (1, 2, 3) then
    raise exception 'VALIDATION: VAT quarters end in month 1, 2 or 3 of the year' using errcode = '22023';
  end if;
  if p_vat_scheme is null or p_vat_scheme not in ('standard', 'cash_accounting', 'flat_rate') then
    raise exception 'VALIDATION: VAT scheme is standard, cash_accounting or flat_rate' using errcode = '22023';
  end if;
  if p_ct_associated_companies is null or p_ct_associated_companies not between 0 and 50 then
    raise exception 'VALIDATION: associated companies is a number from 0 to 50' using errcode = '22023';
  end if;

  select jsonb_build_object(
           'vat_quarter_end_month', o.settings -> 'vat_quarter_end_month',
           'vat_scheme', o.settings -> 'vat_scheme',
           'ct_associated_companies', o.settings -> 'ct_associated_companies')
    into v_before
    from public.organizations o where o.id = p_org
   for update;

  update public.organizations o
     set settings = o.settings
           || jsonb_build_object('vat_quarter_end_month', p_vat_quarter_end_month,
                                 'vat_scheme', p_vat_scheme,
                                 'ct_associated_companies', p_ct_associated_companies)
   where o.id = p_org;

  v_after := jsonb_build_object('vat_quarter_end_month', p_vat_quarter_end_month,
                                'vat_scheme', p_vat_scheme,
                                'ct_associated_companies', p_ct_associated_companies);
  if v_before is distinct from v_after then
    perform app.audit(p_org, 'org.tax_settings_changed', 'organizations', p_org, v_before, v_after, '{}'::jsonb);
  end if;
  return v_after;
end $$;

alter function api.set_tax_settings(uuid, smallint, text, smallint) owner to motion_definer;
revoke all on function api.set_tax_settings(uuid, smallint, text, smallint) from public, anon;
grant execute on function api.set_tax_settings(uuid, smallint, text, smallint) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Currency and country
-- ---------------------------------------------------------------------------------------------

create function api.set_currency_and_country(p_org uuid, p_currency text, p_country text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_currency text;
  v_country  text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_org(p_org);
  perform app.require_permission(p_org, 'settings.manage');

  if p_currency is null or p_currency not in ('GBP', 'AED', 'EUR', 'USD', 'INR') then
    raise exception 'VALIDATION: currency is one of GBP, AED, EUR, USD or INR' using errcode = '22023';
  end if;
  if p_country is null or p_country not in ('GB', 'AE', 'IE', 'IN') then
    raise exception 'VALIDATION: country is one of GB, AE, IE or IN' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));
  select o.base_currency, o.country_code into v_currency, v_country
    from public.organizations o where o.id = p_org for update;

  if v_currency is distinct from p_currency and (
       exists (select 1 from public.ledger_entries x where x.organization_id = p_org)
    or exists (select 1 from public.period_balances x where x.organization_id = p_org)
    or exists (select 1 from public.invoices x where x.organization_id = p_org)
    or exists (select 1 from public.bank_transactions x where x.organization_id = p_org)
    or exists (select 1 from public.bank_accounts x where x.organization_id = p_org)
  ) then
    raise exception 'VALIDATION: the currency cannot change once financial records exist — amounts are never converted, so every figure would be relabelled'
      using errcode = '22023';
  end if;

  if v_currency is not distinct from p_currency and v_country is not distinct from p_country then
    return jsonb_build_object('currency', p_currency, 'country', p_country);
  end if;

  update public.organizations o
     set base_currency = p_currency, country_code = p_country
   where o.id = p_org;

  perform app.audit(p_org, 'org.currency_country_changed', 'organizations', p_org,
                    jsonb_build_object('currency', v_currency, 'country', v_country),
                    jsonb_build_object('currency', p_currency, 'country', p_country), '{}'::jsonb);
  return jsonb_build_object('currency', p_currency, 'country', p_country);
end $$;

alter function api.set_currency_and_country(uuid, text, text) owner to motion_definer;
revoke all on function api.set_currency_and_country(uuid, text, text) from public, anon;
grant execute on function api.set_currency_and_country(uuid, text, text) to authenticated;
