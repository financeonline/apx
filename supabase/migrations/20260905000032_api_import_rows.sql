-- MOTION — Phase 3 (plan Phase 5) · Writing parsed rows and validation results.
-- Contract: IMPORT_ENGINE.md §1.1 (state machine), §5 (parsing), §8 (validation); ADR-043.
--
-- These live in `api_server`, not `api`, and the reason is the whole point of ADR-043: a parse
-- result is a fact the SERVER observed about a file, not an intention the user expressed. If a
-- browser could write `import_rows` it could write rows that were never in the file, or mark an
-- error row `valid` and walk it straight through the commit gate. The parser runs on the server;
-- only the server may record what it found.
--
-- Reviewer decisions, by contrast, ARE user intent and stay in `api.decide_import_rows`.

create function api_server.write_import_rows(
  p_actor uuid,
  p_org   uuid,
  p_batch uuid,
  p_rows  jsonb,
  p_status public.import_batch_status_enum default 'validating'
) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0; r jsonb;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if not app.has_permission_of(p_actor, p_org, 'imports.create') then
    raise exception 'PERMISSION_DENIED: imports.create required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.import_batches b
                  where b.organization_id = p_org and b.id = p_batch
                    and b.status in ('created', 'parsing', 'mapping', 'validating', 'awaiting_review')) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Re-parsing replaces the previous rows wholesale. Rows of a COMMITTED batch are never touched:
  -- they are the provenance of live records (§13).
  delete from public.import_rows r2
   where r2.organization_id = p_org and r2.batch_id = p_batch and r2.status <> 'committed';

  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.import_rows
           (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status,
            issues, dedupe_hash, duplicate_of_table, duplicate_of_id,
            duplicate_within_batch_row_id, reviewer_decision, reviewer_reason, source_page)
    values (p_org, p_batch,
            (r ->> 'row_number')::integer,
            r ->> 'source_ref',
            coalesce(r -> 'raw_data', '{}'::jsonb),
            r -> 'mapped_data',
            coalesce((r ->> 'status')::public.import_row_status_enum, 'pending'),
            coalesce(r -> 'issues', '[]'::jsonb),
            case when (r ->> 'dedupe_hash') is not null
                 then decode(r ->> 'dedupe_hash', 'hex') end,
            (r ->> 'duplicate_of_table')::public.financial_record_table_enum,
            (r ->> 'duplicate_of_id')::uuid,
            (r ->> 'duplicate_within_batch_row_id')::uuid,
            coalesce((r ->> 'reviewer_decision')::public.reviewer_decision_enum, 'none'),
            r ->> 'reviewer_reason',
            (r ->> 'source_page')::integer);
    v_count := v_count + 1;
  end loop;

  update public.import_batches set status = p_status
   where organization_id = p_org and id = p_batch;

  return v_count;
end $$;

-- The batch-level findings and the confirmations this batch's shape requires (§8.2). Also
-- server-asserted: which gates apply is decided by the validator, not by the reviewer.
create function api_server.set_batch_validation(
  p_actor         uuid,
  p_org           uuid,
  p_batch         uuid,
  p_batch_issues  jsonb,
  p_required      text[],
  p_row_counts    jsonb default '{}'::jsonb,
  p_statement     jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if not app.has_permission_of(p_actor, p_org, 'imports.create') then
    raise exception 'PERMISSION_DENIED: imports.create required' using errcode = '42501';
  end if;

  update public.import_batches b
     set batch_issues = coalesce(p_batch_issues, '[]'::jsonb),
         required_confirmations = coalesce(p_required, '{}'),
         row_counts = coalesce(p_row_counts, '{}'::jsonb),
         -- Deterministic or reviewer-typed balances only. An AI reading never reaches these columns
         -- (§5.4, F-C-03): the gate must not be able to trust a figure the model produced.
         statement_opening_balance =
           coalesce((p_statement ->> 'opening')::numeric, b.statement_opening_balance),
         statement_closing_balance =
           coalesce((p_statement ->> 'closing')::numeric, b.statement_closing_balance),
         status = 'awaiting_review',
         -- Any reviewer holding a stale view must reload before acting (§16).
         review_token = gen_random_uuid()
   where b.organization_id = p_org and b.id = p_batch;

  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  perform app.audit(p_org, 'import.validated', 'import_batches', p_batch, null,
                    jsonb_build_object('counts', p_row_counts,
                                       'issues', jsonb_array_length(coalesce(p_batch_issues, '[]'::jsonb))),
                    '{}'::jsonb, p_actor);
  return p_batch;
end $$;

-- A parse that failed leaves the batch `failed` with a reason the user can act on, and the document
-- intact so they can retry without re-uploading (§16).
create function api_server.fail_import_batch(
  p_actor uuid, p_org uuid, p_batch uuid, p_stage text, p_message text,
  p_deferred boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  update public.import_batches
     set status = case when p_deferred then 'failed' else 'failed' end,
         error_summary = jsonb_build_object('stage', p_stage, 'message', p_message, 'at', now())
   where organization_id = p_org and id = p_batch;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  perform app.audit(p_org, 'import.failed', 'import_batches', p_batch, null,
                    jsonb_build_object('stage', p_stage), '{}'::jsonb, p_actor);
  return p_batch;
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api_server'
       and pg_catalog.pg_get_userbyid(p.proowner) <> 'motion_definer'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public, authenticated, anon', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
