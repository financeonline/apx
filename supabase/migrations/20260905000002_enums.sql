-- MOTION — Phase 1 · Enums.
-- Contract: DATABASE_ARCHITECTURE.md §10 (enum summary) plus the inline `{…}` domains in §1, §2, §9.
-- Only the enums Phase 1 tables need are created here; the financial/import/AI enums arrive with
-- their phases (DATABASE_ARCHITECTURE.md §13 "deliberately absent" is respected).

create type public.platform_role_enum as enum ('super_admin', 'employee');
create type public.membership_role_enum as enum ('owner', 'admin', 'client');

create type public.org_status_enum as enum ('active', 'suspended', 'pending_deletion', 'deleted');
create type public.org_kind_enum as enum ('customer', 'adviser');
create type public.org_plan_enum as enum ('trial', 'starter', 'professional', 'enterprise');

create type public.membership_status_enum as enum ('active', 'suspended');
create type public.platform_user_status_enum as enum ('active', 'suspended');
create type public.assignment_status_enum as enum ('active', 'revoked', 'expired');
create type public.invitation_status_enum as enum ('pending', 'accepted', 'expired', 'revoked');
create type public.ownership_transfer_status_enum as enum ('pending', 'accepted', 'cancelled', 'expired');

create type public.actor_type_enum as enum ('user', 'employee', 'platform_admin', 'system', 'ai');

create type public.job_status_enum as enum
  ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled', 'deferred_upstream');

create type public.job_type_enum as enum (
  'calculation.run', 'document.extract', 'import.commit_large', 'alerts.evaluate',
  'org.purge', 'report.render', 'ai.eval', 'storage.cleanup_orphans', 'snapshots.compact'
);

-- Allow-list for api_server.record_access_event (DATABASE_ARCHITECTURE.md §10, ADR-043.2).
create type public.access_event_enum as enum (
  'document.downloaded', 'report.downloaded', 'export.created', 'evidence.viewed',
  'org.data_viewed', 'document.quarantined', 'document.sent_to_ai',
  'auth.sign_in', 'auth.sign_out', 'auth.failed', 'member.invitation_failed'
);
