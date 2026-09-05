-- MOTION — Phase 1 · Schema `api_server`: server-asserted functions.
-- Contract: DATABASE_ARCHITECTURE.md §14.2; ADR-043; findings R2-A-01, R2-A-02, R2-A-05.
--
-- Why this schema exists: `api.*` is granted to `authenticated`, so anything it accepts is
-- something a browser can assert with the user's own token. Facts the SERVER observed — that a
-- download happened, that a scan passed, that an AI answer was grounded — must not be assertable by
-- a client. These functions are therefore executable ONLY by `service_role`, are called from
-- src/core/db/server-rpc.ts, and take the human actor explicitly, re-validating that actor with the
-- actor-parameterised helpers rather than trusting the (service-role) session.
--
-- Phase 1 delivers the two functions Phase 1–3 needs. finalize_upload, register_document,
-- ai_persist_turn, commit_batch_as and set_conversation_archived arrive with Phases 4 and 5.

create function api_server.record_access_event(
  p_actor        uuid,
  p_org          uuid,
  p_action       public.access_event_enum,
  p_target_table text default null,
  p_target_id    uuid default null,
  p_metadata     jsonb default '{}'::jsonb,
  p_request_id   text default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null then
    raise exception 'VALIDATION: an actor is required' using errcode = '22023';
  end if;

  -- Per-action authorisation of the ACTOR (not the session), DATABASE_ARCHITECTURE.md §14.2.
  case p_action
    when 'document.downloaded' then
      if not app.has_permission_of(p_actor, p_org, 'documents.view') then
        raise exception 'PERMISSION_DENIED: documents.view required' using errcode = '42501';
      end if;
    when 'report.downloaded' then
      if not app.has_permission_of(p_actor, p_org, 'reports.view') then
        raise exception 'PERMISSION_DENIED: reports.view required' using errcode = '42501';
      end if;
    when 'export.created' then
      if not app.has_permission_of(p_actor, p_org, 'data.export') then
        raise exception 'PERMISSION_DENIED: data.export required' using errcode = '42501';
      end if;
    when 'evidence.viewed' then
      if not app.has_permission_of(p_actor, p_org, 'financials.view') then
        raise exception 'PERMISSION_DENIED: financials.view required' using errcode = '42501';
      end if;
    when 'org.data_viewed' then
      -- CD-13: only a super admin generates this event, and the organization's owner sees it.
      if app.org_role_of(p_actor, p_org) is distinct from 'super_admin' then
        raise exception 'PERMISSION_DENIED: org.data_viewed is a super-admin event' using errcode = '42501';
      end if;
    else
      -- document.quarantined, document.sent_to_ai, auth.*, member.invitation_failed are system
      -- events written by server code with no per-actor permission of their own.
      null;
  end case;

  -- metadata keys are ids only: never emails, filenames or free text (ADR-038.9).
  if exists (
    select 1 from jsonb_object_keys(coalesce(p_metadata, '{}'::jsonb)) k
     where k not in ('document_id','report_id','batch_id','bundle_id','period_id','surface',
                     'route','pages','export_kind','invitation_id','job_id')
  ) then
    raise exception 'VALIDATION: metadata key not in the allow-list' using errcode = '22023';
  end if;

  v_id := app.audit(p_org, p_action::text, p_target_table, p_target_id, null, null,
                    coalesce(p_metadata, '{}'::jsonb), p_actor, p_request_id);
  return v_id;
end $$;

create function api_server.enqueue_job(
  p_actor    uuid,
  p_org      uuid,
  p_job_type public.job_type_enum,
  p_payload  jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_key text;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- org.purge is enqueued by the organizations deletion trigger alone (ADR-026.4).
  if p_job_type = 'org.purge' then
    raise exception 'PERMISSION_DENIED: org.purge is enqueued by the deletion trigger only'
      using errcode = '42501';
  end if;

  -- Type → permission of the ACTOR. System job types carry a null actor.
  if p_job_type in ('document.extract', 'import.commit_large') then
    if p_actor is null or not app.has_permission_of(p_actor, p_org, 'imports.review') then
      raise exception 'PERMISSION_DENIED: imports.review required' using errcode = '42501';
    end if;
  elsif p_job_type = 'report.render' then
    if p_actor is null or not app.has_permission_of(p_actor, p_org, 'reports.generate') then
      raise exception 'PERMISSION_DENIED: reports.generate required' using errcode = '42501';
    end if;
  elsif p_job_type = 'calculation.run' then
    if p_actor is not null and not app.has_permission_of(p_actor, p_org, 'intelligence.recompute') then
      raise exception 'PERMISSION_DENIED: intelligence.recompute required' using errcode = '42501';
    end if;
  end if;

  if p_org is not null and not exists (select 1 from public.organizations o
                                        where o.id = p_org and o.status <> 'deleted') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  v_key := p_job_type::text || ':' || coalesce(p_org::text, 'platform');

  insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
  values (p_org, p_job_type, coalesce(p_payload, '{}'::jsonb), p_actor, v_key)
  on conflict (job_type, idempotency_key) where (status = 'queued' and idempotency_key is not null)
    do update set payload = public.jobs.payload || coalesce(p_payload, '{}'::jsonb)
  returning id into v_id;

  perform app.audit(p_org, 'job.enqueued', 'jobs', v_id, null,
                    jsonb_build_object('job_type', p_job_type), '{}'::jsonb, p_actor);
  return v_id;
end $$;

-- Ownership and grants: service_role only. `authenticated` must not even see these.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api_server'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
