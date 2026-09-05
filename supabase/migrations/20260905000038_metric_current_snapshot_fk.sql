-- MOTION — Phase 5 (plan Phase 7) · `metric_current.snapshot_id` gains its composite foreign key.
-- Contract: DATABASE_ARCHITECTURE.md §6 ("`snapshot_id → metric_snapshots (org-composite)`");
-- ADR-044.8 (every tenant→tenant reference is composite).
--
-- The column was created without the key, so nothing stopped a pointer naming a snapshot belonging
-- to another organization — the single reference on the dashboard's hot path, and the one that
-- decides which figure a customer sees. It also meant PostgREST could not resolve the join, so the
-- dashboard could not read a metric and its snapshot in one request at all. Found by the Home
-- integration test.
--
-- `metric_snapshots` is hash-partitioned, so the composite target needs its own unique index; the
-- primary key is (id, organization_id) and a foreign key must reference the columns in the order the
-- index declares them.

create unique index metric_snapshots_org_id_unique
  on public.metric_snapshots (organization_id, id);

alter table public.metric_current
  add constraint metric_current_snapshot_fk
  foreign key (organization_id, snapshot_id)
  references public.metric_snapshots (organization_id, id) on delete cascade;

-- The same reference on `health_current` is already composite; this one was the omission.
comment on constraint metric_current_snapshot_fk on public.metric_current is
  'The current snapshot per (period, metric, dimension). Composite so a pointer can never name '
  'another organization''s figure (ADR-044.8).';
