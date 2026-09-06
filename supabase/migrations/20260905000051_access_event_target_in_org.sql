-- MOTION — Evidence UI · An access event must name a target of the organisation it claims.
-- Contract: DATABASE_ARCHITECTURE.md §14.2 (`record_access_event`); TEST_STRATEGY.md §4 case 4;
-- ADR-043.5.
--
-- §14.2 states the rule as "`document.downloaded` → `documents.view` **and document in org**;
-- `report.downloaded` → `reports.view` **and report in org**". The permission half was implemented
-- and the target half was not: the function checked that the actor may download documents in the
-- organisation it was given, and never that the document it was about belonged to it.
--
-- Why that matters more here than it looks. ADR-043.5's design is that the audit row is the INPUT
-- the signer needs: `signDownloadUrl` re-reads the row and refuses unless it names this actor, this
-- target and was written in the last thirty seconds. That check is only as good as the row, and a
-- row naming another organisation's document under your own would have satisfied every part of it.
-- The document route resolves its document by `(organization_id, id)` first, so it could not
-- produce such a row — but `record_access_event` is the shared primitive every download path uses,
-- and a guarantee that holds only because today's callers happen to be careful is not a guarantee.

create or replace function api_server.record_access_event(
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
      -- NOT_FOUND, never PERMISSION_DENIED: a 403 would confirm the document exists for somebody
      -- (SECURITY_MODEL.md §14).
      if p_target_id is not null and not exists (
        select 1 from public.source_documents d
         where d.organization_id = p_org and d.id = p_target_id
      ) then
        raise exception 'NOT_FOUND' using errcode = 'P0002';
      end if;
    when 'report.downloaded' then
      if not app.has_permission_of(p_actor, p_org, 'reports.view') then
        raise exception 'PERMISSION_DENIED: reports.view required' using errcode = '42501';
      end if;
      if p_target_id is not null and not exists (
        select 1 from public.report_files r
         where r.organization_id = p_org and r.id = p_target_id
      ) then
        raise exception 'NOT_FOUND' using errcode = 'P0002';
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

alter function api_server.record_access_event(uuid, uuid, public.access_event_enum, text, uuid, jsonb, text)
  owner to motion_definer;
revoke all on function api_server.record_access_event(uuid, uuid, public.access_event_enum, text, uuid, jsonb, text)
  from public, authenticated, anon;
grant execute on function api_server.record_access_event(uuid, uuid, public.access_event_enum, text, uuid, jsonb, text)
  to service_role;
