-- MOTION — Organisation purge · the deletion order covers every tenant table again.
--
-- `api_server.purge_organization` deletes tenant rows in a fixed order and then refuses (CONFLICT) if
-- any base table carrying `organization_id` still holds a row of the organisation — "a table was
-- added and this list was not updated" is meant to fail loudly. It did: eleven tables added since
-- the list was last written (forecasts and scenarios, Phase 11/12; products, invoice lines,
-- channels, campaigns, spend and opportunities, Phase 14; completeness attestations, Step 0F) were
-- never added, so an organisation that had used any of them could not be purged at all: the job
-- failed on every attempt and the customer's data stayed. Found while adding the Phase 17 table.
--
-- Children before parents, from the FK graph:
--   scenario_values → scenario_runs → forecast_runs; forecast_values → forecast_runs;
--   forecast_runs → calculation_runs, fiscal_periods; invoice_lines → invoices, products;
--   opportunities → campaigns, marketing_channels, counterparties; campaign_spend → campaigns;
--   campaigns → marketing_channels; report_completeness_attestations → import_batches (its own
--   self-reference is satisfied within the one DELETE). The function is otherwise unchanged.

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
    'alert_revisions', 'alerts', 'actions', 'report_files', 'evidence_bundles',
    'health_current', 'health_scores', 'metric_current', 'metric_snapshots',
    'category_history', 'account_category_history', 'record_status_events',
    'bank_transactions', 'recurring_payment_groups', 'ledger_entries', 'invoices',
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
