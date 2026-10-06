-- MOTION — Phase 16 · Funding Readiness (PHASE_16_IMPLEMENTATION.md §3, §8–§10; ADR-119, ADR-121, ADR-145).
--
-- Built locally on the owner's instruction of 2026-10-06 ("build it now, locally") although the
-- design's prerequisite — an independent re-review of the receivables/payables recovery (ADR-120) and
-- its Health regression audit — has not happened. The feature stays OFF by default (D-5) and nothing is
-- calculated while it is off (ADR-121, U-4).
--
--   * `funding_assessments` (append-only) and `funding_current` (a pointer per month), as health_scores /
--     health_current. Unique per (organisation, month, calculation run).
--   * Readable by the five roles over the accessible set (as `period_balances`) AND only while
--     `organizations.features.funding_readiness` is true — a flag that is off hides the rows in RLS too
--     (§10, U-5), never by UI alone.
--   * `api_server.finish_funding` — the only writer: service role, scoped; refuses a disabled
--     organisation, an incomplete month, and a run that is not this organisation's and succeeded; writes
--     the row, its evidence bundle (`funding_assessment`), and the pointer. A repeat of the same month and
--     run is skipped (deterministic: it would be byte-identical).
--   * Enablement: turning the flag on queues `funding.assess` (`enablement_backfill`) in the SAME
--     transaction as the change (ADR-121).
--   * `api_server.enqueue_funding_backstop()` — nightly: any enabled organisation whose latest scored
--     month has no current assessment citing that month's run gets `funding.assess` (`nightly_backstop`).
--   * After every successful calculation the run's handler queues `funding.assess` (`calculation_run`)
--     when the flag is on — a separate job rather than a step inside the chunk loop, so an assessment
--     always cites a run that SUCCEEDED and a failed run never leaves a funding pointer to restore.

create function app.funding_enabled(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (o.features ->> 'funding_readiness') = 'true' from public.organizations o where o.id = p_org), false);
$$;
alter function app.funding_enabled(uuid) owner to motion_definer;
revoke all on function app.funding_enabled(uuid) from public, anon;
grant execute on function app.funding_enabled(uuid) to authenticated;

create table public.funding_assessments (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null references public.organizations (id) on delete cascade,
  calculation_run_id          uuid not null,
  period_id                   uuid not null,
  overall_score               smallint constraint funding_score_range check (overall_score between 0 and 100),
  overall_status              text not null constraint funding_status check (overall_status in ('scored', 'insufficient_data')),
  band                        text,
  factors_used                smallint not null,
  factors_total               smallint not null default 7,
  substantive_weight_scored   smallint not null constraint funding_weight_range check (substantive_weight_scored between 0 and 90),
  data_coverage_percent       smallint not null constraint funding_coverage_range check (data_coverage_percent between 0 and 100),
  breakdown                   jsonb not null,
  rules_version               text not null,
  engine_version              text not null,
  trigger                     text not null constraint funding_trigger check (trigger in ('enablement_backfill', 'calculation_run', 'nightly_backstop')),
  disclaimer                  text not null,
  created_at                  timestamptz not null default now(),
  constraint funding_score_iff_scored check ((overall_score is null) = (overall_status = 'insufficient_data')),
  constraint funding_band_iff_score check ((band is null) = (overall_score is null)),
  constraint funding_assessments_org_id_unique unique (organization_id, id),
  constraint funding_assessments_once unique (organization_id, period_id, calculation_run_id),
  constraint funding_assessments_run_fk foreign key (organization_id, calculation_run_id) references public.calculation_runs (organization_id, id),
  constraint funding_assessments_period_fk foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id)
);
alter table public.funding_assessments owner to motion_definer;
alter table public.funding_assessments enable row level security;
alter table public.funding_assessments force row level security;
revoke insert, update, delete, truncate on public.funding_assessments from authenticated, anon;
revoke select on public.funding_assessments from anon;
grant select on public.funding_assessments to authenticated;
grant all on public.funding_assessments to service_role;
create policy definer_all on public.funding_assessments for all to motion_definer using (true) with check (true);
create policy funding_assessments_select on public.funding_assessments for select to authenticated
  using (organization_id in (select app.org_ids_with_role(variadic array['owner', 'admin', 'employee', 'super_admin', 'client']))
         and app.funding_enabled(organization_id));
create trigger append_only_guard before update or delete on public.funding_assessments
  for each row execute function app.append_only_guard_cascadable();

create table public.funding_current (
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  period_id           uuid not null,
  assessment_id       uuid not null,
  calculation_run_id  uuid not null,
  updated_at          timestamptz not null default now(),
  primary key (organization_id, period_id),
  constraint funding_current_assessment_fk foreign key (organization_id, assessment_id) references public.funding_assessments (organization_id, id),
  constraint funding_current_period_fk foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id)
);
alter table public.funding_current owner to motion_definer;
alter table public.funding_current enable row level security;
alter table public.funding_current force row level security;
revoke insert, update, delete, truncate on public.funding_current from authenticated, anon;
revoke select on public.funding_current from anon;
grant select on public.funding_current to authenticated;
grant all on public.funding_current to service_role;
create policy definer_all on public.funding_current for all to motion_definer using (true) with check (true);
create policy funding_current_select on public.funding_current for select to authenticated
  using (organization_id in (select app.org_ids_with_role(variadic array['owner', 'admin', 'employee', 'super_admin', 'client']))
         and app.funding_enabled(organization_id));

-- Evidence bundles may now name an assessment as their origin.
alter table public.evidence_bundles drop constraint evidence_bundles_origin_table_known;
alter table public.evidence_bundles add constraint evidence_bundles_origin_table_known check (origin_table = any (array[
  'metric_snapshots', 'alerts', 'ai_messages', 'health_scores', 'actions', 'report_files', 'forecast_runs', 'scenario_runs',
  'funding_assessments']));
drop trigger same_org_ref_origin on public.evidence_bundles;
create trigger same_org_ref_origin before insert or update on public.evidence_bundles
  for each row execute function app.same_org_ref(
    'origin_id', 'origin_table',
    'metric_snapshots', 'metric_snapshots', 'alerts', 'alerts', 'ai_messages', 'ai_messages',
    'health_scores', 'health_scores', 'actions', 'actions', 'report_files', 'report_files',
    'forecast_runs', 'forecast_runs', 'scenario_runs', 'scenario_runs', 'funding_assessments', 'funding_assessments');

-- ---------------------------------------------------------------------------------------------
-- The writer
-- ---------------------------------------------------------------------------------------------
create function api_server.finish_funding(p_org uuid, p_assessments jsonb, p_trigger text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_a jsonb; v_item jsonb; v_id uuid; v_bundle uuid; v_sort integer; v_written integer := 0;
        v_period uuid; v_run uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  perform app.require_scope(p_org);
  -- ADR-121: nothing is calculated, or written, while the flag is off.
  if not app.funding_enabled(p_org) then return 0; end if;

  perform pg_advisory_xact_lock(hashtext('funding:' || p_org::text));

  for v_a in select * from jsonb_array_elements(coalesce(p_assessments, '[]'::jsonb)) loop
    v_period := (v_a ->> 'period_id')::uuid;
    v_run := (v_a ->> 'calculation_run_id')::uuid;
    if not exists (select 1 from public.fiscal_periods f where f.organization_id = p_org and f.id = v_period and f.is_complete) then
      raise exception 'INVALID: funding readiness is assessed for complete months only (ADR-030.4)' using errcode = '23514';
    end if;
    if not exists (select 1 from public.calculation_runs r where r.organization_id = p_org and r.id = v_run and r.status in ('succeeded', 'running')) then
      raise exception 'NOT_FOUND: that calculation run is not this organisation''s, or did not succeed' using errcode = 'P0002';
    end if;
    -- The same month and run, assessed again: identical by construction, so the first stands — but
    -- the pointer is put back on it if it was lost (the backstop's case).
    select x.id into v_id from public.funding_assessments x
     where x.organization_id = p_org and x.period_id = v_period and x.calculation_run_id = v_run;
    if v_id is not null then
      insert into public.funding_current (organization_id, period_id, assessment_id, calculation_run_id, updated_at)
      values (p_org, v_period, v_id, v_run, now())
      on conflict (organization_id, period_id) do update
         set assessment_id = excluded.assessment_id, calculation_run_id = excluded.calculation_run_id, updated_at = now();
      continue;
    end if;

    insert into public.funding_assessments
           (organization_id, calculation_run_id, period_id, overall_score, overall_status, band, factors_used, factors_total,
            substantive_weight_scored, data_coverage_percent, breakdown, rules_version, engine_version, trigger, disclaimer)
    values (p_org, v_run, v_period, nullif(v_a ->> 'overall_score', '')::smallint, v_a ->> 'overall_status', v_a ->> 'band',
            (v_a ->> 'factors_used')::smallint, 7, (v_a ->> 'substantive_weight_scored')::smallint,
            (v_a ->> 'data_coverage_percent')::smallint, v_a -> 'breakdown', v_a ->> 'rules_version', v_a ->> 'engine_version',
            p_trigger, v_a ->> 'disclaimer')
    returning id into v_id;
    v_written := v_written + 1;

    if jsonb_array_length(coalesce(v_a -> 'evidence', '[]'::jsonb)) > 0 then
      insert into public.evidence_bundles (organization_id, kind, origin_table, origin_id, calculation_run_id, created_by_type, created_by)
      values (p_org, 'funding_assessment', 'funding_assessments', v_id, v_run, 'system', null)
      returning id into v_bundle;
      v_sort := 0;
      for v_item in select * from jsonb_array_elements(v_a -> 'evidence') loop
        insert into public.evidence_items (organization_id, bundle_id, sort_order, item_type, ref_id, label, assurance_level)
        values (p_org, v_bundle, v_sort, (v_item ->> 'item_type')::public.evidence_item_enum,
                nullif(v_item ->> 'ref_id', '')::uuid, v_item ->> 'label', (v_item ->> 'assurance_level')::public.assurance_level_enum);
        v_sort := v_sort + 1;
      end loop;
    end if;

    insert into public.funding_current (organization_id, period_id, assessment_id, calculation_run_id, updated_at)
    values (p_org, v_period, v_id, v_run, now())
    on conflict (organization_id, period_id) do update
       set assessment_id = excluded.assessment_id, calculation_run_id = excluded.calculation_run_id, updated_at = now();
  end loop;

  if v_written > 0 then
    perform app.audit(p_org, 'funding.assessed', 'funding_assessments', null, null,
                      jsonb_build_object('written', v_written, 'trigger', p_trigger), '{}'::jsonb, null);
  end if;
  return v_written;
end $$;
alter function api_server.finish_funding(uuid, jsonb, text) owner to motion_definer;
revoke all on function api_server.finish_funding(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function api_server.finish_funding(uuid, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Enablement backfill, in the same transaction as the flag (ADR-121)
-- ---------------------------------------------------------------------------------------------
create function app.funding_enablement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.features ->> 'funding_readiness', '') = 'true'
     and coalesce(old.features ->> 'funding_readiness', '') <> 'true' then
    insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
    values (new.id, 'funding.assess', jsonb_build_object('trigger', 'enablement_backfill'), null, 'funding.assess:' || new.id::text)
    on conflict do nothing;
    perform app.audit(new.id, 'funding.enabled', 'organizations', new.id, null, '{}'::jsonb, '{}'::jsonb);
  end if;
  return new;
end $$;
alter function app.funding_enablement() owner to motion_definer;
revoke all on function app.funding_enablement() from public, anon, authenticated;
create trigger funding_enablement after update of features on public.organizations
  for each row execute function app.funding_enablement();

-- ---------------------------------------------------------------------------------------------
-- The nightly backstop
-- ---------------------------------------------------------------------------------------------
create function api_server.enqueue_funding_backstop() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_count integer := 0; v_job uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  for v_org in
    select o.id from public.organizations o
     where o.status = 'active' and app.funding_enabled(o.id)
       and exists (
         -- The latest complete month with current figures has no assessment citing those figures' run.
         select 1 from (
           select mc.period_id, max(mc.calculation_run_id::text) as run_id
             from public.metric_current mc
             join public.fiscal_periods f on f.organization_id = mc.organization_id and f.id = mc.period_id and f.is_complete
            where mc.organization_id = o.id
            group by mc.period_id, f.period_start
            order by f.period_start desc limit 1
         ) latest
         where not exists (select 1 from public.funding_current fc
                            where fc.organization_id = o.id and fc.period_id = latest.period_id
                              and fc.calculation_run_id::text = latest.run_id))
  loop
    insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
    values (v_org, 'funding.assess', jsonb_build_object('trigger', 'nightly_backstop'), null, 'funding.assess:' || v_org::text)
    on conflict do nothing returning id into v_job;
    if v_job is not null then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end $$;
alter function api_server.enqueue_funding_backstop() owner to motion_definer;
revoke all on function api_server.enqueue_funding_backstop() from public, anon, authenticated;
grant execute on function api_server.enqueue_funding_backstop() to service_role;

-- ---------------------------------------------------------------------------------------------
-- Purge: the pointer and the assessments go with the organisation
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
end $function$;
