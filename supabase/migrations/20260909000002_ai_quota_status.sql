-- MOTION — the analyst's quota, readable by the person it applies to (Phase 11 Slice 4, ADR-079).
--
-- UX_ARCHITECTURE.md §5 gives AnalystChat `quota: { remainingToday }` and ROUTE_ARCHITECTURE.md §121
-- shows "Quota exhausted → notice with reset time". The only reader of the quota was the refusal
-- inside api_server.ai_persist_turn, which a user JWT cannot call and which only speaks when it is
-- too late. This function answers the same question the same way — the SAME counting rules, so the
-- notice and the refusal can never disagree — for a member with `ai.use`.
--
-- It reveals nothing a member could not infer by asking: how many questions this organisation has
-- asked today and its allowance. The platform's override table is read through app.effective_quota
-- (SECURITY DEFINER), never granted to the user.

create function api.ai_quota_status(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_daily      bigint;
  v_ceiling    bigint;
  v_used_today bigint;
  v_used_month bigint;
  v_day_start  timestamptz;
begin
  if p_org is null or p_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(p_org, 'ai.use');

  v_daily     := app.effective_quota(p_org, 'ai_quota_daily');
  v_ceiling   := app.effective_quota(p_org, 'ai_token_ceiling_monthly');
  v_day_start := date_trunc('day', now() at time zone 'utc') at time zone 'utc';

  -- Identical to the user half of api_server.ai_persist_turn: user turns since UTC midnight, and
  -- every token this month.
  select count(*) into v_used_today
    from public.ai_messages m
   where m.organization_id = p_org and m.role = 'user'
     and m.created_at >= date_trunc('day', now() at time zone 'utc');

  select coalesce(sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0)), 0) into v_used_month
    from public.ai_messages m
   where m.organization_id = p_org
     and m.created_at >= date_trunc('month', now() at time zone 'utc');

  return jsonb_build_object(
    'used_today',       v_used_today,
    'daily_limit',      v_daily,
    'remaining_today',  case when v_daily is null then null else greatest(v_daily - v_used_today, 0) end,
    'tokens_month',     v_used_month,
    'monthly_ceiling',  v_ceiling,
    'monthly_exhausted', (v_ceiling is not null and v_used_month >= v_ceiling),
    'resets_at',        v_day_start + interval '1 day');
end $$;

alter function api.ai_quota_status(uuid) owner to motion_definer;
revoke all on function api.ai_quota_status(uuid) from public, anon;
grant execute on function api.ai_quota_status(uuid) to authenticated;
