-- MOTION — Phase 3 (plan Phase 5) · Columns the import review and commit gate need.
-- Contract: IMPORT_ENGINE.md §8.2 (batch-level checks), §10 (review contract), §11 (commit).
--
-- Confirmations are stored, not inferred. IMPORT_ENGINE.md §11 requires commit to verify that
-- "every confirmation recorded" — a balance basis, a replacement of existing balances, a probable
-- re-export, an open-items list. If the gate trusted a flag sent by the client it would be no gate
-- at all, so each confirmation is written by its own api.* call with the actor and the instant, and
-- the commit function re-reads them.

alter table public.import_batches
  -- Batch-level issue codes from the last validation pass (§8.2). Errors here block commit.
  add column batch_issues jsonb not null default '[]'::jsonb,
  -- { "IMP-TB-012": {"by": uuid, "at": timestamptz, "value": "cumulative"}, … }
  add column confirmations jsonb not null default '{}'::jsonb,
  -- Which confirmation codes this batch's shape REQUIRES. Computed at validation, checked at commit.
  add column required_confirmations text[] not null default '{}',
  -- §5.4 per-page review state for pdf_claude batches: page number → confirmed-by.
  add column page_confirmations jsonb not null default '{}'::jsonb,
  -- Optimistic concurrency for two reviewers in two tabs (§16). The review screen sends the value it
  -- read; a stale one is a CONFLICT with a reload prompt rather than a silent overwrite.
  add column review_token uuid not null default gen_random_uuid();

-- The declared export range is confirmed by the reviewer, so it must be nullable until then. It was
-- created NOT NULL in Phase 2 with a default of the current month, which would have let a batch
-- commit with a range nobody looked at.
alter table public.import_batches
  alter column period_start drop not null,
  alter column period_end drop not null;

comment on column public.import_batches.period_start is
  'The DECLARED export range start, confirmed by the reviewer at IMP-RANGE-015 (ADR-047.6). '
  'Coverage tests read this, never the last posting date. NULL until confirmed.';

-- Row-level: which parsed line a row came from, and what the reviewer changed.
alter table public.import_rows
  -- Set when a reviewer edits mapped_data in place (§10). The original stays in raw_data.
  add column fixed_by uuid references public.profiles (id) on delete set null,
  add column fixed_at timestamptz,
  -- §5.4: the page a PDF row came from, so page-wide confirmation can find its rows.
  add column source_page integer;

create index import_rows_by_page
  on public.import_rows (organization_id, batch_id, source_page) where source_page is not null;
