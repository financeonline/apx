-- MOTION — Advisory opportunities (SOW §20, REQ-AD-10; ADR-148).
--
-- The opportunity rules read each client's LATEST COMPLETE scored month — the same row
-- `api.portfolio_summary` reports as h1 — trimmed to what the rules need: each dimension's key,
-- whether it was included, its score, and each rule's points, band and value. Scoped exactly as
-- every Command Centre read is (`app.portfolio_scope`, ADR-117): POST, no id list in a URL, and
-- nothing outside what the caller advises now.

create function api.portfolio_health_breakdowns(p_orgs uuid[])
returns table (
  organization_id    uuid,
  health_score_id    uuid,
  period_label       text,
  config_version     text,
  evidence_bundle_id uuid,
  dimensions         jsonb
)
language sql stable security definer set search_path = '' as $$
  with latest as (
    select hc.organization_id, hs.id, p.label, hs.config_version, hs.breakdown,
           row_number() over (partition by hc.organization_id order by p.period_start desc) as rn
      from public.health_current hc
      join public.health_scores hs
        on hs.organization_id = hc.organization_id and hs.id = hc.health_score_id
      join public.fiscal_periods p
        on p.organization_id = hc.organization_id and p.id = hc.period_id
     where hc.organization_id in (select app.portfolio_scope(p_orgs))
       and p.is_complete
  )
  select l.organization_id, l.id, l.label, l.config_version,
         (select b.id from public.evidence_bundles b
           where b.organization_id = l.organization_id and b.kind = 'health_score'
             and b.origin_table = 'health_scores' and b.origin_id = l.id
           limit 1),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'key', d ->> 'key',
                    'included', (d ->> 'included')::boolean,
                    'score', d -> 'score',
                    'rules', coalesce((
                      select jsonb_agg(jsonb_build_object(
                               'rule', r ->> 'rule', 'points', r -> 'points',
                               'result', r ->> 'result', 'value', r ->> 'value',
                               'skipped', r ->> 'skipped_reason'))
                        from jsonb_array_elements(d -> 'rules') r), '[]'::jsonb)))
             from jsonb_array_elements(l.breakdown) d), '[]'::jsonb)
    from latest l
   where l.rn = 1
   order by l.organization_id;
$$;
alter function api.portfolio_health_breakdowns(uuid[]) owner to motion_definer;
revoke all on function api.portfolio_health_breakdowns(uuid[]) from public, anon;
grant execute on function api.portfolio_health_breakdowns(uuid[]) to authenticated;
