-- MOTION — Team/Client Management (Agreement §4 / Annexure A "management and engagement platform
-- between teams and clients … tracking and deliverable notifications to clients about their data";
-- owner decision 2026-10-06 "in-app", ADR-144).
--
-- Three things, all inside the product — no email (no provider; outside Phase 1):
--   1. `action_comments` — a conversation on an action. Append-only. Readable and writable by anyone
--      who can see the action (`actions.view`).
--   2. `engagement_items` + `engagement_events` — a client's REQUESTS of the team and the team's
--      DELIVERABLES to the client, each with a status and a full, append-only history. A request may
--      be raised by anyone with `actions.view` (clients included); deliverables are created, and any
--      item's status changed, by someone with `actions.assign` (the team); a requester may withdraw
--      their own request. No new permission: the existing ones already say who is team and who is client.
--   3. `notifications` — a per-person inbox. Written only by the server: when data is added, when a
--      weekly or adviser report is ready, when a request or deliverable is created or moves, and
--      when someone comments on an action or item you are part of. A notification is sent only to a
--      person who may open what it points at, and never to the person who caused it.

-- ---------------------------------------------------------------------------------------------
-- People of an organisation, and the inbox writer
-- ---------------------------------------------------------------------------------------------
create function app.org_people(p_org uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id from public.organization_memberships m
   where m.organization_id = p_org and m.status = 'active'
  union
  select a.employee_user_id from public.organization_assignments a
   where a.organization_id = p_org and a.status = 'active'
     and (a.starts_at is null or a.starts_at <= now()) and (a.ends_at is null or a.ends_at > now());
$$;
alter function app.org_people(uuid) owner to motion_definer;
revoke all on function app.org_people(uuid) from public, anon, authenticated;

create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  kind            text not null constraint notifications_kind check (kind in (
                    'data_added', 'report_ready', 'engagement_created', 'engagement_status',
                    'engagement_comment', 'action_comment')),
  title           text not null constraint notifications_title check (length(title) between 1 and 200),
  body            text constraint notifications_body check (body is null or length(body) <= 1000),
  href            text constraint notifications_href check (href is null or href like '/app/%'),
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  constraint notifications_org_id_unique unique (organization_id, id)
);
create index notifications_inbox on public.notifications (user_id, organization_id, created_at desc);
create index notifications_unread on public.notifications (user_id, organization_id) where read_at is null;

alter table public.notifications owner to motion_definer;
alter table public.notifications enable row level security;
alter table public.notifications force row level security;
revoke insert, update, delete, truncate on public.notifications from authenticated, anon;
revoke select on public.notifications from anon;
grant select on public.notifications to authenticated;
grant all on public.notifications to service_role;
create policy definer_all on public.notifications for all to motion_definer using (true) with check (true);
-- Your own, in an organisation you can still reach.
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select app.uid()) and organization_id in (select app.accessible_org_ids()));

/*
 * The one writer. `p_permission` is what the recipient must hold to open what the notification
 * points at; anyone who does not hold it is skipped, so an inbox never links to a refusal. The
 * actor is never notified of their own doing. `p_href` is built per recipient by the caller when it
 * depends on what they may open.
 */
create function app.notify(
  p_org uuid, p_user uuid, p_actor uuid, p_permission text, p_kind text, p_title text, p_body text, p_href text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or p_user is not distinct from p_actor then return; end if;
  if not app.has_permission_of(p_user, p_org, p_permission) then return; end if;
  insert into public.notifications (organization_id, user_id, kind, title, body, href)
  values (p_org, p_user, p_kind, left(p_title, 200), left(p_body, 1000), p_href);
end $$;
alter function app.notify(uuid, uuid, uuid, text, text, text, text, text) owner to motion_definer;
revoke all on function app.notify(uuid, uuid, uuid, text, text, text, text, text) from public, anon, authenticated;

create function api.mark_notifications_read(p_org uuid, p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_org(p_org);
  update public.notifications n set read_at = now()
   where n.organization_id = p_org and n.user_id = app.uid() and n.read_at is null
     and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
alter function api.mark_notifications_read(uuid, uuid[]) owner to motion_definer;
revoke all on function api.mark_notifications_read(uuid, uuid[]) from public, anon;
grant execute on function api.mark_notifications_read(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. Comments on actions
-- ---------------------------------------------------------------------------------------------
create table public.action_comments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  action_id       uuid not null,
  author_id       uuid not null references public.profiles (id),
  body            text not null constraint action_comments_body check (length(btrim(body)) between 1 and 4000),
  created_at      timestamptz not null default now(),
  constraint action_comments_org_id_unique unique (organization_id, id),
  constraint action_comments_action_fk foreign key (organization_id, action_id) references public.actions (organization_id, id)
);
create index action_comments_by_action on public.action_comments (organization_id, action_id, created_at);
alter table public.action_comments owner to motion_definer;
alter table public.action_comments enable row level security;
alter table public.action_comments force row level security;
revoke insert, update, delete, truncate on public.action_comments from authenticated, anon;
revoke select on public.action_comments from anon;
grant select on public.action_comments to authenticated;
grant all on public.action_comments to service_role;
create policy definer_all on public.action_comments for all to motion_definer using (true) with check (true);
create policy action_comments_select on public.action_comments for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('actions.view')));
create trigger append_only_guard before update or delete on public.action_comments
  for each row execute function app.append_only_guard_cascadable();

create function api.add_action_comment(p_action uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_title text; v_owner uuid; v_creator uuid; v_id uuid; v_person uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 60, interval '1 minute');
  select a.organization_id, a.title, a.owner_user_id, a.created_by into v_org, v_title, v_owner, v_creator
    from public.actions a where a.id = p_action;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.view');
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'VALIDATION: write a comment' using errcode = '22023';
  end if;

  insert into public.action_comments (organization_id, action_id, author_id, body)
  values (v_org, p_action, app.uid(), btrim(p_body)) returning id into v_id;
  perform app.audit(v_org, 'action.commented', 'actions', p_action, null,
                    jsonb_build_object('comment_id', v_id), '{}'::jsonb);

  -- The owner, the creator and everyone who has commented before.
  for v_person in
    select distinct x from (
      select v_owner as x union select v_creator
      union select c.author_id from public.action_comments c where c.organization_id = v_org and c.action_id = p_action
    ) people where x is not null
  loop
    perform app.notify(v_org, v_person, app.uid(), 'actions.view', 'action_comment',
      'New comment on "' || left(v_title, 150) || '"', left(btrim(p_body), 300),
      '/app/' || (select o.slug from public.organizations o where o.id = v_org) || '/actions/' || p_action::text);
  end loop;
  return v_id;
end $$;
alter function api.add_action_comment(uuid, text) owner to motion_definer;
revoke all on function api.add_action_comment(uuid, text) from public, anon;
grant execute on function api.add_action_comment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Requests and deliverables
-- ---------------------------------------------------------------------------------------------
create table public.engagement_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null constraint engagement_items_kind check (kind in ('request', 'deliverable')),
  title           text not null constraint engagement_items_title check (length(btrim(title)) between 1 and 200),
  detail          text constraint engagement_items_detail check (detail is null or length(detail) <= 4000),
  status          text not null default 'open'
                  constraint engagement_items_status check (status in ('open', 'in_progress', 'delivered', 'closed')),
  due_date        date,
  created_by      uuid not null references public.profiles (id),
  owner_user_id   uuid references public.profiles (id),
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint engagement_items_closed check ((status in ('delivered', 'closed')) = (closed_at is not null)),
  constraint engagement_items_org_id_unique unique (organization_id, id)
);
create index engagement_items_open on public.engagement_items (organization_id, status, due_date);
alter table public.engagement_items owner to motion_definer;
alter table public.engagement_items enable row level security;
alter table public.engagement_items force row level security;
revoke insert, update, delete, truncate on public.engagement_items from authenticated, anon;
revoke select on public.engagement_items from anon;
grant select on public.engagement_items to authenticated;
grant all on public.engagement_items to service_role;
create policy definer_all on public.engagement_items for all to motion_definer using (true) with check (true);
create policy engagement_items_select on public.engagement_items for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('actions.view')));
create trigger set_updated_at before update on public.engagement_items
  for each row execute function app.set_updated_at();

create table public.engagement_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  item_id         uuid not null,
  actor_id        uuid not null references public.profiles (id),
  event           text not null constraint engagement_events_event check (event in ('created', 'status_changed', 'commented')),
  from_status     text,
  to_status       text,
  note            text constraint engagement_events_note check (note is null or length(note) <= 4000),
  created_at      timestamptz not null default now(),
  constraint engagement_events_org_id_unique unique (organization_id, id),
  constraint engagement_events_item_fk foreign key (organization_id, item_id) references public.engagement_items (organization_id, id)
);
create index engagement_events_by_item on public.engagement_events (organization_id, item_id, created_at);
alter table public.engagement_events owner to motion_definer;
alter table public.engagement_events enable row level security;
alter table public.engagement_events force row level security;
revoke insert, update, delete, truncate on public.engagement_events from authenticated, anon;
revoke select on public.engagement_events from anon;
grant select on public.engagement_events to authenticated;
grant all on public.engagement_events to service_role;
create policy definer_all on public.engagement_events for all to motion_definer using (true) with check (true);
create policy engagement_events_select on public.engagement_events for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('actions.view')));
create trigger append_only_guard before update or delete on public.engagement_events
  for each row execute function app.append_only_guard_cascadable();

/* Who hears about an item: its creator, its owner, everyone who has acted on it, and — for a
   deliverable — the organisation's clients, whose deliverable it is. */
create function app.engagement_audience(p_org uuid, p_item uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select i.created_by from public.engagement_items i where i.organization_id = p_org and i.id = p_item
  union select i.owner_user_id from public.engagement_items i where i.organization_id = p_org and i.id = p_item and i.owner_user_id is not null
  union select e.actor_id from public.engagement_events e where e.organization_id = p_org and e.item_id = p_item
  union select m.user_id from public.organization_memberships m
         join public.engagement_items i on i.organization_id = m.organization_id and i.id = p_item
        where m.organization_id = p_org and m.status = 'active' and m.role = 'client' and i.kind = 'deliverable';
$$;
alter function app.engagement_audience(uuid, uuid) owner to motion_definer;
revoke all on function app.engagement_audience(uuid, uuid) from public, anon, authenticated;

create function api.create_engagement_item(p_org uuid, p_kind text, p_title text, p_detail text default null, p_due date default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_person uuid; v_slug text;
begin
  perform app.throttle(app.uid(), 'rpc', 60, interval '1 minute');
  perform app.require_org(p_org);
  if p_kind = 'request' then
    perform app.require_permission(p_org, 'actions.view');
  elsif p_kind = 'deliverable' then
    perform app.require_permission(p_org, 'actions.assign');
  else
    raise exception 'VALIDATION: an item is a request or a deliverable' using errcode = '22023';
  end if;
  if p_title is null or length(btrim(p_title)) = 0 then
    raise exception 'VALIDATION: give it a title' using errcode = '22023';
  end if;

  insert into public.engagement_items (organization_id, kind, title, detail, due_date, created_by)
  values (p_org, p_kind, btrim(p_title), nullif(btrim(coalesce(p_detail, '')), ''), p_due, app.uid())
  returning id into v_id;
  insert into public.engagement_events (organization_id, item_id, actor_id, event, to_status)
  values (p_org, v_id, app.uid(), 'created', 'open');
  perform app.audit(p_org, 'engagement.created', 'engagement_items', v_id, null,
                    jsonb_build_object('kind', p_kind), '{}'::jsonb);

  select o.slug into v_slug from public.organizations o where o.id = p_org;
  -- A request goes to the team (who can act on it); a deliverable to the clients (whose it is).
  for v_person in select * from app.org_people(p_org) loop
    if (p_kind = 'request' and app.has_permission_of(v_person, p_org, 'actions.assign'))
       or (p_kind = 'deliverable' and app.org_role_of(v_person, p_org) = 'client') then
      perform app.notify(p_org, v_person, app.uid(), 'actions.view', 'engagement_created',
        case p_kind when 'request' then 'New request: ' else 'New deliverable: ' end || left(btrim(p_title), 150),
        left(nullif(btrim(coalesce(p_detail, '')), ''), 300),
        '/app/' || v_slug || '/engagement/' || v_id::text);
    end if;
  end loop;
  return v_id;
end $$;
alter function api.create_engagement_item(uuid, text, text, text, date) owner to motion_definer;
revoke all on function api.create_engagement_item(uuid, text, text, text, date) from public, anon;
grant execute on function api.create_engagement_item(uuid, text, text, text, date) to authenticated;

create function api.update_engagement_status(p_item uuid, p_status text, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_kind text; v_from text; v_creator uuid; v_title text; v_person uuid; v_slug text;
begin
  perform app.throttle(app.uid(), 'rpc', 60, interval '1 minute');
  select i.organization_id, i.kind, i.status, i.created_by, i.title into v_org, v_kind, v_from, v_creator, v_title
    from public.engagement_items i where i.id = p_item for update;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.view');
  if p_status not in ('open', 'in_progress', 'delivered', 'closed') then
    raise exception 'VALIDATION: that is not a status' using errcode = '22023';
  end if;
  -- The team moves any item; a requester may only withdraw their own request.
  if not app.has_permission_of(app.uid(), v_org, 'actions.assign')
     and not (v_kind = 'request' and v_creator = app.uid() and p_status = 'closed') then
    raise exception 'PERMISSION_DENIED: actions.assign' using errcode = '42501';
  end if;
  if p_status = v_from then
    raise exception 'CONFLICT: it is already %', p_status using errcode = '23514';
  end if;

  update public.engagement_items
     set status = p_status,
         closed_at = case when p_status in ('delivered', 'closed') then now() else null end,
         owner_user_id = coalesce(owner_user_id, case when app.has_permission_of(app.uid(), v_org, 'actions.assign') then app.uid() end)
   where id = p_item;
  insert into public.engagement_events (organization_id, item_id, actor_id, event, from_status, to_status, note)
  values (v_org, p_item, app.uid(), 'status_changed', v_from, p_status, nullif(btrim(coalesce(p_note, '')), ''));
  perform app.audit(v_org, 'engagement.status_changed', 'engagement_items', p_item,
                    jsonb_build_object('status', v_from), jsonb_build_object('status', p_status), '{}'::jsonb);

  select o.slug into v_slug from public.organizations o where o.id = v_org;
  for v_person in select * from app.engagement_audience(v_org, p_item) loop
    perform app.notify(v_org, v_person, app.uid(), 'actions.view', 'engagement_status',
      '"' || left(v_title, 150) || '" is now ' || replace(p_status, '_', ' '),
      left(nullif(btrim(coalesce(p_note, '')), ''), 300),
      '/app/' || v_slug || '/engagement/' || p_item::text);
  end loop;
  return p_item;
end $$;
alter function api.update_engagement_status(uuid, text, text) owner to motion_definer;
revoke all on function api.update_engagement_status(uuid, text, text) from public, anon;
grant execute on function api.update_engagement_status(uuid, text, text) to authenticated;

create function api.comment_engagement_item(p_item uuid, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_title text; v_id uuid; v_person uuid; v_slug text;
begin
  perform app.throttle(app.uid(), 'rpc', 60, interval '1 minute');
  select i.organization_id, i.title into v_org, v_title from public.engagement_items i where i.id = p_item;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.view');
  if p_note is null or length(btrim(p_note)) = 0 then
    raise exception 'VALIDATION: write a comment' using errcode = '22023';
  end if;
  insert into public.engagement_events (organization_id, item_id, actor_id, event, note)
  values (v_org, p_item, app.uid(), 'commented', btrim(p_note)) returning id into v_id;

  select o.slug into v_slug from public.organizations o where o.id = v_org;
  for v_person in select * from app.engagement_audience(v_org, p_item) loop
    perform app.notify(v_org, v_person, app.uid(), 'actions.view', 'engagement_comment',
      'New comment on "' || left(v_title, 150) || '"', left(btrim(p_note), 300),
      '/app/' || v_slug || '/engagement/' || p_item::text);
  end loop;
  return v_id;
end $$;
alter function api.comment_engagement_item(uuid, text) owner to motion_definer;
revoke all on function api.comment_engagement_item(uuid, text) from public, anon;
grant execute on function api.comment_engagement_item(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Notifications about the client's data and reports
-- ---------------------------------------------------------------------------------------------
create function app.notify_data_added() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_person uuid; v_slug text; v_what text;
begin
  if new.status <> 'committed' or old.status = 'committed' then return new; end if;
  select o.slug into v_slug from public.organizations o where o.id = new.organization_id;
  v_what := replace(new.import_type::text, '_', ' ');
  for v_person in select * from app.org_people(new.organization_id) loop
    perform app.notify(new.organization_id, v_person, new.reviewed_by, 'financials.view', 'data_added',
      'New data added: ' || v_what,
      'Covering ' || coalesce(new.period_start::text, '?') || ' to ' || coalesce(new.period_end::text, '?') || '. Figures are recalculated shortly.',
      -- Someone who reviews imports goes to the import; everybody else to their Home.
      case when app.has_permission_of(v_person, new.organization_id, 'imports.review')
           then '/app/' || v_slug || '/data/imports/' || new.id::text
           else '/app/' || v_slug || '/home' end);
  end loop;
  return new;
end $$;
alter function app.notify_data_added() owner to motion_definer;
create trigger notify_data_added after update of status on public.import_batches
  for each row execute function app.notify_data_added();

create function app.notify_report_ready() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_person uuid; v_slug text;
begin
  -- The weekly and adviser reports only: a notification every morning for the daily brief would be
  -- noise, and a custom report is its author's own.
  if new.report_kind not in ('weekly_intelligence', 'adviser') then return new; end if;
  select o.slug into v_slug from public.organizations o where o.id = new.organization_id;
  for v_person in select * from app.org_people(new.organization_id) loop
    perform app.notify(new.organization_id, v_person, new.requested_by, 'reports.view', 'report_ready',
      case new.report_kind when 'weekly_intelligence' then 'Your weekly report is ready' else 'An Accountant/CFO Report is ready' end,
      'Covering ' || new.window_start::text || ' to ' || new.window_end::text || '.',
      '/app/' || v_slug || '/reports/r/' || new.id::text);
  end loop;
  return new;
end $$;
alter function app.notify_report_ready() owner to motion_definer;
create trigger notify_report_ready after insert on public.reports
  for each row execute function app.notify_report_ready();

-- ---------------------------------------------------------------------------------------------
-- Purge: the new tables go first (children before parents)
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
    -- Team/Client engagement (ADR-144).
    'notifications', 'engagement_events', 'engagement_items', 'action_comments',
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
