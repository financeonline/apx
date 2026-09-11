-- MOTION — Phase 1–7 remediation · H1: the organization scope, established reliably.
-- Contract: ADR-043 (api_server and the scoped server), TENANCY_MODEL.md §6, SECURITY_MODEL.md §4;
--           PHASE_1_7_INTEGRATION_AUDIT.md finding H1.
--
-- WHAT WAS BROKEN. `withOrgScope` asserted the scope with
-- `db.rpc('set_config', {setting_name: 'app.current_org', …})`. Two independent faults:
--
--   1. `set_config` lives in `pg_catalog`, which is not an exposed schema, so PostgREST answered
--      PGRST202 "Could not find the function public.set_config". supabase-js returns that as a
--      value rather than throwing, and both call sites discarded it. The setting was never set.
--   2. Even had the name resolved, `is_local => false` sets a SESSION setting on whichever pooled
--      PostgREST connection served that one request — not on the connection that serves the next
--      one, and not on the SEPARATE client `core/db/server-rpc.ts` keeps for every `api_server.*`
--      call. A session GUC cannot scope a series of independent HTTP requests.
--
-- The guard in `app.audit` therefore never ran: its `current_setting('app.current_org') is not null`
-- conjunct was always false, so the branch was skipped on every call.
--
-- WHAT REPLACES IT. The scope travels as a request HEADER, `x-motion-org`, on a service-role client
-- built for exactly one organization. PostgREST places every request header into `request.headers`,
-- which is TRANSACTION-LOCAL to that one request: it cannot leak to the next request on the same
-- pooled connection, and it cannot be absent from a call that carried it. `app.audit` already reads
-- `request.headers` for `ip` and `user_agent`, so this is the mechanism the file already trusts.
--
-- The header is not a trust input. It is set by the server from the `jobs` row, never from a
-- browser, and it is only ever compared for EQUALITY against an organization the function has
-- already resolved for itself. It can refuse a write; it can never authorise one. Both readers
-- below are `service_role`-only paths, so a value asserted by a user JWT reaches neither.

-- ---------------------------------------------------------------------------
-- The scope, read transaction-locally.
-- ---------------------------------------------------------------------------
create function app.scope_org() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_headers jsonb;
  v_raw     text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;

  v_raw := nullif(v_headers ->> 'x-motion-org', '');
  if v_raw is null then
    return null;
  end if;

  -- A malformed scope is refused, not ignored: silently returning NULL would turn a corrupted
  -- scope into "no scope", which is the fail-OPEN reading of exactly the header we are adding.
  begin
    return v_raw::uuid;
  exception when others then
    raise exception 'VALIDATION: the organization scope header is not a uuid' using errcode = '22023';
  end;
end $$;

comment on function app.scope_org() is
  'The organization this server request is scoped to, from the x-motion-org request header
   (ADR-090). Transaction-local; service-role paths only; never widens access.';

-- ---------------------------------------------------------------------------
-- Fail closed: an organization-scoped server function must be told which organization.
-- ---------------------------------------------------------------------------
create function app.require_scope(p_org uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_scope uuid := app.scope_org();
begin
  if p_org is null then
    raise exception 'VALIDATION: this function is organization-scoped and was given no organization'
      using errcode = '22023';
  end if;
  if v_scope is null then
    raise exception 'PERMISSION_DENIED: no organization scope was established for this request'
      using errcode = '42501';
  end if;
  if v_scope <> p_org then
    raise exception 'PERMISSION_DENIED: the organization scope does not match the organization being written'
      using errcode = '42501';
  end if;
end $$;

comment on function app.require_scope(uuid) is
  'Refuses a scoped write whose organization was not established by the server, or does not match
   the one that was (ADR-090). Missing scope and wrong scope both raise.';

-- ---------------------------------------------------------------------------
-- The audit guard, now reachable.
-- ---------------------------------------------------------------------------
-- Unchanged from 20260905000005 except for the scope read. `is distinct from` rather than `<>` so
-- that a scoped worker writing a platform-level (NULL organization) event is refused too: inside a
-- scope, every event belongs to that organization.
create or replace function app.audit(
  p_org          uuid,
  p_action       text,
  p_target_table text default null,
  p_target_id    uuid default null,
  p_before       jsonb default null,
  p_after        jsonb default null,
  p_metadata     jsonb default '{}'::jsonb,
  p_actor        uuid default null,
  p_request_id   text default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_actor      uuid;
  v_actor_type public.actor_type_enum;
  v_headers    jsonb;
  v_ip         inet;
  v_ua         text;
  v_request_id text;
  v_scope      uuid;
  v_id         bigint;
begin
  if app.role_claim() <> 'authenticated' then
    -- Non-user session: service_role (job workers, api_server) or an administrative connection.
    -- There is no session identity to derive, so the actor is whatever the caller passes; a NULL
    -- actor is a genuine system event. The accessible-set check below is a guard against a USER
    -- forging an event for another organization and is meaningless here — and app.audit is not
    -- executable by `authenticated` at all, which is the control that actually stops forgery.
    --
    -- What this check IS for: a server bug. The scope comes from the `jobs` row; `p_org` comes from
    -- whatever the handler passed. Two sources, compared. A worker draining organization A cannot
    -- write an audit row for organization B, whatever the handler believes (ADR-043, ADR-090).
    v_scope := app.scope_org();
    if v_scope is not null and p_org is distinct from v_scope then
      raise exception 'VALIDATION: audit organization does not match the scoped organization'
        using errcode = '22023';
    end if;
    v_actor := p_actor;
    v_actor_type := case
      when p_actor is null then 'system'::public.actor_type_enum
      when exists (select 1 from public.platform_users p
                    where p.user_id = p_actor and p.platform_role = 'super_admin' and p.status = 'active')
        then 'platform_admin'::public.actor_type_enum
      when exists (select 1 from public.platform_users p
                    where p.user_id = p_actor and p.platform_role = 'employee' and p.status = 'active')
        then 'employee'::public.actor_type_enum
      else 'user'::public.actor_type_enum
    end;
    v_request_id := p_request_id;
  else
    v_actor := app.uid();
    v_actor_type := app.actor_type();
    -- A user-path event must name an organization the caller can actually reach. The two
    -- bootstrap flows (api.create_organization, api.accept_invitation) legitimately audit an
    -- organization the caller is not yet a member of; they set the transaction-local flag below,
    -- which no client can set because app.audit is not executable by `authenticated` at all.
    if p_org is not null
       and coalesce(current_setting('app.bootstrap', true), 'off') <> 'on'
       and not exists (select 1 from app.accessible_org_roles() r where r.organization_id = p_org) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    v_request_id := null;
  end if;

  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;

  -- Caller-supplied and labelled as such (R2-A-06.3): the first x-forwarded-for hop is set by the
  -- Supabase edge; the user agent is truncated.
  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '')::inet;
  v_ua := left(coalesce(v_headers ->> 'user-agent', ''), 256);
  if v_request_id is null then
    v_request_id := coalesce(nullif(v_headers ->> 'x-request-id', ''), gen_random_uuid()::text);
  end if;

  insert into public.audit_events
    (organization_id, actor_user_id, actor_type, action, target_table, target_id,
     before, after, metadata, ip, user_agent, request_id)
  values
    (p_org, v_actor, v_actor_type, p_action, p_target_table, p_target_id,
     p_before, p_after, coalesce(p_metadata, '{}'::jsonb), v_ip, nullif(v_ua, ''), v_request_id)
  returning id into v_id;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Ownership and grants. Neither helper is executable by `authenticated`: both are server-path
-- machinery, and a user session has no scope to establish (DATABASE_ARCHITECTURE.md §14).
-- ---------------------------------------------------------------------------
alter function app.scope_org() owner to motion_definer;
alter function app.require_scope(uuid) owner to motion_definer;
alter function app.audit(uuid, text, text, uuid, jsonb, jsonb, jsonb, uuid, text)
  owner to motion_definer;
revoke all on function app.scope_org() from public, anon, authenticated;
revoke all on function app.require_scope(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The eight `api_server.*` functions that only ever run inside a job.
--
-- Each is called from `src/modules/jobs/handlers/*` and from nowhere else — verified by searching
-- every caller of the `core/db/server-rpc.ts` wrapper that names it. Each therefore asserts that a
-- scope was established and that it is the organization being written. Bodies are otherwise
-- unchanged: the only edit is `perform app.require_scope(p_org)` immediately after the existing
-- service_role guard, applied mechanically to the deployed source so nothing else could drift.
--
-- Functions NOT given the assertion are the ones reachable from a request as well as from a job
-- (`record_access_event`, `register_document`, `commit_batch_as`, `ai_create_conversation`,
-- `enqueue_job`, `finish_job`, …). They validate a human actor instead, and `app.audit`'s equality
-- check still refuses a scoped worker that names the wrong organization.
-- ---------------------------------------------------------------------------
create or replace function api_server.persist_alerts(p_org uuid, p_run uuid, p_changes jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $motion$
declare
  v_change      jsonb;
  v_alert       uuid;
  v_bundle      uuid;
  v_revision    integer;
  v_before      jsonb;
  v_inserted    integer := 0;
  v_revised     integer := 0;
  v_touched     integer := 0;
  v_resolved    integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  if not exists (select 1 from public.calculation_runs r
                  where r.organization_id = p_org and r.id = p_run) then
    raise exception 'NOT_FOUND: no such calculation run' using errcode = 'P0002';
  end if;

  for v_change in select * from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb))
  loop
    case v_change->>'kind'

    -- ---------------------------------------------------------------------------------------
    when 'insert' then
    -- ---------------------------------------------------------------------------------------
      insert into public.alerts (
        organization_id, rule_key, rule_version, severity, metric_key, period_id,
        subject_type, subject_id, title, explanation, threshold_summary,
        recommended_next_step, status, status_reason_code, dedupe_key, key_kind,
        calculation_run_id, first_seen_at, last_evaluated_at)
      values (
        p_org,
        v_change->>'rule_key',
        v_change->>'rule_version',
        (v_change->>'severity')::public.severity_enum,
        nullif(v_change->>'metric_key', ''),
        (v_change->>'period_id')::uuid,
        (v_change->>'subject_type')::public.alert_subject_enum,
        nullif(v_change->>'subject_id', '')::uuid,
        v_change->>'title',
        v_change->>'explanation',
        coalesce(v_change->'threshold_summary', '{}'::jsonb),
        nullif(v_change->>'recommended_next_step', ''),
        'open', 'user',
        v_change->>'dedupe_key',
        (v_change->>'key_kind')::public.alert_key_kind_enum,
        p_run, now(), now())
      -- ADR-018: the unique dedupe key makes a re-run idempotent even if the planner and the
      -- database disagree about what already exists. Nothing is duplicated; the row simply stands.
      on conflict (organization_id, dedupe_key) do nothing
      returning id into v_alert;

      if v_alert is null then
        continue;
      end if;

      v_bundle := app.build_alert_bundle(p_org, p_run, v_alert, v_change->'evidence');

      insert into public.alert_revisions (
        organization_id, alert_id, revision_no, rule_version, severity, explanation,
        threshold_summary, evidence_bundle_id, calculation_run_id)
      values (p_org, v_alert, 1, v_change->>'rule_version',
              (v_change->>'severity')::public.severity_enum,
              v_change->>'explanation',
              coalesce(v_change->'threshold_summary', '{}'::jsonb),
              v_bundle, p_run);

      update public.alerts a
         set current_revision_id = (select r.id from public.alert_revisions r
                                     where r.organization_id = p_org and r.alert_id = v_alert
                                     order by r.revision_no desc limit 1)
       where a.organization_id = p_org and a.id = v_alert;

      perform app.audit(p_org, 'alert.created', 'alerts', v_alert, null,
                        jsonb_build_object('rule_key', v_change->>'rule_key',
                                           'severity', v_change->>'severity'),
                        jsonb_build_object('run_id', p_run));
      v_inserted := v_inserted + 1;

    -- ---------------------------------------------------------------------------------------
    when 'revision' then
    -- ---------------------------------------------------------------------------------------
      v_alert := (v_change->>'alert_id')::uuid;

      select jsonb_build_object('severity', a.severity, 'status', a.status)
        into v_before
        from public.alerts a
       where a.organization_id = p_org and a.id = v_alert;
      if v_before is null then
        continue;
      end if;

      select coalesce(max(r.revision_no), 0) + 1 into v_revision
        from public.alert_revisions r
       where r.organization_id = p_org and r.alert_id = v_alert;

      v_bundle := app.build_alert_bundle(p_org, p_run, v_alert, v_change->'evidence');

      insert into public.alert_revisions (
        organization_id, alert_id, revision_no, rule_version, severity, explanation,
        threshold_summary, evidence_bundle_id, calculation_run_id)
      values (p_org, v_alert, v_revision, v_change->>'rule_version',
              (v_change->>'severity')::public.severity_enum,
              v_change->>'explanation',
              coalesce(v_change->'threshold_summary', '{}'::jsonb),
              v_bundle, p_run);

      update public.alerts a
         set severity = (v_change->>'severity')::public.severity_enum,
             explanation = v_change->>'explanation',
             title = v_change->>'title',
             threshold_summary = coalesce(v_change->'threshold_summary', '{}'::jsonb),
             recommended_next_step = nullif(v_change->>'recommended_next_step', ''),
             -- §8.1: a state alert's period moves to the latest evaluated one; first_seen_at never does.
             period_id = (v_change->>'period_id')::uuid,
             status = (v_change->>'status')::public.alert_status_enum,
             status_reason_code = coalesce(
               nullif(v_change->>'status_reason_code', '')::public.alert_status_reason_enum,
               a.status_reason_code),
             status_changed_at = case
               when a.status <> (v_change->>'status')::public.alert_status_enum then now()
               else a.status_changed_at end,
             -- A status the ENGINE changed has no user behind it.
             status_changed_by = case
               when a.status <> (v_change->>'status')::public.alert_status_enum then null
               else a.status_changed_by end,
             reopened_at = case when (v_change->>'reopened')::boolean then now() else a.reopened_at end,
             current_revision_id = (select r.id from public.alert_revisions r
                                     where r.organization_id = p_org and r.alert_id = v_alert
                                     order by r.revision_no desc limit 1),
             calculation_run_id = p_run,
             last_evaluated_at = now()
       where a.organization_id = p_org and a.id = v_alert;

      perform app.audit(p_org, 'alert.reevaluated', 'alerts', v_alert, v_before,
                        jsonb_build_object('severity', v_change->>'severity',
                                           'status', v_change->>'status'),
                        jsonb_build_object('run_id', p_run, 'revision_no', v_revision));
      v_revised := v_revised + 1;

    -- ---------------------------------------------------------------------------------------
    when 'touch' then
    -- ---------------------------------------------------------------------------------------
      -- Nothing material changed (§8.1). No revision, no audit, no notification: only the fact that
      -- the engine looked again. This is the branch that keeps a nightly run silent.
      update public.alerts a
         set last_evaluated_at = now(),
             period_id = (v_change->>'period_id')::uuid
       where a.organization_id = p_org and a.id = (v_change->>'alert_id')::uuid;
      v_touched := v_touched + 1;

    -- ---------------------------------------------------------------------------------------
    when 'resolve' then
    -- ---------------------------------------------------------------------------------------
      update public.alerts a
         set status = 'resolved',
             status_reason_code = (v_change->>'status_reason_code')::public.alert_status_reason_enum,
             status_changed_at = now(),
             status_changed_by = null,
             last_evaluated_at = now()
       where a.organization_id = p_org and a.id = (v_change->>'alert_id')::uuid
         and a.status in ('open', 'acknowledged');

      if found then
        perform app.audit(p_org, 'alert.status_changed', 'alerts',
                          (v_change->>'alert_id')::uuid,
                          jsonb_build_object('status', 'open'),
                          jsonb_build_object('status', 'resolved',
                                             'reason', v_change->>'status_reason_code'),
                          jsonb_build_object('run_id', p_run));
        v_resolved := v_resolved + 1;
      end if;

    else
      raise exception 'INVALID: unknown change kind %', v_change->>'kind' using errcode = '23514';
    end case;
  end loop;

  perform app.audit(p_org, 'alerts.evaluated', null, null, null,
                    jsonb_build_object('inserted', v_inserted, 'revised', v_revised,
                                       'touched', v_touched, 'resolved', v_resolved),
                    jsonb_build_object('run_id', p_run));

  return jsonb_build_object('inserted', v_inserted, 'revised', v_revised,
                            'touched', v_touched, 'resolved', v_resolved);
end $motion$;

create or replace function api_server.finish_calculation_run(p_org uuid, p_run uuid, p_status calculation_status_enum, p_stats jsonb DEFAULT '{}'::jsonb, p_error jsonb DEFAULT NULL::jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $motion$
declare v_started timestamptz;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  select r.started_at into v_started
    from public.calculation_runs r where r.organization_id = p_org and r.id = p_run;
  if v_started is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_status = 'failed' then
    -- Capture first, delete second. A reader must never be left with this month from a failed run
    -- and last month from the previous one — nor with no pointer at all.
    create temporary table if not exists _restore_pointers (
      period_id uuid, metric_key text, dimension_type public.metric_dimension_enum,
      dimension_id uuid, dimension_key text, snapshot_id uuid, calculation_run_id uuid
    ) on commit drop;
    -- TRUNCATE, not DELETE: the connection runs with `pg_safeupdate` armed, which refuses an
    -- unqualified DELETE (21000) and turned this whole restore into a raise (ADR-057.2).
    truncate _restore_pointers;

    insert into _restore_pointers
    select prev.period_id, prev.metric_key, prev.dimension_type, prev.dimension_id,
           prev.dimension_key, prev.id, prev.calculation_run_id
      from public.metric_current c
      join public.metric_snapshots prev
        on prev.organization_id = c.organization_id and prev.id = c.previous_snapshot_id
     where c.organization_id = p_org and c.calculation_run_id = p_run
       and c.previous_snapshot_id is not null;

    delete from public.metric_current c
     where c.organization_id = p_org and c.calculation_run_id = p_run;

    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id, dimension_key,
            snapshot_id, calculation_run_id)
    select p_org, period_id, metric_key, dimension_type, dimension_id, dimension_key,
           snapshot_id, calculation_run_id
      from _restore_pointers
    on conflict do nothing;

    create temporary table if not exists _restore_health (
      period_id uuid, health_score_id uuid, calculation_run_id uuid
    ) on commit drop;
    truncate _restore_health;

    insert into _restore_health
    select c.period_id, prev.id, prev.calculation_run_id
      from public.health_current c
      join public.health_scores prev
        on prev.organization_id = c.organization_id and prev.id = c.previous_health_score_id
     where c.organization_id = p_org and c.calculation_run_id = p_run
       and c.previous_health_score_id is not null;

    delete from public.health_current c
     where c.organization_id = p_org and c.calculation_run_id = p_run;

    insert into public.health_current
           (organization_id, period_id, health_score_id, calculation_run_id, updated_at)
    select p_org, period_id, health_score_id, calculation_run_id, now()
      from _restore_health
    on conflict do nothing;
  end if;

  update public.calculation_runs r
     set status = p_status,
         finished_at = now(),
         duration_ms = (extract(epoch from (now() - v_started)) * 1000)::integer,
         stats = coalesce(p_stats, '{}'::jsonb),
         error = p_error,
         failure_reason = case when p_status = 'failed' then 'error'::public.calculation_failure_enum end
   where r.organization_id = p_org and r.id = p_run;

  return p_run;
end $motion$;

create or replace function api_server.finish_chunk(p_org uuid, p_run uuid, p_snapshots jsonb, p_period_ids uuid[], p_aggregated_at timestamp with time zone, p_cursor text, p_as_of_keys text[] DEFAULT NULL::text[])
returns jsonb
language plpgsql security definer set search_path = ''
as $motion$
declare
  s          jsonb;
  v_written  integer := 0;
  v_period   uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);
  if not exists (select 1 from public.calculation_runs r
                  where r.organization_id = p_org and r.id = p_run and r.status = 'running') then
    raise exception 'CONFLICT: this run is not running' using errcode = '40001';
  end if;

  delete from public.metric_snapshots
   where organization_id = p_org and calculation_run_id = p_run
     and period_id = any (p_period_ids);

  for s in select * from jsonb_array_elements(p_snapshots) loop
    insert into public.metric_snapshots
           (id, organization_id, calculation_run_id, period_id, metric_key, dimension_type,
            dimension_id, dimension_key, value, unit, currency, basis, assurance_level,
            data_quality, components, evidence_query)
    -- The id comes from the ENGINE when it has one (ADR-059): a derived metric's
    -- `evidence_query.components[].snapshot_id` has to name its inputs, and it is composed before
    -- anything is inserted, so the ids have to exist before the insert or the chain is written
    -- with nulls in it. `gen_random_uuid()` remains the default for any caller that does not care.
    values (coalesce((s ->> 'id')::uuid, gen_random_uuid()), p_org, p_run,
            (s ->> 'period_id')::uuid,
            s ->> 'metric_key',
            coalesce((s ->> 'dimension_type')::public.metric_dimension_enum, 'none'),
            (s ->> 'dimension_id')::uuid,
            s ->> 'dimension_key',
            (s ->> 'value')::numeric,
            (s ->> 'unit')::public.metric_unit_enum,
            s ->> 'currency',
            (s ->> 'basis')::public.metric_basis_enum,
            (s ->> 'assurance_level')::public.assurance_level_enum,
            coalesce(s -> 'data_quality', '{}'::jsonb),
            coalesce(s -> 'components', '{}'::jsonb),
            s -> 'evidence_query');
    v_written := v_written + 1;
  end loop;

  foreach v_period in array p_period_ids loop
    if p_as_of_keys is null then
      delete from public.metric_current c
       where c.organization_id = p_org and c.period_id = v_period;
    else
      delete from public.metric_current c
       where c.organization_id = p_org and c.period_id = v_period
         and c.metric_key = any (p_as_of_keys);
    end if;

    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id, dimension_key,
            snapshot_id, calculation_run_id, previous_snapshot_id)
    select p_org, m.period_id, m.metric_key, m.dimension_type, m.dimension_id, m.dimension_key,
           m.id, p_run,
           (select prev.id
              from public.metric_snapshots prev
              join public.calculation_runs pr
                on pr.organization_id = prev.organization_id and pr.id = prev.calculation_run_id
             where prev.organization_id = p_org
               and prev.period_id = m.period_id
               and prev.metric_key = m.metric_key
               and prev.dimension_type = m.dimension_type
               and prev.dimension_id is not distinct from m.dimension_id
               and prev.dimension_key is not distinct from m.dimension_key
               and prev.calculation_run_id <> p_run
             order by pr.started_at desc
             limit 1)
      from public.metric_snapshots m
     where m.organization_id = p_org and m.calculation_run_id = p_run and m.period_id = v_period
       and (p_as_of_keys is null or m.metric_key = any (p_as_of_keys));
  end loop;

  update public.calculation_runs r
     set chunks = r.chunks || jsonb_build_array(jsonb_build_object(
           'cursor', p_cursor, 'aggregated_at', p_aggregated_at, 'finished_at', now())),
         progress = jsonb_build_object(
           'periods_done', coalesce((r.progress ->> 'periods_done')::int, 0) + array_length(p_period_ids, 1),
           'periods_total', coalesce((r.progress ->> 'periods_total')::int, 0))
   where r.organization_id = p_org and r.id = p_run;

  return jsonb_build_object('written', v_written, 'periods', array_length(p_period_ids, 1));
end $motion$;

create or replace function api_server.finish_health(p_org uuid, p_run uuid, p_scores jsonb, p_period_ids uuid[])
returns integer
language plpgsql security definer set search_path = ''
as $motion$
declare
  v_written integer := 0;
  v_incomplete integer;
  -- `v_s`, not `s`: the completeness query above aliases its own `s`, and a plpgsql variable of
  -- the same name makes that reference ambiguous.
  v_s       jsonb;
  v_item    jsonb;
  v_score   uuid;
  v_bundle  uuid;
  v_sort    integer;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  if not exists (select 1 from public.calculation_runs r
                  where r.organization_id = p_org and r.id = p_run and r.status = 'running') then
    raise exception 'NOT_FOUND: no running calculation run' using errcode = 'P0002';
  end if;

  select count(*) into v_incomplete
    from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb)) s
    join public.fiscal_periods f
      on f.organization_id = p_org and f.id = (s->>'period_id')::uuid
   where f.is_complete is not true;
  if v_incomplete > 0 then
    raise exception 'INVALID: a health score was offered for an incomplete period (ADR-030.4)'
      using errcode = '23514';
  end if;

  -- Idempotent retry of this run's own chunk (ADR-051.4): the guard permits it while `running`.
  delete from public.health_scores h
   where h.organization_id = p_org and h.calculation_run_id = p_run
     and h.period_id = any(p_period_ids);

  /*
   * One row and one bundle per score (EVIDENCE_MODEL.md §5, health-dimension row).
   *
   * Looped rather than set-based because each bundle needs the id of the row it is the evidence
   * for, and because §5 is a bundle PER SCORE — a single bundle over the chunk would not survive
   * the question "which figures produced March's 62".
   */
  for v_s in select * from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb)) loop
    insert into public.health_scores
           (organization_id, calculation_run_id, period_id, score,
            dimensions_used, dimensions_total, breakdown, config_version)
    values (p_org, p_run, (v_s->>'period_id')::uuid,
            nullif(v_s->>'score', '')::smallint,
            (v_s->>'dimensions_used')::smallint,
            (v_s->>'dimensions_total')::smallint,
            coalesce(v_s->'breakdown', '[]'::jsonb),
            v_s->>'config_version')
    returning id into v_score;

    v_written := v_written + 1;

    -- §8.6: no orphan claims. A score with nothing behind it gets no bundle rather than an empty
    -- one, and the drawer says so instead of opening on nothing.
    if jsonb_array_length(coalesce(v_s->'evidence', '[]'::jsonb)) > 0 then
      insert into public.evidence_bundles
             (organization_id, kind, origin_table, origin_id, calculation_run_id,
              created_by_type, created_by)
      values (p_org, 'health_score', 'health_scores', v_score, p_run, 'system', null)
      returning id into v_bundle;

      v_sort := 0;
      for v_item in select * from jsonb_array_elements(v_s->'evidence') loop
        insert into public.evidence_items
               (organization_id, bundle_id, sort_order, item_type, ref_id, label, assurance_level)
        values (p_org, v_bundle, v_sort,
                (v_item->>'item_type')::public.evidence_item_enum,
                nullif(v_item->>'ref_id', '')::uuid,
                v_item->>'label',
                (v_item->>'assurance_level')::public.assurance_level_enum);
        v_sort := v_sort + 1;
      end loop;
    end if;
  end loop;

  -- Repoint. The previous pointer is captured in the same statement that replaces it, so a failed
  -- run has something to put back (the defect ADR-051.3 corrected on the metric side).
  insert into public.health_current
         (organization_id, period_id, health_score_id, calculation_run_id,
          previous_health_score_id, updated_at)
  select p_org, h.period_id, h.id, p_run, null, now()
    from public.health_scores h
   where h.organization_id = p_org and h.calculation_run_id = p_run
     and h.period_id = any(p_period_ids)
  on conflict (organization_id, period_id) do update
     set previous_health_score_id =
           case when public.health_current.calculation_run_id is distinct from p_run
                then public.health_current.health_score_id
                else public.health_current.previous_health_score_id end,
         health_score_id = excluded.health_score_id,
         calculation_run_id = p_run,
         updated_at = now();

  return v_written;
end $motion$;

create or replace function api_server.record_report_file(p_actor uuid, p_org uuid, p_period uuid, p_job uuid, p_file uuid, p_sha256 bytea, p_bytes bigint)
returns uuid
language plpgsql security definer set search_path = ''
as $motion$
declare v_id uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  if not exists (select 1 from public.fiscal_periods f
                  where f.organization_id = p_org and f.id = p_period) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  /*
   * The caller names the FILE, never the PATH. The job has to write the object before it records
   * the row (ADR-043.4) and therefore has to know the id first — but the path is derived here,
   * `{org}/{period}/{id}.pdf`, so a caller cannot point a download at another organisation's object,
   * which is the lesson `register_document` already carries (R2-A-09).
   */
  v_id := coalesce(p_file, gen_random_uuid());

  insert into public.report_files
         (id, organization_id, period_id, report_kind, job_id, storage_bucket, storage_path,
          sha256, byte_size, generated_by)
  values (v_id, p_org, p_period, 'monthly_management', p_job, 'reports',
          p_org::text || '/' || p_period::text || '/' || v_id::text || '.pdf',
          p_sha256, p_bytes, p_actor);

  perform app.audit(p_org, 'report.generated', 'report_files', v_id, null,
                    jsonb_build_object('period_id', p_period, 'byte_size', p_bytes),
                    jsonb_build_object('job_id', p_job), p_actor);
  return v_id;
end $motion$;

create or replace function api_server.purge_organization(p_org uuid, p_job uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $motion$
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
    'evidence_items', 'ai_feedback', 'ai_tool_calls', 'ai_messages', 'ai_conversations',
    'alert_revisions', 'alerts', 'actions', 'report_files', 'evidence_bundles',
    'health_current', 'health_scores', 'metric_current', 'metric_snapshots',
    'category_history', 'account_category_history', 'record_status_events',
    'bank_transactions', 'recurring_payment_groups', 'ledger_entries', 'invoices',
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
end $motion$;

create or replace function api_server.set_period_completeness(p_org uuid, p_periods uuid[], p_complete boolean[])
returns integer
language plpgsql security definer set search_path = ''
as $motion$
declare i integer; v_count integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  for i in 1 .. coalesce(array_length(p_periods, 1), 0) loop
    update public.fiscal_periods
       set is_complete = p_complete[i]
     where organization_id = p_org and id = p_periods[i]
       and is_complete is distinct from p_complete[i];
    v_count := v_count + 1;
  end loop;
  return v_count;
end $motion$;

create or replace function api_server.start_calculation_run(p_org uuid, p_trigger calculation_trigger_enum, p_trigger_ref uuid, p_engine_version text, p_period_from uuid, p_period_to uuid, p_as_of date, p_fingerprint text, p_job uuid DEFAULT NULL::uuid, p_periods_total integer DEFAULT 0)
returns jsonb
language plpgsql security definer set search_path = ''
as $motion$
declare
  v_last_fingerprint bytea;
  v_run              uuid;
  v_fingerprint      bytea := decode(p_fingerprint, 'hex');
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  -- ADR-047.8: the fingerprint is computed from aggregate metadata BEFORE any write. An equal
  -- fingerprint means nothing the engine reads has changed, so the run finishes immediately rather
  -- than rewriting a year of identical snapshots. `recalc_manual` is exempt because a human asking
  -- for a recalculation is entitled to one even when nothing changed.
  select r.input_fingerprint into v_last_fingerprint
    from public.calculation_runs r
   where r.organization_id = p_org and r.status = 'succeeded'
   order by r.finished_at desc nulls last
   limit 1;

  if v_last_fingerprint is not null
     and v_last_fingerprint = v_fingerprint
     and p_trigger <> 'recalc_manual' then
    insert into public.calculation_runs
           (organization_id, job_id, trigger, trigger_ref_id, engine_version,
            period_from, period_to, as_of, status, input_fingerprint,
            started_at, finished_at, duration_ms, stats)
    values (p_org, p_job, p_trigger, p_trigger_ref, p_engine_version,
            p_period_from, p_period_to, p_as_of, 'succeeded', v_fingerprint,
            now(), now(), 0, jsonb_build_object('no_change', true))
    returning id into v_run;

    return jsonb_build_object('runId', v_run, 'noChange', true);
  end if;

  insert into public.calculation_runs
         (organization_id, job_id, trigger, trigger_ref_id, engine_version,
          period_from, period_to, as_of, status, input_fingerprint, started_at, progress)
  values (p_org, p_job, p_trigger, p_trigger_ref, p_engine_version,
          p_period_from, p_period_to, p_as_of, 'running', v_fingerprint, now(),
          jsonb_build_object('periods_done', 0, 'periods_total', p_periods_total))
  returning id into v_run;

  return jsonb_build_object('runId', v_run, 'noChange', false);
end $motion$;


-- Re-assert ownership and the closed grant on every function replaced above (ADR-044.3): a
-- `create or replace` keeps the existing owner and ACL, but stating it here means a future replace
-- that is written by hand cannot quietly widen them.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api_server'
       and p.proname in ('persist_alerts', 'finish_calculation_run', 'finish_chunk', 'finish_health',
                         'record_report_file', 'purge_organization', 'set_period_completeness',
                         'start_calculation_run')
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
