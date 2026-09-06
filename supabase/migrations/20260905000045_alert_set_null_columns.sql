-- MOTION — Phase 7 (plan Phase 9) · Two ON DELETE SET NULL foreign keys that could never fire.
-- Contract: DATABASE_ARCHITECTURE.md §6 (`alerts`); ADR-044.8, ADR-048.1, ADR-056.5.
--
-- `alerts_current_revision_fk` and `alerts_action_fk` are composite keys carrying `organization_id`
-- (ADR-044.8, so a pointer can never cross a tenant boundary) declared `ON DELETE SET NULL`.
--
-- Postgres's bare SET NULL nulls EVERY referencing column, `organization_id` included — and that
-- column is NOT NULL. So the action the constraint describes was impossible: deleting an
-- `alert_revisions` row while its alert still existed raised
--
--     null value in column "organization_id" of relation "alerts" violates not-null constraint
--
-- rather than clearing the pointer. The same defect ADR-048.1 found on `audit_events`, on two more
-- constraints, and it only surfaced here because this phase is the first thing to delete a revision.
--
-- Postgres 15 added the column list, which says exactly what was meant: null the POINTER, leave the
-- tenant column alone. The organisation-cascade path was never affected — `alerts` and
-- `alert_revisions` both cascade from `organizations` — which is why nothing caught this until now.

alter table public.alerts drop constraint alerts_current_revision_fk;
alter table public.alerts
  add constraint alerts_current_revision_fk
  foreign key (organization_id, current_revision_id)
  references public.alert_revisions (organization_id, id)
  on delete set null (current_revision_id);

alter table public.alerts drop constraint alerts_action_fk;
alter table public.alerts
  add constraint alerts_action_fk
  foreign key (organization_id, action_id)
  references public.actions (organization_id, id)
  on delete set null (action_id);
