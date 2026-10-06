-- MOTION — Phase 17 · the Funding Readiness Report's kind (REQ-RP-05; ADR-141, ADR-145). On its own:
-- a value added by `alter type … add value` cannot be used in the transaction that adds it.
alter type public.report_kind_enum add value if not exists 'funding_readiness';
