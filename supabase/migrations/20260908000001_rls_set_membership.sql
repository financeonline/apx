-- MOTION — RLS role checks become set membership, evaluated once per statement (ADR-065).
--
-- Contract: DATABASE_ARCHITECTURE.md §11 (policy template), TENANCY_MODEL.md §4 (helpers),
--           RBAC_MATRIX.md §2.1 / ADR-044.4 (allow-lists; the five frozen-Home tables),
--           PRODUCTION_AUDIT.md C1.
--
-- Every tenant-data SELECT policy was written as
--
--     organization_id in (select app.accessible_org_ids())
--     and app.org_role(organization_id) in ('owner', ...)
--
-- The first predicate is an uncorrelated subquery: the planner hashes it and runs it once. The
-- second takes a COLUMN as its argument, so it is re-executed for every candidate row — and each
-- execution runs app.accessible_org_roles(), a three-way union over four tables, inside a SECURITY
-- DEFINER call. Measured on a 50,000-row ledger read by its owner: 22.7 s, ~18 buffer hits per row,
-- all of it inside the policy (PRODUCTION_AUDIT.md C1).
--
-- The role check is a fact about the ORGANISATION, not the row. It is therefore expressed as a set
-- of organisation ids computed once — "the organisations in which I hold one of these roles" — and
-- the policy becomes a single hashed membership test, the shape the first predicate already had.
-- The allow-lists themselves are unchanged, role for role, table for table; the pgTAP suite that
-- proves them (06_financial_rls) is the proof that nothing moved.
--
-- Two helpers carry the shape, so a policy cannot drift back to a per-row call by accident:
--   app.org_ids_with_role(variadic roles)   — organisations where my effective role is one of these
--   app.org_ids_with_permission(perm)       — organisations where my effective role holds this permission
-- Both are STABLE SECURITY DEFINER like the four helpers they sit beside, owned by motion_definer.

-- ---------------------------------------------------------------------------
-- The helpers
-- ---------------------------------------------------------------------------
create function app.org_ids_with_role(variadic p_roles text[])
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select r.organization_id
    from app.accessible_org_roles() r
   where r.role = any (p_roles);
$$;
comment on function app.org_ids_with_role(text[]) is
  'Organisations in which the caller''s effective role is one of the given roles. For RLS: '
  '`organization_id in (select app.org_ids_with_role(...))` is hashed and evaluated once per '
  'statement (ADR-065).';

create function app.org_ids_with_permission(p_perm text)
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select r.organization_id
    from app.accessible_org_roles() r
    join public.role_permissions rp on rp.role = r.role
   where rp.permission = p_perm;
$$;
comment on function app.org_ids_with_permission(text) is
  'Organisations in which the caller''s effective role holds the given permission. The set form of '
  'app.has_permission, for RLS (ADR-065).';

alter function app.org_ids_with_role(text[]) owner to motion_definer;
alter function app.org_ids_with_permission(text) owner to motion_definer;
revoke all on function app.org_ids_with_role(text[]) from public;
revoke all on function app.org_ids_with_permission(text) from public;
grant execute on function app.org_ids_with_role(text[]) to authenticated;
grant execute on function app.org_ids_with_permission(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The policies. Each is dropped and recreated with the SAME allow-list it had.
-- ---------------------------------------------------------------------------

-- The five real roles (RBAC_MATRIX.md §2.1). suspended_member is excluded by construction, so the
-- frozen-Home tables (organizations, metric_current, health_current, health_scores, alerts) are
-- untouched here — they never carried a role check.
do $$
declare t text;
begin
  foreach t in array array[
    'account_category_history', 'accounts', 'actions', 'alert_revisions', 'bank_accounts',
    'bank_transactions', 'calculation_runs', 'category_history', 'counterparties',
    'fiscal_periods', 'invoices', 'ledger_entries', 'metric_snapshots', 'period_balances',
    'record_status_events', 'recurring_payment_groups'
  ] loop
    execute format('drop policy %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using '
      '(organization_id in (select app.org_ids_with_role(''owner'',''admin'',''employee'',''super_admin'',''client'')))',
      t || '_select', t);
  end loop;
end $$;

-- Source documents: never the client (CD-17; EVIDENCE_MODEL.md §10).
drop policy source_documents_select on public.source_documents;
create policy source_documents_select on public.source_documents for select to authenticated
  using (organization_id in (select app.org_ids_with_role('owner','admin','employee','super_admin')));

-- AI tool calls: staff only (AI_ARCHITECTURE.md §13).
drop policy ai_tool_calls_select on public.ai_tool_calls;
create policy ai_tool_calls_select on public.ai_tool_calls for select to authenticated
  using (organization_id in (select app.org_ids_with_role('owner','admin','super_admin')));

-- Conversations and feedback: your own, or staff sees all.
drop policy ai_conversations_select on public.ai_conversations;
create policy ai_conversations_select on public.ai_conversations for select to authenticated
  using (
    organization_id in (select app.accessible_org_ids())
    and (user_id = app.uid()
         or organization_id in (select app.org_ids_with_role('owner','admin','super_admin')))
  );

drop policy ai_feedback_select on public.ai_feedback;
create policy ai_feedback_select on public.ai_feedback for select to authenticated
  using (
    organization_id in (select app.accessible_org_ids())
    and (user_id = app.uid()
         or organization_id in (select app.org_ids_with_role('owner','admin','super_admin')))
  );

-- Evidence bundles: the five roles, except that an ai_response bundle is visible to staff or to the
-- person whose conversation produced it (EVIDENCE_MODEL.md §10).
drop policy evidence_bundles_select on public.evidence_bundles;
create policy evidence_bundles_select on public.evidence_bundles for select to authenticated
  using (
    organization_id in (select app.org_ids_with_role('owner','admin','employee','super_admin','client'))
    and (
      kind <> 'ai_response'
      or organization_id in (select app.org_ids_with_role('owner','admin','super_admin'))
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

-- Permission-gated reads (DATABASE_ARCHITECTURE.md §11 "narrower SELECT rules").
drop policy import_batches_select on public.import_batches;
create policy import_batches_select on public.import_batches for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('imports.review')));

drop policy import_mappings_select on public.import_mappings;
create policy import_mappings_select on public.import_mappings for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('imports.review')));

drop policy import_rows_select on public.import_rows;
create policy import_rows_select on public.import_rows for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('imports.review')));

drop policy report_files_select on public.report_files;
create policy report_files_select on public.report_files for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('reports.view'))
         and deleted_at is null);

-- ---------------------------------------------------------------------------
-- The invariant, stated where it can fail loudly: no policy on a public table may evaluate a role
-- helper against a column. pgTAP asserts the same (06_financial_rls); this makes the migration
-- itself refuse to leave the database in the shape it is here to remove.
-- ---------------------------------------------------------------------------
do $$
declare v_offender text;
begin
  select c.relname || '.' || p.polname into v_offender
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and (pg_get_expr(p.polqual, p.polrelid) ~ 'app\.(org_role|has_permission)\(organization_id'
          or pg_get_expr(p.polwithcheck, p.polrelid) ~ 'app\.(org_role|has_permission)\(organization_id')
   limit 1;
  if v_offender is not null then
    raise exception 'policy % still evaluates a role helper per row (ADR-065)', v_offender;
  end if;
end $$;
