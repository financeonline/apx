-- MOTION — re-review NF-3: rolling back a corrected report must work.
--
-- `app.rollback_import_batch` restored the rows this batch had superseded (Step 3) BEFORE rejecting
-- this batch's own rows (Step 2). For `period_balances` the restored row and this batch's still-accepted
-- row are then both current for the same period × account × kind, and `single_current_balance`
-- refused the rollback with a raw duplicate-key error — so once a corrected report could be committed
-- (Step 0F, N-3) it could never be undone. The invoice-update path (ADR-073) has the same shape.
--
-- Now the supersession chain is READ first (it lives on the rows about to be rejected), this batch's
-- rows are rejected (leaving the index), and only then are the predecessors re-linked or restored.
-- One transaction under the organisation lock, as before; nothing else changes.

create or replace function app.rollback_import_batch(p_org uuid, p_batch uuid, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_target    public.import_target_enum;
  v_rec_table public.financial_record_table_enum;
  v_status    public.import_batch_status_enum;
  v_promoted  integer;
  v_rejected  integer := 0;
  v_restored  integer := 0;
  v_chain     jsonb := '[]'::jsonb;
  r           record;
begin
  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));

  select b.target_table, b.status into v_target, v_status
    from public.import_batches b where b.organization_id = p_org and b.id = p_batch;
  if v_target is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status <> 'committed' then
    raise exception 'CONFLICT: only a committed batch can be rolled back' using errcode = '40001';
  end if;
  v_rec_table := v_target::text::public.financial_record_table_enum;

  -- Step 1: dependants are promoted, not refused (ADR-047.9).
  v_promoted := app.promote_dependants(p_org, p_batch, p_actor);

  -- The supersession chain, read before anything changes (ADR-047.1): if this batch's row B superseded
  -- A and was itself superseded by C, A will point at C; if B was current, A becomes current again.
  for r in
    execute format($f$
      select old.id as old_id, mine.superseded_by as next_id
        from public.%I mine
        join public.%I old
          on old.organization_id = mine.organization_id and old.superseded_by = mine.id
       where mine.organization_id = $1 and mine.import_batch_id = $2
      $f$, v_rec_table::text, v_rec_table::text)
    using p_org, p_batch
  loop
    v_chain := v_chain || jsonb_build_object('old_id', r.old_id, 'next_id', r.next_id);
  end loop;

  -- Step 2: this batch's records are soft-rejected FIRST (never deleted, ADR-012), so they leave every
  -- partial unique index (`single_current_balance`, `invoices_identity_unique`) before a predecessor
  -- comes back into it.
  for r in
    execute format($f$select id from public.%I
                       where organization_id = $1 and import_batch_id = $2
                         and record_status = 'accepted'::public.record_status_enum$f$,
                   v_rec_table::text)
    using p_org, p_batch
  loop
    execute format($f$update public.%I set record_status = 'rejected', rejected_reason = $1
                      where organization_id = $2 and id = $3$f$, v_rec_table::text)
      using coalesce(p_reason, 'batch rolled back'), p_org, r.id;
    perform app.record_status_event(p_org, v_rec_table, r.id, 'rejected', null, p_batch);
    v_rejected := v_rejected + 1;
  end loop;

  -- Step 3: re-link, or restore, the predecessors.
  for r in select (e ->> 'old_id')::uuid as old_id, nullif(e ->> 'next_id', '')::uuid as next_id
             from jsonb_array_elements(v_chain) e
  loop
    execute format('update public.%I set superseded_by = $1 where organization_id = $2 and id = $3',
                   v_rec_table::text)
      using r.next_id, p_org, r.old_id;
    if r.next_id is null then
      perform app.record_status_event(p_org, v_rec_table, r.old_id, 'restored', null, p_batch);
    else
      perform app.record_status_event(p_org, v_rec_table, r.old_id, 'unsuperseded', r.next_id, p_batch);
    end if;
    v_restored := v_restored + 1;
  end loop;

  update public.import_rows
     set status = 'rejected'
   where organization_id = p_org and batch_id = p_batch and status = 'committed';

  update public.import_batches
     set status = 'rolled_back', rolled_back_at = now(), rolled_back_reason = p_reason
   where organization_id = p_org and id = p_batch;

  perform app.enqueue_recalculation(p_org, 'import_rollback', p_batch);

  perform app.audit(p_org, 'import.rolled_back', 'import_batches', p_batch, null,
                    jsonb_build_object('reason', p_reason, 'rejected', v_rejected,
                                       'promoted', v_promoted, 'restored', v_restored),
                    '{}'::jsonb, p_actor);

  return jsonb_build_object('rejected', v_rejected, 'promoted', v_promoted, 'restored', v_restored);
end $$;

alter function app.rollback_import_batch(uuid, uuid, text, uuid) owner to motion_definer;
