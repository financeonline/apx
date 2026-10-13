-- APX — Marketing: the company profile and the marketing strategy report (ADR-170).
--
-- Opening Marketing shows a ready-made report shaped on the client's own example document. The model
-- writes Sections 01 and 02 and the commentary of Section 03 from the company profile and the
-- figures; Section 03's tables are the product's own figures. The report is written by a background
-- job, stored, and shown until somebody refreshes it.
--
--   1. `organization_profiles` — one row per organisation: website, social links, products and
--      services, and a description. The profile's INDUSTRY is `organizations.industry`, which already
--      existed (set at creation, shown to the platform): one industry per company, never two that can
--      disagree. Readable by the five roles; written only by `api.set_company_profile`, which needs
--      `customers.edit` — the permission that already records the company's commercial and marketing
--      facts (products, channels, campaigns; ADR-102) and that, unlike `settings.manage`, the
--      organisation's assigned APX adviser holds. A client does not hold it.
--   2. `marketing_reports` — one row per attempt, kept as history: queued → running → ready | failed.
--      The page reads the newest READY report and the newest attempt's status, so a refresh in
--      progress, or one that failed, never hides the report already there. At most one attempt per
--      organisation is in flight (a partial unique index), and a finished row never changes.
--   3. `api.request_marketing_report` — who may spend AI on it: `reports.generate` (it produces a stored
--      report, as the adviser and Funding Readiness reports do) AND `ai.use` (it is an AI call). Refused
--      while Marketing is switched off (NOT FOUND), until the profile says what the company sells or
--      its industry (VALIDATION), and once this month's AI allowance is used up (QUOTA); limited to
--      three per organisation per hour. A request while one is queued or running returns that one.
--      It queues `marketing.generate` with ONE attempt: every attempt is a paid model call, so a
--      failure is shown to the person, who decides whether to try again — the queue never retries it.
--   4. `api_server.start_marketing_report` / `finish_marketing_report` / `fail_marketing_report` — the
--      job's writes, service role and scoped. The tokens each attempt spent are recorded on its row and
--      count under the organisation's monthly AI ceiling with the analyst's and the PDF reader's
--      (`app.ai_tokens_used_this_month`, re-created below). The requester is told in the inbox when the
--      report is ready.
--   5. A report never outlives its job: when a `marketing.generate` job ends (a lost worker reclaimed
--      as dead, a cancellation, or a handler that returned without finishing) an attempt still queued
--      or running is marked failed, so the page cannot wait for ever.
--   6. Marketing is a system the super admin switches (`module_marketing`, on unless switched off):
--      `api.set_org_module` is re-created with the key; the reports' RLS includes the switch, so an
--      organisation with Marketing off reads none of them (as Funding Readiness, U-5).
--   7. The purge's deletion order names both tables.
--
-- The new job type is used in this file only inside plpgsql bodies and as text, because a value added
-- by `alter type … add value` cannot be used as an enum in the transaction that adds it.

alter type public.job_type_enum add value if not exists 'marketing.generate';

-- ---------------------------------------------------------------------------------------------
-- The job's time budget. A report is one long model call; the worker is reclaimed after 3× this.
-- Re-created from the live definition; the new type is compared as text (see the header).
-- ---------------------------------------------------------------------------------------------
create or replace function app.job_max_runtime(p_type public.job_type_enum)
returns interval language sql immutable set search_path = '' as $$
  select case p_type::text
    when 'calculation.run'     then interval '5 minutes'
    when 'import.commit_large' then interval '5 minutes'
    when 'document.extract'    then interval '10 minutes'
    when 'org.purge'           then interval '30 minutes'
    when 'marketing.generate'  then interval '5 minutes'
    else interval '2 minutes'
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Whether Marketing is on for an organisation (ADR-158): exactly `enabledModules` in
-- src/modules/tenancy/domain/modules.ts — an absent key is ON (a default-on system); a stored `true`
-- is on; anything else stored is off.
-- ---------------------------------------------------------------------------------------------
create function app.marketing_enabled(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select not (o.features ? 'module_marketing') or (o.features -> 'module_marketing') = 'true'::jsonb
                     from public.organizations o where o.id = p_org), false);
$$;
alter function app.marketing_enabled(uuid) owner to motion_definer;
revoke all on function app.marketing_enabled(uuid) from public, anon;
grant execute on function app.marketing_enabled(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. The company profile
-- ---------------------------------------------------------------------------------------------
create table public.organization_profiles (
  organization_id   uuid primary key references public.organizations (id) on delete cascade,
  website           text constraint organization_profiles_website check (
                      website is null or (length(website) <= 500 and website ~* '^https?://[^\s/?#]+[^\s]*$')),
  social_links      jsonb not null default '[]'::jsonb constraint organization_profiles_social_links check (
                      jsonb_typeof(social_links) = 'array' and jsonb_array_length(social_links) <= 12),
  products_services text constraint organization_profiles_products check (
                      products_services is null or length(products_services) between 1 and 2000),
  description       text constraint organization_profiles_description check (
                      description is null or length(description) between 1 and 4000),
  updated_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.organization_profiles is
  'ADR-170: the company profile the analyst fills in once (Marketing reads it). Its industry is organizations.industry.';
comment on column public.organization_profiles.social_links is
  'Ordered [{label, url}] as the analyst entered them; each url http(s), at most 12 (api.set_company_profile validates each).';

alter table public.organization_profiles owner to motion_definer;
alter table public.organization_profiles enable row level security;
alter table public.organization_profiles force row level security;
revoke insert, update, delete, truncate on public.organization_profiles from authenticated, anon;
revoke select on public.organization_profiles from anon;
grant select on public.organization_profiles to authenticated;
grant all on public.organization_profiles to service_role;
create policy definer_all on public.organization_profiles for all to motion_definer using (true) with check (true);
create policy organization_profiles_select on public.organization_profiles for select to authenticated
  using (organization_id in (select app.org_ids_with_role(variadic array['owner', 'admin', 'employee', 'super_admin', 'client'])));
create trigger set_updated_at before update on public.organization_profiles
  for each row execute function app.set_updated_at();

/* A profile is ready for a report when it says what the company sells, or its industry —
 * `profileIsReady` in src/modules/marketing/domain/types.ts. */
create function app.company_profile_ready(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.organization_profiles p
                  where p.organization_id = p_org and length(btrim(coalesce(p.products_services, ''))) > 0)
      or exists (select 1 from public.organizations o
                  where o.id = p_org and length(btrim(coalesce(o.industry, ''))) > 0);
$$;
alter function app.company_profile_ready(uuid) owner to motion_definer;
revoke all on function app.company_profile_ready(uuid) from public, anon, authenticated;

/*
 * The whole profile, replaced: the form sends every field. Blank means "not given" (NULL). The
 * website and each social link must be an http(s) address — the TypeScript service adds `https://`
 * to a bare domain before it gets here; this is the check that holds for a direct RPC caller too.
 */
create function api.set_company_profile(
  p_org uuid, p_website text, p_social_links jsonb, p_products_services text, p_industry text, p_description text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_website     text := nullif(btrim(coalesce(p_website, '')), '');
  v_products    text := nullif(btrim(coalesce(p_products_services, '')), '');
  v_industry    text := nullif(btrim(coalesce(p_industry, '')), '');
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_links       jsonb := '[]'::jsonb;
  v_link        jsonb;
  v_label       text;
  v_url         text;
  v_before      jsonb;
  v_after       jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'customers.edit');

  if v_website is not null and (length(v_website) > 500 or v_website !~* '^https?://[^\s/?#]+[^\s]*$') then
    raise exception 'VALIDATION: the website must be a web address starting http:// or https://' using errcode = '22023';
  end if;
  if v_products is not null and length(v_products) > 2000 then
    raise exception 'VALIDATION: products and services must be 2,000 characters or fewer' using errcode = '22023';
  end if;
  if v_industry is not null and length(v_industry) > 120 then
    raise exception 'VALIDATION: the industry must be 120 characters or fewer' using errcode = '22023';
  end if;
  if v_description is not null and length(v_description) > 4000 then
    raise exception 'VALIDATION: the description must be 4,000 characters or fewer' using errcode = '22023';
  end if;

  if p_social_links is not null and jsonb_typeof(p_social_links) <> 'null' then
    if jsonb_typeof(p_social_links) <> 'array' then
      raise exception 'VALIDATION: social links must be a list' using errcode = '22023';
    end if;
    if jsonb_array_length(p_social_links) > 12 then
      raise exception 'VALIDATION: add at most 12 social links' using errcode = '22023';
    end if;
    for v_link in select * from jsonb_array_elements(p_social_links) loop
      if jsonb_typeof(v_link) <> 'object' then
        raise exception 'VALIDATION: each social link needs a name and an address' using errcode = '22023';
      end if;
      v_label := nullif(btrim(coalesce(v_link ->> 'label', '')), '');
      v_url := nullif(btrim(coalesce(v_link ->> 'url', '')), '');
      if v_label is null or length(v_label) > 60 then
        raise exception 'VALIDATION: each social link needs a name of 60 characters or fewer' using errcode = '22023';
      end if;
      if v_url is null or length(v_url) > 500 or v_url !~* '^https?://[^\s/?#]+[^\s]*$' then
        raise exception 'VALIDATION: the % link must be a web address starting http:// or https://', v_label using errcode = '22023';
      end if;
      v_links := v_links || jsonb_build_array(jsonb_build_object('label', v_label, 'url', v_url));
    end loop;
  end if;

  select jsonb_build_object('website', p.website, 'social_links', p.social_links, 'products_services', p.products_services,
                            'description', p.description, 'industry', o.industry)
    into v_before
    from public.organizations o
    left join public.organization_profiles p on p.organization_id = o.id
   where o.id = p_org;

  insert into public.organization_profiles (organization_id, website, social_links, products_services, description, updated_by)
  values (p_org, v_website, v_links, v_products, v_description, app.uid())
  on conflict (organization_id) do update
     set website = excluded.website, social_links = excluded.social_links,
         products_services = excluded.products_services, description = excluded.description,
         updated_by = excluded.updated_by;

  update public.organizations o set industry = v_industry
   where o.id = p_org and o.industry is distinct from v_industry;

  v_after := jsonb_build_object('website', v_website, 'social_links', v_links, 'products_services', v_products,
                                'description', v_description, 'industry', v_industry);
  if v_before is distinct from v_after then
    perform app.audit(p_org, 'company_profile.updated', 'organization_profiles', p_org, v_before, v_after, '{}'::jsonb);
  end if;
  return p_org;
end $$;
alter function api.set_company_profile(uuid, text, jsonb, text, text, text) owner to motion_definer;
revoke all on function api.set_company_profile(uuid, text, jsonb, text, text, text) from public, anon;
grant execute on function api.set_company_profile(uuid, text, jsonb, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. The reports
-- ---------------------------------------------------------------------------------------------
create table public.marketing_reports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  status          text not null default 'queued'
                  constraint marketing_reports_status check (status in ('queued', 'running', 'ready', 'failed')),
  -- The MarketingReport (src/modules/marketing/domain/types.ts), exactly as the page renders it.
  report          jsonb,
  report_version  text,
  -- What the person is shown when the attempt failed. Never a provider's own error text.
  failure         text constraint marketing_reports_failure check (failure is null or length(failure) between 1 and 500),
  requested_by    uuid references public.profiles (id) on delete set null,
  job_id          uuid,
  model           text constraint marketing_reports_model check (model is null or length(model) between 1 and 200),
  prompt_version  text constraint marketing_reports_prompt check (prompt_version is null or length(prompt_version) between 1 and 200),
  input_tokens    integer not null default 0 constraint marketing_reports_input_tokens check (input_tokens >= 0),
  output_tokens   integer not null default 0 constraint marketing_reports_output_tokens check (output_tokens >= 0),
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  updated_at      timestamptz not null default now(),
  constraint marketing_reports_ready_has_report check ((status = 'ready') = (report is not null)),
  constraint marketing_reports_version_with_report check ((report is null) = (report_version is null)),
  constraint marketing_reports_failed_has_reason check ((status = 'failed') = (failure is not null)),
  constraint marketing_reports_finished check ((status in ('ready', 'failed')) = (finished_at is not null)),
  constraint marketing_reports_org_id_unique unique (organization_id, id),
  -- Carries organization_id (ADR-044.8), as every job reference does; a job row removed clears only
  -- the link, never the organisation.
  constraint marketing_reports_job_fk foreign key (organization_id, job_id)
    references public.jobs (organization_id, id) on delete set null (job_id)
);
comment on table public.marketing_reports is
  'ADR-170: every attempt at the marketing report, kept as history. The page shows the newest ready report and the newest attempt''s status.';

-- One attempt in flight per organisation: the invariant api.request_marketing_report relies on.
create unique index marketing_reports_one_in_flight on public.marketing_reports (organization_id)
  where status in ('queued', 'running');
create index marketing_reports_latest on public.marketing_reports (organization_id, created_at desc);
create index marketing_reports_latest_ready on public.marketing_reports (organization_id, finished_at desc)
  where status = 'ready';
create index marketing_reports_by_job on public.marketing_reports (job_id) where job_id is not null;

alter table public.marketing_reports owner to motion_definer;
alter table public.marketing_reports enable row level security;
alter table public.marketing_reports force row level security;
revoke insert, update, delete, truncate on public.marketing_reports from authenticated, anon;
revoke select on public.marketing_reports from anon;
grant select on public.marketing_reports to authenticated;
grant all on public.marketing_reports to service_role;
create policy definer_all on public.marketing_reports for all to motion_definer using (true) with check (true);
-- `reports.view` (the five roles), and only while Marketing is on for the organisation.
create policy marketing_reports_select on public.marketing_reports for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('reports.view'))
         and app.marketing_enabled(organization_id));
create trigger set_updated_at before update on public.marketing_reports
  for each row execute function app.set_updated_at();

/*
 * History is kept: an attempt moves forward (queued → running → ready | failed) and a finished one
 * never changes. Rows go only with their organisation — the purge, or the organisation's own delete
 * cascading — exactly as `app.append_only_guard_cascadable` allows.
 *
 * The one change a finished row admits is a link being CLEARED by its foreign key's ON DELETE SET
 * NULL (the person who asked loses their account; a job row is removed): refusing that would make
 * deleting a user or a job fail because a report once named them.
 */
create function app.marketing_report_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_links constant text[] := array['requested_by', 'job_id', 'updated_at'];
begin
  if coalesce(current_setting('app.purge', true), 'off') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
      return old;
    end if;
    raise exception 'IMMUTABLE: marketing reports are kept as history' using errcode = '23514';
  end if;
  -- Who asked, and when, never change; a link is only ever cleared — or, once, the job attached.
  if new.organization_id is distinct from old.organization_id or new.created_at is distinct from old.created_at
     or (new.requested_by is distinct from old.requested_by and new.requested_by is not null)
     or (new.job_id is distinct from old.job_id and new.job_id is not null and old.job_id is not null) then
    raise exception 'IMMUTABLE: who asked for a marketing report, and when, is not changed' using errcode = '23514';
  end if;
  if old.status in ('ready', 'failed') and (to_jsonb(new) - v_links) is distinct from (to_jsonb(old) - v_links) then
    raise exception 'IMMUTABLE: a finished marketing report is not changed' using errcode = '23514';
  end if;
  return new;
end $$;
alter function app.marketing_report_guard() owner to motion_definer;
revoke all on function app.marketing_report_guard() from public, anon, authenticated;
create trigger marketing_report_guard before update or delete on public.marketing_reports
  for each row execute function app.marketing_report_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. Asking for a report
-- ---------------------------------------------------------------------------------------------
create function api.request_marketing_report(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id      uuid;
  v_job     uuid;
  v_ceiling bigint;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'reports.generate');
  perform app.require_permission(p_org, 'ai.use');
  -- A switched-off system is absent, not refused (ADR-158).
  if not app.marketing_enabled(p_org) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext('marketing:' || p_org::text));

  -- An attempt whose job has ended cannot hold the slot (the trigger below normally sees to this;
  -- this covers a job row that is gone).
  update public.marketing_reports r
     set status = 'failed', failure = 'The report could not be finished. Refresh it to try again.', finished_at = now()
   where r.organization_id = p_org and r.status in ('queued', 'running')
     and not exists (select 1 from public.jobs j
                      where j.id = r.job_id and j.status in ('queued', 'running', 'deferred_upstream'));

  -- One at a time: a second press returns the attempt already under way, and spends nothing.
  select r.id into v_id from public.marketing_reports r
   where r.organization_id = p_org and r.status in ('queued', 'running');
  if v_id is not null then
    return jsonb_build_object('report_id', v_id, 'created', false);
  end if;

  if not app.company_profile_ready(p_org) then
    raise exception 'VALIDATION: add what the company sells, or its industry, to the company profile first'
      using errcode = '22023';
  end if;

  -- The same monthly ceiling the analyst and the PDF reader are held to (CD-24).
  v_ceiling := app.effective_quota(p_org, 'ai_token_ceiling_monthly');
  if v_ceiling is not null and app.ai_tokens_used_this_month(p_org) >= v_ceiling then
    raise exception 'QUOTA: this company''s AI allowance for the month has been used' using errcode = '53400';
  end if;

  -- Three reports an hour per organisation. Counted here, after every refusal above, so a refused
  -- or repeated press costs nothing.
  perform app.throttle(p_org, 'marketing_report', 3, interval '1 hour');

  insert into public.marketing_reports (organization_id, status, requested_by)
  values (p_org, 'queued', app.uid())
  returning id into v_id;

  -- One attempt: each is a paid model call, and a failure is the person's to retry, not the queue's.
  insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key, max_attempts)
  values (p_org, 'marketing.generate', jsonb_build_object('reportId', v_id), app.uid(),
          'marketing.generate:' || v_id::text, 1)
  returning id into v_job;

  update public.marketing_reports set job_id = v_job where id = v_id;

  perform app.audit(p_org, 'marketing.report_requested', 'marketing_reports', v_id, null,
                    jsonb_build_object('job_id', v_job), '{}'::jsonb);
  perform app.audit(p_org, 'job.enqueued', 'jobs', v_job, null,
                    jsonb_build_object('job_type', 'marketing.generate'), '{}'::jsonb);
  return jsonb_build_object('report_id', v_id, 'created', true);
end $$;
alter function api.request_marketing_report(uuid) owner to motion_definer;
revoke all on function api.request_marketing_report(uuid) from public, anon;
grant execute on function api.request_marketing_report(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. The job's writes (service role, scoped to the job's organisation; ADR-043, ADR-090)
-- ---------------------------------------------------------------------------------------------

/* Marks the attempt running. Returns NULL when there is nothing to do: the attempt already finished,
 * or Marketing was switched off after it was asked for (then it is failed, saying so). */
create function api_server.start_marketing_report(p_org uuid, p_report uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  perform app.require_scope(p_org);

  select r.status into v_status from public.marketing_reports r
   where r.organization_id = p_org and r.id = p_report
   for update;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status not in ('queued', 'running') then
    return null;
  end if;
  if not app.marketing_enabled(p_org) then
    update public.marketing_reports
       set status = 'failed', failure = 'Marketing is switched off for this company.', finished_at = now()
     where organization_id = p_org and id = p_report;
    return null;
  end if;

  update public.marketing_reports set status = 'running', started_at = now()
   where organization_id = p_org and id = p_report;
  return p_report;
end $$;
alter function api_server.start_marketing_report(uuid, uuid) owner to motion_definer;
revoke all on function api_server.start_marketing_report(uuid, uuid) from public, anon, authenticated;
grant execute on function api_server.start_marketing_report(uuid, uuid) to service_role;

/* Stores the finished report and tells the person who asked for it. */
create function api_server.finish_marketing_report(
  p_org uuid, p_report uuid, p_content jsonb, p_model text, p_prompt_version text,
  p_input_tokens integer, p_output_tokens integer
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_requested_by uuid; v_slug text;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  perform app.require_scope(p_org);

  if p_content is null or jsonb_typeof(p_content) <> 'object' or p_content ->> 'version' is distinct from 'marketing-v1' then
    raise exception 'VALIDATION: a marketing report is a marketing-v1 document' using errcode = '22023';
  end if;
  if length(p_content::text) > 1000000 then
    raise exception 'VALIDATION: the marketing report is too large to store' using errcode = '22023';
  end if;
  if coalesce(length(btrim(p_model)), 0) = 0 or coalesce(length(btrim(p_prompt_version)), 0) = 0 then
    raise exception 'VALIDATION: a finished report names its model and prompt version' using errcode = '22023';
  end if;
  if coalesce(p_input_tokens, -1) < 0 or coalesce(p_output_tokens, -1) < 0 then
    raise exception 'VALIDATION: token counts are whole numbers from zero' using errcode = '22023';
  end if;

  update public.marketing_reports
     set status = 'ready', report = p_content, report_version = p_content ->> 'version', failure = null,
         model = btrim(p_model), prompt_version = btrim(p_prompt_version),
         input_tokens = p_input_tokens, output_tokens = p_output_tokens, finished_at = now()
   where organization_id = p_org and id = p_report and status = 'running'
  returning requested_by into v_requested_by;
  if not found then
    raise exception 'CONFLICT: that marketing report is not being written' using errcode = '23514';
  end if;

  perform app.audit(p_org, 'marketing.report_ready', 'marketing_reports', p_report, null,
                    jsonb_build_object('model', btrim(p_model), 'prompt_version', btrim(p_prompt_version)),
                    jsonb_build_object('input_tokens', p_input_tokens, 'output_tokens', p_output_tokens));

  select o.slug::text into v_slug from public.organizations o where o.id = p_org;
  perform app.notify(p_org, v_requested_by, null, 'reports.view', 'report_ready',
                     'Your marketing report is ready', null, '/app/' || v_slug || '/marketing');
  return p_report;
end $$;
alter function api_server.finish_marketing_report(uuid, uuid, jsonb, text, text, integer, integer) owner to motion_definer;
revoke all on function api_server.finish_marketing_report(uuid, uuid, jsonb, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_server.finish_marketing_report(uuid, uuid, jsonb, text, text, integer, integer) to service_role;

/* Records a failed attempt with the sentence the person is shown, and what it cost. Idempotent: an
 * attempt that has already finished is left as it is, and NULL is returned. */
create function api_server.fail_marketing_report(
  p_org uuid, p_report uuid, p_failure text, p_model text default null, p_prompt_version text default null,
  p_input_tokens integer default 0, p_output_tokens integer default 0
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_failure text := left(nullif(btrim(coalesce(p_failure, '')), ''), 500);
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  perform app.require_scope(p_org);

  if v_failure is null then
    raise exception 'VALIDATION: a failed report says why' using errcode = '22023';
  end if;
  if coalesce(p_input_tokens, -1) < 0 or coalesce(p_output_tokens, -1) < 0 then
    raise exception 'VALIDATION: token counts are whole numbers from zero' using errcode = '22023';
  end if;
  if not exists (select 1 from public.marketing_reports r where r.organization_id = p_org and r.id = p_report) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.marketing_reports
     set status = 'failed', failure = v_failure,
         model = nullif(btrim(coalesce(p_model, '')), ''), prompt_version = nullif(btrim(coalesce(p_prompt_version, '')), ''),
         input_tokens = p_input_tokens, output_tokens = p_output_tokens, finished_at = now()
   where organization_id = p_org and id = p_report and status in ('queued', 'running');
  if not found then
    return null;
  end if;

  perform app.audit(p_org, 'marketing.report_failed', 'marketing_reports', p_report, null,
                    jsonb_build_object('failure', v_failure),
                    jsonb_build_object('input_tokens', p_input_tokens, 'output_tokens', p_output_tokens));
  return p_report;
end $$;
alter function api_server.fail_marketing_report(uuid, uuid, text, text, text, integer, integer) owner to motion_definer;
revoke all on function api_server.fail_marketing_report(uuid, uuid, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_server.fail_marketing_report(uuid, uuid, text, text, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. A report never outlives its job
-- ---------------------------------------------------------------------------------------------
create function app.marketing_job_ended() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.marketing_reports r
     set status = 'failed', failure = 'The report could not be finished. Refresh it to try again.', finished_at = now()
   where r.organization_id = new.organization_id and r.job_id = new.id and r.status in ('queued', 'running');
  return null;
end $$;
alter function app.marketing_job_ended() owner to motion_definer;
revoke all on function app.marketing_job_ended() from public, anon, authenticated;
create trigger marketing_job_ended after update of status on public.jobs
  for each row
  when (new.job_type::text = 'marketing.generate'
        and new.status in ('succeeded', 'dead', 'cancelled')
        and old.status is distinct from new.status)
  execute function app.marketing_job_ended();

-- ---------------------------------------------------------------------------------------------
-- The monthly AI ceiling counts the marketing report's tokens too (CD-24). Re-created from the live
-- definition with the third term added.
-- ---------------------------------------------------------------------------------------------
create or replace function app.ai_tokens_used_this_month(p_org uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0))
                     from public.ai_messages m
                    where m.organization_id = p_org
                      and m.created_at >= date_trunc('month', now() at time zone 'utc')), 0)
       + coalesce((select sum(coalesce((b.extraction_stats ->> 'tokens_in')::bigint, 0)
                            + coalesce((b.extraction_stats ->> 'tokens_out')::bigint, 0))
                     from public.import_batches b
                    where b.organization_id = p_org
                      and b.updated_at >= date_trunc('month', now() at time zone 'utc')), 0)
       -- ADR-170: every attempt at the marketing report, ready or failed, in the month it finished.
       + coalesce((select sum(r.input_tokens::bigint + r.output_tokens::bigint)
                     from public.marketing_reports r
                    where r.organization_id = p_org
                      and r.finished_at >= date_trunc('month', now() at time zone 'utc')), 0);
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. The super admin's switch: re-created exactly as it stands, with `module_marketing` added.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api.set_org_module(p_org uuid, p_feature_key text, p_on boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  if p_feature_key is null or p_feature_key not in (
       'module_banking', 'module_customers', 'module_actions', 'module_reports', 'module_analyst',
       'module_planning', 'module_tax', 'funding_readiness', 'ai_pdf_extraction', 'module_marketing') then
    raise exception 'VALIDATION: that is not a system APX can switch' using errcode = '22023';
  end if;
  if p_on is null then
    raise exception 'VALIDATION: on or off is required' using errcode = '22023';
  end if;

  select o.features into v_before from public.organizations o where o.id = p_org for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.organizations o
     set features = o.features || jsonb_build_object(p_feature_key, p_on)
   where o.id = p_org
  returning o.features into v_after;

  if v_before -> p_feature_key is distinct from v_after -> p_feature_key then
    perform app.audit(p_org, 'platform.org_module_changed', 'organizations', p_org,
                      jsonb_build_object(p_feature_key, v_before -> p_feature_key),
                      jsonb_build_object(p_feature_key, p_on), '{}'::jsonb);
  end if;
  return v_after;
end $function$
;

-- ---------------------------------------------------------------------------------------------
-- 7. The purge: re-created exactly as it stands, with the two Marketing tables in the order. Neither
--    has a child; `marketing_reports.job_id` points at jobs, which go after the loop.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_server.purge_organization(p_org uuid, p_job uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status    public.org_status_enum;
  v_requested timestamptz;
  v_running   integer;
  v_table     text;
  v_n         integer;
  v_counts    jsonb := '{}'::jsonb;
  v_redacted  integer;
  v_left      integer;
  v_offender  text;
  -- Children before parents, from the FK graph (NO ACTION constraints make the order matter).
  v_order     text[] := array[
    -- Tables added after this list was last written (Phases 11, 12, 14 and Step 0F). The guard
    -- below refused every purge of an organisation holding a row in any of them.
    'scenario_values', 'scenario_runs', 'forecast_values', 'forecast_runs',
    'invoice_lines', 'opportunities', 'campaign_spend', 'campaigns', 'marketing_channels', 'products',
    'report_completeness_attestations',
    -- Funding Readiness (ADR-145): the pointer before the assessments it points at.
    'funding_current', 'funding_assessments',
    -- Marketing (ADR-170): the reports and the company profile.
    'marketing_reports', 'organization_profiles',
    -- Team/Client engagement (ADR-144).
    'notifications', 'engagement_events', 'engagement_items', 'action_comments',
    'evidence_items', 'ai_feedback', 'ai_tool_calls', 'ai_messages', 'ai_conversations',
    'alert_revisions', 'alerts', 'actions', 'report_files', 'reports', 'evidence_bundles',
    'health_current', 'health_scores', 'metric_current', 'metric_snapshots',
    'category_history', 'account_category_history', 'record_status_events',
    'budget_lines', 'bank_transactions', 'recurring_payment_groups', 'ledger_entries', 'invoices',
    'period_balances', 'import_rows', 'calculation_runs', 'import_batches', 'import_mappings',
    'source_documents', 'counterparties', 'bank_accounts', 'accounts', 'fiscal_periods',
    'ownership_transfers', 'invitations', 'organization_assignments', 'organization_memberships',
    'platform_org_settings'
  ];
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));

  select o.status, o.deletion_requested_at into v_status, v_requested
    from public.organizations o where o.id = p_org;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotent: a retry after the rows went (the handler died before the objects did) has nothing
  -- to re-verify and nothing to delete here.
  if v_status = 'deleted' then
    return jsonb_build_object('status', 'already_deleted');
  end if;

  -- The two facts the trigger relied on thirty days ago, re-verified now (§2). A purge running for
  -- an organisation in any other state — cancelled, requeued by hand, a trigger bug — is refused,
  -- and the refusal is a CONFLICT the worker records, not a silent no-op.
  if v_status <> 'pending_deletion' or v_requested is null then
    raise exception 'CONFLICT: % is not scheduled for deletion', p_org using errcode = '23514';
  end if;
  if v_requested > now() - interval '30 days' then
    raise exception 'CONFLICT: % was scheduled for deletion less than 30 days ago (%)', p_org, v_requested
      using errcode = '23514';
  end if;

  -- Zero running jobs of the organisation other than this one. Waiting is not failing: the caller
  -- defers and comes back.
  select count(*) into v_running
    from public.jobs j
   where j.organization_id = p_org and j.status = 'running' and j.id is distinct from p_job;
  if v_running > 0 then
    return jsonb_build_object('status', 'waiting', 'running_jobs', v_running);
  end if;

  -- The append-only guards and the audit redaction policy open for this transaction only.
  perform set_config('app.purge', 'on', true);

  foreach v_table in array v_order loop
    execute format('delete from public.%I where organization_id = $1', v_table) using p_org;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_counts := v_counts || jsonb_build_object(v_table, v_n);
    end if;
  end loop;

  -- Every other job of the organisation goes; this one stays so the worker can record its outcome.
  delete from public.jobs j where j.organization_id = p_org and j.id is distinct from p_job;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    v_counts := v_counts || jsonb_build_object('jobs', v_n);
  end if;

  -- The guard: no base table carrying organization_id may still hold a row for this organisation.
  -- This is what turns "a table was added and this list was not updated" into a loud failure.
  for v_table in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'organization_id'
       and t.table_type = 'BASE TABLE'
       and c.table_name not in ('organizations', 'audit_events', 'jobs')
       and c.table_name not like 'audit_events_%'
       and c.table_name not like 'metric_snapshots_p%'
  loop
    execute format('select count(*) from public.%I where organization_id = $1', v_table)
       into v_left using p_org;
    if v_left > 0 then
      v_offender := v_table;
      exit;
    end if;
  end loop;
  if v_offender is not null then
    raise exception 'CONFLICT: purge left % row(s) in %; the deletion order in api_server.purge_organization needs that table',
      v_left, v_offender using errcode = '23514';
  end if;

  -- The organisation row survives, marked. `profiles.last_active_org_id` would have been nulled by
  -- its FK had the row gone; it has not, so it is nulled here.
  update public.organizations
     set status = 'deleted', deleted_at = now()
   where id = p_org;
  update public.profiles set last_active_org_id = null where last_active_org_id = p_org;

  -- Redaction (ADR-038.9): the events survive as the record that things happened; what they
  -- carried of the customer's data does not. This runs AFTER the status update so that update's
  -- own audit diff is redacted with the rest.
  update public.audit_events
     set before = null, after = null, metadata = '{}'::jsonb, ip = null, user_agent = null
   where organization_id = p_org;
  get diagnostics v_redacted = row_count;

  perform set_config('app.purge', 'off', true);

  -- Written last, so it is the one event about this organisation that keeps a payload — `after`
  -- holds counts, and nothing that was in the rows.
  perform app.audit(p_org, 'org.purged', 'organizations', p_org, null,
                    jsonb_build_object('rows', v_counts, 'audit_events_redacted', v_redacted,
                                       'job_id', p_job),
                    '{}'::jsonb, null);

  return jsonb_build_object('status', 'purged', 'rows', v_counts,
                            'audit_events_redacted', v_redacted);
end $function$
;
