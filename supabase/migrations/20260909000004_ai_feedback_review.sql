-- MOTION — reviewing analyst feedback (Phase 11 Slice 6, ADR-082).
--
-- AI_ARCHITECTURE.md §13 (CD-25): `/platform/ai-feedback` lists open items with the message, tool
-- calls, grounding report and evidence; platform staff mark them reviewed / actioned / dismissed
-- with a note; employees see only assigned organisations' items. DATABASE_ARCHITECTURE.md §14
-- catalogued `api.review_ai_feedback(feedback, status, note)` under `platform.ai_feedback.review`
-- from the start; this is the function, and the reads the page needs.
--
-- Two things change for an assigned EMPLOYEE at aal2. The select policies on feedback, conversations
-- and tool calls named owner/admin/super_admin only (ADR-065), which left the employee — the person
-- RBAC_MATRIX.md §2.1 gives `platform.ai_feedback.review` ◐ for assigned organisations — unable to
-- read what they are asked to review. The role set now includes `employee`, whose reach is already
-- confined to assigned organisations by app.accessible_org_roles() (SECURITY_MODEL.md §4, aal2).
-- Nothing else widens: a client still sees only their own conversation and feedback.

create function api.review_ai_feedback(
  p_feedback uuid, p_status public.ai_feedback_status_enum, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_message uuid; v_before text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select f.organization_id, f.message_id, f.status::text into v_org, v_message, v_before
    from public.ai_feedback f where f.id = p_feedback;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'platform.ai_feedback.review');

  if p_status = 'open' then
    raise exception 'VALIDATION: a review marks feedback reviewed, actioned or dismissed' using errcode = '22023';
  end if;
  if p_note is not null and length(p_note) > 1000 then
    raise exception 'VALIDATION: keep the note under 1000 characters' using errcode = '22023';
  end if;

  update public.ai_feedback
     set status = p_status, reviewed_by = app.uid(), reviewed_at = now(),
         resolution_note = nullif(btrim(p_note), ''), updated_at = now()
   where organization_id = v_org and id = p_feedback;

  -- §13: a message under review, or acted on, wears the badge in its organisation; a dismissed
  -- report takes it off. Only an assistant message can carry it.
  if v_message is not null then
    update public.ai_messages
       set flagged = (p_status in ('reviewed', 'actioned'))
     where organization_id = v_org and id = v_message;
  end if;

  perform app.audit(v_org, 'ai.feedback_reviewed', 'ai_feedback', p_feedback,
                    jsonb_build_object('status', v_before),
                    jsonb_build_object('status', p_status::text),
                    '{}'::jsonb);
  return p_feedback;
end $$;

alter function api.review_ai_feedback(uuid, public.ai_feedback_status_enum, text) owner to motion_definer;
revoke all on function api.review_ai_feedback(uuid, public.ai_feedback_status_enum, text) from public, anon;
grant execute on function api.review_ai_feedback(uuid, public.ai_feedback_status_enum, text) to authenticated;

-- The reviewer's reads (§13): what they review, in the organisations they may reach.
drop policy ai_feedback_select on public.ai_feedback;
create policy ai_feedback_select on public.ai_feedback for select to authenticated
  using (
    organization_id in (select app.accessible_org_ids())
    and (user_id = app.uid()
         or organization_id in (select app.org_ids_with_role('owner','admin','employee','super_admin')))
  );

drop policy ai_conversations_select on public.ai_conversations;
create policy ai_conversations_select on public.ai_conversations for select to authenticated
  using (
    organization_id in (select app.accessible_org_ids())
    and (user_id = app.uid()
         or organization_id in (select app.org_ids_with_role('owner','admin','employee','super_admin')))
  );

drop policy ai_tool_calls_select on public.ai_tool_calls;
create policy ai_tool_calls_select on public.ai_tool_calls for select to authenticated
  using (organization_id in (select app.org_ids_with_role('owner','admin','employee','super_admin')));
