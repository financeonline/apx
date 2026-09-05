-- MOTION — Phase 2 (plan Phase 4) · Storage buckets.
-- Contract: TENANCY_MODEL.md §8; SECURITY_MODEL.md §5b; ADR-038.1 (F-A-04), ADR-043.4/5.
--
-- Two private buckets, and DELIBERATELY NO `storage.objects` policies for `authenticated` or `anon`.
-- That absence is the security control, not an omission: with no policy, a user JWT can neither list
-- nor fetch an object through the Storage REST API, however the object key is guessed. The only
-- reader and writer is `src/core/storage/signer.ts`, which holds a storage-scoped service client,
-- asserts that every key begins with the caller's own organization id, verifies the id of an audit
-- event written in the same request, and mints 60-second signed URLs.
--
-- Object paths:
--   source-documents/{organization_id}/{document_id}/{original-filename}
--   source-documents/{organization_id}/{document_id}/text.json
--   reports/{organization_id}/{period}/{job_id}.pdf

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('source-documents', 'source-documents', false, 52428800,
   array['text/csv', 'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/pdf', 'application/json', 'text/plain']),
  ('reports', 'reports', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Belt and braces: if a policy for a user role is ever added to these buckets by accident — a
-- migration copied from another project, a dashboard click — this removes it. Storage's own default
-- is deny, so having none is the correct end state.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (policyname ilike '%source-documents%' or policyname ilike '%reports%')
  loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;
