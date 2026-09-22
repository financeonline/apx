-- MOTION — Phase 14 · Commercial Intelligence (ADR-102).
-- Contract: PRODUCT_REQUIREMENTS.md §16 (REQ-CI-01…12), REQ-FD-09, REQ-CA-11; CD-01, CD-08, CD-19;
--           DATABASE_ARCHITECTURE.md §3a, §14; SECURITY_MODEL.md §6; RBAC_MATRIX.md §2.1.
--
-- Commercial activity sits ABOVE the financial records, on the `counterparties` seam MVP_SCOPE.md
-- reserved for it. Six tables, all org-composite, all read under `customers.view` and written only
-- through `api.*` under `customers.edit`. None of them holds a financial figure the engine also
-- holds: customer revenue, contribution and concentration stay in `metric_current`; what is added
-- is what a person records about products, campaigns, channels, spend and the pipeline, plus the
-- one link that makes attribution honest — an invoice line naming a product, and a won opportunity
-- naming a customer and a campaign. No cost is allocated without a recorded line; no revenue is
-- attributed to a campaign without a won opportunity.

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------
create table public.products (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  name             text not null constraint products_name_len check (length(name) between 1 and 200),
  normalized_name  text not null,
  kind             text not null default 'service' constraint products_kind check (kind in ('product', 'service')),
  code             text,
  is_active        boolean not null default true,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint products_org_id_unique unique (organization_id, id),
  constraint products_name_unique unique (organization_id, normalized_name)
);

-- A line is a person's statement that part of an invoice was for a product or service. It carries
-- the NET amount for that part. Revenue direction follows the invoice: a sales credit note's lines
-- subtract, a purchase invoice's lines are cost. Lines inherit the invoice's standing at read time:
-- only lines of accepted, current invoices count, so a rejected or superseded invoice takes its
-- lines out of every figure with it (ADR-026.6).
create table public.invoice_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  invoice_id       uuid not null,
  product_id       uuid,
  description      text,
  quantity         numeric(18,4) constraint invoice_lines_quantity_nonneg check (quantity is null or quantity >= 0),
  amount           numeric(18,2) not null constraint invoice_lines_amount_nonneg check (amount >= 0),
  sort_order       integer not null default 0,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint invoice_lines_org_id_unique unique (organization_id, id),
  constraint invoice_lines_invoice_fk
    foreign key (organization_id, invoice_id) references public.invoices (organization_id, id) on delete cascade,
  constraint invoice_lines_product_fk
    foreign key (organization_id, product_id) references public.products (organization_id, id)
);
create index invoice_lines_org_invoice on public.invoice_lines (organization_id, invoice_id);
create index invoice_lines_org_product on public.invoice_lines (organization_id, product_id);

create table public.marketing_channels (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  name             text not null constraint channels_name_len check (length(name) between 1 and 120),
  normalized_name  text not null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint channels_org_id_unique unique (organization_id, id),
  constraint channels_name_unique unique (organization_id, normalized_name)
);

create table public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  name             text not null constraint campaigns_name_len check (length(name) between 1 and 200),
  normalized_name  text not null,
  channel_id       uuid,
  starts_on        date,
  ends_on          date,
  status           text not null default 'active' constraint campaigns_status check (status in ('planned', 'active', 'ended')),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint campaigns_org_id_unique unique (organization_id, id),
  constraint campaigns_name_unique unique (organization_id, normalized_name),
  constraint campaigns_channel_fk
    foreign key (organization_id, channel_id) references public.marketing_channels (organization_id, id) on delete set null,
  constraint campaigns_dates check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index campaigns_org_channel on public.campaigns (organization_id, channel_id);

-- Spend is recorded per campaign per month by a person. The ledger's `marketing` category is NOT
-- read as campaign spend: nothing in a ledger line says which campaign it paid for (Phase 14 brief
-- §5, §7), and inventing that link would invent every CAC downstream of it.
create table public.campaign_spend (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  campaign_id      uuid not null,
  period_id        uuid not null,
  amount           numeric(18,2) not null constraint campaign_spend_nonneg check (amount >= 0),
  currency         char(3) not null,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint campaign_spend_org_id_unique unique (organization_id, id),
  constraint campaign_spend_once unique (organization_id, campaign_id, period_id),
  constraint campaign_spend_campaign_fk
    foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete cascade,
  constraint campaign_spend_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id)
);

-- One table for the whole pipeline. A lead IS an opportunity at its first stage; the stages are the
-- chain the SOW names, and nothing more. `won` requires a customer (the counterparty the revenue
-- will arrive under) and a date, because attribution starts from that month and nowhere else.
create table public.opportunities (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  name              text not null constraint opportunities_name_len check (length(name) between 1 and 200),
  stage             text not null default 'lead'
                    constraint opportunities_stage check (stage in ('lead', 'qualified', 'proposal', 'won', 'lost')),
  counterparty_id   uuid,
  campaign_id       uuid,
  channel_id        uuid,
  estimated_value   numeric(18,2) constraint opportunities_value_nonneg check (estimated_value is null or estimated_value >= 0),
  currency          char(3) not null,
  created_on        date not null default current_date,
  stage_changed_on  date not null default current_date,
  won_on            date,
  lost_on           date,
  notes             text,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint opportunities_org_id_unique unique (organization_id, id),
  constraint opportunities_counterparty_fk
    foreign key (organization_id, counterparty_id) references public.counterparties (organization_id, id),
  constraint opportunities_campaign_fk
    foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete set null,
  constraint opportunities_channel_fk
    foreign key (organization_id, channel_id) references public.marketing_channels (organization_id, id) on delete set null,
  constraint opportunities_won_needs_customer check (stage <> 'won' or (counterparty_id is not null and won_on is not null)),
  constraint opportunities_lost_dated check (stage <> 'lost' or lost_on is not null)
);
create index opportunities_org_stage on public.opportunities (organization_id, stage);
create index opportunities_org_campaign on public.opportunities (organization_id, campaign_id);
create index opportunities_org_counterparty on public.opportunities (organization_id, counterparty_id);
create index opportunities_org_created on public.opportunities (organization_id, created_on);

-- Derived names and updated_at, the same triggers every other named tenant table uses.
create trigger derive_normalized_name before insert or update of name on public.products
  for each row execute function app.derive_normalized_name();
create trigger derive_normalized_name before insert or update of name on public.marketing_channels
  for each row execute function app.derive_normalized_name();
create trigger derive_normalized_name before insert or update of name on public.campaigns
  for each row execute function app.derive_normalized_name();
do $$
declare t text;
begin
  foreach t in array array['products', 'invoice_lines', 'marketing_channels', 'campaigns', 'campaign_spend', 'opportunities']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function app.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Privileges and RLS (ADR-026): readable under customers.view by every role that holds it
--    (all five), writable by nobody but the definer through api.*.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['products', 'invoice_lines', 'marketing_channels', 'campaigns', 'campaign_spend', 'opportunities']
  loop
    execute format('alter table public.%I owner to motion_definer', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated, anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create policy definer_all on public.%I for all to motion_definer using (true) with check (true)', t);
    execute format($p$create policy %I_select on public.%I for select to authenticated
      using (organization_id in (select app.org_ids_with_role(
        variadic array['owner', 'admin', 'employee', 'super_admin', 'client'])))$p$, t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Writes (api.*, customers.edit). Each: throttle, accessible set, permission, org-scoped
--    validation of every referenced row, audit. Nothing here queues a calculation: commercial rows
--    do not change a financial figure (ADR-102).
-- ---------------------------------------------------------------------------------------------
create function app.require_commercial_edit(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  if p_org is null or p_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(p_org, 'customers.edit');
end $$;
alter function app.require_commercial_edit(uuid) owner to motion_definer;
revoke all on function app.require_commercial_edit(uuid) from public, authenticated, anon;

create function api.upsert_product(p_org uuid, p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p_input ->> 'id', '')::uuid; v_before jsonb;
begin
  perform app.require_commercial_edit(p_org);
  if coalesce(trim(p_input ->> 'name'), '') = '' then
    raise exception 'VALIDATION: a name is required' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.products (organization_id, name, kind, code, notes)
    values (p_org, trim(p_input ->> 'name'), coalesce(nullif(p_input ->> 'kind', ''), 'service'),
            nullif(trim(coalesce(p_input ->> 'code', '')), ''), nullif(p_input ->> 'notes', ''))
    returning id into v_id;
    perform app.audit(p_org, 'product.created', 'products', v_id, null, p_input, '{}'::jsonb);
  else
    select to_jsonb(p) into v_before from public.products p where p.organization_id = p_org and p.id = v_id;
    if v_before is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    update public.products
       set name = trim(p_input ->> 'name'),
           kind = coalesce(nullif(p_input ->> 'kind', ''), kind),
           code = case when p_input ? 'code' then nullif(trim(coalesce(p_input ->> 'code', '')), '') else code end,
           notes = case when p_input ? 'notes' then nullif(p_input ->> 'notes', '') else notes end,
           is_active = coalesce((p_input ->> 'is_active')::boolean, is_active)
     where organization_id = p_org and id = v_id;
    perform app.audit(p_org, 'product.updated', 'products', v_id, v_before, p_input, '{}'::jsonb);
  end if;
  return v_id;
exception
  when unique_violation then
    raise exception 'CONFLICT: a product or service with that name already exists' using errcode = '23505';
end $$;

create function api.upsert_channel(p_org uuid, p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p_input ->> 'id', '')::uuid; v_before jsonb;
begin
  perform app.require_commercial_edit(p_org);
  if coalesce(trim(p_input ->> 'name'), '') = '' then
    raise exception 'VALIDATION: a name is required' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.marketing_channels (organization_id, name) values (p_org, trim(p_input ->> 'name'))
    returning id into v_id;
    perform app.audit(p_org, 'channel.created', 'marketing_channels', v_id, null, p_input, '{}'::jsonb);
  else
    select to_jsonb(c) into v_before from public.marketing_channels c where c.organization_id = p_org and c.id = v_id;
    if v_before is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    update public.marketing_channels
       set name = trim(p_input ->> 'name'), is_active = coalesce((p_input ->> 'is_active')::boolean, is_active)
     where organization_id = p_org and id = v_id;
    perform app.audit(p_org, 'channel.updated', 'marketing_channels', v_id, v_before, p_input, '{}'::jsonb);
  end if;
  return v_id;
exception
  when unique_violation then
    raise exception 'CONFLICT: a channel with that name already exists' using errcode = '23505';
end $$;

create function api.upsert_campaign(p_org uuid, p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p_input ->> 'id', '')::uuid; v_before jsonb;
        v_channel uuid := nullif(p_input ->> 'channel_id', '')::uuid;
begin
  perform app.require_commercial_edit(p_org);
  if coalesce(trim(p_input ->> 'name'), '') = '' then
    raise exception 'VALIDATION: a name is required' using errcode = '22023';
  end if;
  if v_channel is not null and not exists (
    select 1 from public.marketing_channels c where c.organization_id = p_org and c.id = v_channel
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_id is null then
    insert into public.campaigns (organization_id, name, channel_id, starts_on, ends_on, status, notes)
    values (p_org, trim(p_input ->> 'name'), v_channel,
            nullif(p_input ->> 'starts_on', '')::date, nullif(p_input ->> 'ends_on', '')::date,
            coalesce(nullif(p_input ->> 'status', ''), 'active'), nullif(p_input ->> 'notes', ''))
    returning id into v_id;
    perform app.audit(p_org, 'campaign.created', 'campaigns', v_id, null, p_input, '{}'::jsonb);
  else
    select to_jsonb(c) into v_before from public.campaigns c where c.organization_id = p_org and c.id = v_id;
    if v_before is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    update public.campaigns
       set name = trim(p_input ->> 'name'),
           channel_id = case when p_input ? 'channel_id' then v_channel else channel_id end,
           starts_on = case when p_input ? 'starts_on' then nullif(p_input ->> 'starts_on', '')::date else starts_on end,
           ends_on = case when p_input ? 'ends_on' then nullif(p_input ->> 'ends_on', '')::date else ends_on end,
           status = coalesce(nullif(p_input ->> 'status', ''), status),
           notes = case when p_input ? 'notes' then nullif(p_input ->> 'notes', '') else notes end
     where organization_id = p_org and id = v_id;
    perform app.audit(p_org, 'campaign.updated', 'campaigns', v_id, v_before, p_input, '{}'::jsonb);
  end if;
  return v_id;
exception
  when unique_violation then
    raise exception 'CONFLICT: a campaign with that name already exists' using errcode = '23505';
end $$;

create function api.set_campaign_spend(p_org uuid, p_campaign uuid, p_period uuid, p_amount numeric, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_currency char(3);
begin
  perform app.require_commercial_edit(p_org);
  if not exists (select 1 from public.campaigns c where c.organization_id = p_org and c.id = p_campaign)
     or not exists (select 1 from public.fiscal_periods f where f.organization_id = p_org and f.id = p_period) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'VALIDATION: spend must be zero or more' using errcode = '22023';
  end if;
  select o.base_currency into v_currency from public.organizations o where o.id = p_org;
  insert into public.campaign_spend (organization_id, campaign_id, period_id, amount, currency, note)
  values (p_org, p_campaign, p_period, p_amount, v_currency, nullif(p_note, ''))
  on conflict (organization_id, campaign_id, period_id) do update
    set amount = excluded.amount, note = excluded.note, updated_at = now()
  returning id into v_id;
  perform app.audit(p_org, 'campaign.spend_set', 'campaign_spend', v_id, null,
                    jsonb_build_object('campaign_id', p_campaign, 'period_id', p_period, 'amount', p_amount), '{}'::jsonb);
  return v_id;
end $$;

create function api.upsert_opportunity(p_org uuid, p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id       uuid := nullif(p_input ->> 'id', '')::uuid;
  v_before   public.opportunities%rowtype;
  v_stage    text := nullif(p_input ->> 'stage', '');
  v_cp       uuid := nullif(p_input ->> 'counterparty_id', '')::uuid;
  v_campaign uuid := nullif(p_input ->> 'campaign_id', '')::uuid;
  v_channel  uuid := nullif(p_input ->> 'channel_id', '')::uuid;
  v_currency char(3);
  v_today    date;
begin
  perform app.require_commercial_edit(p_org);
  if v_id is null and coalesce(trim(p_input ->> 'name'), '') = '' then
    raise exception 'VALIDATION: a name is required' using errcode = '22023';
  end if;
  if v_cp is not null and not exists (select 1 from public.counterparties c where c.organization_id = p_org and c.id = v_cp) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_campaign is not null and not exists (select 1 from public.campaigns c where c.organization_id = p_org and c.id = v_campaign) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_channel is not null and not exists (select 1 from public.marketing_channels c where c.organization_id = p_org and c.id = v_channel) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select o.base_currency, (now() at time zone o.timezone)::date into v_currency, v_today
    from public.organizations o where o.id = p_org;

  if v_id is null then
    v_stage := coalesce(v_stage, 'lead');
    if v_stage = 'won' and v_cp is null then
      raise exception 'VALIDATION: a won opportunity needs the customer it was won with' using errcode = '22023';
    end if;
    insert into public.opportunities
           (organization_id, name, stage, counterparty_id, campaign_id, channel_id, estimated_value, currency,
            created_on, stage_changed_on, won_on, lost_on, notes, created_by)
    values (p_org, trim(p_input ->> 'name'), v_stage, v_cp, v_campaign, v_channel,
            nullif(p_input ->> 'estimated_value', '')::numeric, v_currency,
            coalesce(nullif(p_input ->> 'created_on', '')::date, v_today),
            coalesce(nullif(p_input ->> 'stage_changed_on', '')::date, v_today),
            case when v_stage = 'won' then coalesce(nullif(p_input ->> 'won_on', '')::date, v_today) end,
            case when v_stage = 'lost' then coalesce(nullif(p_input ->> 'lost_on', '')::date, v_today) end,
            nullif(p_input ->> 'notes', ''), app.uid())
    returning id into v_id;
    perform app.audit(p_org, 'opportunity.created', 'opportunities', v_id, null, p_input, '{}'::jsonb);
    return v_id;
  end if;

  select * into v_before from public.opportunities o where o.organization_id = p_org and o.id = v_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  v_stage := coalesce(v_stage, v_before.stage);
  if not (p_input ? 'counterparty_id') then v_cp := v_before.counterparty_id; end if;
  if v_stage = 'won' and v_cp is null then
    raise exception 'VALIDATION: a won opportunity needs the customer it was won with' using errcode = '22023';
  end if;
  update public.opportunities
     set name = coalesce(nullif(trim(p_input ->> 'name'), ''), name),
         stage = v_stage,
         counterparty_id = v_cp,
         campaign_id = case when p_input ? 'campaign_id' then v_campaign else campaign_id end,
         channel_id = case when p_input ? 'channel_id' then v_channel else channel_id end,
         estimated_value = case when p_input ? 'estimated_value' then nullif(p_input ->> 'estimated_value', '')::numeric else estimated_value end,
         stage_changed_on = case when v_stage <> v_before.stage then coalesce(nullif(p_input ->> 'stage_changed_on', '')::date, v_today) else stage_changed_on end,
         won_on = case when v_stage = 'won' then coalesce(nullif(p_input ->> 'won_on', '')::date, won_on, v_today) else null end,
         lost_on = case when v_stage = 'lost' then coalesce(nullif(p_input ->> 'lost_on', '')::date, lost_on, v_today) else null end,
         notes = case when p_input ? 'notes' then nullif(p_input ->> 'notes', '') else notes end
   where organization_id = p_org and id = v_id;
  perform app.audit(p_org, 'opportunity.updated', 'opportunities', v_id, to_jsonb(v_before), p_input,
                    jsonb_build_object('stage_from', v_before.stage, 'stage_to', v_stage));
  return v_id;
end $$;

-- Replaces the lines of one invoice. The invoice must be this organisation's and current; every
-- product must be this organisation's; the lines may not exceed the invoice's net amount. A line
-- with no product is allowed (a person may split an invoice and leave part unassigned) — it still
-- counts as "not yet attributed" in every product figure.
create function api.set_invoice_lines(p_invoice uuid, p_lines jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid; v_net numeric; v_status public.record_status_enum; v_superseded uuid;
  v_sum numeric := 0; v_count integer := 0; l jsonb; v_product uuid;
begin
  select i.organization_id, coalesce(i.subtotal, case when i.tax_amount is not null then i.total_amount - i.tax_amount else i.total_amount end),
         i.record_status, i.superseded_by
    into v_org, v_net, v_status, v_superseded
    from public.invoices i where i.id = p_invoice;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_commercial_edit(v_org);
  if v_status <> 'accepted' or v_superseded is not null then
    raise exception 'CONFLICT: only a current, accepted invoice can be split into lines' using errcode = '40001';
  end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_product := nullif(l ->> 'product_id', '')::uuid;
    if v_product is not null and not exists (
      select 1 from public.products p where p.organization_id = v_org and p.id = v_product
    ) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    if (l ->> 'amount') is null or (l ->> 'amount')::numeric < 0 then
      raise exception 'VALIDATION: every line needs an amount of zero or more' using errcode = '22023';
    end if;
    v_sum := v_sum + (l ->> 'amount')::numeric;
  end loop;
  if v_sum > abs(v_net) + 0.005 then
    raise exception 'VALIDATION: the lines add up to more than the invoice' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('invoice:' || p_invoice::text));
  delete from public.invoice_lines where organization_id = v_org and invoice_id = p_invoice;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    insert into public.invoice_lines (organization_id, invoice_id, product_id, description, quantity, amount, sort_order, created_by)
    values (v_org, p_invoice, nullif(l ->> 'product_id', '')::uuid, nullif(l ->> 'description', ''),
            nullif(l ->> 'quantity', '')::numeric, (l ->> 'amount')::numeric, v_count, app.uid());
    v_count := v_count + 1;
  end loop;
  perform app.audit(v_org, 'invoice.lines_set', 'invoices', p_invoice, null,
                    jsonb_build_object('lines', v_count, 'attributed', v_sum, 'net', v_net), '{}'::jsonb);
  return v_count;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'upsert_product(uuid, jsonb)', 'upsert_channel(uuid, jsonb)', 'upsert_campaign(uuid, jsonb)',
    'set_campaign_spend(uuid, uuid, uuid, numeric, text)', 'upsert_opportunity(uuid, jsonb)',
    'set_invoice_lines(uuid, jsonb)']
  loop
    execute format('alter function api.%s owner to motion_definer', f);
    execute format('revoke all on function api.%s from public, anon', f);
    execute format('grant execute on function api.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. One read: product figures per period, aggregated where the rows are.
-- ---------------------------------------------------------------------------------------------
-- Per product per period: net sales attributed by lines (credit notes subtract), net cost attributed
-- by purchase lines, line and invoice counts; per period the sales revenue no line attributes
-- ("unattributed"); and per product the customer mix over the periods. Only lines of accepted,
-- current invoices count. The invoice-basis totals here reconcile to the engine's invoice-basis
-- revenue by construction (same rows, same net rule), which `test/integration/commercial.test.ts`
-- asserts.
create function api.product_period_summary(p_org uuid, p_period_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_products jsonb; v_unattributed jsonb; v_mix jsonb;
begin
  if p_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(p_org, 'customers.view');

  with lines as (
    select l.product_id, i.period_id, i.counterparty_id, i.invoice_type, l.invoice_id,
           case when i.invoice_type in ('sales', 'sales_credit_note')
                then case when i.invoice_type = 'sales' then l.amount else -l.amount end end as sales,
           case when i.invoice_type in ('purchase', 'purchase_credit_note')
                then case when i.invoice_type = 'purchase' then l.amount else -l.amount end end as cost
      from public.invoice_lines l
      join public.invoices i on i.organization_id = l.organization_id and i.id = l.invoice_id
     where l.organization_id = p_org and i.period_id = any(p_period_ids)
       and i.record_status = 'accepted' and i.superseded_by is null and i.status <> 'void'
  )
  select coalesce(jsonb_agg(row_to_json(x) order by x.product_id, x.period_id), '[]'::jsonb) into v_products
    from (
      select product_id, period_id,
             sum(coalesce(sales, 0))::text as sales, sum(coalesce(cost, 0))::text as cost,
             count(*) filter (where sales is not null)::int as sales_lines,
             count(*) filter (where cost is not null)::int as cost_lines,
             count(distinct invoice_id)::int as invoices
        from lines group by product_id, period_id
    ) x;

  select coalesce(jsonb_agg(row_to_json(u) order by u.period_id), '[]'::jsonb) into v_unattributed
    from (
      select i.period_id,
             sum(case when i.invoice_type = 'sales' then 1 else -1 end
                 * coalesce(i.subtotal, case when i.tax_amount is not null then i.total_amount - i.tax_amount else i.total_amount end))::text as sales_net,
             coalesce((select sum(case when j.invoice_type = 'sales' then l.amount else -l.amount end)
                         from public.invoice_lines l join public.invoices j on j.organization_id = l.organization_id and j.id = l.invoice_id
                        where l.organization_id = p_org and j.period_id = i.period_id and l.product_id is not null
                          and j.invoice_type in ('sales', 'sales_credit_note')
                          and j.record_status = 'accepted' and j.superseded_by is null and j.status <> 'void'), 0)::text as attributed,
             count(*)::int as invoices,
             count(*) filter (where not exists (select 1 from public.invoice_lines l where l.organization_id = i.organization_id and l.invoice_id = i.id))::int as invoices_without_lines
        from public.invoices i
       where i.organization_id = p_org and i.period_id = any(p_period_ids)
         and i.invoice_type in ('sales', 'sales_credit_note')
         and i.record_status = 'accepted' and i.superseded_by is null and i.status <> 'void'
       group by i.period_id
    ) u;

  with lines as (
    select l.product_id, i.counterparty_id,
           case when i.invoice_type = 'sales' then l.amount when i.invoice_type = 'sales_credit_note' then -l.amount end as sales
      from public.invoice_lines l
      join public.invoices i on i.organization_id = l.organization_id and i.id = l.invoice_id
     where l.organization_id = p_org and i.period_id = any(p_period_ids) and l.product_id is not null
       and i.invoice_type in ('sales', 'sales_credit_note')
       and i.record_status = 'accepted' and i.superseded_by is null and i.status <> 'void'
  )
  select coalesce(jsonb_agg(row_to_json(m) order by m.product_id, m.sales desc), '[]'::jsonb) into v_mix
    from (select product_id, counterparty_id, sum(sales) as sales, count(*)::int as lines from lines group by product_id, counterparty_id) m;

  return jsonb_build_object('products', v_products, 'unattributed', v_unattributed, 'customer_mix', v_mix);
end $$;

alter function api.product_period_summary(uuid, uuid[]) owner to motion_definer;
revoke all on function api.product_period_summary(uuid, uuid[]) from public, anon;
grant execute on function api.product_period_summary(uuid, uuid[]) to authenticated;
