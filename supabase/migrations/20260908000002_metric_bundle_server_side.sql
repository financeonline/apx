-- MOTION — Evidence · A metric bundle is built by the server, from the figure's own tree (ADR-066).
-- Contract: EVIDENCE_MODEL.md §5 (metric row), §8.1, §8.5, §8.6; SECURITY_MODEL.md §14; ADR-043;
--           PRODUCTION_AUDIT.md C2.
--
-- `api.build_metric_bundle(snapshot, items)` was granted to `authenticated` and trusted every field
-- of every item except `item_type`. A client — the least-privileged tenant role — could therefore
-- attach a `query` item with any label, any claim text and any descriptor to any figure in the
-- organisation; the bundle was attributed to the system, was immutable, was returned to every later
-- reader of that figure, and was not audited. Executed in the audit: the owner's revenue figure,
-- "evidenced" by payroll rows under a fabricated label, with a reconciliation sentence saying the
-- figure had no support.
--
-- The items still come from TypeScript, for the reason ADR-059.2 gives (the descriptor hash and the
-- labels have one implementation, and it is not plpgsql). What changes is WHO may hand them over
-- and WHAT is checked on the way in:
--
--   1. Only the server. The function lives in `api_server` behind the service-role guard, and the
--      human actor is passed explicitly and re-validated with `app.has_permission_of` (ADR-043).
--      There is no bundle-writing surface a browser token can reach at all.
--   2. Every item must be DERIVABLE from the snapshot. A metric bundle is the engine's evidence
--      (ADR-034: the snapshot is its own evidence root), so nothing a caller adds to it can be:
--        - a `metric_snapshot` item names the root or a component reachable from it;
--        - a `calculation_run` item names the snapshot's run;
--        - a `counterparty` / `account` item names the snapshot's dimension;
--        - a `query` item's descriptor is a leaf of the snapshot's own evidence tree;
--        - no item carries `claim` text — a metric bundle holds figures, not sentences.
--   3. One bundle per snapshot, by index, not by hope: `evidence_bundles_metric_origin_unique`
--      replaces the "loser of the race discards its own" comment, which described no mechanism.
--   4. It is audited (`evidence.bundle_built`, with the actor).
--
-- The `query` comparison strips `order` and normalises an absent `filters` to `{}` because the
-- TypeScript schema appends the terminal order and defaults the filters when it PARSES a stored
-- descriptor (domain/descriptor.ts), so the parsed form a caller sends legitimately differs from
-- the stored form in exactly those two ways and no other.

-- ---------------------------------------------------------------------------
-- One metric bundle per snapshot.
-- ---------------------------------------------------------------------------
do $$
declare v_dupes integer;
begin
  select count(*) into v_dupes from (
    select 1 from public.evidence_bundles
     where kind = 'metric'
     group by organization_id, origin_table, origin_id
    having count(*) > 1) d;
  if v_dupes > 0 then
    -- Evidence is append-only; a migration does not decide which of two bundles was the answer.
    raise exception 'ADR-066: % snapshot(s) carry more than one metric bundle; resolve before migrating', v_dupes;
  end if;
end $$;

create unique index evidence_bundles_metric_origin_unique
  on public.evidence_bundles (organization_id, origin_table, origin_id)
  where kind = 'metric';

-- ---------------------------------------------------------------------------
-- The server-side builder.
-- ---------------------------------------------------------------------------
create function api_server.build_metric_bundle_as(p_actor uuid, p_snapshot uuid, p_items jsonb)
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
         coalesce(jsonb_agg(t.evidence_query -> 'descriptor')
                    filter (where t.evidence_query ->> 'kind' = 'leaf'), '[]'::jsonb)
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

-- The browser-reachable twin is gone, not merely revoked: a function that exists with no grant is
-- a function somebody will one day grant back.
drop function api.build_metric_bundle(uuid, jsonb);
