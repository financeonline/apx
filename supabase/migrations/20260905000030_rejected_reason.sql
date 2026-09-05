-- MOTION — Phase 3 (plan Phase 5) · `rejected_reason` on all four financial record tables.
--
-- IMPORT_ENGINE.md §12 says a rolled-back batch's records get
-- `record_status = 'rejected', rejected_reason = 'batch rolled back'`, and that applies to whichever
-- of the four tables the batch targeted. DATABASE_ARCHITECTURE.md §3 lists the column only under
-- `ledger_entries`, so the other three were created without it and the rollback failed at runtime
-- with "column rejected_reason does not exist" — found by the rollback test, not by inspection.
--
-- The column matters beyond tidiness: "why is this row not in my figures any more?" must have an
-- answer on the row itself, not only in an audit event a reader may not have access to.

alter table public.period_balances    add column rejected_reason text;
alter table public.invoices           add column rejected_reason text;
alter table public.bank_transactions  add column rejected_reason text;

comment on column public.bank_transactions.rejected_reason is
  'Why this record left the accepted set: a batch rollback, or a manual rejection (IMPORT_ENGINE.md §12).';
