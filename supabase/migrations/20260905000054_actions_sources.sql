-- MOTION — Action Centre · Creating an action from the thing that prompted it.
-- Contract: SERVICE_ARCHITECTURE.md §4.13; EVIDENCE_MODEL.md §5 (action row), §8.9;
-- DATABASE_ARCHITECTURE.md `actions`; IMPLEMENTATION_PLAN.md Phase 12; ADR-032.5, R2-C-12.
--
-- `api.create_action` already exists and already refuses an AI source that did not pass grounding.
-- What it never did is the other half of §5's action row: **the source's bundle items are COPIED
-- into a new bundle**, so the action's evidence is frozen even if the alert is re-evaluated
-- afterwards. Without the copy, an action created from an alert in March would silently start
-- showing June's figures the next time the rule fired — and an action is a commitment somebody made
-- on the strength of what they were shown at the time.

-- ---------------------------------------------------------------------------------------------
-- §8.9: a clone remembers where it came from
-- ---------------------------------------------------------------------------------------------
--
-- "Reading through any item of an `ai_response` bundle … and through an `action` bundle cloned from
-- one (`origin_message_id` set) requires the origin message's owner or an organization owner/admin
-- (R2-C-12)." The column the rule names did not exist, so a clone of an AI answer's evidence lost
-- the one fact that decides who may read it.
alter table public.evidence_bundles
  add column origin_message_id uuid;

comment on column public.evidence_bundles.origin_message_id is
  'For an action bundle cloned from an ai_response bundle: the message it came from. Carries the '
  'ownership rule of EVIDENCE_MODEL.md §8.9 across the clone (R2-C-12).';

-- ---------------------------------------------------------------------------------------------
-- The clone itself
-- ---------------------------------------------------------------------------------------------
create function app.clone_bundle_for_action(
  p_org    uuid,
  p_source uuid,
  p_action uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_bundle  uuid;
  v_kind    public.evidence_kind_enum;
  v_run     uuid;
  v_message uuid;
begin
  if p_source is null then return null; end if;

  select b.kind, b.calculation_run_id,
         case when b.kind = 'ai_response' then b.origin_id else b.origin_message_id end
    into v_kind, v_run, v_message
    from public.evidence_bundles b
   where b.organization_id = p_org and b.id = p_source;
  if v_kind is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.evidence_bundles
         (organization_id, kind, origin_table, origin_id, calculation_run_id,
          origin_message_id, created_by_type, created_by)
  values (p_org, 'action', 'actions', p_action, v_run, v_message, 'user', app.uid())
  returning id into v_bundle;

  -- Items are COPIED, not referenced. A bundle is immutable (§8.1), so the copy can never drift
  -- from what the reader saw, and the source stays the evidence of the alert or the answer.
  insert into public.evidence_items
         (organization_id, bundle_id, sort_order, item_type, ref_id, ref_revision_no,
          query_descriptor, descriptor_hash, label, claim, assurance_level)
  select p_org, v_bundle, i.sort_order, i.item_type, i.ref_id, i.ref_revision_no,
         i.query_descriptor, i.descriptor_hash, i.label, i.claim, i.assurance_level
    from public.evidence_items i
   where i.organization_id = p_org and i.bundle_id = p_source;

  return v_bundle;
end $$;

alter function app.clone_bundle_for_action(uuid, uuid, uuid) owner to motion_definer;
revoke all on function app.clone_bundle_for_action(uuid, uuid, uuid) from public, authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- api.create_action_from_alert
-- ---------------------------------------------------------------------------------------------
--
-- Pins the CURRENT revision, and clones that revision's bundle. An alert is re-evaluated whenever
-- the figures change (ADR-034); the action must keep saying what the alert said when somebody
-- decided to act on it, or "why did we do this?" becomes unanswerable a month later.
create function api.create_action_from_alert(p_alert uuid, p_input jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_revision uuid;
  v_rev_no   integer;
  v_bundle   uuid;
  v_title    text;
  v_action   uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.current_revision_id into v_org, v_revision
    from public.alerts a where a.id = p_alert;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.create');

  select r.revision_no, r.evidence_bundle_id into v_rev_no, v_bundle
    from public.alert_revisions r
   where r.organization_id = v_org and r.id = v_revision;

  v_title := coalesce(nullif(trim(p_input ->> 'title'), ''),
                      (select a.title from public.alerts a where a.id = p_alert));

  insert into public.actions
         (organization_id, title, issue, recommendation, priority, owner_user_id, due_date,
          source_type, source_id, created_by)
  values (v_org, v_title,
          coalesce(p_input ->> 'issue',
                   (select r.explanation from public.alert_revisions r where r.id = v_revision)),
          coalesce(p_input ->> 'recommendation',
                   (select a.recommended_next_step from public.alerts a where a.id = p_alert)),
          coalesce((p_input ->> 'priority')::public.action_priority_enum, 'medium'),
          nullif(p_input ->> 'owner_user_id', '')::uuid,
          (p_input ->> 'due_date')::date,
          'alert', p_alert, app.uid())
  returning id into v_action;

  update public.actions
     set evidence_bundle_id = app.clone_bundle_for_action(v_org, v_bundle, v_action)
   where organization_id = v_org and id = v_action;

  -- The alert points back, so the list can show "converted" rather than offering the button twice.
  update public.alerts set action_id = v_action
   where organization_id = v_org and id = p_alert;

  perform app.audit(v_org, 'alert.converted_to_action', 'alerts', p_alert, null,
                    jsonb_build_object('action_id', v_action, 'revision_no', v_rev_no), '{}'::jsonb);
  perform app.audit(v_org, 'action.created', 'actions', v_action, null,
                    jsonb_build_object('title', v_title, 'source_type', 'alert'), '{}'::jsonb);
  return v_action;
end $$;

alter function api.create_action_from_alert(uuid, jsonb) owner to motion_definer;
revoke all on function api.create_action_from_alert(uuid, jsonb) from public, anon;
grant execute on function api.create_action_from_alert(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- api.create_action_from_recommendation (ADR-032.5)
-- ---------------------------------------------------------------------------------------------
--
-- The gate is the whole function: an action may be created from an AI answer ONLY when that answer
-- passed grounding. A degraded answer has had its unverifiable sentences REMOVED (§7.8), and a
-- failed one was never shown as fact — turning either into a task would launder it into something
-- that looks authoritative precisely because it is now a commitment with an owner and a due date.
create function api.create_action_from_recommendation(
  p_message uuid,
  p_index   integer,
  p_input   jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_status   public.grounding_status_enum;
  v_response jsonb;
  v_bundle   uuid;
  v_rec      jsonb;
  v_action   uuid;
  v_title    text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select m.organization_id, m.grounding_status, m.structured_response, m.evidence_bundle_id
    into v_org, v_status, v_response, v_bundle
    from public.ai_messages m where m.id = p_message;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.create');

  if v_status <> 'passed' then
    raise exception 'VALIDATION: an action cannot be created from an ungrounded answer'
      using errcode = '22023';
  end if;

  v_rec := v_response -> 'recommended_actions' -> p_index;
  if v_rec is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The three Statement texts, copied verbatim (§4.13). The model wrote them and grounding passed
  -- them; re-writing them here would put words in the analyst's mouth that nothing checked.
  v_title := coalesce(nullif(trim(p_input ->> 'title'), ''), v_rec -> 'title' ->> 'statement');
  if coalesce(trim(v_title), '') = '' then
    raise exception 'VALIDATION: a title is required' using errcode = '22023';
  end if;

  insert into public.actions
         (organization_id, title, issue, recommendation, priority, owner_user_id, due_date,
          source_type, source_id, created_by)
  values (v_org, v_title,
          v_rec -> 'issue' ->> 'statement',
          v_rec -> 'recommendation' ->> 'statement',
          coalesce((v_rec ->> 'priority')::public.action_priority_enum, 'medium'),
          nullif(p_input ->> 'owner_user_id', '')::uuid,
          (p_input ->> 'due_date')::date,
          'ai', p_message, app.uid())
  returning id into v_action;

  update public.actions
     set evidence_bundle_id = app.clone_bundle_for_action(v_org, v_bundle, v_action)
   where organization_id = v_org and id = v_action;

  perform app.audit(v_org, 'action.created', 'actions', v_action, null,
                    jsonb_build_object('title', v_title, 'source_type', 'ai',
                                       'message_id', p_message), '{}'::jsonb);
  return v_action;
end $$;

alter function api.create_action_from_recommendation(uuid, integer, jsonb) owner to motion_definer;
revoke all on function api.create_action_from_recommendation(uuid, integer, jsonb) from public, anon;
grant execute on function api.create_action_from_recommendation(uuid, integer, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- api.update_action — the staff edit §4.13 names
-- ---------------------------------------------------------------------------------------------
--
-- Separate from `update_own_action` because they answer different questions. This one asks "may you
-- edit actions here at all"; that one asks "is this action yours", and limits the columns to the
-- two a client may move. Collapsing them into one function with a role branch is how a client ends
-- up able to change a due date (ADR-003: code asks for a permission, never for a role name).
create function api.update_action(p_action uuid, p_patch jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_owner uuid; v_before jsonb;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.owner_user_id,
         jsonb_build_object('title', a.title, 'priority', a.priority, 'due_date', a.due_date)
    into v_org, v_owner, v_before
    from public.actions a where a.id = p_action;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.create');

  if p_patch ? 'owner_user_id' then
    raise exception 'VALIDATION: use api.assign_action to change the owner' using errcode = '22023';
  end if;
  if p_patch ? 'title' and coalesce(trim(p_patch ->> 'title'), '') = '' then
    raise exception 'VALIDATION: a title is required' using errcode = '22023';
  end if;

  update public.actions
     set title = coalesce(nullif(trim(p_patch ->> 'title'), ''), title),
         issue = coalesce(p_patch ->> 'issue', issue),
         recommendation = coalesce(p_patch ->> 'recommendation', recommendation),
         priority = coalesce((p_patch ->> 'priority')::public.action_priority_enum, priority),
         due_date = case when p_patch ? 'due_date'
                         then (p_patch ->> 'due_date')::date else due_date end
   where organization_id = v_org and id = p_action;

  perform app.audit(v_org, 'action.updated', 'actions', p_action, v_before, p_patch, '{}'::jsonb);
  return p_action;
end $$;

alter function api.update_action(uuid, jsonb) owner to motion_definer;
revoke all on function api.update_action(uuid, jsonb) from public, anon;
grant execute on function api.update_action(uuid, jsonb) to authenticated;
