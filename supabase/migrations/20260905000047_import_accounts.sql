-- MOTION — Import wizard · Creating the accounts a file names.
-- Contract: IMPORT_ENGINE.md §6.5; IMPLEMENTATION_PLAN.md Phase 5 slice 5; ADR-004, ADR-026.
--
-- A general ledger or trial balance names accounts in the customer's own chart — "Sales", "4000",
-- "Subcontractors" — and `ledger_entries.account_id` is NOT NULL. Until now nothing created them:
-- the pipeline collected the unmapped names and every commit of a ledger failed on the not-null
-- constraint. §6.5 says what should happen — "unmapped → uncategorised" — and this is the function
-- that does it (ADR-058.3).
--
-- The category is a SUGGESTION the caller passes, from the keyword rules. It is never trusted to be
-- right: an account created here appears first on `/data/accounts`, where a human confirms or
-- re-maps it, and everything it feeds is marked incomplete until they do (§5).

create function api.create_import_accounts(p_batch uuid, p_accounts jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org     uuid;
  v_status  public.import_batch_status_enum;
  a         jsonb;
  v_created integer := 0;
  v_name    text;
  v_code    text;
  v_category public.standard_category_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, b.status into v_org, v_status
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');

  -- Only while the batch is still being prepared. Creating accounts for a committed batch would
  -- change what its rows mean after the fact.
  if v_status not in ('created', 'parsing', 'mapping', 'validating', 'awaiting_review') then
    raise exception 'CONFLICT: this batch is not open for mapping' using errcode = '40001';
  end if;

  for a in select * from jsonb_array_elements(coalesce(p_accounts, '[]'::jsonb))
  loop
    v_name := nullif(btrim(a ->> 'name'), '');
    if v_name is null then
      continue;
    end if;
    v_code := nullif(btrim(coalesce(a ->> 'code', '')), '');
    v_category := coalesce(
      nullif(a ->> 'standard_category', '')::public.standard_category_enum,
      'uncategorised');

    -- `normalized_name` is derived by trigger (ADR-052.8), and uniqueness is on it — so a second
    -- upload naming "Bank  Charges" finds the account created for "bank charges" rather than
    -- splitting the history in two.
    insert into public.accounts (organization_id, code, name, standard_category, account_type)
    values (v_org, v_code, v_name, v_category, public.standard_category_account_type(v_category))
    on conflict do nothing;

    if found then
      v_created := v_created + 1;
      perform app.audit(v_org, 'account.created', 'accounts', null, null,
                        jsonb_build_object('name', v_name, 'code', v_code,
                                           'standard_category', v_category),
                        jsonb_build_object('batch_id', p_batch, 'source', 'import'));
    end if;
  end loop;

  return v_created;
end $$;

alter function api.create_import_accounts(uuid, jsonb) owner to motion_definer;
revoke all on function api.create_import_accounts(uuid, jsonb) from public, anon;
grant execute on function api.create_import_accounts(uuid, jsonb) to authenticated;
