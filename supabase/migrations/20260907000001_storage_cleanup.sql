-- MOTION — Storage · The orphan sweep records what it removed.
-- Contract: SERVICE_ARCHITECTURE.md §7 (job types); TENANCY_MODEL.md §8; SECURITY_MODEL.md §5b;
--           DATABASE_ARCHITECTURE.md §14.2; ADR-038.1, ADR-043.4, ADR-062.2.
--
-- `storage.cleanup_orphans` is the only job in the product that destroys customer data, and it does
-- so with no human asking and no row left behind to show for it — the row is the very thing whose
-- absence made the object a candidate. Without this function a sweep would be invisible: an operator
-- asked "where did that file go?" could answer only by reading application logs, which are not
-- retained on the terms an audit trail is (SECURITY_MODEL.md §16).
--
-- Server-asserted for the usual reason (ADR-043): what a sweep observed in a bucket is a fact about
-- the server, not an intention anybody expressed, and a browser able to write it could manufacture a
-- plausible history for files it had removed by other means.

create function api_server.record_storage_cleanup(
  p_org      uuid,
  p_job      uuid,
  p_bucket   text,
  p_examined integer,
  p_removed  integer,
  p_failed   integer
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  if p_bucket not in ('source-documents', 'reports') then
    raise exception 'VALIDATION: unknown bucket' using errcode = '22023';
  end if;
  if coalesce(p_examined, -1) < 0 or coalesce(p_removed, -1) < 0 or coalesce(p_failed, -1) < 0 then
    raise exception 'VALIDATION: counts cannot be negative' using errcode = '22023';
  end if;
  if p_removed > p_examined then
    -- A sweep that removed more than it looked at has miscounted, and a miscounting sweep is one
    -- whose arithmetic decides what to delete. Refusing the record makes the job fail loudly.
    raise exception 'VALIDATION: a sweep cannot remove more objects than it examined'
      using errcode = '22023';
  end if;

  /*
   * The organization is NOT checked against `organizations`. The most interesting sweep is the one
   * that collects a purged organization's leftovers (SECURITY_MODEL.md §5b), and by then the row is
   * gone; `audit_events` deliberately holds no foreign keys for exactly this reason (§16, ADR-038.9).
   *
   * Counts only, no keys: object paths carry the uploader's original filename, and ADR-038.9 keeps
   * audit metadata to an allow-list of ids for that reason. Which keys went is in the job's log line.
   *
   * The actor is NULL — a nightly sweep is the system acting as itself, and `app.audit` records it
   * as `system` rather than inventing a person.
   */
  v_id := app.audit(
    p_org, 'storage.orphans_removed', null, null, null,
    jsonb_build_object('bucket', p_bucket, 'examined', p_examined,
                       'removed', p_removed, 'failed', p_failed),
    jsonb_build_object('job_id', p_job), null);

  return v_id;
end $$;

alter function api_server.record_storage_cleanup(uuid, uuid, text, integer, integer, integer)
  owner to motion_definer;
revoke all on function api_server.record_storage_cleanup(uuid, uuid, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function api_server.record_storage_cleanup(uuid, uuid, text, integer, integer, integer)
  to service_role;

comment on function api_server.record_storage_cleanup(uuid, uuid, text, integer, integer, integer) is
  'Records one organization''s share of a storage.cleanup_orphans sweep. Counts only: object paths '
  'carry original filenames, which audit metadata does not hold (ADR-038.9).';
