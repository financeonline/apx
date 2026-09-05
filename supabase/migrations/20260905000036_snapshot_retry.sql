-- MOTION — Phase 4 (plan Phase 6) · A run may redo its own in-flight chunk.
-- Contract: FINANCIAL_ENGINE.md §2.4 step 3 ("delete from metric_snapshots where
-- calculation_run_id = run.id and period_id in chunk -- idempotent retry"); ADR-046.1.
--
-- The append-only guard refused that delete, so a worker that died after writing half a chunk could
-- never retry it: the second attempt would double the chunk's snapshots or fail outright. Found by
-- the integration suite.
--
-- The distinction the guard should draw is between PUBLISHED history and IN-FLIGHT output. A
-- snapshot belonging to a run that is still `running` is a partial attempt being redone, not a
-- figure anybody has been shown. Once the run finishes — succeeded or failed — its snapshots are
-- immutable forever, which is what makes an AI answer or a report from last month still resolve to
-- the numbers it saw (§6).

create function app.metric_snapshot_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status public.calculation_status_enum;
begin
  if coalesce(current_setting('app.purge', true), 'off') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- The organization is going away; the cascade is the intended lifecycle (ADR-049.2).
  if tg_op = 'DELETE'
     and not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return old;
  end if;

  -- A run redoing its own chunk. Deleting is permitted; UPDATE never is, because a figure that
  -- changes in place cannot be explained by the run that produced it.
  if tg_op = 'DELETE' then
    select r.status into v_status
      from public.calculation_runs r
     where r.organization_id = old.organization_id and r.id = old.calculation_run_id;
    if v_status = 'running' then
      return old;
    end if;
  end if;

  raise exception 'IMMUTABLE: % is append-only', tg_table_name using errcode = '23514';
end $$;

drop trigger append_only_guard on public.metric_snapshots;
create trigger append_only_guard before update or delete on public.metric_snapshots
  for each row execute function app.metric_snapshot_guard();

alter function app.metric_snapshot_guard() owner to motion_definer;
revoke all on function app.metric_snapshot_guard() from public;
