-- MOTION — Phase 2 (plan Phase 4) · Append-only guards must stand down when the organization itself
-- is going away.
-- Contract: ADR-046.1 (append-only tables), ADR-038.9 (purge), ADR-048.1/2 (the same class of defect
-- found in Phase 1 on audit_events and last_owner_guard).
--
-- Found by the integration suite, not by inspection. The eight append-only tables and the two
-- history tables all carry `on delete cascade` to `organizations`, which is the correct lifecycle:
-- they are tenant data, and `org.purge` deletes tenant data. But the guards refused the cascade,
-- so deleting an organization raised `IMMUTABLE: account_category_history is append-only` and the
-- delete failed. An organization holding any evidence, any metric snapshot or any category history —
-- which is every organization that has ever been used — could not be deleted at all, and the
-- `org.purge` job would have failed in Phase 4 exactly as the audit_events FK would have (ADR-048.1).
--
-- The rule these guards actually encode is "a row of a LIVING organization is immutable". When the
-- parent organization row is already gone, there is nothing left to protect and refusing only makes
-- the data undeletable. `app.purge = 'on'` remains the explicit in-life exemption.
--
-- `audit_events` deliberately does NOT get this treatment. It has no foreign key (ADR-048.1) and
-- must outlive the organization it describes, so it keeps the strict guard: purge REDACTS its
-- payloads and keeps the rows.

create function app.append_only_guard_cascadable() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if coalesce(current_setting('app.purge', true), 'off') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- A cascade from the deletion of the owning organization. The parent row is already gone by the
  -- time the cascade fires, which is what distinguishes this from an application-level delete.
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    if not exists (select 1 from public.organizations o where o.id = v_org) then
      return old;
    end if;
  end if;

  raise exception 'IMMUTABLE: % is append-only', tg_table_name using errcode = '23514';
end $$;

create or replace function app.history_close_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('app.purge', true), 'off') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    -- Same reasoning as app.append_only_guard_cascadable: a cascade from the organization's own
    -- deletion is the intended lifecycle, not tampering.
    if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
      return old;
    end if;
    raise exception 'IMMUTABLE: % is append-only', tg_table_name using errcode = '23514';
  end if;

  -- Everything except valid_to must be identical, and valid_to may only be set once.
  if old.valid_to is not null or new.valid_to is null then
    raise exception 'IMMUTABLE: % rows may only have valid_to set once', tg_table_name
      using errcode = '23514';
  end if;
  if to_jsonb(new) - 'valid_to' <> to_jsonb(old) - 'valid_to' then
    raise exception 'IMMUTABLE: only valid_to may change on %', tg_table_name using errcode = '23514';
  end if;
  return new;
end $$;

-- Re-point the six Phase 2 append-only tables at the cascade-aware guard. audit_events keeps
-- app.append_only_guard() untouched.
do $$
declare t text;
begin
  foreach t in array array[
    'evidence_bundles', 'evidence_items', 'alert_revisions', 'record_status_events',
    'metric_snapshots', 'health_scores'
  ] loop
    execute format('drop trigger append_only_guard on public.%I', t);
    execute format(
      'create trigger append_only_guard before update or delete on public.%I
         for each row execute function app.append_only_guard_cascadable()', t);
  end loop;
end $$;

alter function app.append_only_guard_cascadable() owner to motion_definer;
revoke all on function app.append_only_guard_cascadable() from public;
