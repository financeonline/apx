-- MOTION — api_server.fail_import_batch never worked (PDF slice 1, ADR-083; PRODUCTION_AUDIT.md N3).
--
-- `set status = case when p_deferred then 'failed' else 'failed' end` yields TEXT, and Postgres
-- refuses to assign text to an enum column (42804). Every call failed — so no parse or validation
-- failure has ever marked a batch `failed` with its reason (§16); the wizard's error path threw a
-- second, unmapped error instead and the batch stayed wherever it was. Found the first time a
-- text-layer PDF with no table reached it.
--
-- `import_batch_status_enum` has no `deferred_upstream` (that is a JOB state); a provider outage is
-- recorded on the batch's error summary and the status stays `failed`, as §16 describes it to the
-- user ("waiting for the extraction service").

create or replace function api_server.fail_import_batch(
  p_actor uuid, p_org uuid, p_batch uuid, p_stage text, p_message text,
  p_deferred boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  update public.import_batches
     set status = 'failed'::public.import_batch_status_enum,
         error_summary = jsonb_build_object('stage', p_stage, 'message', p_message, 'at', now(),
                                            'deferred', coalesce(p_deferred, false))
   where organization_id = p_org and id = p_batch;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  perform app.audit(p_org, 'import.failed', 'import_batches', p_batch, null,
                    jsonb_build_object('stage', p_stage, 'deferred', coalesce(p_deferred, false)), '{}'::jsonb, p_actor);
  return p_batch;
end $$;
