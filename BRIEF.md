# BRIEF: MOTION — Financial Intelligence System (Architecture Phase)
**Building:** The complete engineering specification for MOTION, a multi-tenant financial-intelligence SaaS for non-technical business owners and their advisers, so a senior engineer can implement it without guessing.
**Job class:** dashboard (SaaS app) — specification only in this phase, no code.
**Visitor's job:** Upload financial data and, within minutes, see how the business is doing, what changed, why, what needs attention and what to do next — with every material number traceable to source.
**Register:** calm, trustworthy, plain-spoken.
**Pages/features:** Home, Insights, Money, Customers, Actions, Reports, AI Analyst, Settings; separate /platform admin; import engine; deterministic calculation engine; health score; alerts; evidence layer; Claude analyst behind server-side tools.
**Constraints/Existing:** Source of truth is `docs/SOW_v2_extracted.md` (extracted from Downloads/MOTION_Financial_Intelligence_System_SOW_v1.docx, titled "Version 2.0"). Stack fixed by SOW: Next.js, TypeScript, Tailwind, shadcn/ui, Supabase (Postgres, Auth, Storage), Recharts, Claude API server-side. Five user-facing roles: Owner, Super Admin, Admin, Client, My Employee. Directory was empty at start; no existing code.
**Assumptions:** Assuming the complete SOW file (with Team Management, CRM and Marketing Analysis rows) is authoritative over the later "Copy" that blanks those rows. Assuming hosting on Vercel + Supabase cloud. Assuming single currency per organization for MVP. Assuming calendar-month periods with configurable fiscal-year start. Assuming the SOW "adviser" in MVP is a platform employee, not an external accountancy tenant. All further assumptions are numbered in `docs/ARCHITECTURAL_DECISIONS.md`.
**Done when:**
- [x] All 17 files listed in the request exist under `docs/` and each is non-empty, with no code beyond schema/type/contract sketches.
- [x] Every SOW section (1–30) is referenced by at least one requirement ID in `docs/PRODUCT_REQUIREMENTS.md`, verifiable with `grep -c "SOW §" docs/PRODUCT_REQUIREMENTS.md`.
- [x] Every table named in any doc also appears in `docs/DATABASE_ARCHITECTURE.md`, verifiable by grep of backticked table names.
- [x] Every permission key in the request appears in `docs/RBAC_MATRIX.md` with a value for all five roles.
- [x] `docs/ARCHITECTURAL_DECISIONS.md` contains a "CRITICAL DECISIONS REQUIRED" section where every item has Problem, Why it matters, Recommended decision, Impact if ignored.
- [x] `docs/ARCHITECTURE.md` ends with 20 numbered red flags, each with Risk, Likelihood, Impact, Prevention.
**Out of scope:** No application code, no database migrations, no UI mockups, no vendor procurement; forecasting, scenarios, CRM, marketing, funding readiness, adviser command centre and the reporting suite are specified only at boundary level as post-MVP.
