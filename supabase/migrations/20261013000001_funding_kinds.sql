-- MOTION — Phase 16 · Funding Readiness: the job and the evidence kind (PHASE_16_IMPLEMENTATION.md §3, §8;
-- ADR-145). On their own: a value added by `alter type … add value` cannot be used in the same transaction.
alter type public.job_type_enum add value if not exists 'funding.assess';
alter type public.evidence_kind_enum add value if not exists 'funding_assessment';
