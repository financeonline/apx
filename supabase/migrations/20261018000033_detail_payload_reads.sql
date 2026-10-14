-- APX — Switching off a detail permission hides the detail EVERYWHERE it is stored, and suspension
-- never widens anybody's reads (ADR-172 hardening; independent security review, 2026-10-14,
-- findings HIGH 1, MEDIUM 3 and MEDIUM 4).
--
-- ADR-172 moved every detail TABLE behind the permission its pages need. The review found the same
-- detail stored a second time in places those switches did not reach:
--
--   HIGH 1a  `audit_events.before/after` hold whole row copies (`db.<table>.insert/update/delete`:
--            bank lines, the ledger, invoices, accounts, bank accounts, budget lines, memberships and
--            invitations with e-mail addresses), readable with `audit.view` alone — which admins hold
--            by default and which is switchable ON for anybody. An admin whose detail switches the
--            owner had turned off read every bank line through the trail (probe p6).
--   HIGH 1b  `bank_transactions_raw` — the unmasked statement text ADR-044.2 withholds from the
--            table — returned EVERY bank line of the company to `imports.review` alone (a 3rd party
--            with that one switch on read them, probe p7); `import_rows.raw_data`/`mapped_data` (the
--            same text, verbatim from the file, every batch ever imported) likewise.
--   HIGH 1c  `counterparties_contact` (e-mail addresses, notes) opened to `customers.edit` without
--            `customers.view`.
--   MEDIUM 3 The overview a 3rd party reads (`dashboard.view`) carried named detail inside its jsonb:
--            `health_scores.breakdown[].conditions[].subject_key` (bank descriptions naming customers
--            and suppliers), `metric_snapshots.components` (per-account balances, bank account NAMES,
--            top counterparty ids) and `evidence_query` (account, counterparty and record ids), and
--            `metric_current` pointed at every per-customer and per-account figure (probe p4).
--   MEDIUM 4 The frozen-Home branches of `alerts_select` and `metric_snapshots_select` admitted
--            `suspended_member` whatever the person's real role and switches: suspending a company
--            gave its 3rd party the alert sentences and the per-customer figures (probe p10).
--
-- What this file does:
--
--   1. `audit_events`: SELECT on `before`, `after`, `ip` and `user_agent` is revoked from
--      `authenticated` (table-level SELECT replaced by a column list). The trail is served by
--      `api.org_audit_events` / `api.platform_audit_events`, which never returned those columns; no
--      reader in src/ selects them (the storage signer re-reads ids and times as the service role).
--      An `audit.view` holder still reads WHO did WHAT to WHICH row and WHEN — never the row.
--   2. `bank_transactions_raw` (re-created from its live definition): rows only while a batch is IN
--      REVIEW — lines of a batch under review, or existing lines a row under review is flagged as a
--      duplicate of (the comparison the reviewer makes) — and only for a person holding
--      `imports.review` AND (`banking.view` or `financials.view`). After commit the masked
--      `description_normalized` is the only text anybody reads (ADR-044.2's intent, now enforced).
--      `import_rows`: the rows need `imports.review` AND (`banking.view` or `financials.view`); the
--      verbatim columns `raw_data`/`mapped_data` are revoked from the table and served by the new
--      definer view `import_rows_review` under the same in-review rule. The review page hides a
--      committed batch's rows already (they are in the books, read through the record tables).
--   3. `counterparties_contact` (re-created from its live definition): `customers.edit` AND
--      `customers.view`.
--   4. The payload columns of the overview tables — `metric_snapshots.components`,
--      `metric_snapshots.evidence_query`, `health_scores.breakdown` — are revoked from
--      `authenticated` and served by two definer views that decide, row by row, between the WHOLE
--      payload (whoever reads the detail behind it: `financials.view`; `customers.view` for a
--      per-customer figure; the frozen Home of a suspended company for those who held that detail
--      before it was suspended) and a REDACTED one (a `dashboard.view` reader of the overview):
--        - `metric_snapshot_payloads`: components reduced to numbers and dates (no ids, no names, no
--          nested lists — `app.redact_metric_components`), `evidence_query` NULL;
--        - `health_score_breakdowns`: each dimension rebuilt from an allow-list of keys, conditions
--          reduced to their rule, every subject, record and snapshot id dropped
--          (`app.redact_health_breakdown`).
--      The service role (jobs composing reports) reads the whole payload, as it reads the tables.
--      `data_quality` stays readable: it is codes from two fixed vocabularies
--      (`DATA_QUALITY_WARNINGS`, `DATA_QUALITY_MISSING`), a completeness ratio and a proxy flag —
--      nothing named, nothing identifying — and a lender reading a cash figure must see that it is
--      incomplete. The engine still writes bank account names into `components.missing_bank_accounts`
--      (the Cash page lists them); with the column revoked only `financials.view` holders, who read
--      `bank_accounts` anyway, ever see them, so the engine is left as it is.
--   5. `metric_current`: an undimensioned or standard-category pointer stays readable by every
--      resolved role (no figures); a per-customer pointer needs `financials.view` or
--      `customers.view`; a per-account or per-bank-account pointer `financials.view` — the same
--      reach as the snapshot it points at.
--   6. Suspension (MEDIUM 4): `app.frozen_org_ids_with_any_permission(…)` — the suspended companies
--      in which the caller's REAL role (membership role, or Financial Analyst by assignment) with
--      their switches holds one of the permissions. The frozen-Home branches of `alerts_select`,
--      `metric_snapshots_select` and `metric_current_select` use it instead of
--      `org_ids_with_role('suspended_member')`: a frozen company shows each person what they saw
--      before, never more.
--
-- Every policy keeps the SET form (ADR-065); the views evaluate each permission set once per
-- statement. pgTAP 31_member_access_hardening asserts each finding closed and the views' rows equal
-- to what the tables' policies admit.

-- ---------------------------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------------------------

-- Is the reader the server (the service role, jobs)? A definer so the views below need grant only
-- this, not the JWT plumbing beneath it.
create function app.payload_reader_is_server() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.role_claim() = 'service_role';
$$;

-- An import batch that has not reached the books: being read, mapped, validated, waiting for review,
-- or failed before it got there. `committing`/`committed`/`rolled_back`/`rejected` are not.
create function app.import_batch_in_review(p_status public.import_batch_status_enum) returns boolean
language sql immutable security definer set search_path = '' as $$
  select coalesce(p_status in ('created', 'parsing', 'mapping', 'validating', 'awaiting_review', 'failed'), false);
$$;

/*
 * The suspended companies in which the caller's REAL role — their membership role, or `employee` for
 * an assigned Financial Analyst — with their switches effectively holds ANY of the permissions.
 *
 * `app.accessible_org_roles()` reports everyone in a suspended company as `suspended_member`
 * (ADR-044.4), which is right for every write and every other read. The frozen Home, though, has
 * always shown the alerts and the current figures; keyed on `suspended_member` alone it showed them
 * to a 3rd party who never saw them while the company was active. Keyed on this, it shows each person
 * what their role and switches showed them before — never more.
 */
create function app.frozen_org_ids_with_any_permission(variadic p_perms text[])
returns setof uuid language sql stable security definer set search_path = '' as $$
  select f.organization_id
    from app.accessible_org_roles() f
    cross join lateral (
      select case
        -- The employee branch of accessible_org_roles admits only an active assignment; the
        -- membership branch only a person with none.
        when exists (select 1 from public.organization_assignments a
                      where a.organization_id = f.organization_id and a.employee_user_id = app.uid()
                        and a.status = 'active')
          then 'employee'
        else (select m.role::text from public.organization_memberships m
               where m.organization_id = f.organization_id and m.user_id = app.uid()
                 and m.status = 'active')
      end as role
    ) u
   where f.role = 'suspended_member'
     and exists (select 1 from unnest(p_perms) p(perm)
                  where app.effective_permission(app.uid(), f.organization_id, u.role, p.perm));
$$;

/*
 * A metric's `components` as a `dashboard.view` reader of the overview may see them: the top-level
 * entries whose value is a number, a boolean, null, or a string that is a number or a date — the
 * percentage change, the comparison figure, the statement total. Dropped: every key naming an id
 * (`…_id`, `…_ids`), every nested list or object (per account, per bank account, missing accounts
 * with their names, top counterparties) and every other string. DENY BY DEFAULT: a component the
 * engine adds tomorrow is dropped unless it is a bare number or date.
 */
create function app.redact_metric_components(p_components jsonb) returns jsonb
language sql immutable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_components) = 'object' then p_components else '{}'::jsonb end) e
   where e.key !~ '(^|_)ids?$'
     and (jsonb_typeof(e.value) in ('number', 'boolean', 'null')
          or (jsonb_typeof(e.value) = 'string'
              and ((e.value #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$'
                   or (e.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')));
$$;

/*
 * A Business Health Score breakdown as a `dashboard.view` reader of the overview may see it: each
 * dimension REBUILT from an allow-list of keys (its score, weights, inclusion, cap, the factor
 * sentences and the rules with their bands and points), with the parts that point at detail removed:
 * conditions keep only their rule (`subject_id`, `subject_key` — a bank description naming a
 * customer or supplier — `snapshot_ids` and `record_ids` go), metrics and factor sentences lose their
 * snapshot ids. The shape is the stored one, so the Health page reads it unchanged. DENY BY DEFAULT:
 * a key the engine adds tomorrow is not copied.
 */
create function app.redact_health_breakdown(p_breakdown jsonb) returns jsonb
language sql immutable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'key', d -> 'key',
             'score', d -> 'score',
             'weight_config', d -> 'weight_config',
             'weight_applied', d -> 'weight_applied',
             'included', d -> 'included',
             'exclusion_reason', d -> 'exclusion_reason',
             'capped', d -> 'capped',
             'cap_reason', d -> 'cap_reason',
             'positives', coalesce(d -> 'positives', '[]'::jsonb),
             'negatives', coalesce(d -> 'negatives', '[]'::jsonb),
             'data_quality', jsonb_build_object('completeness', d -> 'data_quality' -> 'completeness',
                                                'warnings', coalesce(d -> 'data_quality' -> 'warnings', '[]'::jsonb)),
             'rules', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'rule', r -> 'rule', 'result', r -> 'result', 'points', r -> 'points',
                                 'value', r -> 'value', 'skipped_reason', r -> 'skipped_reason') order by ro), '[]'::jsonb)
                         from jsonb_array_elements(case when jsonb_typeof(d -> 'rules') = 'array' then d -> 'rules' else '[]'::jsonb end)
                              with ordinality as rr(r, ro)),
             'metrics', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'metric_key', m -> 'metric_key', 'value', m -> 'value', 'snapshot_id', null) order by mo), '[]'::jsonb)
                           from jsonb_array_elements(case when jsonb_typeof(d -> 'metrics') = 'array' then d -> 'metrics' else '[]'::jsonb end)
                                with ordinality as mm(m, mo)),
             'conditions', (select coalesce(jsonb_agg(jsonb_build_object(
                                      'rule_key', c -> 'rule_key', 'subject_id', null, 'subject_key', null,
                                      'snapshot_ids', '[]'::jsonb, 'record_ids', '[]'::jsonb) order by co), '[]'::jsonb)
                              from jsonb_array_elements(case when jsonb_typeof(d -> 'conditions') = 'array' then d -> 'conditions' else '[]'::jsonb end)
                                   with ordinality as cc(c, co)),
             'positives_structured', (select coalesce(jsonb_agg(jsonb_build_object(
                                                'template_id', s -> 'template_id', 'text', s -> 'text',
                                                'values', coalesce(s -> 'values', '{}'::jsonb), 'snapshot_ids', '[]'::jsonb) order by so), '[]'::jsonb)
                                        from jsonb_array_elements(case when jsonb_typeof(d -> 'positives_structured') = 'array' then d -> 'positives_structured' else '[]'::jsonb end)
                                             with ordinality as ss(s, so)),
             'negatives_structured', (select coalesce(jsonb_agg(jsonb_build_object(
                                                'template_id', s -> 'template_id', 'text', s -> 'text',
                                                'values', coalesce(s -> 'values', '{}'::jsonb), 'snapshot_ids', '[]'::jsonb) order by so), '[]'::jsonb)
                                        from jsonb_array_elements(case when jsonb_typeof(d -> 'negatives_structured') = 'array' then d -> 'negatives_structured' else '[]'::jsonb end)
                                             with ordinality as ss(s, so))
           ) order by t.ord), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_breakdown) = 'array' then p_breakdown else '[]'::jsonb end)
         with ordinality as t(d, ord);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'app.payload_reader_is_server()',
    'app.import_batch_in_review(public.import_batch_status_enum)',
    'app.frozen_org_ids_with_any_permission(text[])',
    'app.redact_metric_components(jsonb)',
    'app.redact_health_breakdown(jsonb)'
  ] loop
    execute format('alter function %s owner to motion_definer', f);
    execute format('revoke all on function %s from public, anon', f);
    -- Referenced from policies and definer views, so the reader needs EXECUTE (PostgreSQL checks a
    -- function inside a view against the querying role). Each is a pure helper or answers only for
    -- the caller; none reads a row on anybody's behalf.
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- The service role (jobs composing the briefs and reports) reads the payload views. It holds every
-- table privilege and bypasses RLS already; it needs the schema and the functions the views call,
-- and nothing else of `app`.
grant usage on schema app to service_role;
grant execute on function app.payload_reader_is_server() to service_role;
grant execute on function app.import_batch_in_review(public.import_batch_status_enum) to service_role;
grant execute on function app.frozen_org_ids_with_any_permission(text[]) to service_role;
grant execute on function app.redact_metric_components(jsonb) to service_role;
grant execute on function app.redact_health_breakdown(jsonb) to service_role;
grant execute on function app.org_ids_with_permission(text) to service_role;
grant execute on function app.org_ids_with_any_permission(text[]) to service_role;

-- Replace table-level SELECT for `authenticated` with every column but the protected ones (the
-- pattern of 20260905000019 for bank_transactions and counterparties). A column added later is NOT
-- readable until somebody grants it: deny by default.
do $$
declare
  t record;
  v_columns text;
begin
  for t in
    select * from (values
      ('audit_events',     array['before', 'after', 'ip', 'user_agent']),
      ('import_rows',      array['raw_data', 'mapped_data']),
      ('metric_snapshots', array['components', 'evidence_query']),
      ('health_scores',    array['breakdown'])
    ) as v(table_name, protected)
  loop
    execute format('revoke select on public.%I from authenticated', t.table_name);
    execute format('revoke select on public.%I from anon', t.table_name);
    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position)
      into v_columns
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = t.table_name
       and not (c.column_name = any (t.protected));
    execute format('grant select (%s) on public.%I to authenticated', v_columns, t.table_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Raw statement text: only while it is being reviewed, only to who reads the lines
-- ---------------------------------------------------------------------------------------------
-- Re-created from the live definition (`pg_get_viewdef`, 2026-10-14). Same columns; the permission
-- tests in the set form (ADR-065); the in-review rule added.
create or replace view public.bank_transactions_raw
  with (security_invoker = false, security_barrier = true) as
  select t.id, t.organization_id, t.bank_account_id, t.transaction_date, t.amount,
         t.description_raw, t.description_normalized, t.counterparty_name_raw,
         t.reference, t.source_ref, t.import_batch_id, t.import_row_id, t.record_status
    from public.bank_transactions t
   where t.organization_id in (select app.accessible_org_ids())
     and t.organization_id in (select app.org_ids_with_permission('imports.review'))
     and t.organization_id in (select app.org_ids_with_any_permission('banking.view', 'financials.view'))
     and (exists (select 1 from public.import_batches b
                   where b.organization_id = t.organization_id and b.id = t.import_batch_id
                     and app.import_batch_in_review(b.status))
          or exists (select 1
                       from public.import_rows r
                       join public.import_batches b on b.organization_id = r.organization_id and b.id = r.batch_id
                      where r.organization_id = t.organization_id
                        and r.duplicate_of_table = 'bank_transactions'
                        and r.duplicate_of_id = t.id
                        and app.import_batch_in_review(b.status)));
-- Read-only, and never for anon (default privileges had granted it; the body returned nothing).
revoke all on public.bank_transactions_raw from public, anon, authenticated, service_role;
grant select on public.bank_transactions_raw to authenticated, service_role;

-- Import rows: the lines themselves are the detail.
alter policy import_rows_select on public.import_rows
  using (organization_id in (select app.org_ids_with_permission('imports.review'))
         and organization_id in (select app.org_ids_with_any_permission('banking.view', 'financials.view')));

-- The verbatim file columns, while the batch is in review.
create view public.import_rows_review
  with (security_invoker = false, security_barrier = true) as
  select r.id, r.organization_id, r.batch_id, r.row_number, r.status, r.raw_data, r.mapped_data
    from public.import_rows r
    join public.import_batches b on b.organization_id = r.organization_id and b.id = r.batch_id
   where app.payload_reader_is_server()
      or (app.import_batch_in_review(b.status)
          and r.organization_id in (select app.org_ids_with_permission('imports.review'))
          and r.organization_id in (select app.org_ids_with_any_permission('banking.view', 'financials.view')));
alter view public.import_rows_review owner to motion_definer;
revoke all on public.import_rows_review from public, anon, authenticated, service_role;
grant select on public.import_rows_review to authenticated, service_role;
comment on view public.import_rows_review is
  'ADR-172 hardening: import_rows.raw_data/mapped_data (the file verbatim) while the batch is in review, to imports.review AND (banking.view or financials.view).';

-- ---------------------------------------------------------------------------------------------
-- 3. Contact details: editing customers is not a licence to read them
-- ---------------------------------------------------------------------------------------------
create or replace view public.counterparties_contact
  with (security_invoker = false, security_barrier = true) as
  select c.id, c.organization_id, c.name, c.kind, c.email, c.notes, c.external_ref
    from public.counterparties c
   where c.organization_id in (select app.accessible_org_ids())
     and c.organization_id in (select app.org_ids_with_permission('customers.edit'))
     and c.organization_id in (select app.org_ids_with_permission('customers.view'));
revoke all on public.counterparties_contact from public, anon, authenticated, service_role;
grant select on public.counterparties_contact to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Suspension shows each person what they saw before (before §4–5, which use the helper)
-- ---------------------------------------------------------------------------------------------
alter policy alerts_select on public.alerts
  using (organization_id in (select app.org_ids_with_any_permission('financials.view', 'alerts.manage'))
         or organization_id in (select app.frozen_org_ids_with_any_permission('financials.view', 'alerts.manage')));

/*
 * The figures. `financials.view` reads every snapshot, history included. Without it:
 *   - `customers.view` reads the per-customer figures the customer pages show;
 *   - `dashboard.view` reads the CURRENT snapshots of the undimensioned figures and the
 *     standard-category breakdowns, and nothing per account or per counterparty;
 *   - a suspended company's frozen Home reads its current snapshots as each person read them before
 *     the suspension: every dimension for whose role held `financials.view`, the per-customer ones
 *     for `customers.view` (2026-10-14; was every current row for every `suspended_member`).
 */
alter policy metric_snapshots_select on public.metric_snapshots
  using (organization_id in (select app.org_ids_with_permission('financials.view'))
         or (dimension_type = 'counterparty'::public.metric_dimension_enum
             and organization_id in (select app.org_ids_with_permission('customers.view')))
         or (organization_id in (select app.org_ids_with_permission('dashboard.view'))
             and (dimension_type in ('none'::public.metric_dimension_enum, 'standard_category'::public.metric_dimension_enum)
                  or organization_id in (select app.frozen_org_ids_with_any_permission('financials.view'))
                  or (dimension_type = 'counterparty'::public.metric_dimension_enum
                      and organization_id in (select app.frozen_org_ids_with_any_permission('customers.view'))))
             and exists (select 1 from public.metric_current c
                          where c.organization_id = metric_snapshots.organization_id
                            and c.snapshot_id = metric_snapshots.id)));

-- ---------------------------------------------------------------------------------------------
-- 5. Pointers reach as far as the figures they point at
-- ---------------------------------------------------------------------------------------------
alter policy metric_current_select on public.metric_current
  using (organization_id in (select app.accessible_org_ids())
         and (dimension_type in ('none'::public.metric_dimension_enum, 'standard_category'::public.metric_dimension_enum)
              or organization_id in (select app.org_ids_with_permission('financials.view'))
              or (dimension_type = 'counterparty'::public.metric_dimension_enum
                  and organization_id in (select app.org_ids_with_permission('customers.view')))
              or organization_id in (select app.frozen_org_ids_with_any_permission('financials.view'))
              or (dimension_type = 'counterparty'::public.metric_dimension_enum
                  and organization_id in (select app.frozen_org_ids_with_any_permission('customers.view')))));

-- ---------------------------------------------------------------------------------------------
-- 4. The overview's payloads: whole for the detail's readers, redacted for the overview's
-- ---------------------------------------------------------------------------------------------
/*
 * One row per snapshot the caller may read — the rows `metric_snapshots_select` admits, decided by
 * the same permission sets (pgTAP 31 compares the two for every fixture person) — with its payload
 * WHOLE when the caller reads the detail behind it and REDACTED when they read only the overview.
 * `is_current` lets a reader ask for the current figures with the same filters it puts on
 * `metric_current`, so no list of ids travels in a URL.
 */
create view public.metric_snapshot_payloads
  with (security_invoker = false, security_barrier = true) as
  select s.organization_id, s.id, s.calculation_run_id, s.period_id, s.metric_key,
         s.dimension_type, s.dimension_id, s.dimension_key,
         k.is_current,
         case when k.detail then s.components else app.redact_metric_components(s.components) end as components,
         case when k.detail then s.evidence_query end as evidence_query
    from public.metric_snapshots s
    cross join lateral (
      select exists (select 1 from public.metric_current c
                      where c.organization_id = s.organization_id and c.snapshot_id = s.id) as is_current
    ) cur
    cross join lateral (
      select cur.is_current,
             app.payload_reader_is_server()
               or s.organization_id in (select app.org_ids_with_permission('financials.view'))
               or (s.dimension_type = 'counterparty'::public.metric_dimension_enum
                   and s.organization_id in (select app.org_ids_with_permission('customers.view')))
               or (cur.is_current
                   and (s.organization_id in (select app.frozen_org_ids_with_any_permission('financials.view'))
                        or (s.dimension_type = 'counterparty'::public.metric_dimension_enum
                            and s.organization_id in (select app.frozen_org_ids_with_any_permission('customers.view')))))
               as detail
    ) k
   where k.detail
      or (k.is_current
          and s.dimension_type in ('none'::public.metric_dimension_enum, 'standard_category'::public.metric_dimension_enum)
          and s.organization_id in (select app.org_ids_with_permission('dashboard.view')));
alter view public.metric_snapshot_payloads owner to motion_definer;
revoke all on public.metric_snapshot_payloads from public, anon, authenticated, service_role;
grant select on public.metric_snapshot_payloads to authenticated, service_role;
comment on view public.metric_snapshot_payloads is
  'ADR-172 hardening: metric_snapshots.components/evidence_query, whole for whoever reads the detail (financials.view; customers.view per customer), redacted for a dashboard.view reader of the overview. The columns are not selectable on the table.';

-- The score's breakdown: every reader of the score (`health_scores_select` is `dashboard.view`);
-- whole for `financials.view` (and the frozen Home of whoever held it), redacted otherwise.
create view public.health_score_breakdowns
  with (security_invoker = false, security_barrier = true) as
  select h.organization_id, h.id, h.period_id,
         case when app.payload_reader_is_server()
                   or h.organization_id in (select app.org_ids_with_permission('financials.view'))
                   or h.organization_id in (select app.frozen_org_ids_with_any_permission('financials.view'))
              then h.breakdown
              else app.redact_health_breakdown(h.breakdown) end as breakdown
    from public.health_scores h
   where app.payload_reader_is_server()
      or h.organization_id in (select app.org_ids_with_permission('dashboard.view'));
alter view public.health_score_breakdowns owner to motion_definer;
revoke all on public.health_score_breakdowns from public, anon, authenticated, service_role;
grant select on public.health_score_breakdowns to authenticated, service_role;
comment on view public.health_score_breakdowns is
  'ADR-172 hardening: health_scores.breakdown, whole for financials.view, redacted (no subjects, records or snapshot ids) for a dashboard.view reader. The column is not selectable on the table.';
