-- MOTION — Budgets (Agreement §9 "budget/forecast variance"; REQ-FC-03/04; owner decision 2026-10-06,
-- ADR-142): the enum values a budget import needs, on their own because a value added by
-- `alter type … add value` cannot be used in the transaction that adds it.
alter type public.import_type_enum add value if not exists 'budget';
alter type public.import_target_enum add value if not exists 'budget_lines';
alter type public.financial_record_table_enum add value if not exists 'budget_lines';
alter type public.document_kind_enum add value if not exists 'budget';
