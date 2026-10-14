-- APX — The Monthly Management Report's summary edition: the full report is detail, `financials.view`
-- (ADR-172 addendum, the owner's decision of 2026-10-14; RBAC_MATRIX.md §8.3).
--
-- The decision. A 3rd party (lender, investor, partner — `dashboard.view` + `reports.view`) gets a SAFE
-- edition of the Monthly Management Report: the headline figures, the Business Health Score and the
-- report's own words — no alerts (their sentences name customers and suppliers), no open action
-- titles, no customer, supplier or bank account names, nothing per counterparty or per account. Until
-- now a 3rd party could download the full stored PDF, which prints all of those (RBAC_MATRIX §8.3,
-- "what to watch"). The rule is drawn on `financials.view`, not on the role: anyone without it — a 3rd
-- party by default, or a client, accountant or admin whose switch is off — gets only the summary
-- edition; whoever holds it gets the full report as before.
--
-- The design (ADR-172 addendum, decision 1). The summary edition is NOT stored. It is rendered on
-- request, at download, by `GET /api/reports/summary/[periodId]`, from the overview alone, read with
-- the READER'S own client — so for a 3rd party RLS withholds the detail at render time too. A stored
-- second PDF would have needed a variant column, a second render in the job, and would exist only
-- for months someone with `reports.generate` re-rendered after this change; and a stored PDF is the
-- one place the database cannot redact (§8.3). What the database CAN do, it does here:
--
--   1. `report_files_select`: the Monthly Management Report's PDF (a file with no report row — the
--      `report_files_subject` CHECK makes `report_id IS NULL` exactly `monthly_management`) is
--      readable only with `financials.view` as well as `reports.view`. A 3rd party's client simply
--      has no such row: the download route resolves nothing (NOT FOUND) and so never reaches the
--      signer. Composed reports' files keep their rule (their report readable, `reports_select`).
--   2. `api_server.record_access_event`, `report.downloaded`:
--        - a stored file (target `report_files`): the same rule, applied to the ACTOR — the monthly
--          file needs `financials.view` — else NOT FOUND. No audit id, so the signer will not sign
--          (ADR-043.5): the full PDF cannot be signed for a reader without `financials.view` even by
--          a route that forgot to ask;
--        - the summary edition (target `fiscal_periods`, a complete month of THIS organisation):
--          `reports.view`, as every report rendered on request (Marketing, Investment);
--        - a target that is neither is refused (VALIDATION), rather than checked against
--          `report_files` whatever table it names, as before;
--        - no target at all (Marketing, Investment): `reports.view`, unchanged.
--
-- The policy is altered in place (`ALTER POLICY`, its name, command and role unchanged) from its LIVE
-- text (pg_policies, 2026-10-14) with only the `financials.view` term added; the function is
-- re-created from its LIVE definition (`pg_get_functiondef`, 2026-10-14) with only the
-- `report.downloaded` branch changed. pgTAP `32_report_variants`.

alter policy report_files_select on public.report_files
  using (
    organization_id in (select app.org_ids_with_permission('reports.view'))
    and deleted_at is null
    and (
      -- The Monthly Management Report's own PDF (no report row): the FULL report — its alerts and
      -- open actions — so detail, `financials.view` (ADR-172 addendum). Without it, the reader gets
      -- the summary edition, rendered on request; there is no stored file for them to read.
      (report_id is null
       and organization_id in (select app.org_ids_with_permission('financials.view')))
      or exists (
        select 1 from public.reports r
         where r.organization_id = report_files.organization_id and r.id = report_files.report_id)
    )
  );

comment on policy report_files_select on public.report_files is
  'ADR-172 addendum (20261018000036): reports.view, not deleted, and either the Monthly Management Report PDF with financials.view as well (the full report is detail; a reader without it gets the summary edition, rendered on request and never stored), or a composed report''s PDF whose report is readable (reports_select).';

CREATE OR REPLACE FUNCTION api_server.record_access_event(p_actor uuid, p_org uuid, p_action access_event_enum, p_target_table text DEFAULT NULL::text, p_target_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb, p_request_id text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      if p_target_id is null then
        -- A report rendered on request with no month to name (Marketing, Investment): reports.view.
        null;
      elsif p_target_table = 'fiscal_periods' then
        -- The Monthly Management Report's SUMMARY EDITION (ADR-172 addendum, 20261018000036):
        -- rendered on request from the overview, never stored, so there is no file to name — the
        -- event names the month. reports.view, and a COMPLETE month of this organisation (a report
        -- exists only for a month that has finished, ADR-030.4); anything else does not exist.
        if not exists (
          select 1 from public.fiscal_periods fp
           where fp.organization_id = p_org and fp.id = p_target_id and fp.is_complete
        ) then
          raise exception 'NOT_FOUND' using errcode = 'P0002';
        end if;
      elsif p_target_table = 'report_files' then
        -- The file must be one the ACTOR may read: `report_files_select` (not deleted; the Monthly
        -- Management Report's own PDF needs `financials.view` — it is the FULL report, ADR-172
        -- addendum; a composed report's PDF needs its report readable) and `reports_select`'s rule
        -- per kind, word for word — a custom AI report is its author's, Funding Readiness needs
        -- Funding on, and every kind but the Monthly Management Report and Funding Readiness (the
        -- daily, weekly and adviser reports) needs `financials.view` as well (ADR-172 hardening,
        -- 2026-10-14). A report they cannot read does not exist for them.
        if not exists (
          select 1
            from public.report_files f
            left join public.reports r on r.organization_id = f.organization_id and r.id = f.report_id
           where f.organization_id = p_org and f.id = p_target_id
             and f.deleted_at is null
             and ((f.report_id is null and app.has_permission_of(p_actor, p_org, 'financials.view'))
                  or (r.id is not null
                      and (r.report_kind <> 'custom_ai'::public.report_kind_enum or r.requested_by = p_actor)
                      and (r.report_kind <> 'funding_readiness'::public.report_kind_enum or app.funding_enabled(p_org))
                      and (r.report_kind in ('monthly_management'::public.report_kind_enum, 'funding_readiness'::public.report_kind_enum)
                           or app.has_permission_of(p_actor, p_org, 'financials.view'))))
        ) then
          raise exception 'NOT_FOUND' using errcode = 'P0002';
        end if;
      else
        -- Deny by default: a download names a stored file or a month, nothing else.
        raise exception 'VALIDATION: report.downloaded names a report file or a month' using errcode = '22023';
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
end $function$;
