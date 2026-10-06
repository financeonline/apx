-- MOTION — Reading receipts with AI (SOW §8 "Invoices and receipts"; ADR-150).
--
-- 1. Source documents may be JPEG or PNG photos (a receipt). They are validated by magic bytes
--    (≤ 5 MB) before storage, stored and access-controlled like any other document.
-- 2. `api_server.begin_receipt_extraction` turns a Receipts batch that is waiting to be read into an
--    AI-read (`pdf_claude`) one — the same method, so the commit stamps every row `inferred` and the
--    commit gate demands every page confirmed, exactly as for an AI-read statement. It differs from
--    `begin_extraction` only where receipts differ: the file has no text layer (the FILE is sent),
--    and the reviewer names the expense account the receipts post to — the model never chooses one.

update storage.buckets
   set allowed_mime_types = array['text/csv', 'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/pdf', 'application/json', 'text/plain', 'image/jpeg', 'image/png']
 where id = 'source-documents';

create function api_server.begin_receipt_extraction(
  p_actor uuid, p_org uuid, p_batch uuid, p_document uuid, p_pages_total integer, p_account uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_status public.import_batch_status_enum; v_method public.extraction_method_enum;
        v_type public.import_type_enum; v_flag boolean; v_kind text; v_account text;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null or not app.has_permission_of(p_actor, p_org, 'imports.review') then
    raise exception 'PERMISSION_DENIED: imports.review required' using errcode = '42501';
  end if;
  select (o.features ->> 'ai_pdf_extraction')::boolean into v_flag from public.organizations o where o.id = p_org;
  if coalesce(v_flag, false) is not true then
    raise exception 'PERMISSION_DENIED: AI reading of documents is not enabled for this organisation' using errcode = '42501';
  end if;
  if p_pages_total is null or p_pages_total < 1 or p_pages_total > 10 then
    raise exception 'VALIDATION: a receipt file is read whole, up to 10 pages' using errcode = '22023';
  end if;

  select b.status, b.extraction_method, b.import_type into v_status, v_method, v_type
    from public.import_batches b where b.organization_id = p_org and b.id = p_batch and b.source_document_id = p_document;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_type <> 'receipts' or not (v_status = 'failed' and v_method = 'pdf_text') then
    raise exception 'CONFLICT: only a Receipts upload waiting to be read can be read this way' using errcode = '40001';
  end if;
  select d.document_kind::text into v_kind from public.source_documents d
   where d.organization_id = p_org and d.id = p_document and d.deleted_at is null and d.status <> 'quarantined';
  if v_kind is distinct from 'receipt' then
    raise exception 'CONFLICT: this document is not a receipt that can be read' using errcode = '40001';
  end if;
  -- The reviewer's account: this organisation's, active, and an expense (the receipts post there).
  select a.name into v_account from public.accounts a
   where a.organization_id = p_org and a.id = p_account and a.is_active and a.account_type = 'expense';
  if v_account is null then
    raise exception 'VALIDATION: choose one of this organisation''s expense accounts for the receipts' using errcode = '22023';
  end if;

  update public.import_batches
     set extraction_method = 'pdf_claude', status = 'parsing', error_summary = null,
         pages_extracted = 0, pages_failed = array[]::integer[],
         extraction_stats = jsonb_build_object('pages_total', p_pages_total, 'pages_extracted', '[]'::jsonb,
                                               'pages_failed', '[]'::jsonb, 'pages_deferred', '[]'::jsonb,
                                               'attempts', '{}'::jsonb, 'tokens_in', 0, 'tokens_out', 0,
                                               'confidence', '{}'::jsonb, 'line_counts', '{}'::jsonb,
                                               'kind', 'receipts', 'receipt_account_id', p_account),
         updated_at = now()
   where organization_id = p_org and id = p_batch;
  delete from public.import_rows r where r.organization_id = p_org and r.batch_id = p_batch;

  -- F-A-15, CD-35: the FILE is about to be sent to the provider (not only its text), with the
  -- reviewer who consented as the actor.
  insert into public.audit_events (organization_id, actor_user_id, actor_type, action, target_table, target_id, metadata)
  values (p_org, p_actor, 'user', 'document.sent_to_ai', 'source_documents', p_document,
          jsonb_build_object('document_id', p_document, 'pages', p_pages_total, 'batch_id', p_batch,
                             'kind', 'receipts', 'file_sent', true, 'account', p_account));
  return p_batch;
end $$;
alter function api_server.begin_receipt_extraction(uuid, uuid, uuid, uuid, integer, uuid) owner to motion_definer;
revoke all on function api_server.begin_receipt_extraction(uuid, uuid, uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function api_server.begin_receipt_extraction(uuid, uuid, uuid, uuid, integer, uuid) to service_role;
