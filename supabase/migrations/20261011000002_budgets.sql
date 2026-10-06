-- MOTION — Budgets (Agreement §9; REQ-FC-03/04; owner decision 2026-10-06 "separate budget module", ADR-142).
--
-- A budget is imported through the ordinary import wizard (import type `budget`, target
-- `budget_lines`): a CSV/XLSX of month, account and amount, mapped to the chart of accounts like a
-- trial balance, validated, reviewed and committed — with the same traceability (source document,
-- batch, row), the same record-status trail, and the same rollback, because `budget_lines` follows
-- the financial-record contract every generic function relies on (record_status, superseded_by,
-- import_batch_id, rejected_reason).
--
-- A budget is NOT a financial record of what happened: the engine never reads it, no metric
-- snapshot is written from it, and the engine version is unchanged. Budget-versus-actual is a
-- deterministic read beside the engine (`modules/budgets`), comparing these lines with the actual
-- figures the engine already wrote.
--
-- A month's budget REPLACES the last one for that month (batch scope, like a balance report): the
-- old lines are superseded, never deleted, and rolling the new import back restores them.
-- Amounts are positive in the reporting sense: income budgeted as income, costs as costs.

create table public.budget_lines (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  period_start        date not null constraint budget_lines_month check (period_start = date_trunc('month', period_start)::date),
  period_id           uuid not null,
  account_id          uuid not null,
  amount              numeric(18,2) not null,
  currency            char(3) not null default 'GBP',
  source_document_id  uuid,
  import_batch_id     uuid,
  import_row_id       uuid,
  source_ref          text,
  record_status       public.record_status_enum not null default 'pending',
  assurance_level     public.assurance_level_enum not null default 'verified',
  superseded_by       uuid,
  superseded_at       timestamptz,
  rejected_reason     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint budget_lines_no_self_supersede check (superseded_by is null or superseded_by <> id),
  constraint budget_lines_org_id_unique unique (organization_id, id),
  constraint budget_lines_batch_cell_unique unique (organization_id, period_id, account_id, import_batch_id),
  constraint budget_lines_period_fk foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id),
  constraint budget_lines_account_fk foreign key (organization_id, account_id) references public.accounts (organization_id, id),
  constraint budget_lines_batch_fk foreign key (organization_id, import_batch_id) references public.import_batches (organization_id, id),
  constraint budget_lines_document_fk foreign key (organization_id, source_document_id) references public.source_documents (organization_id, id)
);

create unique index single_current_budget on public.budget_lines (organization_id, period_id, account_id)
  where record_status = 'accepted' and superseded_by is null;
create index budget_lines_current_lookup on public.budget_lines (organization_id, period_id)
  where record_status = 'accepted' and superseded_by is null;

alter table public.budget_lines owner to motion_definer;
alter table public.budget_lines enable row level security;
alter table public.budget_lines force row level security;
revoke insert, update, delete, truncate on public.budget_lines from authenticated, anon;
revoke select on public.budget_lines from anon;
grant select on public.budget_lines to authenticated;
grant all on public.budget_lines to service_role;

create policy definer_all on public.budget_lines for all to motion_definer using (true) with check (true);
-- Readable where the financial records are: the same five-role allow-list as `period_balances`.
create policy budget_lines_select on public.budget_lines for select to authenticated
  using (organization_id in (select app.org_ids_with_role(variadic array['owner', 'admin', 'employee', 'super_admin', 'client'])));

create trigger period_assign before insert or update of period_start on public.budget_lines
  for each row execute function app.period_assign('period_start');
create trigger superseded_at_set before update of superseded_by on public.budget_lines
  for each row execute function app.superseded_at_set();
create trigger set_updated_at before update on public.budget_lines
  for each row execute function app.set_updated_at();
create trigger audit_diff after insert or delete or update on public.budget_lines
  for each row execute function app.audit_diff();

-- The polymorphic references that name a record table now accept budget lines too.
drop trigger same_org_ref_record on public.record_status_events;
create trigger same_org_ref_record before insert on public.record_status_events
  for each row execute function app.same_org_ref('record_id', 'record_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions', 'invoices', 'invoices',
    'period_balances', 'period_balances', 'budget_lines', 'budget_lines');
drop trigger same_org_ref_related on public.record_status_events;
create trigger same_org_ref_related before insert on public.record_status_events
  for each row execute function app.same_org_ref('related_record_id', 'record_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions', 'invoices', 'invoices',
    'period_balances', 'period_balances', 'budget_lines', 'budget_lines');
drop trigger same_org_ref_duplicate on public.import_rows;
create trigger same_org_ref_duplicate before insert or update on public.import_rows
  for each row execute function app.same_org_ref('duplicate_of_id', 'duplicate_of_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions', 'invoices', 'invoices',
    'period_balances', 'period_balances', 'budget_lines', 'budget_lines');
drop trigger same_org_ref_committed on public.import_rows;
create trigger same_org_ref_committed before insert or update on public.import_rows
  for each row execute function app.same_org_ref('committed_record_id', 'committed_table',
    'ledger_entries', 'ledger_entries', 'bank_transactions', 'bank_transactions', 'invoices', 'invoices',
    'period_balances', 'period_balances', 'budget_lines', 'budget_lines');

-- ---------------------------------------------------------------------------------------------
-- The wizard's batch start: `budget` → `budget_lines` (otherwise unchanged)
-- ---------------------------------------------------------------------------------------------
create or replace function api.start_import_batch(p_document uuid, p_import_type public.import_type_enum, p_opts jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_status public.document_status_enum; v_batch uuid; v_target public.import_target_enum;
        v_method public.extraction_method_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select d.organization_id, d.status into v_org, v_status
    from public.source_documents d where d.id = p_document and d.deleted_at is null;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'imports.create');

  if v_status <> 'ready' then
    raise exception 'CONFLICT: this document is not ready to import' using errcode = '40001';
  end if;
  -- One active batch per document: two concurrent wizards over one file would produce two
  -- independent sets of records from the same source.
  if exists (select 1 from public.import_batches b
              where b.organization_id = v_org and b.source_document_id = p_document
                and b.status in ('created','parsing','mapping','validating','awaiting_review','committing')) then
    raise exception 'CONFLICT: an import of this document is already in progress' using errcode = '40001';
  end if;

  v_method := coalesce((p_opts ->> 'extraction_method')::public.extraction_method_enum, 'csv');
  if v_method not in ('csv', 'xlsx', 'pdf_text') then
    raise exception 'VALIDATION: an AI-read or manual batch is created by the server, not the wizard'
      using errcode = '22023';
  end if;

  v_target := case p_import_type
    when 'general_ledger' then 'ledger_entries'
    when 'receipts' then 'ledger_entries'
    when 'trial_balance' then 'period_balances'
    when 'pnl_report' then 'period_balances'
    when 'balance_sheet' then 'period_balances'
    when 'bank_statement' then 'bank_transactions'
    when 'budget' then 'budget_lines'
    else 'invoices' end::public.import_target_enum;

  if v_target = 'bank_transactions' and (p_opts ->> 'bank_account_id') is null then
    raise exception 'VALIDATION: a bank statement import needs a bank account' using errcode = '22023';
  end if;

  insert into public.import_batches
         (organization_id, source_document_id, import_type, target_table, bank_account_id,
          period_start, period_end, balance_basis, created_by,
          fiscal_year_start_month_at_commit, extraction_method)
  select v_org, p_document, p_import_type, v_target,
         (p_opts ->> 'bank_account_id')::uuid,
         coalesce((p_opts ->> 'period_start')::date, date_trunc('month', now())::date),
         coalesce((p_opts ->> 'period_end')::date,
                  (date_trunc('month', now()) + interval '1 month - 1 day')::date),
         (p_opts ->> 'balance_basis')::public.balance_basis_enum,
         app.uid(), o.fiscal_year_start_month, v_method
    from public.organizations o where o.id = v_org
  returning id into v_batch;

  perform app.audit(v_org, 'import.started', 'import_batches', v_batch, null,
                    jsonb_build_object('import_type', p_import_type, 'document', p_document,
                                       'extraction_method', v_method),
                    '{}'::jsonb);
  return v_batch;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Commit-time dedupe: budget lines are replaced at batch scope (otherwise unchanged)
-- ---------------------------------------------------------------------------------------------
create or replace function app.rerun_dedupe(p_org uuid, p_batch uuid, p_target public.financial_record_table_enum)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_collisions integer;
begin
  -- A balance row has no row hash: `period_balances` supersedes at BATCH scope (commit's own loop),
  -- and the join below named a column it does not have, so every trial balance, P&L report and
  -- balance sheet failed at commit (Step 0C validation).
  -- Budget lines, likewise, are replaced at batch scope (a budget for a month replaces the last one).
  if p_target in ('period_balances', 'budget_lines') then
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
end $$;

-- ---------------------------------------------------------------------------------------------
-- Commit: the budget branch and its batch-scope replacement (otherwise unchanged from 20261008000002)
-- ---------------------------------------------------------------------------------------------
create or replace function app.commit_import_batch(p_org uuid, p_batch uuid, p_actor uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $function$
declare
  v_target      public.import_target_enum;
  v_rec_table   public.financial_record_table_enum;
  v_type        public.import_type_enum;
  v_method      public.extraction_method_enum;
  v_doc         uuid;
  v_bank        uuid;
  v_sign        public.balance_sign_enum;
  v_basis       public.balance_basis_enum;
  v_kind        public.balance_kind_enum;
  v_assurance   public.assurance_level_enum;
  v_reconciled  boolean;
  v_collisions  integer;
  v_committed   integer := 0;
  v_superseded  integer := 0;
  v_job         uuid;
  v_record_id   uuid;
  v_update      boolean;
  v_replaces    integer;
  r             record;
begin
  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));
  perform app.assert_batch_committable(p_org, p_batch);

  select b.target_table, b.import_type, b.extraction_method, b.source_document_id, b.bank_account_id,
         b.balance_sign, b.balance_basis
    into v_target, v_type, v_method, v_doc, v_bank, v_sign, v_basis
    from public.import_batches b where b.organization_id = p_org and b.id = p_batch;

  v_rec_table := v_target::text::public.financial_record_table_enum;

  -- §9.3, BEFORE anything is written. On a collision the batch goes back to review with the rows
  -- re-flagged and the function RETURNS — it does not raise, because raising would roll back the
  -- very evidence the reviewer needs.
  v_collisions := app.rerun_dedupe(p_org, p_batch, v_rec_table);
  if v_collisions > 0 then
    update public.import_batches
       set status = 'awaiting_review',
           error_summary = jsonb_build_object(
             'stage', 'dedupe', 'collisions', v_collisions, 'at', now())
     where organization_id = p_org and id = p_batch;

    perform app.audit(p_org, 'import.commit_conflicted', 'import_batches', p_batch, null,
                      jsonb_build_object('collisions', v_collisions), '{}'::jsonb, p_actor);

    return jsonb_build_object('status', 'conflict', 'collisions', v_collisions,
                              'committed', 0, 'superseded', 0);
  end if;

  if v_target = 'period_balances' then
    v_kind := case v_type
      when 'trial_balance' then 'trial_balance'
      when 'pnl_report'    then 'pnl_report'
      else 'balance_sheet' end::public.balance_kind_enum;

    -- Step 0F (N-3): a balance report REPLACES the accepted report of its kind for every month it
    -- states (batch scope, ADR-029.2). That is never silent: the first time a commit finds it would
    -- replace accepted balances, the reviewer is asked (IMP-COV-013) and nothing is written. Checked
    -- HERE, under the organisation lock, so a report committed by someone else after this one was
    -- checked is caught too. Like a dedupe collision it RETURNS rather than raises, so the newly
    -- required confirmation survives.
    select count(*) into v_replaces
      from public.period_balances old
     where old.organization_id = p_org
       and old.balance_kind = v_kind
       and old.record_status = 'accepted'
       and old.superseded_by is null
       and old.import_batch_id is distinct from p_batch
       and old.period_start in (
             select distinct (ir.mapped_data ->> 'period_start')::date
               from public.import_rows ir
              where ir.organization_id = p_org and ir.batch_id = p_batch
                and (ir.status in ('valid', 'warning')
                     or (ir.status = 'duplicate' and ir.reviewer_decision = 'keep'))
                and ir.reviewer_decision <> 'skip');
    if v_replaces > 0 and not exists (
         select 1 from public.import_batches b
          where b.organization_id = p_org and b.id = p_batch and b.confirmations ? 'IMP-COV-013') then
      update public.import_batches
         set required_confirmations = case when 'IMP-COV-013' = any (required_confirmations)
                                           then required_confirmations
                                           else required_confirmations || 'IMP-COV-013'::text end
       where organization_id = p_org and id = p_batch;
      perform app.audit(p_org, 'import.replacement_unconfirmed', 'import_batches', p_batch, null,
                        jsonb_build_object('replaces', v_replaces), '{}'::jsonb, p_actor);
      return jsonb_build_object('status', 'needs_confirmation', 'code', 'IMP-COV-013',
                                'replaces', v_replaces, 'committed', 0, 'superseded', 0);
    end if;
  end if;

  update public.import_batches set status = 'committing'
   where organization_id = p_org and id = p_batch;

  v_reconciled := not exists (
    select 1 from public.import_batches b, lateral jsonb_array_elements(b.batch_issues) i
     where b.organization_id = p_org and b.id = p_batch
       and i ->> 'code' in ('IMP-BAL-006', 'IMP-BAL-007'));

  v_assurance := case v_method
    when 'pdf_claude' then 'inferred'::public.assurance_level_enum
    when 'pdf_text'   then case when v_reconciled then 'verified' else 'calculated' end::public.assurance_level_enum
    else 'verified'::public.assurance_level_enum
  end;

  for r in
    select * from public.import_rows ir
     where ir.organization_id = p_org and ir.batch_id = p_batch
       and (ir.status in ('valid', 'warning')
            or (ir.status = 'duplicate' and ir.reviewer_decision = 'keep'))
       and ir.reviewer_decision <> 'skip'
     order by ir.row_number
  loop
    if v_target = 'ledger_entries' then
      insert into public.ledger_entries
        (organization_id, entry_date, period_id, account_id, direction, amount, currency,
         description, reference, counterparty_id, journal_ref, source_document_id,
         import_batch_id, import_row_id, source_ref, record_status, assurance_level,
         dedupe_hash, duplicate_reviewed, is_opening_balance)
      values
        (p_org, (r.mapped_data ->> 'entry_date')::date, '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'account_id')::uuid,
         (r.mapped_data ->> 'direction')::public.entry_direction_enum,
         (r.mapped_data ->> 'amount')::numeric, coalesce(r.mapped_data ->> 'currency', 'GBP'),
         r.mapped_data ->> 'description', r.mapped_data ->> 'reference',
         (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'journal_ref',
         v_doc, p_batch, r.id, r.source_ref, 'accepted', v_assurance,
         r.dedupe_hash, r.reviewer_decision = 'keep',
         coalesce((r.mapped_data ->> 'is_opening_balance')::boolean, false))
      returning id into v_record_id;

    elsif v_target = 'bank_transactions' then
      insert into public.bank_transactions
        (organization_id, bank_account_id, transaction_date, posted_date, period_id, amount,
         currency, description_raw, counterparty_name_raw, counterparty_id, reference,
         balance_after, source_document_id, import_batch_id, import_row_id, source_ref,
         record_status, assurance_level, dedupe_hash, duplicate_reviewed)
      values
        (p_org, v_bank, (r.mapped_data ->> 'transaction_date')::date,
         (r.mapped_data ->> 'posted_date')::date, '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'amount')::numeric, coalesce(r.mapped_data ->> 'currency', 'GBP'),
         r.mapped_data ->> 'description', r.mapped_data ->> 'counterparty_name',
         (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'reference',
         (r.mapped_data ->> 'balance_after')::numeric,
         v_doc, p_batch, r.id, r.source_ref, 'accepted', v_assurance,
         r.dedupe_hash, r.reviewer_decision = 'keep')
      returning id into v_record_id;

    elsif v_target = 'invoices' then
      v_update := r.duplicate_of_table = 'invoices' and r.duplicate_of_id is not null;

      -- ADR-073: an update candidate is inserted OUTSIDE the identity index first. The index is
      -- partial on `record_status = 'accepted' and superseded_by is null`, and the row it must
      -- replace is still in it; inserting the new row as `accepted` collided with the old one on
      -- every re-exported invoice, so ADR-029.1's supersession never reached commit. The new row
      -- starts `pending`, the old row is superseded (and leaves the index), and only then does the
      -- new row become `accepted` — three statements, one transaction, no moment at which two
      -- accepted rows share an identity or a figure reads a half-committed invoice.
      insert into public.invoices
        (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date,
         period_id, subtotal, tax_amount, total_amount, amount_paid, currency, status, paid_date,
         description, source_document_id, import_batch_id, import_row_id, source_ref,
         record_status, assurance_level, dedupe_hash, duplicate_reviewed)
      values
        (p_org, (r.mapped_data ->> 'invoice_type')::public.invoice_type_enum,
         (r.mapped_data ->> 'counterparty_id')::uuid, r.mapped_data ->> 'invoice_number',
         (r.mapped_data ->> 'issue_date')::date, (r.mapped_data ->> 'due_date')::date,
         '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'subtotal')::numeric, (r.mapped_data ->> 'tax_amount')::numeric,
         (r.mapped_data ->> 'total_amount')::numeric,
         coalesce((r.mapped_data ->> 'amount_paid')::numeric, 0),
         coalesce(r.mapped_data ->> 'currency', 'GBP'),
         coalesce((r.mapped_data ->> 'status')::public.invoice_status_enum, 'open'),
         (r.mapped_data ->> 'paid_date')::date, r.mapped_data ->> 'description',
         v_doc, p_batch, r.id, r.source_ref,
         case when v_update then 'pending' else 'accepted' end::public.record_status_enum,
         v_assurance, r.dedupe_hash, r.reviewer_decision = 'keep')
      returning id into v_record_id;

      if v_update then
        perform app.supersede_row(p_org, 'invoices', r.duplicate_of_id, v_record_id, p_batch);
        update public.invoices set record_status = 'accepted'
         where organization_id = p_org and id = v_record_id;
        v_superseded := v_superseded + 1;
      end if;

    elsif v_target = 'period_balances' then
      -- Step 0F (N-3): inserted OUTSIDE `single_current_balance` (`pending`), exactly as an invoice
      -- update candidate is (ADR-073). The accepted rows this report replaces are still in that
      -- index; inserting `accepted` collided with them, so a corrected report could never be
      -- committed. After the loop the old rows are superseded and only then are these promoted.
      --
      -- N-6: the reporting-sign flip applies only to a ONE-column layout. A row that carries debit or
      -- credit totals was computed as debit − credit — natural by construction — whatever sign a
      -- saved mapping or an API call put on the batch.
      insert into public.period_balances
        (organization_id, period_start, period_id, account_id, opening_balance, debit_total,
         credit_total, closing_balance, currency, balance_kind, balance_basis,
         source_document_id, import_batch_id, import_row_id, source_ref,
         record_status, assurance_level, duplicate_reviewed)
      values
        (p_org, (r.mapped_data ->> 'period_start')::date, '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'account_id')::uuid,
         (r.mapped_data ->> 'opening_balance')::numeric,
         (r.mapped_data ->> 'debit_total')::numeric, (r.mapped_data ->> 'credit_total')::numeric,
         case when v_sign = 'reporting'
                and (r.mapped_data ->> 'debit_total') is null
                and (r.mapped_data ->> 'credit_total') is null
                and public.standard_category_account_type(
                      (select a.standard_category from public.accounts a
                        where a.organization_id = p_org
                          and a.id = (r.mapped_data ->> 'account_id')::uuid))
                    in ('income', 'liability', 'equity')
              then -((r.mapped_data ->> 'closing_balance')::numeric)
              else (r.mapped_data ->> 'closing_balance')::numeric end,
         coalesce(r.mapped_data ->> 'currency', 'GBP'), v_kind, coalesce(v_basis, 'movement'),
         v_doc, p_batch, r.id, r.source_ref, 'pending', v_assurance, r.reviewer_decision = 'keep')
      returning id into v_record_id;
    elsif v_target = 'budget_lines' then
      -- Budgets (ADR-142): a month's budget replaces the last one for that month, at batch scope,
      -- exactly as a balance report replaces its kind — inserted `pending`, outside
      -- `single_current_budget`, until the old lines are superseded below.
      insert into public.budget_lines
        (organization_id, period_start, period_id, account_id, amount, currency,
         source_document_id, import_batch_id, import_row_id, source_ref, record_status, assurance_level)
      values
        (p_org, date_trunc('month', (r.mapped_data ->> 'period_start')::date)::date,
         '00000000-0000-0000-0000-000000000000',
         (r.mapped_data ->> 'account_id')::uuid, (r.mapped_data ->> 'amount')::numeric,
         coalesce(r.mapped_data ->> 'currency', 'GBP'),
         v_doc, p_batch, r.id, r.source_ref, 'pending', v_assurance)
      returning id into v_record_id;
    end if;

    perform app.record_status_event(p_org, v_rec_table, v_record_id, 'accepted', null, p_batch);

    update public.import_rows
       set status = 'committed', committed_table = v_rec_table, committed_record_id = v_record_id
     where organization_id = p_org and id = r.id;

    v_committed := v_committed + 1;
  end loop;

  if v_target = 'period_balances' then
    for r in
      select old.id as old_id, old.period_id, old.balance_kind, old.account_id
        from public.period_balances old
       where old.organization_id = p_org
         and old.balance_kind = v_kind
         and old.record_status = 'accepted'
         and old.superseded_by is null
         and old.import_batch_id is distinct from p_batch
         and old.period_id in (select distinct nb.period_id from public.period_balances nb
                                where nb.organization_id = p_org and nb.import_batch_id = p_batch)
    loop
      perform app.supersede_row(
        p_org, 'period_balances', r.old_id,
        -- The same account's new line where the report has one; else the report's line for the month.
        (select nw.id from public.period_balances nw
          where nw.organization_id = p_org and nw.import_batch_id = p_batch
            and nw.period_id = r.period_id and nw.balance_kind = r.balance_kind
          order by (nw.account_id = r.account_id) desc, nw.id
          limit 1),
        p_batch);
      v_superseded := v_superseded + 1;
    end loop;

    -- Step 0F (N-3): the old report has left the index; the new one takes its place. One
    -- transaction: no reader ever sees both reports, or neither, as current.
    update public.period_balances
       set record_status = 'accepted'
     where organization_id = p_org and import_batch_id = p_batch and record_status = 'pending';
  end if;

  if v_target = 'budget_lines' then
    for r in
      select old.id as old_id, old.period_id, old.account_id
        from public.budget_lines old
       where old.organization_id = p_org
         and old.record_status = 'accepted'
         and old.superseded_by is null
         and old.import_batch_id is distinct from p_batch
         and old.period_id in (select distinct nb.period_id from public.budget_lines nb
                                where nb.organization_id = p_org and nb.import_batch_id = p_batch)
    loop
      perform app.supersede_row(
        p_org, 'budget_lines', r.old_id,
        (select nw.id from public.budget_lines nw
          where nw.organization_id = p_org and nw.import_batch_id = p_batch and nw.period_id = r.period_id
          order by (nw.account_id = r.account_id) desc, nw.id
          limit 1),
        p_batch);
      v_superseded := v_superseded + 1;
    end loop;
    update public.budget_lines set record_status = 'accepted'
     where organization_id = p_org and import_batch_id = p_batch and record_status = 'pending';
  end if;

  update public.import_rows
     set status = 'skipped'
   where organization_id = p_org and batch_id = p_batch
     and (reviewer_decision = 'skip' or status in ('duplicate', 'error'))
     and status <> 'committed';

  update public.import_batches
     set status = 'committed', committed_at = now(), reviewed_by = p_actor,
         row_counts = jsonb_build_object(
           'committed', v_committed, 'superseded', v_superseded,
           'total', (select count(*) from public.import_rows ir
                      where ir.organization_id = p_org and ir.batch_id = p_batch)),
         fiscal_year_start_month_at_commit =
           (select o.fiscal_year_start_month from public.organizations o where o.id = p_org)
   where organization_id = p_org and id = p_batch;

  v_job := app.enqueue_recalculation(p_org, 'import_commit', p_batch);
  update public.import_batches set calculation_job_id = v_job
   where organization_id = p_org and id = p_batch and v_job is not null;

  perform app.audit(p_org, 'import.committed', 'import_batches', p_batch, null,
                    jsonb_build_object('committed', v_committed, 'superseded', v_superseded,
                                       'assurance', v_assurance, 'method', v_method),
                    '{}'::jsonb, p_actor);

  return jsonb_build_object('status', 'committed', 'committed', v_committed,
                            'superseded', v_superseded, 'job', v_job);
end $function$;


alter function app.commit_import_batch(uuid, uuid, uuid) owner to motion_definer;

-- ---------------------------------------------------------------------------------------------
-- Purge: budget lines go before the import rows and accounts they reference
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_server.purge_organization(p_org uuid, p_job uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status    public.org_status_enum;
  v_requested timestamptz;
  v_running   integer;
  v_table     text;
  v_n         integer;
  v_counts    jsonb := '{}'::jsonb;
  v_redacted  integer;
  v_left      integer;
  v_offender  text;
  -- Children before parents, from the FK graph (NO ACTION constraints make the order matter).
  v_order     text[] := array[
    -- Tables added after this list was last written (Phases 11, 12, 14 and Step 0F). The guard
    -- below refused every purge of an organisation holding a row in any of them.
    'scenario_values', 'scenario_runs', 'forecast_values', 'forecast_runs',
    'invoice_lines', 'opportunities', 'campaign_spend', 'campaigns', 'marketing_channels', 'products',
    'report_completeness_attestations',
    'evidence_items', 'ai_feedback', 'ai_tool_calls', 'ai_messages', 'ai_conversations',
    'alert_revisions', 'alerts', 'actions', 'report_files', 'reports', 'evidence_bundles',
    'health_current', 'health_scores', 'metric_current', 'metric_snapshots',
    'category_history', 'account_category_history', 'record_status_events',
    'budget_lines', 'bank_transactions', 'recurring_payment_groups', 'ledger_entries', 'invoices',
    'period_balances', 'import_rows', 'calculation_runs', 'import_batches', 'import_mappings',
    'source_documents', 'counterparties', 'bank_accounts', 'accounts', 'fiscal_periods',
    'ownership_transfers', 'invitations', 'organization_assignments', 'organization_memberships',
    'platform_org_settings'
  ];
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));

  select o.status, o.deletion_requested_at into v_status, v_requested
    from public.organizations o where o.id = p_org;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotent: a retry after the rows went (the handler died before the objects did) has nothing
  -- to re-verify and nothing to delete here.
  if v_status = 'deleted' then
    return jsonb_build_object('status', 'already_deleted');
  end if;

  -- The two facts the trigger relied on thirty days ago, re-verified now (§2). A purge running for
  -- an organisation in any other state — cancelled, requeued by hand, a trigger bug — is refused,
  -- and the refusal is a CONFLICT the worker records, not a silent no-op.
  if v_status <> 'pending_deletion' or v_requested is null then
    raise exception 'CONFLICT: % is not scheduled for deletion', p_org using errcode = '23514';
  end if;
  if v_requested > now() - interval '30 days' then
    raise exception 'CONFLICT: % was scheduled for deletion less than 30 days ago (%)', p_org, v_requested
      using errcode = '23514';
  end if;

  -- Zero running jobs of the organisation other than this one. Waiting is not failing: the caller
  -- defers and comes back.
  select count(*) into v_running
    from public.jobs j
   where j.organization_id = p_org and j.status = 'running' and j.id is distinct from p_job;
  if v_running > 0 then
    return jsonb_build_object('status', 'waiting', 'running_jobs', v_running);
  end if;

  -- The append-only guards and the audit redaction policy open for this transaction only.
  perform set_config('app.purge', 'on', true);

  foreach v_table in array v_order loop
    execute format('delete from public.%I where organization_id = $1', v_table) using p_org;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_counts := v_counts || jsonb_build_object(v_table, v_n);
    end if;
  end loop;

  -- Every other job of the organisation goes; this one stays so the worker can record its outcome.
  delete from public.jobs j where j.organization_id = p_org and j.id is distinct from p_job;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    v_counts := v_counts || jsonb_build_object('jobs', v_n);
  end if;

  -- The guard: no base table carrying organization_id may still hold a row for this organisation.
  -- This is what turns "a table was added and this list was not updated" into a loud failure.
  for v_table in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'organization_id'
       and t.table_type = 'BASE TABLE'
       and c.table_name not in ('organizations', 'audit_events', 'jobs')
       and c.table_name not like 'audit_events_%'
       and c.table_name not like 'metric_snapshots_p%'
  loop
    execute format('select count(*) from public.%I where organization_id = $1', v_table)
       into v_left using p_org;
    if v_left > 0 then
      v_offender := v_table;
      exit;
    end if;
  end loop;
  if v_offender is not null then
    raise exception 'CONFLICT: purge left % row(s) in %; the deletion order in api_server.purge_organization needs that table',
      v_left, v_offender using errcode = '23514';
  end if;

  -- The organisation row survives, marked. `profiles.last_active_org_id` would have been nulled by
  -- its FK had the row gone; it has not, so it is nulled here.
  update public.organizations
     set status = 'deleted', deleted_at = now()
   where id = p_org;
  update public.profiles set last_active_org_id = null where last_active_org_id = p_org;

  -- Redaction (ADR-038.9): the events survive as the record that things happened; what they
  -- carried of the customer's data does not. This runs AFTER the status update so that update's
  -- own audit diff is redacted with the rest.
  update public.audit_events
     set before = null, after = null, metadata = '{}'::jsonb, ip = null, user_agent = null
   where organization_id = p_org;
  get diagnostics v_redacted = row_count;

  perform set_config('app.purge', 'off', true);

  -- Written last, so it is the one event about this organisation that keeps a payload — `after`
  -- holds counts, and nothing that was in the rows.
  perform app.audit(p_org, 'org.purged', 'organizations', p_org, null,
                    jsonb_build_object('rows', v_counts, 'audit_events_redacted', v_redacted,
                                       'job_id', p_job),
                    '{}'::jsonb, null);

  return jsonb_build_object('status', 'purged', 'rows', v_counts,
                            'audit_events_redacted', v_redacted);
end $function$;
