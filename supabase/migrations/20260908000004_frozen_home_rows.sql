-- MOTION — Tenancy · The frozen Home needs its rows (ADR-068).
-- Contract: TENANCY_MODEL.md §4 (suspension semantic), RBAC_MATRIX.md §3.7, SECURITY_MODEL.md §4,
--           DATABASE_ARCHITECTURE.md §7 (health_current: "one of the five frozen-Home tables"),
--           ADR-044.4; PRODUCTION_AUDIT.md H1.
--
-- ADR-044.4 promised that a suspended organisation's members "see the frozen Home and nothing
-- else", and named five tables that admit `suspended_member`: organizations, metric_current,
-- health_current, health_scores, alerts. Two of those five are POINTER tables. The figures Home
-- shows live in `metric_snapshots`, and the month it shows lives in `fiscal_periods` — neither of
-- which admitted the role. Executed in the audit: under suspension the owner's client read 0
-- periods, 0 snapshots and 0 rows from the join Home issues, and Home rendered "add your first file"
-- beneath the suspension banner.
--
-- Two policies change, as narrowly as the promise allows:
--   * `fiscal_periods` admits `suspended_member`. A period is a label and two dates.
--   * `metric_snapshots` admits `suspended_member` for the rows `metric_current` POINTS AT — the
--     frozen figures, and nothing of their history. A suspended member reads exactly what was on
--     Home when the organisation was suspended; a superseded run's figures stay out of reach.
-- Every other tenant-data policy is unchanged, and `suspended_member`'s one permission is unchanged.

-- The pointer lookup the second policy makes is per candidate row of the SUSPENDED organisation only
-- (the first branch short-circuits for every real role); it is indexed so that cost is a probe.
create index metric_current_by_snapshot
  on public.metric_current (organization_id, snapshot_id);

drop policy fiscal_periods_select on public.fiscal_periods;
create policy fiscal_periods_select on public.fiscal_periods for select to authenticated
  using (organization_id in (select app.org_ids_with_role(
           'owner', 'admin', 'employee', 'super_admin', 'client', 'suspended_member')));

drop policy metric_snapshots_select on public.metric_snapshots;
create policy metric_snapshots_select on public.metric_snapshots for select to authenticated
  using (
    organization_id in (select app.org_ids_with_role('owner', 'admin', 'employee', 'super_admin', 'client'))
    or (
      organization_id in (select app.org_ids_with_role('suspended_member'))
      and exists (
        select 1 from public.metric_current c
         where c.organization_id = metric_snapshots.organization_id
           and c.snapshot_id = metric_snapshots.id)
    )
  );
