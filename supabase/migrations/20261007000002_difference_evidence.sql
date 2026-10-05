-- MOTION — Step 0E · evidence for a figure that is a DIFFERENCE of two periods' records.
--
-- A cumulative trial balance's or P&L report's month is year-to-date(P) − year-to-date(P−1) (§3). No
-- single row selection totals to it (ADR-109), so its `evidence_query` is `kind: 'difference'`: the
-- formula and two terms, each with its own leaf descriptor (or the reason it is unavailable). A metric
-- bundle accepts a query item only for a leaf of the figure's evidence tree; this teaches the builder
-- that a difference's term descriptors are such leaves. Nothing else in the function changes.

create or replace function api_server.build_metric_bundle_as(p_actor uuid, p_snapshot uuid, p_items jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org      uuid;
  v_run      uuid;
  v_dim_id   uuid;
  v_bundle   uuid;
  v_tree_ids uuid[];
  v_leaves   jsonb;
  v_item     jsonb;
  v_type     public.evidence_item_enum;
  v_ref      uuid;
  v_desc     jsonb;
  v_sort     integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null then
    raise exception 'PERMISSION_DENIED: an actor is required' using errcode = '42501';
  end if;

  select s.organization_id, s.calculation_run_id, s.dimension_id
    into v_org, v_run, v_dim_id
    from public.metric_snapshots s
   where s.id = p_snapshot;
  -- An actor with no standing in the organisation learns nothing, not even that the snapshot
  -- exists (SECURITY_MODEL.md §14). financials.view is held by every real role and by nobody else.
  if v_org is null or not app.has_permission_of(p_actor, v_org, 'financials.view') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Serialised per snapshot, so two first clicks build one bundle rather than racing to the index.
  perform pg_advisory_xact_lock(hashtext('metric_bundle:' || p_snapshot::text));

  select b.id into v_bundle
    from public.evidence_bundles b
   where b.organization_id = v_org
     and b.kind = 'metric'
     and b.origin_table = 'metric_snapshots'
     and b.origin_id = p_snapshot;
  if v_bundle is not null then
    return v_bundle;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    -- §8.6: no orphan claims. An empty bundle is never created.
    raise exception 'VALIDATION: a metric bundle needs at least one item' using errcode = '22023';
  end if;

  -- The snapshot's own evidence tree (ADR-034): the root, every component reachable from it, and
  -- the leaf descriptors. Bounded in depth and cycle-checked; the engine writes neither, but a
  -- recursive walk that trusts its input is how a bug becomes an outage.
  with recursive tree as (
    select s.id, s.evidence_query, 0 as depth, array[s.id] as path
      from public.metric_snapshots s
     where s.organization_id = v_org and s.id = p_snapshot
    union all
    select c.id, c.evidence_query, t.depth + 1, t.path || c.id
      from tree t
      cross join lateral jsonb_array_elements(t.evidence_query -> 'components') comp
      join public.metric_snapshots c
        on c.organization_id = v_org and c.id = (comp ->> 'snapshot_id')::uuid
     where t.evidence_query ->> 'kind' = 'derived'
       and t.depth < 32
       and not (c.id = any (t.path))
  )
  select array_agg(t.id),
         -- Step 0E: a `difference` figure's two period selections are leaves of its tree too.
         coalesce((select jsonb_agg(l.d)
                     from tree t2
                     cross join lateral (
                       select t2.evidence_query -> 'descriptor' as d
                        where t2.evidence_query ->> 'kind' = 'leaf'
                       union all
                       select term -> 'descriptor'
                         from jsonb_array_elements(case when t2.evidence_query ->> 'kind' = 'difference'
                                                        then t2.evidence_query -> 'terms' else '[]'::jsonb end) term
                        where coalesce(term -> 'descriptor', 'null'::jsonb) <> 'null'::jsonb
                     ) l), '[]'::jsonb)
    into v_tree_ids, v_leaves
    from tree t;

  insert into public.evidence_bundles (organization_id, kind, origin_table, origin_id,
                                       calculation_run_id, created_by_type, created_by)
  values (v_org, 'metric', 'metric_snapshots', p_snapshot, v_run, 'system', null)
  returning id into v_bundle;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_type := (v_item ->> 'item_type')::public.evidence_item_enum;
    v_ref  := nullif(v_item ->> 'ref_id', '')::uuid;
    v_desc := case when coalesce(v_item -> 'query_descriptor', 'null'::jsonb) = 'null'::jsonb
                   then null else v_item -> 'query_descriptor' end;

    -- The vocabulary §5 gives a metric bundle, and nothing else.
    if v_type not in ('metric_snapshot', 'calculation_run', 'query', 'counterparty', 'account') then
      raise exception 'VALIDATION: % is not an item type a metric bundle may carry', v_type
        using errcode = '22023';
    end if;
    if nullif(v_item ->> 'claim', '') is not null then
      raise exception 'VALIDATION: a metric bundle carries figures, not claims' using errcode = '22023';
    end if;

    -- Derivable from the snapshot, or refused.
    if v_type = 'metric_snapshot' and (v_ref is null or not (v_ref = any (v_tree_ids))) then
      raise exception 'VALIDATION: % is not a snapshot in this figure''s evidence tree', v_ref
        using errcode = '22023';
    end if;
    if v_type = 'calculation_run' and v_ref is distinct from v_run then
      raise exception 'VALIDATION: % is not the run that produced this figure', v_ref
        using errcode = '22023';
    end if;
    if v_type in ('counterparty', 'account') and (v_dim_id is null or v_ref is distinct from v_dim_id) then
      raise exception 'VALIDATION: % is not the dimension this figure is about', v_ref
        using errcode = '22023';
    end if;
    if v_type = 'query' then
      if v_desc is null or nullif(v_item ->> 'descriptor_hash', '') is null then
        raise exception 'VALIDATION: a query item needs a descriptor and its hash' using errcode = '22023';
      end if;
      if not exists (
        select 1 from jsonb_array_elements(v_leaves) l
         where ((l - 'order') || jsonb_build_object('filters', coalesce(l -> 'filters', '{}'::jsonb)))
             = ((v_desc - 'order') || jsonb_build_object('filters', coalesce(v_desc -> 'filters', '{}'::jsonb)))
      ) then
        raise exception 'VALIDATION: that descriptor is not a leaf of this figure''s evidence tree'
          using errcode = '22023';
      end if;
    elsif v_desc is not null then
      raise exception 'VALIDATION: only a query item carries a descriptor' using errcode = '22023';
    end if;

    insert into public.evidence_items (organization_id, bundle_id, sort_order, item_type,
                                       ref_id, query_descriptor, descriptor_hash,
                                       label, claim, assurance_level)
    values (v_org, v_bundle, v_sort, v_type,
            v_ref, v_desc,
            case when v_item ->> 'descriptor_hash' is null then null
                 else decode(v_item ->> 'descriptor_hash', 'hex') end,
            v_item ->> 'label',
            null,
            (v_item ->> 'assurance_level')::public.assurance_level_enum);
    v_sort := v_sort + 1;
  end loop;

  perform app.audit(v_org, 'evidence.bundle_built', 'evidence_bundles', v_bundle, null,
                    jsonb_build_object('snapshot_id', p_snapshot, 'items', v_sort),
                    '{}'::jsonb, p_actor);
  return v_bundle;
end $$;

alter function api_server.build_metric_bundle_as(uuid, uuid, jsonb) owner to motion_definer;
revoke all on function api_server.build_metric_bundle_as(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function api_server.build_metric_bundle_as(uuid, uuid, jsonb) to service_role;
