-- MOTION — Imports · an invoice list creates the customers and suppliers it names (IMPORT_ENGINE.md §6.6).
--
-- `invoices.counterparty_id` is NOT NULL, and nothing in the product created a counterparty: the
-- pipeline collected `newCounterparties` and no one read them. So an invoice list could commit only
-- for customers that already existed — and none could exist, because no path created one. The
-- import wizard now calls this between parsing and validation, exactly as it calls
-- `api.create_import_accounts` for ledger accounts (ADR-058.3).
--
-- The caller sends NAMES only. The kind is the batch's to decide: a sales list names customers, a
-- purchase list names suppliers. An existing counterparty met on the other side becomes `both`
-- (§6.6); a merged-away one is never touched. A name that carries an amount or a percentage is
-- refused (ADR-045.3) — entity names are exempt from the AI grounding scan, so this is what stops
-- a figure riding into an answer inside a name. The wizard applies the full rule first
-- (`IMP-NAME-015`); this is the database's own copy of its core, for a direct call.

create function api.create_import_counterparties(p_batch uuid, p_names jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_status   public.import_batch_status_enum;
  v_type     public.import_type_enum;
  v_target   public.import_target_enum;
  v_kind     public.counterparty_kind_enum;
  v_name     text;
  v_id       uuid;
  v_existing public.counterparty_kind_enum;
  v_created  integer := 0;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, b.status, b.import_type, b.target_table
    into v_org, v_status, v_type, v_target
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');

  -- Only while the batch is still being prepared, as for accounts.
  if v_status not in ('created', 'parsing', 'mapping', 'validating', 'awaiting_review') then
    raise exception 'CONFLICT: this batch is not open for mapping' using errcode = '40001';
  end if;
  if v_target <> 'invoices' then
    raise exception 'VALIDATION: only an invoice list adds customers or suppliers' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_names, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_names, '[]'::jsonb)) > 5000 then
    raise exception 'VALIDATION: names must be a list of at most 5,000' using errcode = '22023';
  end if;

  v_kind := case when v_type in ('sales_invoices', 'sales_report') then 'customer'
                 else 'supplier' end::public.counterparty_kind_enum;

  for v_name in select btrim(value) from jsonb_array_elements_text(coalesce(p_names, '[]'::jsonb))
  loop
    if v_name is null or v_name = '' or length(v_name) > 300
       or app.normalize_name(v_name) = '' then
      continue;
    end if;
    if v_name ~ '[£$€¥₹₽₩₪₦₺฿¢¤][[:space:]]?[0-9]'
       or v_name ~ '[0-9][[:space:]]?[£$€¥₹₽₩₪₦₺฿¢¤]'
       or v_name ~* '[0-9][[:space:]]?(%|per[[:space:]]?cent)(?![[:alpha:]])'
       or v_name ~ '[0-9]{1,3}(,[0-9]{3})+' then
      raise exception 'VALIDATION: names cannot contain amounts' using errcode = '22023';
    end if;

    insert into public.counterparties (organization_id, name, kind)
    values (v_org, v_name, v_kind)
    on conflict (organization_id, normalized_name) do nothing
    returning id into v_id;

    if v_id is not null then
      v_created := v_created + 1;
      perform app.audit(v_org, 'counterparty.created', 'counterparties', v_id, null,
                        jsonb_build_object('name', v_name, 'kind', v_kind),
                        jsonb_build_object('batch_id', p_batch, 'source', 'import'));
    else
      -- The name is taken. A current counterparty first seen on the other side of the business
      -- becomes `both`; one that is merged away stays exactly as it is.
      select c.id, c.kind into v_id, v_existing
        from public.counterparties c
       where c.organization_id = v_org
         and c.normalized_name = app.normalize_name(v_name)
         and c.merged_into_id is null;
      if v_id is not null and v_existing <> v_kind and v_existing <> 'both' then
        update public.counterparties
           set kind = case when v_existing = 'unknown' then v_kind else 'both' end
         where organization_id = v_org and id = v_id;
        perform app.audit(v_org, 'counterparty.kind_changed', 'counterparties', v_id,
                          jsonb_build_object('kind', v_existing),
                          jsonb_build_object('kind', case when v_existing = 'unknown' then v_kind else 'both' end),
                          jsonb_build_object('batch_id', p_batch, 'source', 'import'));
      end if;
    end if;
    v_id := null;
  end loop;

  return v_created;
end $$;

alter function api.create_import_counterparties(uuid, jsonb) owner to motion_definer;
revoke all on function api.create_import_counterparties(uuid, jsonb) from public, anon;
grant execute on function api.create_import_counterparties(uuid, jsonb) to authenticated;
