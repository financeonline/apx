-- MOTION — a stored document says whether it has a text layer (IMPORT_ENGINE.md §4, §5.4; ADR-083).
--
-- `source_documents.has_text_layer` and `page_count` existed and were never written: the upload
-- probed the PDF (§4 "text layer probed on first 3 pages → has_text_layer") and then dropped the
-- answer. §5.4's "available only when has_text_layer = true" had nothing to read. The register
-- call now carries both, from the same probe that decided the document's status.

create or replace function api_server.register_document(
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
          document_kind, status, uploaded_by, has_text_layer, page_count)
  values (v_id, p_org, v_path, v_filename,
          coalesce(p_meta ->> 'mime_type', 'application/octet-stream'),
          (p_meta ->> 'byte_size')::bigint, v_sha,
          coalesce((p_meta ->> 'document_kind')::public.document_kind_enum, 'unknown'),
          'uploaded', p_actor,
          (p_meta ->> 'has_text_layer')::boolean,
          (p_meta ->> 'page_count')::integer);

  perform app.audit(p_org, 'document.uploaded', 'source_documents', v_id, null,
                    jsonb_build_object('filename', v_safe, 'kind', p_meta ->> 'document_kind'),
                    '{}'::jsonb, p_actor, p_request_id);
  return v_id;
end $$;
