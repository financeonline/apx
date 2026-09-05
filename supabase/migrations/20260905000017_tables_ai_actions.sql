-- MOTION — Phase 2 (plan Phase 4) · AI conversation storage, the Action Centre and report artefacts.
-- Contract: DATABASE_ARCHITECTURE.md §7, §8, §9 (report_files); ADR-032, ADR-038.7.
--
-- Scope note: this migration creates the SCHEMA these features need. No AI behaviour, prompt, tool
-- or analyst loop is built here — that is plan Phase 11. The tables exist now because
-- `evidence_bundles.origin_id`, `ai_feedback.message_id` and `actions.source_id` are polymorphic
-- references that the `same_org_ref` trigger must be able to resolve, and a trigger cannot be
-- written against tables that do not exist yet.

-- ---------------------------------------------------------------------------------------------
-- AI conversations and messages
-- ---------------------------------------------------------------------------------------------
create table public.ai_conversations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  title             text,
  status            public.ai_conversation_status_enum not null default 'active',
  last_message_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint ai_conversations_org_id_unique unique (organization_id, id)
);

create index ai_conversations_by_user
  on public.ai_conversations (organization_id, user_id, last_message_at desc);

create table public.ai_messages (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  conversation_id      uuid not null,
  role                 public.ai_message_role_enum not null,
  -- ADR-032.4: user text only. An assistant row's content is ALWAYS NULL — the validated
  -- `structured_response` is the single assistant channel, so there is no free-text path by which an
  -- unvalidated model answer could reach a reader.
  content              text,
  structured_response  jsonb,
  prompt_version       text,
  model                text,
  input_tokens         integer,
  output_tokens        integer,
  latency_ms           integer,
  grounding_status     public.grounding_status_enum not null default 'not_applicable',
  grounding_report     jsonb,
  evidence_bundle_id   uuid,
  period_context       jsonb not null default '{}'::jsonb,
  flagged              boolean not null default false,
  created_at           timestamptz not null default now(),
  constraint ai_messages_org_id_unique unique (organization_id, id),
  constraint ai_messages_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.ai_conversations (organization_id, id) on delete cascade,
  constraint ai_messages_bundle_fk
    foreign key (organization_id, evidence_bundle_id) references public.evidence_bundles (organization_id, id),
  -- The channel rule, enforced rather than merely documented (ADR-032.4).
  constraint ai_messages_channel
    check ((role = 'user'      and content is not null and structured_response is null)
        or (role = 'assistant' and content is null))
);

create index ai_messages_by_conversation
  on public.ai_messages (organization_id, conversation_id, created_at);

-- This table IS the AI audit trail (DATABASE_ARCHITECTURE.md §7).
create table public.ai_tool_calls (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  message_id       uuid not null,
  sequence         smallint not null,
  tool_name        text not null,
  input            jsonb not null default '{}'::jsonb,
  authorized       boolean not null,
  denial_reason    text,
  output_hash      bytea,
  -- Counts, metric keys and ids returned — deliberately not the full payload, which would duplicate
  -- tenant financial data into a second table with different access rules.
  output_summary   jsonb not null default '{}'::jsonb,
  duration_ms      integer,
  error            text,
  created_at       timestamptz not null default now(),
  constraint ai_tool_calls_org_id_unique unique (organization_id, id),
  constraint ai_tool_calls_message_fk
    foreign key (organization_id, message_id) references public.ai_messages (organization_id, id) on delete cascade,
  constraint ai_tool_calls_sequence_unique unique (message_id, sequence)
);

create index ai_tool_calls_by_message on public.ai_tool_calls (organization_id, message_id, sequence);
create index ai_tool_calls_by_tool on public.ai_tool_calls (organization_id, tool_name, created_at desc);

create table public.ai_feedback (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  message_id       uuid,                                -- guarded by same_org_ref
  alert_id         uuid,                                -- guarded by same_org_ref
  user_id          uuid not null references public.profiles (id) on delete cascade,
  feedback_type    public.ai_feedback_type_enum not null,
  comment          text,
  status           public.ai_feedback_status_enum not null default 'open',
  reviewed_by      uuid references public.profiles (id) on delete set null,
  reviewed_at      timestamptz,
  resolution_note  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ai_feedback_org_id_unique unique (organization_id, id),
  constraint ai_feedback_message_fk
    foreign key (organization_id, message_id) references public.ai_messages (organization_id, id) on delete cascade,
  constraint ai_feedback_alert_fk
    foreign key (organization_id, alert_id) references public.alerts (organization_id, id) on delete cascade,
  -- Feedback is about something. A row referencing neither an answer nor an alert cannot be reviewed.
  constraint ai_feedback_subject check (message_id is not null or alert_id is not null)
);

create index ai_feedback_open on public.ai_feedback (organization_id, status, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Actions (SOW §17 Action Centre)
-- ---------------------------------------------------------------------------------------------
create table public.actions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  title               text not null constraint actions_title_len check (length(title) between 1 and 300),
  issue               text,                              -- the problem or opportunity
  recommendation      text,
  priority            public.action_priority_enum not null default 'medium',
  -- Must be a member or an assigned employee; validated in the api function, not by FK, because the
  -- membership can be revoked later without invalidating the historical assignment.
  owner_user_id       uuid references public.profiles (id) on delete set null,
  due_date            date,
  status              public.action_status_enum not null default 'open',
  source_type         public.action_source_enum not null default 'user',
  source_id           uuid,                              -- polymorphic; guarded by same_org_ref
  evidence_bundle_id  uuid,
  outcome_notes       text,
  outcome_value       numeric(18,2),
  outcome_currency    char(3),
  completed_at        timestamptz,
  dismissed_reason    text,
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint actions_org_id_unique unique (organization_id, id),
  constraint actions_bundle_fk
    foreign key (organization_id, evidence_bundle_id) references public.evidence_bundles (organization_id, id),
  constraint actions_completed_pair
    check ((status = 'completed') = (completed_at is not null))
);

create index actions_worklist on public.actions (organization_id, status, priority, due_date);
create index actions_by_owner on public.actions (organization_id, owner_user_id, status);

alter table public.alerts
  add constraint alerts_action_fk foreign key (organization_id, action_id)
      references public.actions (organization_id, id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- Rendered report artefacts (ADR-038.7; F-A-11)
-- ---------------------------------------------------------------------------------------------
-- There is no report *definition* table in MVP: the monthly management pack is code. This table
-- holds only what was actually rendered, so a download can be re-served and audited.
create table public.report_files (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  period_id           uuid not null,
  report_kind         public.report_kind_enum not null default 'monthly_management',
  job_id              uuid,
  storage_bucket      text not null default 'reports',
  storage_path        text not null,                    -- {organization_id}/{period}/{job_id}.pdf
  sha256              bytea,
  byte_size           bigint,
  generated_by        uuid references public.profiles (id) on delete set null,
  evidence_bundle_id  uuid,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  constraint report_files_org_id_unique unique (organization_id, id),
  constraint report_files_object_unique unique (storage_bucket, storage_path),
  constraint report_files_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id),
  constraint report_files_job_fk
    foreign key (organization_id, job_id) references public.jobs (organization_id, id) on delete set null,
  constraint report_files_bundle_fk
    foreign key (organization_id, evidence_bundle_id) references public.evidence_bundles (organization_id, id)
);

create index report_files_by_period on public.report_files (organization_id, period_id, created_at desc);
