-- APX — Investment: the Investment Pack (ADR-171).
--
-- Opening Investment shows a ready-made "Investment Pack" shaped section by section on the client's own
-- example ("Investment Strategy & Financial Growth Plan", October 2026). Every number in it is APX's own
-- arithmetic on the company's figures — the growth paths, the surplus split, the portfolio amounts, the
-- return scenarios; ChatGPT writes only the words and chooses the options and the portfolio's asset
-- classes and shares. The pack is written by a background job, stored, and shown until somebody
-- refreshes it. It mirrors Marketing (ADR-170, migration 20261018000014) deliberately: one pattern for
-- every AI-written department report.
--
--   1. `investment_reports` — one row per attempt, kept as history: queued → running → ready | failed.
--      The page reads the newest READY pack and the newest attempt's status, so a refresh in progress,
--      or one that failed, never hides the pack already there. At most one attempt per organisation is
--      in flight (a partial unique index), and a finished row never changes. `assumptions` holds what
--      the person asked the pack to be built on: `{"surplus": "95000.00"}` when the analyst entered the
--      amount to allocate, `{}` when APX is to use the base year's net profit. It is written once, by
--      the request, and never changes (the guard below).
--   2. `api.request_investment_report(org, surplus)` — who may spend AI on it: `reports.generate` (it
--      produces a stored report, as Marketing, the adviser and Funding Readiness reports do) AND
--      `ai.use` (it is an AI call). Refused while Investment is switched off (NOT FOUND), for an amount
--      below 1 (the pack's figures are whole currency units, so less would allocate nothing) or beyond
--      any company's means (VALIDATION: more than 1,000,000,000,000), and once this month's AI
--      allowance is used up (QUOTA); limited to three per
--      organisation per hour. A request while one is queued or running returns that one (and its
--      amount, not the new one). It queues `investment.generate` with ONE attempt: every attempt is a
--      paid model call, so a failure is shown to the person, who decides whether to try again.
--
--      Whether the company HAS a surplus — a profit in its base year, or an amount entered — is not
--      decided here: the base year is worked out in TypeScript from the company's figures
--      (`loadInvestmentBase`), and one rule must not live in two languages. The service refuses the
--      request before calling this function, and the job fails the attempt in the same words, without
--      calling the model, for a caller that came straight here.
--   3. `api_server.start_investment_report` / `finish_investment_report` / `fail_investment_report` —
--      the job's writes, service role and scoped. The tokens each attempt spent are recorded on its row
--      and count under the organisation's monthly AI ceiling with the analyst's, the PDF reader's and
--      the Marketing report's (`app.ai_tokens_used_this_month`, re-created below). The requester is
--      told in the inbox when the pack is ready.
--   4. A pack never outlives its job: when an `investment.generate` job ends (a lost worker reclaimed
--      as dead, a cancellation, or a handler that returned without finishing) an attempt still queued
--      or running is marked failed, so the page cannot wait for ever.
--   5. Investment is a system the super admin switches (`module_investment`, on unless switched off):
--      `api.set_org_module` is re-created with the key; the packs' RLS includes the switch, so an
--      organisation with Investment off reads none of them (as Marketing and Funding Readiness).
--   6. The purge's deletion order names the new table.
--
-- `app.job_max_runtime`, `app.ai_tokens_used_this_month`, `api.set_org_module` and
-- `api_server.purge_organization` are re-created from their LIVE definitions (`pg_get_functiondef`,
-- which already include Marketing's additions), each with only the Investment line added.
--
-- The new job type is used in this file only inside plpgsql bodies and as text, because a value added
-- by `alter type … add value` cannot be used as an enum in the transaction that adds it.

alter type public.job_type_enum add value if not exists 'investment.generate';

-- ---------------------------------------------------------------------------------------------
-- The job's time budget. A pack is one long model call; the worker is reclaimed after 3× this.
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
    when 'investment.generate' then interval '5 minutes'
    else interval '2 minutes'
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Whether Investment is on for an organisation (ADR-158): exactly `enabledModules` in
-- src/modules/tenancy/domain/modules.ts — an absent key is ON (a default-on system); a stored `true`
-- is on; anything else stored is off.
-- ---------------------------------------------------------------------------------------------
create function app.investment_enabled(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select not (o.features ? 'module_investment') or (o.features -> 'module_investment') = 'true'::jsonb
                     from public.organizations o where o.id = p_org), false);
$$;
alter function app.investment_enabled(uuid) owner to motion_definer;
revoke all on function app.investment_enabled(uuid) from public, anon;
grant execute on function app.investment_enabled(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. The packs
-- ---------------------------------------------------------------------------------------------
create table public.investment_reports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  status          text not null default 'queued'
                  constraint investment_reports_status check (status in ('queued', 'running', 'ready', 'failed')),
  -- What the pack is built on, as asked: {"surplus": "<decimal string>"} when the analyst entered the
  -- amount to allocate; {} for the base year's net profit. Money as a decimal string, never a float.
  assumptions     jsonb not null default '{}'::jsonb constraint investment_reports_assumptions check (
                    jsonb_typeof(assumptions) = 'object' and length(assumptions::text) <= 2000
                    and (not (assumptions ? 'surplus')
                         or (jsonb_typeof(assumptions -> 'surplus') = 'string'
                             and (assumptions ->> 'surplus') ~ '^[0-9]{1,13}\.[0-9]{2}$'))),
  -- The InvestmentReport (src/modules/investment/domain/types.ts), exactly as the page renders it.
  report          jsonb,
  report_version  text,
  -- What the person is shown when the attempt failed. Never a provider's own error text.
  failure         text constraint investment_reports_failure check (failure is null or length(failure) between 1 and 500),
  requested_by    uuid references public.profiles (id) on delete set null,
  job_id          uuid,
  model           text constraint investment_reports_model check (model is null or length(model) between 1 and 200),
  prompt_version  text constraint investment_reports_prompt check (prompt_version is null or length(prompt_version) between 1 and 200),
  input_tokens    integer not null default 0 constraint investment_reports_input_tokens check (input_tokens >= 0),
  output_tokens   integer not null default 0 constraint investment_reports_output_tokens check (output_tokens >= 0),
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  updated_at      timestamptz not null default now(),
  constraint investment_reports_ready_has_report check ((status = 'ready') = (report is not null)),
  constraint investment_reports_version_with_report check ((report is null) = (report_version is null)),
  constraint investment_reports_failed_has_reason check ((status = 'failed') = (failure is not null)),
  constraint investment_reports_finished check ((status in ('ready', 'failed')) = (finished_at is not null)),
  constraint investment_reports_org_id_unique unique (organization_id, id),
  -- Carries organization_id (ADR-044.8), as every job reference does; a job row removed clears only
  -- the link, never the organisation.
  constraint investment_reports_job_fk foreign key (organization_id, job_id)
    references public.jobs (organization_id, id) on delete set null (job_id)
);
comment on table public.investment_reports is
  'ADR-171: every attempt at the Investment Pack, kept as history. The page shows the newest ready pack and the newest attempt''s status.';
comment on column public.investment_reports.assumptions is
  'What the pack was asked to be built on: {"surplus": "95000.00"} when the analyst entered the amount to allocate; {} for the base year''s net profit. Written once.';

-- One attempt in flight per organisation: the invariant api.request_investment_report relies on.
create unique index investment_reports_one_in_flight on public.investment_reports (organization_id)
  where status in ('queued', 'running');
create index investment_reports_latest on public.investment_reports (organization_id, created_at desc);
create index investment_reports_latest_ready on public.investment_reports (organization_id, finished_at desc)
  where status = 'ready';
create index investment_reports_by_job on public.investment_reports (job_id) where job_id is not null;

alter table public.investment_reports owner to motion_definer;
alter table public.investment_reports enable row level security;
alter table public.investment_reports force row level security;
revoke insert, update, delete, truncate on public.investment_reports from authenticated, anon;
revoke select on public.investment_reports from anon;
grant select on public.investment_reports to authenticated;
grant all on public.investment_reports to service_role;
create policy definer_all on public.investment_reports for all to motion_definer using (true) with check (true);
-- `reports.view` (the five roles), and only while Investment is on for the organisation.
create policy investment_reports_select on public.investment_reports for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('reports.view'))
         and app.investment_enabled(organization_id));
create trigger set_updated_at before update on public.investment_reports
  for each row execute function app.set_updated_at();

/*
 * History is kept: an attempt moves forward (queued → running → ready | failed) and a finished one
 * never changes. Rows go only with their organisation — the purge, or the organisation's own delete
 * cascading — exactly as `app.append_only_guard_cascadable` allows.
 *
 * What was asked for — the organisation, when, the assumptions — never changes, even while the attempt
 * is in flight: the pack the job writes is the pack that was requested.
 *
 * The one change a finished row admits is a link being CLEARED by its foreign key's ON DELETE SET
 * NULL (the person who asked loses their account; a job row is removed): refusing that would make
 * deleting a user or a job fail because a pack once named them.
 */
create function app.investment_report_guard() returns trigger
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
    raise exception 'IMMUTABLE: investment packs are kept as history' using errcode = '23514';
  end if;
  -- Who asked, when, and on what assumptions never change; a link is only ever cleared — or, once,
  -- the job attached.
  if new.organization_id is distinct from old.organization_id or new.created_at is distinct from old.created_at
     or new.assumptions is distinct from old.assumptions
     or (new.requested_by is distinct from old.requested_by and new.requested_by is not null)
     or (new.job_id is distinct from old.job_id and new.job_id is not null and old.job_id is not null) then
    raise exception 'IMMUTABLE: who asked for an investment pack, when, and on what assumptions, is not changed' using errcode = '23514';
  end if;
  if old.status in ('ready', 'failed') and (to_jsonb(new) - v_links) is distinct from (to_jsonb(old) - v_links) then
    raise exception 'IMMUTABLE: a finished investment pack is not changed' using errcode = '23514';
  end if;
  return new;
end $$;
alter function app.investment_report_guard() owner to motion_definer;
revoke all on function app.investment_report_guard() from public, anon, authenticated;
create trigger investment_report_guard before update or delete on public.investment_reports
  for each row execute function app.investment_report_guard();

-- ---------------------------------------------------------------------------------------------
-- 2. Asking for a pack
-- ---------------------------------------------------------------------------------------------
create function api.request_investment_report(p_org uuid, p_surplus numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id          uuid;
  v_job         uuid;
  v_ceiling     bigint;
  v_surplus     numeric;
  v_assumptions jsonb := '{}'::jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'reports.generate');
  perform app.require_permission(p_org, 'ai.use');
  -- A switched-off system is absent, not refused (ADR-158).
  if not app.investment_enabled(p_org) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The amount to allocate, when the analyst entered one: money, to the penny, at least one whole
  -- currency unit — the pack's figures are whole units (`buildInvestmentFigures`), so less would round
  -- to nothing to allocate — and within any company's means. ±Infinity (numeric admits both) fails the
  -- same two tests; NaN is refused by name.
  if p_surplus is not null then
    if p_surplus = 'NaN'::numeric then
      raise exception 'VALIDATION: the amount to allocate must be a number' using errcode = '22023';
    end if;
    v_surplus := round(p_surplus, 2);
    if v_surplus < 1 then
      raise exception 'VALIDATION: Enter an amount of at least 1.' using errcode = '22023';
    end if;
    if v_surplus > 1000000000000 then
      raise exception 'VALIDATION: the amount to allocate must be 1,000,000,000,000 or less' using errcode = '22023';
    end if;
    v_assumptions := jsonb_build_object('surplus', v_surplus::text);
  end if;

  perform pg_advisory_xact_lock(hashtext('investment:' || p_org::text));

  -- An attempt whose job has ended cannot hold the slot (the trigger below normally sees to this;
  -- this covers a job row that is gone).
  update public.investment_reports r
     set status = 'failed', failure = 'The pack could not be finished. Refresh it to try again.', finished_at = now()
   where r.organization_id = p_org and r.status in ('queued', 'running')
     and not exists (select 1 from public.jobs j
                      where j.id = r.job_id and j.status in ('queued', 'running', 'deferred_upstream'));

  -- One at a time: a second press returns the attempt already under way, and spends nothing.
  select r.id into v_id from public.investment_reports r
   where r.organization_id = p_org and r.status in ('queued', 'running');
  if v_id is not null then
    return jsonb_build_object('report_id', v_id, 'created', false);
  end if;

  -- The same monthly ceiling the analyst, the PDF reader and Marketing are held to (CD-24).
  v_ceiling := app.effective_quota(p_org, 'ai_token_ceiling_monthly');
  if v_ceiling is not null and app.ai_tokens_used_this_month(p_org) >= v_ceiling then
    raise exception 'QUOTA: this company''s AI allowance for the month has been used' using errcode = '53400';
  end if;

  -- Three packs an hour per organisation. Counted here, after every refusal above, so a refused or
  -- repeated press costs nothing.
  perform app.throttle(p_org, 'investment_report', 3, interval '1 hour');

  insert into public.investment_reports (organization_id, status, assumptions, requested_by)
  values (p_org, 'queued', v_assumptions, app.uid())
  returning id into v_id;

  -- One attempt: each is a paid model call, and a failure is the person's to retry, not the queue's.
  insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key, max_attempts)
  values (p_org, 'investment.generate', jsonb_build_object('reportId', v_id), app.uid(),
          'investment.generate:' || v_id::text, 1)
  returning id into v_job;

  update public.investment_reports set job_id = v_job where id = v_id;

  perform app.audit(p_org, 'investment.report_requested', 'investment_reports', v_id, null,
                    jsonb_build_object('job_id', v_job, 'assumptions', v_assumptions), '{}'::jsonb);
  perform app.audit(p_org, 'job.enqueued', 'jobs', v_job, null,
                    jsonb_build_object('job_type', 'investment.generate'), '{}'::jsonb);
  return jsonb_build_object('report_id', v_id, 'created', true);
end $$;
alter function api.request_investment_report(uuid, numeric) owner to motion_definer;
revoke all on function api.request_investment_report(uuid, numeric) from public, anon;
grant execute on function api.request_investment_report(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. The job's writes (service role, scoped to the job's organisation; ADR-043, ADR-090)
-- ---------------------------------------------------------------------------------------------

/* Marks the attempt running. Returns NULL when there is nothing to do: the attempt already finished,
 * or Investment was switched off after it was asked for (then it is failed, saying so). */
create function api_server.start_investment_report(p_org uuid, p_report uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  perform app.require_scope(p_org);

  select r.status into v_status from public.investment_reports r
   where r.organization_id = p_org and r.id = p_report
   for update;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status not in ('queued', 'running') then
    return null;
  end if;
  if not app.investment_enabled(p_org) then
    update public.investment_reports
       set status = 'failed', failure = 'Investment is switched off for this company.', finished_at = now()
     where organization_id = p_org and id = p_report;
    return null;
  end if;

  update public.investment_reports set status = 'running', started_at = now()
   where organization_id = p_org and id = p_report;
  return p_report;
end $$;
alter function api_server.start_investment_report(uuid, uuid) owner to motion_definer;
revoke all on function api_server.start_investment_report(uuid, uuid) from public, anon, authenticated;
grant execute on function api_server.start_investment_report(uuid, uuid) to service_role;

/* Stores the finished pack and tells the person who asked for it. */
create function api_server.finish_investment_report(
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

  if p_content is null or jsonb_typeof(p_content) <> 'object' or p_content ->> 'version' is distinct from 'investment-v1' then
    raise exception 'VALIDATION: an investment pack is an investment-v1 document' using errcode = '22023';
  end if;
  if length(p_content::text) > 1000000 then
    raise exception 'VALIDATION: the investment pack is too large to store' using errcode = '22023';
  end if;
  if coalesce(length(btrim(p_model)), 0) = 0 or coalesce(length(btrim(p_prompt_version)), 0) = 0 then
    raise exception 'VALIDATION: a finished pack names its model and prompt version' using errcode = '22023';
  end if;
  if coalesce(p_input_tokens, -1) < 0 or coalesce(p_output_tokens, -1) < 0 then
    raise exception 'VALIDATION: token counts are whole numbers from zero' using errcode = '22023';
  end if;

  update public.investment_reports
     set status = 'ready', report = p_content, report_version = p_content ->> 'version', failure = null,
         model = btrim(p_model), prompt_version = btrim(p_prompt_version),
         input_tokens = p_input_tokens, output_tokens = p_output_tokens, finished_at = now()
   where organization_id = p_org and id = p_report and status = 'running'
  returning requested_by into v_requested_by;
  if not found then
    raise exception 'CONFLICT: that investment pack is not being written' using errcode = '23514';
  end if;

  perform app.audit(p_org, 'investment.report_ready', 'investment_reports', p_report, null,
                    jsonb_build_object('model', btrim(p_model), 'prompt_version', btrim(p_prompt_version)),
                    jsonb_build_object('input_tokens', p_input_tokens, 'output_tokens', p_output_tokens));

  select o.slug::text into v_slug from public.organizations o where o.id = p_org;
  perform app.notify(p_org, v_requested_by, null, 'reports.view', 'report_ready',
                     'Your investment pack is ready', null, '/app/' || v_slug || '/investment');
  return p_report;
end $$;
alter function api_server.finish_investment_report(uuid, uuid, jsonb, text, text, integer, integer) owner to motion_definer;
revoke all on function api_server.finish_investment_report(uuid, uuid, jsonb, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_server.finish_investment_report(uuid, uuid, jsonb, text, text, integer, integer) to service_role;

/* Records a failed attempt with the sentence the person is shown, and what it cost. Idempotent: an
 * attempt that has already finished is left as it is, and NULL is returned. */
create function api_server.fail_investment_report(
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
    raise exception 'VALIDATION: a failed pack says why' using errcode = '22023';
  end if;
  if coalesce(p_input_tokens, -1) < 0 or coalesce(p_output_tokens, -1) < 0 then
    raise exception 'VALIDATION: token counts are whole numbers from zero' using errcode = '22023';
  end if;
  if not exists (select 1 from public.investment_reports r where r.organization_id = p_org and r.id = p_report) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.investment_reports
     set status = 'failed', failure = v_failure,
         model = nullif(btrim(coalesce(p_model, '')), ''), prompt_version = nullif(btrim(coalesce(p_prompt_version, '')), ''),
         input_tokens = p_input_tokens, output_tokens = p_output_tokens, finished_at = now()
   where organization_id = p_org and id = p_report and status in ('queued', 'running');
  if not found then
    return null;
  end if;

  perform app.audit(p_org, 'investment.report_failed', 'investment_reports', p_report, null,
                    jsonb_build_object('failure', v_failure),
                    jsonb_build_object('input_tokens', p_input_tokens, 'output_tokens', p_output_tokens));
  return p_report;
end $$;
alter function api_server.fail_investment_report(uuid, uuid, text, text, text, integer, integer) owner to motion_definer;
revoke all on function api_server.fail_investment_report(uuid, uuid, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_server.fail_investment_report(uuid, uuid, text, text, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. A pack never outlives its job — Marketing's `marketing_job_ended` behaviour, for the new type.
-- ---------------------------------------------------------------------------------------------
create function app.investment_job_ended() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.investment_reports r
     set status = 'failed', failure = 'The pack could not be finished. Refresh it to try again.', finished_at = now()
   where r.organization_id = new.organization_id and r.job_id = new.id and r.status in ('queued', 'running');
  return null;
end $$;
alter function app.investment_job_ended() owner to motion_definer;
revoke all on function app.investment_job_ended() from public, anon, authenticated;
create trigger investment_job_ended after update of status on public.jobs
  for each row
  when (new.job_type::text = 'investment.generate'
        and new.status in ('succeeded', 'dead', 'cancelled')
        and old.status is distinct from new.status)
  execute function app.investment_job_ended();

-- ---------------------------------------------------------------------------------------------
-- The monthly AI ceiling counts the Investment Pack's tokens too (CD-24). Re-created from the live
-- definition with the fourth term added.
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
                      and r.finished_at >= date_trunc('month', now() at time zone 'utc')), 0)
       -- ADR-171: every attempt at the Investment Pack, ready or failed, in the month it finished.
       + coalesce((select sum(r.input_tokens::bigint + r.output_tokens::bigint)
                     from public.investment_reports r
                    where r.organization_id = p_org
                      and r.finished_at >= date_trunc('month', now() at time zone 'utc')), 0);
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. The super admin's switch: re-created exactly as it stands, with `module_investment` added.
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
       'module_planning', 'module_tax', 'funding_readiness', 'ai_pdf_extraction', 'module_marketing',
       'module_investment') then
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
-- 6. The purge: re-created exactly as it stands, with the Investment table in the order. It has no
--    child; `investment_reports.job_id` points at jobs, which go after the loop.
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
    -- Investment (ADR-171): the packs.
    'investment_reports',
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
