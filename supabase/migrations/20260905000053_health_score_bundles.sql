-- MOTION — Evidence UI · A health score carries the figures it was worked out from.
-- Contract: EVIDENCE_MODEL.md §5 (health-dimension row), §8.6; FINANCIAL_ENGINE.md §7.4; ADR-060.
--
-- §5 says a health score writes one `health_score` bundle per score row, holding a `metric_snapshot`
-- item for every metric in `breakdown[].metrics` and the `calculation_run`. Phase 8 built the score
-- and the explainability panel and never built the bundle, so the most prominent number in the
-- product — the one a customer is most likely to argue with — was the only figure with no evidence
-- behind it. The panel linked each pinned snapshot to the METRIC's bundle instead, which reaches
-- the same records by a different route and cannot answer "what produced this score".
--
-- The items are supplied by the caller for the reason `build_metric_bundle` gives (ADR-059.2):
-- labels come from the canonical §8.1 vocabulary, which lives in TypeScript. What the caller cannot
-- do is the part that matters — the kind, the organisation, the origin and the run are derived here
-- from the score row that was just written, and `same_org_ref` still guards every reference.

create or replace function api_server.finish_health(
  p_org       uuid,
  p_run       uuid,
  p_scores    jsonb,
  p_period_ids uuid[]
) returns integer
language plpgsql security definer set search_path = '' as $$
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
end $$;

alter function api_server.finish_health(uuid, uuid, jsonb, uuid[]) owner to motion_definer;
revoke all on function api_server.finish_health(uuid, uuid, jsonb, uuid[])
  from public, authenticated, anon;
grant execute on function api_server.finish_health(uuid, uuid, jsonb, uuid[]) to service_role;
