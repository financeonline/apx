-- MOTION — Phase 2 (plan Phase 4) · Calculation runs, metrics, health, alerts, evidence and the
-- record lifecycle log.
-- Contract: DATABASE_ARCHITECTURE.md §6; ADR-008, ADR-009, ADR-031, ADR-034, ADR-036, ADR-046,
-- ADR-047.

-- ---------------------------------------------------------------------------------------------
-- Calculation runs (ADR-008, ADR-031, ADR-047.7)
-- ---------------------------------------------------------------------------------------------
create table public.calculation_runs (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  job_id             uuid,
  trigger            public.calculation_trigger_enum not null,
  trigger_ref_id     uuid,                              -- polymorphic; guarded by same_org_ref
  engine_version     text not null,
  period_from        uuid not null,
  period_to          uuid not null,
  -- ADR-031.2: part of the fingerprint when the run touches the current period, because
  -- "overdue today" changes meaning overnight even when no record changed.
  as_of              date not null,
  -- ADR-046.2 / R2-C-10: the transaction snapshot time of the aggregation step. Evidence resolves
  -- as-of THIS instant, not finished_at — a run that takes four minutes must not appear to have read
  -- rows committed during those four minutes.
  as_of_ts           timestamptz not null default now(),
  status             public.calculation_status_enum not null default 'queued',
  failure_reason     public.calculation_failure_enum,
  -- ADR-031.1 / ADR-046.2: set by the record_superseded and counterparty_merged triggers when a
  -- change lands after started_at. The worker loops until it is clear, so a run can never publish
  -- numbers computed from data that moved underneath it.
  stale              boolean not null default false,
  -- ADR-047.8: computed BEFORE any write, from aggregate metadata. A run whose fingerprint equals
  -- the last succeeded run's finishes immediately as succeeded with stats.no_change.
  input_fingerprint  bytea,
  -- ADR-047.7: one entry per chunk, {cursor, aggregated_at, finished_at}. The descriptor as_of
  -- instant is per chunk, because a chunked run spans several transactions.
  chunks             jsonb not null default '[]'::jsonb,
  progress           jsonb not null default '{}'::jsonb,
  started_at         timestamptz,
  finished_at        timestamptz,
  duration_ms        integer,
  error              jsonb,
  stats              jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint calculation_runs_org_id_unique unique (organization_id, id),
  constraint calculation_runs_job_fk
    foreign key (organization_id, job_id) references public.jobs (organization_id, id) on delete set null,
  constraint calculation_runs_period_from_fk
    foreign key (organization_id, period_from) references public.fiscal_periods (organization_id, id),
  constraint calculation_runs_period_to_fk
    foreign key (organization_id, period_to) references public.fiscal_periods (organization_id, id)
);

create index calculation_runs_recent on public.calculation_runs (organization_id, created_at desc);
create index calculation_runs_running
  on public.calculation_runs (organization_id, status) where status = 'running';

-- import_batches.calculation_run_id can now be constrained.
alter table public.import_batches
  add constraint import_batches_run_fk foreign key (organization_id, calculation_run_id)
      references public.calculation_runs (organization_id, id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- Metric snapshots (ADR-008, ADR-005, ADR-031.5)
-- ---------------------------------------------------------------------------------------------
-- Partitioned by hash of organization_id from day one: this is the largest table in the system
-- (periods × metrics × dimensions × runs) and repartitioning later would require downtime.
--
-- Two consequences of partitioning, both forced by Postgres rather than chosen:
--   * The primary key must contain the partition key, so it is (id, organization_id) rather than
--     (id). `id` alone is still globally unique in practice — it is a uuid — and every composite
--     foreign key that targets this table uses (organization_id, id) anyway.
--   * The uniqueness rule from DATABASE_ARCHITECTURE.md §6 —
--     (calculation_run_id, period_id, metric_key, dimension_type, dimension_id) — must likewise
--     include organization_id. That does not weaken it: calculation_run_id is already org-scoped by
--     its own composite FK, so the two forms admit exactly the same rows.
create table public.metric_snapshots (
  id                 uuid not null default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  calculation_run_id uuid not null,
  period_id          uuid not null,
  metric_key         text not null,                     -- FINANCIAL_ENGINE.md §3 registry
  dimension_type     public.metric_dimension_enum not null default 'none',
  dimension_id       uuid,
  -- NULL means "not computable", which is a real and distinct answer from zero. The engine must
  -- never coerce one into the other (FINANCIAL_ENGINE.md §5).
  value              numeric(20,6),
  unit               public.metric_unit_enum not null,
  currency           char(3),
  basis              public.metric_basis_enum not null,
  assurance_level    public.assurance_level_enum not null,
  data_quality       jsonb not null default '{}'::jsonb,
  -- Named inputs with values AND snapshot ids (ADR-034), so a derived metric can be walked down to
  -- the leaves without re-deriving anything.
  components         jsonb not null default '{}'::jsonb,
  -- ADR-009/ADR-034: {kind:'leaf', descriptor} for metrics computed directly from records, or
  -- {kind:'derived', components:[{name, snapshot_id}]}. Descriptors name account_ids and
  -- bank_account_ids resolved at run time, never standard_categories.
  evidence_query     jsonb,
  created_at         timestamptz not null default now(),
  primary key (id, organization_id)
) partition by hash (organization_id);

do $$
begin
  for i in 0..7 loop
    execute format(
      'create table public.metric_snapshots_p%s partition of public.metric_snapshots
         for values with (modulus 8, remainder %s)', i, i);
  end loop;
end $$;

-- NULLS NOT DISTINCT (Postgres 15+) is essential here: dimension_id is NULL both for
-- dimension_type='none' and for the synthetic "Unattributed" breakdown row, and under the default
-- NULLS DISTINCT those rows would be free to duplicate without limit.
create unique index metric_snapshots_cell_unique
  on public.metric_snapshots (organization_id, calculation_run_id, period_id, metric_key,
                              dimension_type, dimension_id) nulls not distinct;
create index metric_snapshots_by_run on public.metric_snapshots (organization_id, calculation_run_id);
create index metric_snapshots_by_metric on public.metric_snapshots (organization_id, period_id, metric_key);

-- ---------------------------------------------------------------------------------------------
-- metric_current — the pointer table (ADR-031.5, ADR-047.7)
-- ---------------------------------------------------------------------------------------------
-- Replaces a per-row `is_current` flag. A run deletes every pointer in its period range and inserts
-- pointers for what it wrote, so a dimension that vanished (a remapped category, a merged
-- counterparty) is retired in the same transaction rather than lingering as a stale current row.
--
-- The key is a UNIQUE INDEX rather than a PRIMARY KEY because dimension_id is nullable and a primary
-- key may not contain NULLs — while NULL is exactly the value the 'none' dimension needs.
create table public.metric_current (
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  period_id             uuid not null,
  metric_key            text not null,
  dimension_type        public.metric_dimension_enum not null default 'none',
  dimension_id          uuid,
  snapshot_id           uuid not null,
  calculation_run_id    uuid not null,
  -- ADR-047.7: the pointer this run replaced, so a failed run can restore its whole range.
  previous_snapshot_id  uuid,
  updated_at            timestamptz not null default now(),
  constraint metric_current_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id) on delete cascade,
  constraint metric_current_run_fk
    foreign key (organization_id, calculation_run_id)
    references public.calculation_runs (organization_id, id) on delete cascade
);

create unique index metric_current_cell_unique
  on public.metric_current (organization_id, period_id, metric_key, dimension_type, dimension_id)
  nulls not distinct;
create index metric_current_by_metric on public.metric_current (organization_id, metric_key, period_id);

-- ---------------------------------------------------------------------------------------------
-- Health scores (ADR-030.4, ADR-031.5, ADR-035)
-- ---------------------------------------------------------------------------------------------
create table public.health_scores (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  calculation_run_id  uuid not null,
  period_id           uuid not null,
  score               smallint constraint health_scores_range check (score is null or score between 0 and 100),
  dimensions_used     smallint not null,
  dimensions_total    smallint not null,
  -- ADR-035: rule inputs that used to read `alerts` rows (K3, B3) are condition counts recorded here
  -- with their contributing snapshot ids, so the health score does not depend on alert persistence.
  breakdown           jsonb not null default '[]'::jsonb,
  config_version      text not null,
  created_at          timestamptz not null default now(),
  constraint health_scores_org_id_unique unique (organization_id, id),
  constraint health_scores_run_period_unique unique (organization_id, period_id, calculation_run_id),
  constraint health_scores_run_fk
    foreign key (organization_id, calculation_run_id) references public.calculation_runs (organization_id, id),
  constraint health_scores_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id)
);

create index health_scores_by_period on public.health_scores (organization_id, period_id);

-- The health equivalent of metric_current, rewritten per run in the same way.
create table public.health_current (
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  period_id         uuid not null,
  health_score_id   uuid not null,
  updated_at        timestamptz not null default now(),
  primary key (organization_id, period_id),
  constraint health_current_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id) on delete cascade,
  constraint health_current_score_fk
    foreign key (organization_id, health_score_id) references public.health_scores (organization_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Alerts and their revision history (ADR-018, ADR-034, ADR-036, ADR-046.1, ADR-047.2)
-- ---------------------------------------------------------------------------------------------
create table public.alerts (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  rule_key              text not null,
  rule_version          text not null,
  severity              public.severity_enum not null,
  metric_key            text,
  period_id             uuid not null,
  subject_type          public.alert_subject_enum not null default 'none',
  subject_id            uuid,                            -- polymorphic; guarded by same_org_ref
  title                 text not null,
  explanation           text not null,
  threshold_summary     jsonb not null default '{}'::jsonb,
  recommended_next_step text,
  -- ADR-046.1 / R2-C-09: the alert's evidence bundle is reached through the CURRENT revision, not a
  -- second pointer on this row. One pointer cannot drift out of step with the revision history.
  current_revision_id   uuid,
  status                public.alert_status_enum not null default 'open',
  status_changed_by     uuid references public.profiles (id) on delete set null,
  status_changed_at     timestamptz,
  status_reason_code    public.alert_status_reason_enum not null default 'user',
  status_reason         text,
  action_id             uuid,
  -- ADR-036: state rules key by (rule_key, subject); event rules by (rule_key, period_id, subject).
  dedupe_key            text not null,
  key_kind              public.alert_key_kind_enum not null,
  calculation_run_id    uuid not null,
  first_seen_at         timestamptz not null default now(),
  reopened_at           timestamptz,                     -- ADR-047.2
  dismissed_at          timestamptz,                     -- ADR-047.2 (90-day dismissal cooldown)
  last_evaluated_at     timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint alerts_org_id_unique unique (organization_id, id),
  constraint alert_dedupe unique (organization_id, dedupe_key),
  constraint alerts_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id),
  constraint alerts_run_fk
    foreign key (organization_id, calculation_run_id) references public.calculation_runs (organization_id, id)
);

create index alerts_status_severity on public.alerts (organization_id, status, severity);
create index alerts_by_period on public.alerts (organization_id, period_id);

create table public.alert_revisions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  alert_id            uuid not null,
  revision_no         integer not null,
  rule_version        text not null,
  severity            public.severity_enum not null,
  explanation         text not null,
  threshold_summary   jsonb not null default '{}'::jsonb,
  evidence_bundle_id  uuid,
  calculation_run_id  uuid not null,
  created_at          timestamptz not null default now(),
  constraint alert_revisions_org_id_unique unique (organization_id, id),
  constraint alert_revisions_no_unique unique (alert_id, revision_no),
  constraint alert_revisions_alert_fk
    foreign key (organization_id, alert_id) references public.alerts (organization_id, id) on delete cascade,
  constraint alert_revisions_run_fk
    foreign key (organization_id, calculation_run_id) references public.calculation_runs (organization_id, id)
);

alter table public.alerts
  add constraint alerts_current_revision_fk foreign key (organization_id, current_revision_id)
      references public.alert_revisions (organization_id, id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- Evidence (ADR-009, ADR-032.6, ADR-034)
-- ---------------------------------------------------------------------------------------------
create table public.evidence_bundles (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  kind                public.evidence_kind_enum not null,
  origin_table        text not null,
  origin_id           uuid,                              -- polymorphic; guarded by same_org_ref
  calculation_run_id  uuid,                              -- the as-of run
  created_by_type     public.evidence_creator_enum not null default 'system',
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint evidence_bundles_org_id_unique unique (organization_id, id),
  constraint evidence_bundles_run_fk
    foreign key (organization_id, calculation_run_id) references public.calculation_runs (organization_id, id)
);

alter table public.alert_revisions
  add constraint alert_revisions_bundle_fk foreign key (organization_id, evidence_bundle_id)
      references public.evidence_bundles (organization_id, id);

create table public.evidence_items (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  bundle_id         uuid not null,
  sort_order        integer not null default 0,
  item_type         public.evidence_item_enum not null,
  ref_id            uuid,                                -- polymorphic; guarded by same_org_ref
  -- ADR-034: an `alert` item pins a specific revision, because an alert's text and severity change
  -- between evaluations and the evidence must show what it said when it was cited.
  ref_revision_no   integer,
  query_descriptor  jsonb,
  -- sha256 of the RFC 8785 canonical descriptor. An AI bundle may carry a `query` item only when
  -- this hash matches a descriptor a tool returned in the same turn (ADR-032.6).
  descriptor_hash   bytea,
  label             text not null,
  claim             text,
  assurance_level   public.assurance_level_enum not null,
  created_at        timestamptz not null default now(),
  constraint evidence_items_org_id_unique unique (organization_id, id),
  constraint evidence_items_bundle_fk
    foreign key (organization_id, bundle_id) references public.evidence_bundles (organization_id, id) on delete cascade,
  -- An item points at a record OR describes a selection. Both would be ambiguous about what the
  -- reader is being shown; neither would be an item that supports nothing.
  constraint evidence_item_xor
    check ((ref_id is not null) <> (query_descriptor is not null)),
  constraint evidence_items_query_needs_hash
    check (query_descriptor is null or descriptor_hash is not null),
  constraint evidence_items_revision_only_for_alerts
    check (ref_revision_no is null or item_type = 'alert')
);

create index evidence_items_by_bundle on public.evidence_items (organization_id, bundle_id, sort_order);
create index evidence_items_by_ref on public.evidence_items (organization_id, item_type, ref_id);

-- ---------------------------------------------------------------------------------------------
-- record_status_events (ADR-034, ADR-046.1/2, ADR-047.1)
-- ---------------------------------------------------------------------------------------------
-- The append-only lifecycle log for the four financial record tables. `superseded_by` on the record
-- is the current state; this table is the history. That separation is what lets the evidence
-- resolver reconstruct which rows were accepted at any past instant, and what makes a rollback
-- reversible: resetting a column loses information, appending an event does not.
create table public.record_status_events (
  id                 bigint generated always as identity,
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  record_table       public.financial_record_table_enum not null,
  record_id          uuid not null,                     -- polymorphic; guarded by same_org_ref
  event              public.record_status_event_enum not null,
  related_record_id  uuid,                              -- the superseding or restored row
  import_batch_id    uuid,
  actor_user_id      uuid references public.profiles (id) on delete set null,
  at                 timestamptz not null default now(),
  primary key (id),
  constraint record_status_events_batch_fk
    foreign key (organization_id, import_batch_id) references public.import_batches (organization_id, id) on delete cascade
);

create index record_status_events_record
  on public.record_status_events (organization_id, record_table, record_id, at);
create index record_status_events_batch
  on public.record_status_events (organization_id, import_batch_id);
