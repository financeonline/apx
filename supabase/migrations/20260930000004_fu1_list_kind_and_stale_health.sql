-- MOTION — FU-1 companions: an invoice list is FULL unless confirmed open items (FU-13), and a month
-- that stops being complete stops showing a Health score (FU-14).
-- Contract: IMPORT_ENGINE.md §184, §200 (IMP-INV-012, ADR-047.10); FINANCIAL_ENGINE.md §2.2, §7;
-- ADR-030.4; ADR-125.
--
-- 1. FU-13 — THE LIST KIND WAS NEVER WRITTEN.
--
--    IMPORT_ENGINE.md §184 declares `invoice_list_kind ∈ {full, open_items}` for every invoice batch,
--    and IMP-INV-012 is how a reviewer confirms that a list is open items only. Nothing ever wrote
--    `full`: the only writer, `api.record_batch_confirmation`, copies `p_value ->> 'invoice_list_kind'`,
--    which the review page never sends (it confirms with `{answer: 'yes'}`), so the column was NULL on
--    every invoice batch committed through the app. Engine 4.0.0 (FU-1) states revenue only from a
--    FULL sales list; without this, no imported list would state any month's revenue. The engine's
--    AR/AP "full list" test (days-to-get-paid) never saw a real imported list either.
--
--    The rule, applied when a batch COMMITS and to every batch already committed: a batch whose
--    reviewer confirmed IMP-INV-012 is `open_items`; any other invoice batch is `full`. An explicit
--    value already on the batch is left as it is.
--
-- 2. FU-14 — A MONTH THAT STOPS BEING COMPLETE KEPT ITS HEALTH SCORE.
--
--    No Health score is written for an incomplete period (ADR-030.4), but a period that WAS complete
--    and no longer is — because its figures rested on a source that turns out not to cover it (FU-1's
--    manufactured revenue months; ADR-124's partly covered cash months) — kept the pointer an earlier
--    run left in `health_current`, and Home and the history kept showing a score built on figures the
--    engine no longer states. `set_period_completeness` now withdraws that pointer when it marks a
--    period incomplete. `health_scores` rows are history and are not touched; no Health rule, weight or
--    threshold changes.

-- ---------------------------------------------------------------------------------------------
-- 1. The list kind at commit
-- ---------------------------------------------------------------------------------------------

create function app.invoice_list_kind_at_commit()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.target_table = 'invoices' and new.status = 'committed' and new.invoice_list_kind is null then
    new.invoice_list_kind := case
      when coalesce(new.confirmations, '{}'::jsonb) ? 'IMP-INV-012' then 'open_items'::public.invoice_list_kind_enum
      else 'full'::public.invoice_list_kind_enum
    end;
  end if;
  return new;
end $$;

alter function app.invoice_list_kind_at_commit() owner to motion_definer;
revoke all on function app.invoice_list_kind_at_commit() from public, anon, authenticated;

create trigger import_batches_invoice_list_kind
  before insert or update of status, invoice_list_kind on public.import_batches
  for each row execute function app.invoice_list_kind_at_commit();

-- Every invoice batch already committed, by the same rule. A function, so the rule the backfill
-- applies is the one pgTAP tests (supabase/tests/16_fu1_list_kind.test.sql), not a one-off statement.
create function app.backfill_invoice_list_kind()
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.import_batches b
     set invoice_list_kind = case
           when coalesce(b.confirmations, '{}'::jsonb) ? 'IMP-INV-012' then 'open_items'::public.invoice_list_kind_enum
           else 'full'::public.invoice_list_kind_enum
         end
   where b.target_table = 'invoices'
     and b.status = 'committed'
     and b.invoice_list_kind is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

alter function app.backfill_invoice_list_kind() owner to motion_definer;
revoke all on function app.backfill_invoice_list_kind() from public, anon, authenticated;

select app.backfill_invoice_list_kind();

-- ---------------------------------------------------------------------------------------------
-- 2. An incomplete period shows no Health score
-- ---------------------------------------------------------------------------------------------

create or replace function api_server.set_period_completeness(p_org uuid, p_periods uuid[], p_complete boolean[])
returns integer
language plpgsql security definer set search_path = ''
as $motion$
declare i integer; v_count integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  for i in 1 .. coalesce(array_length(p_periods, 1), 0) loop
    update public.fiscal_periods
       set is_complete = p_complete[i]
     where organization_id = p_org and id = p_periods[i]
       and is_complete is distinct from p_complete[i];

    -- FU-14: an incomplete period has no Health score (ADR-030.4). One an earlier run scored while the
    -- period still looked complete is withdrawn from what is shown; its `health_scores` row stays.
    if p_complete[i] is not true then
      delete from public.health_current c
       where c.organization_id = p_org and c.period_id = p_periods[i];
    end if;

    v_count := v_count + 1;
  end loop;
  return v_count;
end $motion$;

alter function api_server.set_period_completeness(uuid, uuid[], boolean[]) owner to motion_definer;
revoke all on function api_server.set_period_completeness(uuid, uuid[], boolean[]) from public, anon, authenticated;
grant execute on function api_server.set_period_completeness(uuid, uuid[], boolean[]) to service_role;
