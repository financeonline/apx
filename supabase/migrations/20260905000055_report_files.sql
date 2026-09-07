-- MOTION — Reporting · The job records the file it rendered.
-- Contract: SERVICE_ARCHITECTURE.md §4.14; DATABASE_ARCHITECTURE.md `report_files`;
-- IMPLEMENTATION_PLAN.md Phase 13 slice 2; ADR-024, ADR-038.7, ADR-043.
--
-- Server-asserted, like every other row that records something the SERVER observed (ADR-043): the
-- size and the hash of a PDF are facts about a file the job wrote, not an intention a browser
-- expressed. A user JWT that could write `report_files` could point a download at any object in the
-- bucket — the row IS the authority the download route resolves by `(organization_id, id)`.

create function api_server.record_report_file(
  p_actor   uuid,
  p_org     uuid,
  p_period  uuid,
  p_job     uuid,
  p_file    uuid,
  p_sha256  bytea,
  p_bytes   bigint
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  if not exists (select 1 from public.fiscal_periods f
                  where f.organization_id = p_org and f.id = p_period) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  /*
   * The caller names the FILE, never the PATH. The job has to write the object before it records
   * the row (ADR-043.4) and therefore has to know the id first — but the path is derived here,
   * `{org}/{period}/{id}.pdf`, so a caller cannot point a download at another organisation's object,
   * which is the lesson `register_document` already carries (R2-A-09).
   */
  v_id := coalesce(p_file, gen_random_uuid());

  insert into public.report_files
         (id, organization_id, period_id, report_kind, job_id, storage_bucket, storage_path,
          sha256, byte_size, generated_by)
  values (v_id, p_org, p_period, 'monthly_management', p_job, 'reports',
          p_org::text || '/' || p_period::text || '/' || v_id::text || '.pdf',
          p_sha256, p_bytes, p_actor);

  perform app.audit(p_org, 'report.generated', 'report_files', v_id, null,
                    jsonb_build_object('period_id', p_period, 'byte_size', p_bytes),
                    jsonb_build_object('job_id', p_job), p_actor);
  return v_id;
end $$;

alter function api_server.record_report_file(uuid, uuid, uuid, uuid, uuid, bytea, bigint)
  owner to motion_definer;
revoke all on function api_server.record_report_file(uuid, uuid, uuid, uuid, uuid, bytea, bigint)
  from public, authenticated, anon;
grant execute on function api_server.record_report_file(uuid, uuid, uuid, uuid, uuid, bytea, bigint)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- The storage path a caller must write to, so the job can put the object before recording the row.
-- ---------------------------------------------------------------------------------------------
--
-- Two steps rather than one, in the order `ADR-043.4` fixes for documents: the object is written
-- first and the row second, so a row can never name an object that is not there. A crash between
-- them leaves an orphan object, which `storage.cleanup_orphans` removes; the reverse would leave a
-- download that 404s from a row the product believes in.
comment on function api_server.record_report_file(uuid, uuid, uuid, uuid, uuid, bytea, bigint) is
  'Records a rendered report. The object is written to the path this function generates BEFORE the '
  'row is recorded (ADR-043.4), so a row never names an object that does not exist.';
