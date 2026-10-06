-- MOTION — Phase 17 · Intelligent Reporting: the report kinds and the job that composes them.
-- Contract: PHASE_17_IMPLEMENTATION.md §1, §8; ADR-141.
--
-- On their own, because a value added by `alter type … add value` cannot be used in the transaction
-- that adds it; the table and functions that use them follow in the next migration.
--
--   daily_brief          Daily Executive Brief (with the Daily Challenges section, R17-2)
--   weekly_intelligence  Weekly Intelligence Report (with the week-on-week comparison, R17-2)
--   adviser              Accountant/CFO Report
--   custom_ai            Custom AI Report
--
-- `funding_readiness` is deliberately absent: Phase 16 has not started, and a kind with no report
-- behind it would be a promise the product cannot keep.

alter type public.report_kind_enum add value if not exists 'daily_brief';
alter type public.report_kind_enum add value if not exists 'weekly_intelligence';
alter type public.report_kind_enum add value if not exists 'adviser';
alter type public.report_kind_enum add value if not exists 'custom_ai';

alter type public.job_type_enum add value if not exists 'report.compose';
