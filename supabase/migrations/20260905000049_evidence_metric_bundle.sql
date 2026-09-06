-- MOTION — Evidence UI · The bundle behind a number.
-- Contract: EVIDENCE_MODEL.md §5 (metric row), §8.1/§8.5; IMPLEMENTATION_PLAN.md Phase 10 slice 1;
-- ADR-026, ADR-034.
--
-- A metric snapshot IS its own evidence root: `metric_snapshots.evidence_query` is either a `leaf`
-- descriptor or a `derived` list of component snapshot ids. Nothing is written at run time, because
-- most numbers are never opened. This materialises the bundle the first time somebody asks "Why?",
-- and returns the same bundle every time after — bundles are immutable (§8.1), so a second one for
-- the same snapshot would be a second answer to a question with one answer.
--
-- The ITEMS come from the caller (`evidence/services/build-metric.ts`), for one reason: a `query`
-- item must carry `descriptor_hash`, and the hash is RFC 8785 canonical JSON + sha256 computed by
-- the single TypeScript implementation (EVIDENCE_MODEL.md §3, ADR-046.2). A second canonicalisation
-- in plpgsql would eventually disagree with the first, and two hashes for one descriptor defeats the
-- point of having one. Labels come from the same side for the same reason: the plain-language
-- vocabulary is `UX_ARCHITECTURE.md §8.1` and the metric registry, both of which live in TypeScript.
--
-- What the caller therefore CANNOT do is the part that matters: the bundle's kind, organization,
-- origin and run are derived here from the snapshot, `item_type` is restricted to the metric
-- vocabulary, and every `ref_id` still passes `same_org_ref`. The drawer re-resolves every reference
-- and every descriptor from the referenced objects under RLS, so a label is a caption, never a fact.

create function api.build_metric_bundle(p_snapshot uuid, p_items jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org    uuid;
  v_run    uuid;
  v_bundle uuid;
  v_item   jsonb;
  v_type   public.evidence_item_enum;
  v_sort   integer := 0;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select s.organization_id, s.calculation_run_id into v_org, v_run
    from public.metric_snapshots s where s.id = p_snapshot;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'financials.view');

  -- Idempotent by (organization, snapshot). Two readers opening the same figure at the same moment
  -- both get a bundle; the loser of the race discards its own rather than leaving two.
  select b.id into v_bundle
    from public.evidence_bundles b
   where b.organization_id = v_org
     and b.kind = 'metric'
     and b.origin_table = 'metric_snapshots'
     and b.origin_id = p_snapshot
   limit 1;
  if v_bundle is not null then
    return v_bundle;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    -- §8.6: no orphan claims. An empty bundle is never created; the caller is told rather than
    -- handed an id that opens an empty drawer.
    raise exception 'VALIDATION: a metric bundle needs at least one item' using errcode = '22023';
  end if;

  insert into public.evidence_bundles (organization_id, kind, origin_table, origin_id,
                                       calculation_run_id, created_by_type, created_by)
  values (v_org, 'metric', 'metric_snapshots', p_snapshot, v_run, 'system', null)
  returning id into v_bundle;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_type := (v_item->>'item_type')::public.evidence_item_enum;

    -- The vocabulary §5 gives a metric bundle, and nothing else. An `alert` or `ai_response` item
    -- reached through this function would be evidence nobody produced.
    if v_type not in ('metric_snapshot', 'calculation_run', 'query', 'counterparty', 'account') then
      raise exception 'VALIDATION: % is not an item type a metric bundle may carry', v_type
        using errcode = '22023';
    end if;

    insert into public.evidence_items (organization_id, bundle_id, sort_order, item_type,
                                       ref_id, query_descriptor, descriptor_hash,
                                       label, claim, assurance_level)
    values (v_org, v_bundle, v_sort, v_type,
            nullif(v_item->>'ref_id', '')::uuid,
            case when coalesce(v_item->'query_descriptor', 'null'::jsonb) = 'null'::jsonb
                 then null else v_item->'query_descriptor' end,
            case when v_item->>'descriptor_hash' is null then null
                 else decode(v_item->>'descriptor_hash', 'hex') end,
            v_item->>'label',
            nullif(v_item->>'claim', ''),
            (v_item->>'assurance_level')::public.assurance_level_enum);
    v_sort := v_sort + 1;
  end loop;

  return v_bundle;
end $$;

alter function api.build_metric_bundle(uuid, jsonb) owner to motion_definer;
revoke all on function api.build_metric_bundle(uuid, jsonb) from public, anon;
grant execute on function api.build_metric_bundle(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The rate limit for a route, applied where the counter already lives.
-- ---------------------------------------------------------------------------------------------
--
-- `ROUTE_ARCHITECTURE.md §164` puts 60/min on `/api/documents/[documentId]/url`. Every `api.*`
-- function already throttles through `app.throttle`, whose counter is the `api_rate_limits` table —
-- but `app` is deliberately not on PostgREST's exposed schema list, so a route cannot reach it.
-- A second, in-process counter would be a second answer: it would reset on every deploy and would
-- not be shared between instances, which is precisely what a download limit must survive.
create function api_server.throttle(
  p_actor  uuid,
  p_bucket text,
  p_limit  integer,
  p_window interval
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- The guard every `api_server.*` function carries (ADR-043), and pgTAP asserts is present in the
  -- body of each: a REVOKE alone is one migration away from being undone by accident.
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  perform app.throttle(p_actor, p_bucket, p_limit, p_window);
end $$;

alter function api_server.throttle(uuid, text, integer, interval) owner to motion_definer;
revoke all on function api_server.throttle(uuid, text, integer, interval) from public, authenticated, anon;
grant execute on function api_server.throttle(uuid, text, integer, interval) to service_role;
