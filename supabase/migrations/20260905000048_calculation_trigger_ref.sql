-- MOTION — `calculation_runs.trigger_ref_id` could never be non-null.
-- Contract: DATABASE_ARCHITECTURE.md §6 (`same_org_ref`); ADR-034, ADR-044.8, ADR-058.7.
--
-- The guard was registered as `app.same_org_ref('trigger_ref_id', '')` — a FIXED-table check with no
-- table named. `tg_argv[2]` is therefore NULL, `format('%I', NULL)` raises 22004, and every insert
-- carrying a trigger reference failed with
--
--     null values cannot be formatted as an SQL identifier
--
-- Nothing caught it because nothing had ever started a run with a reference: the engine had no job
-- handler (ADR-057.1), and every test called `start_calculation_run` with `p_trigger_ref => null`.
-- The first real import commit hit it immediately.
--
-- The column is POLYMORPHIC — the trigger decides what it points at — so the guard is registered the
-- way the other polymorphic references are: on the discriminator, with one table per value it can
-- name. A trigger value with no mapping is skipped by design, which covers the run kinds that carry
-- no reference at all and `record_superseded`, whose ref may be any of the four record tables and so
-- cannot be resolved from a single discriminator.

drop trigger same_org_ref_trigger_ref on public.calculation_runs;

create trigger same_org_ref_trigger_ref before insert or update on public.calculation_runs
  for each row execute function app.same_org_ref(
    'trigger_ref_id', 'trigger',
    'import_commit',       'import_batches',
    'import_rollback',     'import_batches',
    'account_remapped',    'accounts',
    'counterparty_merged', 'counterparties');
