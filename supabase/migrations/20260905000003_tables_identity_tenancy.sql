-- MOTION — Phase 1 · Identity and tenancy tables.
-- Contract: DATABASE_ARCHITECTURE.md §1 (Identity), §2 (Tenancy); TENANCY_MODEL.md §2, §3, §6.

-- Shared timestamp trigger (DATABASE_ARCHITECTURE.md §12 `set_updated_at`).
create function app.set_updated_at() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- organizations — the tenant root (TENANCY_MODEL.md §2, ADR-001)
-- ---------------------------------------------------------------------------
create table public.organizations (
  id                       uuid primary key default gen_random_uuid(),
  slug                     extensions.citext not null unique
                             constraint organizations_slug_format check (slug ~ '^[a-z0-9-]{3,40}$'),
  name                     text not null constraint organizations_name_len check (length(name) between 1 and 200),
  legal_name               text,
  country_code             char(2),
  base_currency            char(3) not null default 'GBP',
  fiscal_year_start_month  smallint not null default 1
                             constraint organizations_fy_month check (fiscal_year_start_month between 1 and 12),
  industry                 text,
  kind                     public.org_kind_enum not null default 'customer',
  status                   public.org_status_enum not null default 'active',
  plan                     public.org_plan_enum not null default 'trial',
  features                 jsonb not null default '{}'::jsonb,
  -- Tenant-editable only: alert prefs, vat_registered, default_vat_rate. Never quotas — those live
  -- in platform_org_settings (ADR-038.5; F-A-09).
  settings                 jsonb not null default '{}'::jsonb,
  timezone                 text not null default 'Europe/London',   -- ADR-030.5
  deletion_requested_at    timestamptz,
  created_by               uuid,
  deleted_at               timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint organizations_org_id_unique unique (id)
);
create index organizations_status_idx on public.organizations (status);
create trigger set_updated_at before update on public.organizations
  for each row execute function app.set_updated_at();

comment on column public.organizations.settings is
  'Tenant-editable settings only. Quotas and model overrides live in platform_org_settings (ADR-038.5).';

-- ---------------------------------------------------------------------------
-- profiles — application mirror of auth.users (DATABASE_ARCHITECTURE.md §1)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  email              extensions.citext not null unique,
  full_name          text,
  avatar_url         text,
  last_active_org_id uuid,
  timezone           text not null default 'Europe/London',
  onboarding_state   jsonb not null default '{}'::jsonb,
  disabled_at        timestamptz,
  -- Mirrored from auth by the profiles_from_auth / profiles_email_sync triggers. MOTION never
  -- reads the auth schema directly (see 20260905000001_foundation.sql).
  email_confirmed_at timestamptz,
  -- Stamped by api.confirm_mfa_enrolment(), which requires the caller's own session to already be
  -- aal2 — a state only GoTrue can produce after a real TOTP verification.
  mfa_enrolled_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger set_updated_at before update on public.profiles
  for each row execute function app.set_updated_at();

-- Circular references resolved after both tables exist.
alter table public.profiles
  add constraint profiles_last_active_org_fk
  foreign key (last_active_org_id) references public.organizations (id) on delete set null;
alter table public.organizations
  add constraint organizations_created_by_fk
  foreign key (created_by) references public.profiles (id) on delete set null;

-- ---------------------------------------------------------------------------
-- platform_users — platform role grants (ADR-002)
-- ---------------------------------------------------------------------------
create table public.platform_users (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  platform_role public.platform_role_enum not null,
  status        public.platform_user_status_enum not null default 'active',
  granted_by    uuid references public.profiles (id) on delete set null,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index platform_users_role_idx on public.platform_users (platform_role, status);
create trigger set_updated_at before update on public.platform_users
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- organization_memberships (DATABASE_ARCHITECTURE.md §2)
-- ---------------------------------------------------------------------------
create table public.organization_memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  role            public.membership_role_enum not null,
  status          public.membership_status_enum not null default 'active',
  invited_by      uuid references public.profiles (id) on delete set null,
  joined_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint organization_memberships_org_user_unique unique (organization_id, user_id),
  constraint organization_memberships_org_id_unique unique (organization_id, id)
);
create index organization_memberships_user_status_idx
  on public.organization_memberships (user_id, status);
create index organization_memberships_org_role_idx
  on public.organization_memberships (organization_id, role);
create trigger set_updated_at before update on public.organization_memberships
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- organization_assignments — platform employee → organization (TENANCY_MODEL.md §5)
-- ---------------------------------------------------------------------------
create table public.organization_assignments (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete cascade,
  employee_user_id         uuid not null references public.platform_users (user_id) on delete cascade,
  assigned_by              uuid references public.profiles (id) on delete set null,
  -- Populated post-MVP when an adviser organization grants access (CD-02). NULL in MVP.
  grantor_organization_id  uuid references public.organizations (id) on delete set null,
  status                   public.assignment_status_enum not null default 'active',
  starts_at                timestamptz,
  ends_at                  timestamptz not null default (now() + interval '12 months'),
  revoked_by               uuid references public.profiles (id) on delete set null,
  revoked_reason           text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint organization_assignments_org_employee_unique unique (organization_id, employee_user_id),
  constraint organization_assignments_org_id_unique unique (organization_id, id)
);
create index organization_assignments_employee_status_idx
  on public.organization_assignments (employee_user_id, status);
create trigger set_updated_at before update on public.organization_assignments
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- invitations (DATABASE_ARCHITECTURE.md §1)
-- ---------------------------------------------------------------------------
create table public.invitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  email            extensions.citext not null,
  role             public.membership_role_enum not null,
  token_hash       text not null unique,
  invited_by       uuid references public.profiles (id) on delete set null,
  expires_at       timestamptz not null default (now() + interval '7 days'),
  accepted_at      timestamptz,
  accepted_user_id uuid references public.profiles (id) on delete set null,
  status           public.invitation_status_enum not null default 'pending',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint invitations_org_id_unique unique (organization_id, id)
);
-- ADR-038.12: one pending invitation per (organization, email).
create unique index invitation_pending_unique
  on public.invitations (organization_id, email) where status = 'pending';
create index invitations_org_status_idx on public.invitations (organization_id, status);
create index invitations_email_pending_idx on public.invitations (email) where status = 'pending';
create trigger set_updated_at before update on public.invitations
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- ownership_transfers — the two-step sole-ownership transfer (ADR-044.7; R2-A-11)
-- ---------------------------------------------------------------------------
create table public.ownership_transfers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  initiator_user_id uuid not null references public.profiles (id) on delete cascade,
  nominee_user_id   uuid not null references public.profiles (id) on delete cascade,
  demote_initiator  boolean not null default false,
  status            public.ownership_transfer_status_enum not null default 'pending',
  expires_at        timestamptz not null default (now() + interval '7 days'),
  accepted_at       timestamptz,
  cancelled_by      uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint ownership_transfers_org_id_unique unique (organization_id, id),
  constraint ownership_transfers_distinct check (initiator_user_id <> nominee_user_id)
);
create unique index ownership_transfer_pending_unique
  on public.ownership_transfers (organization_id) where status = 'pending';
create index ownership_transfers_nominee_idx
  on public.ownership_transfers (nominee_user_id, status);
create trigger set_updated_at before update on public.ownership_transfers
  for each row execute function app.set_updated_at();
