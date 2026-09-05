-- MOTION — Phase 2 (plan Phase 4) · api.* and api_server.* for documents, imports, alerts, actions
-- and AI storage.
-- Contract: DATABASE_ARCHITECTURE.md §14.1/§14.2; ADR-029, ADR-032, ADR-038, ADR-043.
--
-- Deliberate scope boundary, so nothing here reads as a silent stub:
--   `api.commit_import_batch`, `api.rollback_import_batch` and `api.replace_import_batch` are NOT in
--   this migration. IMPLEMENTATION_PLAN.md assigns their behaviour to Phase 5 slice 7 — commit-time
--   cross-batch dedupe re-check, batch-scoped supersession, promotion of dependants (ADR-047.9) and
--   chain re-linking are import-engine logic that cannot be written correctly before the dedupe
--   machinery exists. The primitives they will be built from (`app.supersede_row`,
--   `app.record_status_event`, `app.enqueue_recalculation`) ARE built and tested here, and the
--   batch lifecycle up to `awaiting_review` is complete. A batch can therefore be created, mapped,
--   reviewed and rejected in this phase; it cannot yet be committed.

-- ---------------------------------------------------------------------------
-- Documents (ADR-043.4)
-- ---------------------------------------------------------------------------

-- Server-asserted: the browser may not choose where its own upload lands. The id and the storage
-- path are GENERATED here, so a caller cannot aim a write at another organization's prefix.
create function api_server.register_document(
  p_actor uuid,
  p_org   uuid,
  p_meta  jsonb,
  p_request_id text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id       uuid := gen_random_uuid();
  v_filename text;
  v_safe     text;
  v_path     text;
  v_prior    uuid;
  v_sha      bytea;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null then
    raise exception 'VALIDATION: an actor is required' using errcode = '22023';
  end if;
  if not app.has_permission_of(p_actor, p_org, 'imports.create') then
    raise exception 'PERMISSION_DENIED: imports.create required' using errcode = '42501';
  end if;

  v_filename := coalesce(p_meta ->> 'original_filename', 'upload');
  -- Strip anything that could traverse or collide: the path is ours to construct, not the file's.
  -- Replacing the disallowed characters alone is NOT enough — `.` is legal in a filename, so
  -- `../../etc/passwd` survives as `.._.._etc_passwd` and a filename of exactly `..` becomes a
  -- traversal segment. Collapse runs of dots and strip leading ones; mirrors sanitiseFilename() in
  -- src/core/storage/signer.ts, and a test asserts the two agree.
  v_safe := regexp_replace(v_filename, '[^A-Za-z0-9._-]+', '_', 'g');
  v_safe := regexp_replace(v_safe, '\.{2,}', '.', 'g');
  v_safe := regexp_replace(v_safe, '^[._-]+', '');
  v_safe := regexp_replace(left(v_safe, 120), '[._-]+$', '');
  if v_safe = '' then v_safe := 'upload'; end if;
  v_path := p_org::text || '/' || v_id::text || '/' || v_safe;

  v_sha := decode(p_meta ->> 'sha256', 'hex');

  -- CD-12: the same bytes twice is a file-level duplicate. Reported as a CONFLICT carrying the prior
  -- id so the UI can link to the existing import rather than making the user guess.
  select d.id into v_prior
    from public.source_documents d
   where d.organization_id = p_org and d.sha256 = v_sha and d.deleted_at is null;
  if v_prior is not null then
    raise exception 'CONFLICT: this file has already been uploaded (%)', v_prior
      using errcode = '23505';
  end if;

  insert into public.source_documents
         (id, organization_id, storage_path, original_filename, mime_type, byte_size, sha256,
          document_kind, status, uploaded_by)
  values (v_id, p_org, v_path, v_filename,
          coalesce(p_meta ->> 'mime_type', 'application/octet-stream'),
          (p_meta ->> 'byte_size')::bigint, v_sha,
          coalesce((p_meta ->> 'document_kind')::public.document_kind_enum, 'unknown'),
          'uploaded', p_actor);

  perform app.audit(p_org, 'document.uploaded', 'source_documents', v_id, null,
                    jsonb_build_object('filename', v_safe, 'kind', p_meta ->> 'document_kind'),
                    '{}'::jsonb, p_actor, p_request_id);
  return v_id;
end $$;

-- The second half of the upload handshake. Status only moves to `ready` once the object is actually
-- present at the declared size: a row claiming a file that is not there would give the import engine
-- something to parse that does not exist (ADR-043.4).
create function api_server.finalize_upload(
  p_actor       uuid,
  p_org         uuid,
  p_document    uuid,
  p_byte_size   bigint,
  p_scan_result jsonb,
  p_status      public.document_status_enum,
  p_request_id  text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_declared bigint;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if not app.has_permission_of(p_actor, p_org, 'imports.create') then
    raise exception 'PERMISSION_DENIED: imports.create required' using errcode = '42501';
  end if;
  if p_status not in ('ready', 'quarantined', 'unreadable') then
    raise exception 'VALIDATION: finalize_upload sets ready, quarantined or unreadable only'
      using errcode = '22023';
  end if;

  select d.byte_size into v_declared
    from public.source_documents d
   where d.organization_id = p_org and d.id = p_document and d.status = 'uploaded';
  if v_declared is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_declared <> p_byte_size then
    raise exception 'VALIDATION: the stored object does not match the declared size'
      using errcode = '22023';
  end if;

  update public.source_documents
     set status = p_status, scan_result = coalesce(p_scan_result, '{}'::jsonb)
   where organization_id = p_org and id = p_document;

  if p_status = 'quarantined' then
    perform app.audit(p_org, 'document.quarantined', 'source_documents', p_document, null,
                      jsonb_build_object('scan', p_scan_result), '{}'::jsonb, p_actor, p_request_id);
  end if;
  return p_document;
end $$;

create function api.delete_document(p_document uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_status public.document_status_enum; v_path text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select d.organization_id, d.status, d.storage_path into v_org, v_status, v_path
    from public.source_documents d where d.id = p_document and d.deleted_at is null;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');

  -- A quarantined file is evidence of an attempted upload and is kept until the investigation ends.
  if v_status = 'quarantined' then
    raise exception 'CONFLICT: a quarantined document cannot be deleted' using errcode = '40001';
  end if;
  if exists (select 1 from public.import_batches b
              where b.organization_id = v_org and b.source_document_id = p_document
                and b.status not in ('rejected', 'rolled_back')) then
    raise exception 'CONFLICT: this document is referenced by an import' using errcode = '40001';
  end if;

  -- The row is marked, not removed; the Storage signer then deletes the object, and
  -- storage.cleanup_orphans finishes the job if that fails (ADR-043.4; R2-A-09).
  update public.source_documents
     set status = 'deleted', deleted_at = now()
   where organization_id = v_org and id = p_document;

  perform app.audit(v_org, 'document.deleted', 'source_documents', p_document, null, null, '{}'::jsonb);
  return v_path;
end $$;

-- ---------------------------------------------------------------------------
-- Import batch lifecycle up to review (commit/rollback are Phase 5 — see the header)
-- ---------------------------------------------------------------------------

create function api.start_import_batch(p_document uuid, p_import_type public.import_type_enum, p_opts jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_status public.document_status_enum; v_batch uuid; v_target public.import_target_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select d.organization_id, d.status into v_org, v_status
    from public.source_documents d where d.id = p_document and d.deleted_at is null;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.create');

  if v_status <> 'ready' then
    raise exception 'CONFLICT: this document is not ready to import' using errcode = '40001';
  end if;
  -- One active batch per document: two concurrent wizards over one file would produce two
  -- independent sets of records from the same source.
  if exists (select 1 from public.import_batches b
              where b.organization_id = v_org and b.source_document_id = p_document
                and b.status in ('created','parsing','mapping','validating','awaiting_review','committing')) then
    raise exception 'CONFLICT: an import of this document is already in progress' using errcode = '40001';
  end if;

  v_target := case p_import_type
    when 'general_ledger' then 'ledger_entries'
    when 'receipts' then 'ledger_entries'
    when 'trial_balance' then 'period_balances'
    when 'pnl_report' then 'period_balances'
    when 'balance_sheet' then 'period_balances'
    when 'bank_statement' then 'bank_transactions'
    else 'invoices' end::public.import_target_enum;

  if v_target = 'bank_transactions' and (p_opts ->> 'bank_account_id') is null then
    raise exception 'VALIDATION: a bank statement import needs a bank account' using errcode = '22023';
  end if;

  insert into public.import_batches
         (organization_id, source_document_id, import_type, target_table, bank_account_id,
          period_start, period_end, balance_basis, created_by,
          fiscal_year_start_month_at_commit)
  select v_org, p_document, p_import_type, v_target,
         (p_opts ->> 'bank_account_id')::uuid,
         coalesce((p_opts ->> 'period_start')::date, date_trunc('month', now())::date),
         coalesce((p_opts ->> 'period_end')::date,
                  (date_trunc('month', now()) + interval '1 month - 1 day')::date),
         (p_opts ->> 'balance_basis')::public.balance_basis_enum,
         app.uid(), o.fiscal_year_start_month
    from public.organizations o where o.id = v_org
  returning id into v_batch;

  perform app.audit(v_org, 'import.started', 'import_batches', v_batch, null,
                    jsonb_build_object('import_type', p_import_type, 'document', p_document),
                    '{}'::jsonb);
  return v_batch;
end $$;

create function api.set_statement_balances(p_batch uuid, p_opening numeric, p_closing numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_status public.import_batch_status_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, b.status into v_org, v_status
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');
  if v_status not in ('mapping', 'validating', 'awaiting_review') then
    raise exception 'CONFLICT: this batch is not open for review' using errcode = '40001';
  end if;

  update public.import_batches
     set statement_opening_balance = p_opening, statement_closing_balance = p_closing,
         reviewed_by = app.uid()
   where organization_id = v_org and id = p_batch;

  perform app.audit(v_org, 'import.mapped', 'import_batches', p_batch, null,
                    jsonb_build_object('opening', p_opening, 'closing', p_closing,
                                       'reviewer_entered', true), '{}'::jsonb);
  return p_batch;
end $$;

create function api.decide_import_rows(p_batch uuid, p_decisions jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_status public.import_batch_status_enum; d jsonb; v_count integer := 0;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, b.status into v_org, v_status
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');
  if v_status <> 'awaiting_review' then
    raise exception 'CONFLICT: this batch is not awaiting review' using errcode = '40001';
  end if;

  for d in select * from jsonb_array_elements(p_decisions) loop
    -- A reason is mandatory when the reviewer overrides what validation concluded: keeping a row
    -- flagged as a duplicate, or skipping a row that validated cleanly. Those two decisions are the
    -- ones a later reader will need explained.
    if (d ->> 'decision') = 'keep' and (d ->> 'reason') is null
       and exists (select 1 from public.import_rows r
                    where r.organization_id = v_org and r.batch_id = p_batch
                      and r.id = (d ->> 'row_id')::uuid and r.status = 'duplicate') then
      raise exception 'VALIDATION: keeping a duplicate needs a reason' using errcode = '22023';
    end if;
    if (d ->> 'decision') = 'skip' and (d ->> 'reason') is null
       and exists (select 1 from public.import_rows r
                    where r.organization_id = v_org and r.batch_id = p_batch
                      and r.id = (d ->> 'row_id')::uuid and r.status = 'valid') then
      raise exception 'VALIDATION: skipping a valid row needs a reason' using errcode = '22023';
    end if;

    update public.import_rows
       set reviewer_decision = (d ->> 'decision')::public.reviewer_decision_enum,
           reviewer_reason = d ->> 'reason'
     where organization_id = v_org and batch_id = p_batch and id = (d ->> 'row_id')::uuid;
    v_count := v_count + 1;
  end loop;

  perform app.audit(v_org, 'import.row_decided', 'import_batches', p_batch, null,
                    jsonb_build_object('rows', v_count), '{}'::jsonb);
  return v_count;
end $$;

create function api.reject_import_batch(p_batch uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_status public.import_batch_status_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, b.status into v_org, v_status
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');
  -- Pre-commit only: once records exist, undoing is a rollback, which is a different operation.
  if v_status = 'committed' then
    raise exception 'CONFLICT: a committed batch is rolled back, not rejected' using errcode = '40001';
  end if;

  update public.import_batches set status = 'rejected', rolled_back_reason = p_reason
   where organization_id = v_org and id = p_batch;
  update public.import_rows set status = 'rejected'
   where organization_id = v_org and batch_id = p_batch and status <> 'committed';

  perform app.audit(v_org, 'import.rejected', 'import_batches', p_batch, null,
                    jsonb_build_object('reason', p_reason), '{}'::jsonb);
  return p_batch;
end $$;

create function api.save_import_mapping(p_batch uuid, p_mapping jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_type public.import_type_enum; v_target public.import_target_enum; v_mapping uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select b.organization_id, b.import_type, b.target_table into v_org, v_type, v_target
    from public.import_batches b where b.id = p_batch;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.review');

  -- ADR-027.1 / IMP-TB-012: a balance target is meaningless without knowing whether the figures are
  -- cumulative or per-period, so the reviewer must state it before the batch can go further.
  if v_target = 'period_balances' and (p_mapping ->> 'balance_basis') is null then
    raise exception 'VALIDATION: a balance import needs its basis confirmed (cumulative or movement)'
      using errcode = '22023';
  end if;

  insert into public.import_mappings
         (organization_id, name, import_type, header_signature, column_map, transforms,
          account_map, created_by, last_used_at)
  values (v_org, coalesce(p_mapping ->> 'name', 'Saved mapping'), v_type,
          p_mapping ->> 'header_signature',
          coalesce(p_mapping -> 'column_map', '{}'::jsonb),
          coalesce(p_mapping -> 'transforms', '{}'::jsonb),
          coalesce(p_mapping -> 'account_map', '{}'::jsonb),
          app.uid(), now())
  on conflict (organization_id, import_type, header_signature) do update
     set column_map = excluded.column_map,
         transforms = excluded.transforms,
         account_map = excluded.account_map,
         last_used_at = now()
  returning id into v_mapping;

  update public.import_batches
     set mapping_id = v_mapping,
         mapping_snapshot = p_mapping,
         balance_basis = coalesce((p_mapping ->> 'balance_basis')::public.balance_basis_enum, balance_basis),
         balance_sign = coalesce((p_mapping ->> 'balance_sign')::public.balance_sign_enum, balance_sign),
         status = case when status = 'created' then 'mapping'::public.import_batch_status_enum
                       else status end,
         reviewed_by = app.uid()
   where organization_id = v_org and id = p_batch;

  perform app.audit(v_org, 'import.mapped', 'import_batches', p_batch, null,
                    jsonb_build_object('mapping', v_mapping), '{}'::jsonb);
  return v_mapping;
end $$;

-- ---------------------------------------------------------------------------
-- Alerts
-- ---------------------------------------------------------------------------

create function api.set_alert_status(p_alert uuid, p_status public.alert_status_enum, p_reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_role text; v_before public.alert_status_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.status into v_org, v_before
    from public.alerts a where a.id = p_alert;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_role := app.require_permission(v_org, 'alerts.manage');

  -- RBAC_MATRIX §2.1: a client's alerts.manage is partial — they may acknowledge that they have seen
  -- something, but resolving or dismissing it is a judgement the organization's staff make.
  if v_role = 'client' and p_status <> 'acknowledged' then
    raise exception 'PERMISSION_DENIED: acknowledging is the only status change available to you'
      using errcode = '42501';
  end if;

  update public.alerts
     set status = p_status,
         status_changed_by = app.uid(),
         status_changed_at = now(),
         status_reason_code = 'user',
         status_reason = p_reason,
         -- ADR-047.2: the dismissal instant starts the 90-day cooldown after which the alert may
         -- re-open by itself.
         dismissed_at = case when p_status = 'dismissed' then now() else dismissed_at end
   where organization_id = v_org and id = p_alert;

  perform app.audit(v_org, 'alert.status_changed', 'alerts', p_alert,
                    jsonb_build_object('status', v_before),
                    jsonb_build_object('status', p_status, 'reason', p_reason), '{}'::jsonb);
  return p_alert;
end $$;

-- ---------------------------------------------------------------------------
-- Actions (SOW §17)
-- ---------------------------------------------------------------------------

create function api.create_action(p_org uuid, p_input jsonb, p_source jsonb default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id       uuid;
  v_owner    uuid := (p_input ->> 'owner_user_id')::uuid;
  v_src_type public.action_source_enum := coalesce((p_source ->> 'type')::public.action_source_enum, 'user');
  v_src_id   uuid := (p_source ->> 'id')::uuid;
  v_grounded public.grounding_status_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'actions.create');

  if coalesce(trim(p_input ->> 'title'), '') = '' then
    raise exception 'VALIDATION: a title is required' using errcode = '22023';
  end if;

  -- ADR-032.5: an action may be created from an AI answer only if that answer passed grounding.
  -- Without this, a failed or degraded answer could be laundered into a task that looks authoritative.
  if v_src_type = 'ai' then
    select m.grounding_status into v_grounded
      from public.ai_messages m where m.organization_id = p_org and m.id = v_src_id;
    if v_grounded is null then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_grounded <> 'passed' then
      raise exception 'VALIDATION: an action cannot be created from an ungrounded answer'
        using errcode = '22023';
    end if;
  end if;

  -- The owner must be someone who can actually see the organization: a member, or an employee
  -- currently assigned to it.
  if v_owner is not null and app.org_role_of(v_owner, p_org) is null then
    raise exception 'VALIDATION: that person has no access to this organization' using errcode = '22023';
  end if;

  insert into public.actions
         (organization_id, title, issue, recommendation, priority, owner_user_id, due_date,
          source_type, source_id, created_by)
  values (p_org, trim(p_input ->> 'title'), p_input ->> 'issue', p_input ->> 'recommendation',
          coalesce((p_input ->> 'priority')::public.action_priority_enum, 'medium'),
          v_owner, (p_input ->> 'due_date')::date, v_src_type, v_src_id, app.uid())
  returning id into v_id;

  perform app.audit(p_org, 'action.created', 'actions', v_id, null,
                    jsonb_build_object('title', trim(p_input ->> 'title'),
                                       'source_type', v_src_type), '{}'::jsonb);
  return v_id;
end $$;

create function api.assign_action(p_action uuid, p_owner uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_before uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.owner_user_id into v_org, v_before
    from public.actions a where a.id = p_action;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.assign');

  if p_owner is not null and app.org_role_of(p_owner, v_org) is null then
    raise exception 'VALIDATION: that person has no access to this organization' using errcode = '22023';
  end if;

  update public.actions set owner_user_id = p_owner
   where organization_id = v_org and id = p_action;

  perform app.audit(v_org, 'action.assigned', 'actions', p_action,
                    jsonb_build_object('owner_user_id', v_before),
                    jsonb_build_object('owner_user_id', p_owner), '{}'::jsonb);
  return p_action;
end $$;

-- A client may move their OWN action along and record the outcome, and nothing else. Ownership is
-- checked here rather than in a policy because it decides which columns may move, not which rows
-- are visible.
create function api.update_own_action(p_action uuid, p_patch jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_owner uuid; v_status public.action_status_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.owner_user_id, a.status into v_org, v_owner, v_status
    from public.actions a where a.id = p_action;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.update_own');
  if v_owner is distinct from app.uid() then
    raise exception 'PERMISSION_DENIED: this action is assigned to somebody else' using errcode = '42501';
  end if;

  v_status := coalesce((p_patch ->> 'status')::public.action_status_enum, v_status);

  update public.actions
     set status = v_status,
         outcome_notes = coalesce(p_patch ->> 'outcome_notes', outcome_notes),
         outcome_value = coalesce((p_patch ->> 'outcome_value')::numeric, outcome_value),
         completed_at = case when v_status = 'completed' then coalesce(completed_at, now()) else null end
   where organization_id = v_org and id = p_action;

  perform app.audit(v_org, 'action.status_changed', 'actions', p_action, null, p_patch, '{}'::jsonb);
  return p_action;
end $$;

create function api.set_action_status(p_action uuid, p_status public.action_status_enum, p_outcome jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_role text; v_owner uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.owner_user_id into v_org, v_owner
    from public.actions a where a.id = p_action;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_role := app.require_permission(v_org, 'actions.update_own');

  -- A client reaches this only for their own rows; staff may move any row in their organization.
  if not app.has_permission(v_org, 'actions.create') and v_owner is distinct from app.uid() then
    raise exception 'PERMISSION_DENIED: this action is assigned to somebody else' using errcode = '42501';
  end if;

  update public.actions
     set status = p_status,
         outcome_notes = coalesce(p_outcome ->> 'outcome_notes', outcome_notes),
         outcome_value = coalesce((p_outcome ->> 'outcome_value')::numeric, outcome_value),
         dismissed_reason = coalesce(p_outcome ->> 'dismissed_reason', dismissed_reason),
         completed_at = case when p_status = 'completed' then coalesce(completed_at, now()) else null end
   where organization_id = v_org and id = p_action;

  perform app.audit(v_org, 'action.status_changed', 'actions', p_action, null,
                    jsonb_build_object('status', p_status), '{}'::jsonb);
  return p_action;
end $$;

-- ---------------------------------------------------------------------------
-- AI storage (schema only; the analyst loop is Phase 11)
-- ---------------------------------------------------------------------------

create function api.create_conversation(p_org uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'ai.use');

  insert into public.ai_conversations (organization_id, user_id)
  values (p_org, app.uid())
  returning id into v_id;
  return v_id;
end $$;

create function api.archive_conversation(p_conversation uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_owner uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select c.organization_id, c.user_id into v_org, v_owner
    from public.ai_conversations c where c.id = p_conversation;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- Your own conversation, or somebody else's if you govern the organization.
  if v_owner is distinct from app.uid() and not app.has_permission(v_org, 'users.manage') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.ai_conversations set status = 'archived'
   where organization_id = v_org and id = p_conversation;
  return p_conversation;
end $$;

create function api.submit_ai_feedback(
  p_message uuid, p_alert uuid, p_type public.ai_feedback_type_enum, p_comment text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  if p_message is not null then
    select m.organization_id into v_org from public.ai_messages m where m.id = p_message;
  elsif p_alert is not null then
    select a.organization_id into v_org from public.alerts a where a.id = p_alert;
  else
    raise exception 'VALIDATION: feedback must name a message or an alert' using errcode = '22023';
  end if;

  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'ai.use');

  insert into public.ai_feedback (organization_id, message_id, alert_id, user_id, feedback_type, comment)
  values (v_org, p_message, p_alert, app.uid(), p_type, p_comment)
  returning id into v_id;

  perform app.audit(v_org, 'ai.feedback_submitted', 'ai_feedback', v_id, null,
                    jsonb_build_object('type', p_type), '{}'::jsonb);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Ownership and grants (ADR-044.3). api_server is service_role only (ADR-043).
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, n.nspname
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'api', 'api_server')
       and pg_catalog.pg_get_userbyid(p.proowner) <> 'motion_definer'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public, authenticated, anon', f.sig);
    if f.nspname = 'api' then
      execute format('grant execute on function %s to authenticated', f.sig);
    elsif f.nspname = 'api_server' then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
