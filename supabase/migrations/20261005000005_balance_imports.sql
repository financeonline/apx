-- MOTION — Imports · trial balances, P&L reports and balance sheets can commit again (Step 0C).
-- Contract: IMPORT_ENGINE.md §9.3, §11; ADR-073.
--
-- Found by the first real-database run of the wizard for every import type: `app.rerun_dedupe`
-- (the commit-time duplicate re-check) joins the target table on `dedupe_hash`, and
-- `period_balances` has no such column — balances supersede at batch scope, not row by row. Every
-- commit of a balance import therefore raised "column t.dedupe_hash does not exist". The re-check
-- now returns 0 for that table; the batch-scope supersession in `app.commit_import_batch` is
-- unchanged. (The wizard's read of existing records had the same fault; fixed in TypeScript.)

create or replace function app.rerun_dedupe(p_org uuid, p_batch uuid, p_target public.financial_record_table_enum)
returns integer
language plpgsql security definer
set search_path = ''
as $function$
declare v_collisions integer;
begin
  -- A balance row has no row hash: `period_balances` supersedes at BATCH scope (commit's own loop),
  -- and the join below named a column it does not have, so every trial balance, P&L report and
  -- balance sheet failed at commit (Step 0C validation).
  if p_target = 'period_balances' then
    return 0;
  end if;

  -- Pass 2: the same row, byte for byte, committed since this file was checked. A collision: the
  -- row is re-flagged and the batch goes back to review (the caller decides that on the count).
  execute format($f$
    with fresh as (
      select r.id, r.dedupe_hash, t.id as existing_id
        from public.import_rows r
        join public.%I t
          on t.organization_id = r.organization_id
         and t.dedupe_hash = r.dedupe_hash
         and t.record_status = 'accepted'
         and t.superseded_by is null
         and t.import_batch_id is distinct from r.batch_id
       where r.organization_id = $1
         and r.batch_id = $2
         and r.status in ('valid', 'warning')
         and r.reviewer_decision <> 'skip'
         and r.dedupe_hash is not null)
    update public.import_rows r
       set status = 'duplicate',
           duplicate_of_table = $3,
           duplicate_of_id = fresh.existing_id,
           reviewer_decision = 'none',
           issues = r.issues || jsonb_build_array(jsonb_build_object(
             'code', 'IMP-DUP-001', 'severity', 'duplicate',
             'message', 'This row duplicates a record committed since this file was checked.'))
      from fresh
     where r.id = fresh.id
    $f$, p_target::text)
  using p_org, p_batch, p_target;

  get diagnostics v_collisions = row_count;

  if p_target = 'invoices' then
    -- Pass 1 (ADR-073): the same invoice IDENTITY — type, customer, number — committed since this
    -- file was checked, with different figures. Not a collision: this row UPDATES it, exactly as it
    -- would have had the other batch been there at validation (§9.2 pass 1, F-B-03). Left as it was,
    -- the insert would have hit `invoices_identity_unique` and the whole commit would have died with
    -- a Postgres sentence on screen.
    update public.import_rows r
       set duplicate_of_table = 'invoices',
           duplicate_of_id = fresh.existing_id,
           issues = r.issues || jsonb_build_array(jsonb_build_object(
             'code', 'IMP-INV-010', 'severity', 'warning',
             'message', 'An invoice with this number for this customer was committed since this file was checked; this row updates it.'))
      from (
        select r2.id, i.id as existing_id
          from public.import_rows r2
          join public.invoices i
            on i.organization_id = r2.organization_id
           and i.invoice_type = (r2.mapped_data ->> 'invoice_type')::public.invoice_type_enum
           and i.counterparty_id = (r2.mapped_data ->> 'counterparty_id')::uuid
           and i.invoice_number = r2.mapped_data ->> 'invoice_number'
           and i.record_status = 'accepted'
           and i.superseded_by is null
           and i.import_batch_id is distinct from r2.batch_id
         where r2.organization_id = p_org
           and r2.batch_id = p_batch
           and r2.status in ('valid', 'warning')
           and r2.reviewer_decision <> 'skip'
           and r2.duplicate_of_id is null) fresh
     where r.id = fresh.id;

    -- An update candidate whose target was itself updated since validation follows the chain to
    -- the row that is current now, rather than failing at commit with "already superseded".
    update public.import_rows r
       set duplicate_of_id = cur.id
      from public.invoices old
      join public.invoices cur
        on cur.organization_id = old.organization_id
       and cur.invoice_type = old.invoice_type
       and cur.counterparty_id is not distinct from old.counterparty_id
       and cur.invoice_number = old.invoice_number
       and cur.record_status = 'accepted'
       and cur.superseded_by is null
     where r.organization_id = p_org
       and r.batch_id = p_batch
       and r.duplicate_of_table = 'invoices'
       and r.duplicate_of_id = old.id
       and old.organization_id = p_org
       and old.superseded_by is not null;
  end if;

  return v_collisions;
end $function$;

alter function app.rerun_dedupe(uuid, uuid, public.financial_record_table_enum) owner to motion_definer;
revoke all on function app.rerun_dedupe(uuid, uuid, public.financial_record_table_enum) from public, authenticated, anon;
