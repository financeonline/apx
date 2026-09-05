-- MOTION — Phase 1 · Audit, jobs, throttles and platform configuration.
-- Contract: DATABASE_ARCHITECTURE.md §9; ADR-015, ADR-020, ADR-026.4/5, ADR-043.3, ADR-044.5/6.

-- ---------------------------------------------------------------------------
-- audit_events — append-only, partitioned by month (DATABASE_ARCHITECTURE.md §9)
--
-- CONTRACT RESOLUTION (Phase 1 report, finding #2): §9 specifies `PK id bigint identity` AND
-- monthly partitioning. PostgreSQL requires the partition key to be part of every unique
-- constraint, so the primary key is (id, created_at); `id` keeps its identity sequence and stays
-- globally unique in practice. api_server.record_access_event returns that id and the Storage
-- signer verifies it (ADR-043.5).
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id              bigint generated always as identity,
  -- Deliberately NOT foreign keys (Phase 1 report, finding #10). The audit log is append-only and
  -- must outlive what it describes: `on delete set null` would both rewrite history and be refused
  -- by append_only_guard, making an organization impossible to delete. The purge job redacts
  -- payloads and keeps the rows, with the organization id intact so the events remain findable
  -- (SECURITY_MODEL.md §16, ADR-038.9).
  organization_id uuid,                                    -- NULL = platform event
  actor_user_id   uuid,
  actor_type      public.actor_type_enum not null,
  action          text not null,
  target_table    text,
  target_id       uuid,
  before          jsonb,
  after           jsonb,
  metadata        jsonb not null default '{}'::jsonb,
  ip              inet,
  user_agent      text,
  request_id      text,
  created_at      timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

create index audit_events_org_created_idx on public.audit_events (organization_id, created_at desc);
create index audit_events_actor_created_idx on public.audit_events (actor_user_id, created_at desc);
create index audit_events_action_created_idx on public.audit_events (action, created_at desc);

-- Monthly partitions. Created eagerly for a 24-month window; the DEFAULT partition guarantees no
-- insert is ever lost if the rolling job has not yet extended the window.
create function app.ensure_audit_partition(p_ts timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_start date := date_trunc('month', p_ts)::date;
  v_end   date := (date_trunc('month', p_ts) + interval '1 month')::date;
  v_name  text := 'audit_events_' || to_char(v_start, 'YYYYMM');
begin
  if not exists (select 1 from pg_catalog.pg_class where relname = v_name) then
    execute format(
      'create table public.%I partition of public.audit_events for values from (%L) to (%L)',
      v_name, v_start, v_end);
    execute format('alter table public.%I owner to motion_definer', v_name);
  end if;
end $$;

-- Creating a partition requires ownership of the parent, and the builder itself creates objects in
-- `public`: both must be motion_definer, which is the final owner of every table anyway (§11).
alter table public.audit_events owner to motion_definer;

-- The partition builder creates objects in `public`, so it must run as the role that owns them.
alter function app.ensure_audit_partition(timestamptz) owner to motion_definer;

do $$
declare i int;
begin
  for i in -12..12 loop
    perform app.ensure_audit_partition(now() + (i || ' months')::interval);
  end loop;
end $$;

create table public.audit_events_default partition of public.audit_events default;

-- ---------------------------------------------------------------------------
-- jobs — the background queue (ADR-020, ADR-031.1, ADR-043.3, ADR-044.6)
-- Phase 1 creates the table because api.enqueue_job is a Phase 3 slice-0 function and the
-- organization deletion trigger enqueues org.purge. The worker itself lands in Phase 4.
-- ---------------------------------------------------------------------------
create table public.jobs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid references public.organizations (id) on delete cascade,
  job_type         public.job_type_enum not null,
  idempotency_key  text,
  payload          jsonb not null default '{}'::jsonb,
  requested_by     uuid references public.profiles (id) on delete set null,
  status           public.job_status_enum not null default 'queued',
  attempts         smallint not null default 0,
  max_attempts     smallint not null default 3,
  run_after        timestamptz not null default now(),
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,
  result           jsonb,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Composite target for report_files.job_id, calculation_runs.job_id and
  -- import_batches.calculation_job_id (ADR-044.8).
  constraint jobs_org_id_unique unique (organization_id, id)
);
-- Queued-only idempotency: a running job must not swallow a new request (ADR-031.1).
create unique index jobs_idempotency_queued_unique
  on public.jobs (job_type, idempotency_key) where status = 'queued' and idempotency_key is not null;
create index jobs_claim_idx on public.jobs (status, run_after) where status = 'queued';
create index jobs_org_type_idx on public.jobs (organization_id, job_type, created_at desc);
create index jobs_org_active_idx on public.jobs (organization_id, status)
  where status in ('queued', 'running');
create trigger set_updated_at before update on public.jobs
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- api_rate_limits — database-side throttling of the RPC surface (ADR-044.5; R2-A-08)
-- The RPC surface is reachable directly on the Supabase host and never passes the Vercel edge,
-- so edge limits alone are not limits.
-- ---------------------------------------------------------------------------
create table public.api_rate_limits (
  actor_user_id uuid not null,
  bucket        text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (actor_user_id, bucket, window_start)
);
create index api_rate_limits_window_idx on public.api_rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- role_permissions — generated, read-only mirror of ROLE_MATRIX (ADR-003)
-- Regenerated by scripts/sync-permission-matrix.ts; the pgTAP parity test fails CI on drift.
-- ---------------------------------------------------------------------------
create table public.role_permissions (
  role       text not null,
  permission text not null,
  primary key (role, permission)
);

-- ---------------------------------------------------------------------------
-- platform_settings / platform_org_settings (ADR-038.5, ADR-038.11)
-- ---------------------------------------------------------------------------
create table public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.platform_settings
  for each row execute function app.set_updated_at();

create table public.platform_org_settings (
  organization_id             uuid primary key references public.organizations (id) on delete cascade,
  ai_quota_daily              integer,
  ai_token_ceiling_monthly    bigint,
  ai_extraction_pages_per_day integer,
  model_overrides             jsonb not null default '{}'::jsonb,
  notes                       text,
  updated_by                  uuid references public.profiles (id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create trigger set_updated_at before update on public.platform_org_settings
  for each row execute function app.set_updated_at();

comment on table public.platform_org_settings is
  'Platform-controlled per-organization values. Tenants can never edit these (ADR-038.5; F-A-09).';

-- Defaults referenced by later phases; seeded here so the keys exist from day one.
insert into public.platform_settings (key, value) values
  ('ai_quota_daily',              '100'::jsonb),
  ('ai_token_ceiling_monthly',    '20000000'::jsonb),
  ('ai_extraction_pages_per_day', '300'::jsonb),
  ('taxable_categories',          '["revenue","cost_of_sales","operating_expense","marketing"]'::jsonb);
