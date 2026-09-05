-- MOTION — Phase 2 (plan Phase 4) · Privileges and RLS for the financial schema.
-- Contract: DATABASE_ARCHITECTURE.md §11; ADR-026, ADR-038.4, ADR-044.2/4; R2-A-04, R2-A-07.
--
-- Migration 20260905000006 established the two invariants for the Phase 1 tables. The tables created
-- in this phase were not in existence when that migration ran, so it is repeated over them here.
-- The invariants are unchanged:
--   1. `authenticated` holds NO insert/update/delete on ANY table. Every mutation is an api.* function.
--   2. Every table has ENABLE + FORCE RLS, and every role test is an ALLOW-LIST. A negation such as
--      `<> 'client'` would let `suspended_member` fall through and silently widen access (R2-A-07).

-- ---------------------------------------------------------------------------
-- Ownership, privileges and forced RLS over everything created since migration 006.
-- ---------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in
    select c.oid::regclass as rel, c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and pg_catalog.pg_get_userbyid(c.relowner) <> 'motion_definer'
  loop
    execute format('alter table %s owner to motion_definer', t.rel);
    execute format('alter table %s enable row level security', t.rel);
    execute format('alter table %s force row level security', t.rel);
    execute format(
      'create policy definer_all on public.%I for all to motion_definer using (true) with check (true)',
      t.relname);
  end loop;
end $$;

revoke insert, update, delete, truncate on all tables in schema public from authenticated, anon;
revoke all on all tables in schema public from anon;
grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Read policies. Three shapes recur:
--
--   T-data       the accessible set, minus suspended_member. Used by almost every tenant table.
--   frozen-Home  the accessible set INCLUDING suspended_member. Only the five tables that render
--                the frozen Home of a suspended organization (ADR-044.4).
--   permissioned a specific permission bit, for surfaces that expose more than the figures —
--                the file verbatim, the mapping, a rendered report.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  -- The allow-list. `suspended_member` is absent by construction, not by negation.
  t_data constant text :=
    'organization_id in (select app.accessible_org_ids())
       and app.org_role(organization_id) in (''owner'',''admin'',''employee'',''super_admin'',''client'')';
begin
  foreach t in array array[
    'fiscal_periods', 'accounts', 'account_category_history', 'counterparties',
    'ledger_entries', 'period_balances', 'invoices',
    'bank_accounts', 'recurring_payment_groups', 'category_history',
    'calculation_runs', 'metric_snapshots', 'alert_revisions',
    'record_status_events', 'actions'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (%s)',
      t || '_select', t, t_data);
  end loop;
end $$;

-- The frozen Home of a suspended organization: these three (with `organizations`, already done in
-- Phase 1) are the only tenant tables a suspended_member may read. Everything else is the allow-list
-- above, which excludes them.
create policy metric_current_select on public.metric_current for select to authenticated
  using (organization_id in (select app.accessible_org_ids()));
create policy health_current_select on public.health_current for select to authenticated
  using (organization_id in (select app.accessible_org_ids()));
create policy health_scores_select on public.health_scores for select to authenticated
  using (organization_id in (select app.accessible_org_ids()));
create policy alerts_select on public.alerts for select to authenticated
  using (organization_id in (select app.accessible_org_ids()));

-- ---------------------------------------------------------------------------
-- Documents and imports: narrower than T-data (ADR-038.4).
-- ---------------------------------------------------------------------------
-- A source document is the customer's own file. `raw_data`, the mapping and the statement balances
-- on a batch expose more than the finished figures, so these are gated on the import permissions
-- rather than on mere membership. The document allow-list omits `client` deliberately.
create policy source_documents_select on public.source_documents for select to authenticated
  using (organization_id in (select app.accessible_org_ids())
     and app.org_role(organization_id) in ('owner', 'admin', 'employee', 'super_admin'));

create policy import_mappings_select on public.import_mappings for select to authenticated
  using (app.has_permission(organization_id, 'imports.review'));
create policy import_batches_select on public.import_batches for select to authenticated
  using (app.has_permission(organization_id, 'imports.review'));
create policy import_rows_select on public.import_rows for select to authenticated
  using (app.has_permission(organization_id, 'imports.review'));

-- ---------------------------------------------------------------------------
-- Bank transactions: row policy plus COLUMN privileges (ADR-044.2; R2-A-04).
-- ---------------------------------------------------------------------------
create policy bank_transactions_select on public.bank_transactions for select to authenticated
  using (organization_id in (select app.accessible_org_ids())
     and app.org_role(organization_id) in ('owner','admin','employee','super_admin','client'));

-- `description_raw` carries third-party sort codes and account numbers verbatim. No row policy can
-- protect a column, so the privilege itself is withdrawn: even an owner cannot select it through the
-- table. The definer view below is the only way in, and it checks a permission of its own.
--
-- The mechanism matters, and the obvious spelling does not work. In Postgres a TABLE-level
-- `GRANT SELECT` confers select on every column, present and future, and a column-level
-- `REVOKE SELECT (col)` cannot subtract from it — the two privileges are additive, not layered.
-- Writing the revoke alone leaves the column readable, which is what an integration test caught here
-- (ADR-044.2; R2-A-04). The only construction that actually withholds a column is to hold NO
-- table-level grant and enumerate the columns that ARE readable. The loop below does that, so a
-- column added to either table in future is unreadable until somebody adds it deliberately —
-- fail-closed, which is the right default for a table holding third-party bank details.
do $$
declare
  t          record;
  v_columns  text;
begin
  for t in
    select * from (values
      ('bank_transactions', array['description_raw', 'counterparty_name_raw']),
      ('counterparties',    array['email', 'notes'])
    ) as v(table_name, protected)
  loop
    execute format('revoke select on public.%I from authenticated', t.table_name);

    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position)
      into v_columns
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = t.table_name
       and not (c.column_name = any (t.protected));

    execute format('grant select (%s) on public.%I to authenticated', v_columns, t.table_name);
  end loop;
end $$;

-- (counterparties' row policy is the T-data one created in the loop above; only its two
--  contact columns need the extra treatment, done by the revoke and the view.)

-- security_invoker = false: the view runs as its owner (motion_definer) so it can read the revoked
-- columns, and re-imposes both the tenant boundary and the permission in its own body.
create view public.bank_transactions_raw
  with (security_invoker = false, security_barrier = true) as
  select t.id, t.organization_id, t.bank_account_id, t.transaction_date, t.amount,
         t.description_raw, t.description_normalized, t.counterparty_name_raw,
         t.reference, t.source_ref, t.import_batch_id, t.import_row_id, t.record_status
    from public.bank_transactions t
   where t.organization_id in (select app.accessible_org_ids())
     and app.has_permission(t.organization_id, 'imports.review');

create view public.counterparties_contact
  with (security_invoker = false, security_barrier = true) as
  select c.id, c.organization_id, c.name, c.kind, c.email, c.notes, c.external_ref
    from public.counterparties c
   where c.organization_id in (select app.accessible_org_ids())
     and app.has_permission(c.organization_id, 'customers.edit');

alter view public.bank_transactions_raw owner to motion_definer;
alter view public.counterparties_contact owner to motion_definer;
grant select on public.bank_transactions_raw to authenticated;
grant select on public.counterparties_contact to authenticated;

-- ---------------------------------------------------------------------------
-- Evidence: an ai_response bundle belongs to the person who asked (F-C-11).
-- ---------------------------------------------------------------------------
-- A bundle of kind `ai_response` can quote whatever the asker's question surfaced, so it is readable
-- only by that person or by governance — not by every colleague with financials.view.
create policy evidence_bundles_select on public.evidence_bundles for select to authenticated
  using (
    organization_id in (select app.accessible_org_ids())
    and app.org_role(organization_id) in ('owner','admin','employee','super_admin','client')
    and (
      kind <> 'ai_response'
      or app.org_role(organization_id) in ('owner','admin','super_admin')
      or exists (
        select 1
          from public.ai_messages m
          join public.ai_conversations c
            on c.organization_id = m.organization_id and c.id = m.conversation_id
         where m.organization_id = evidence_bundles.organization_id
           and m.id = evidence_bundles.origin_id
           and c.user_id = app.uid())
    )
  );

create policy evidence_items_select on public.evidence_items for select to authenticated
  using (exists (select 1 from public.evidence_bundles b
                  where b.organization_id = evidence_items.organization_id
                    and b.id = evidence_items.bundle_id));

-- ---------------------------------------------------------------------------
-- AI tables (ADR-032.8; F-C-11)
-- ---------------------------------------------------------------------------
create policy ai_conversations_select on public.ai_conversations for select to authenticated
  using (organization_id in (select app.accessible_org_ids())
     and (user_id = app.uid()
          or app.org_role(organization_id) in ('owner', 'admin', 'super_admin')));

create policy ai_messages_select on public.ai_messages for select to authenticated
  using (exists (select 1 from public.ai_conversations c
                  where c.organization_id = ai_messages.organization_id
                    and c.id = ai_messages.conversation_id));

create policy ai_tool_calls_select on public.ai_tool_calls for select to authenticated
  using (organization_id in (select app.accessible_org_ids())
     and app.org_role(organization_id) in ('owner', 'admin', 'super_admin'));

create policy ai_feedback_select on public.ai_feedback for select to authenticated
  using (organization_id in (select app.accessible_org_ids())
     and (user_id = app.uid()
          or app.org_role(organization_id) in ('owner', 'admin', 'super_admin')));

-- ---------------------------------------------------------------------------
-- Rendered reports (ADR-038.7)
-- ---------------------------------------------------------------------------
create policy report_files_select on public.report_files for select to authenticated
  using (app.has_permission(organization_id, 'reports.view') and deleted_at is null);
