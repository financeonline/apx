-- APX — Company roles: Accountant and 3rd party (ADR-172, part 1 of 3).
--
-- The client's revised SOW §"User Access" names five kinds of person; the owner's choices
-- (2026-10-14, recorded in src/modules/tenancy/domain/member-access.ts — the contract) map them:
--
--   - Financial Analyst → the existing platform `employee` (a label only; nothing here).
--   - Accountant        → NEW company role `accountant`: the company's own or outside accountant,
--                         invited by the owner or an admin. Data capture and compliance; no AI, no
--                         team, no settings.
--   - Client            → the existing `client`.
--   - 3rd party         → NEW company role `third_party`: a lender, investor or partner. A read-only
--                         overview (headline figures, the Business Health Score, reports) and
--                         "Request more information".
--
-- This file only adds the two enum values. It is a file of its own because a value added by
-- `alter type … add value` cannot be USED in the transaction that adds it, and the next two
-- migrations use them (role_permissions rows, policies, the api.* functions that compare roles as
-- text). Owners and admins invite and assign the new roles through the existing
-- `api.invite_member_with_token` / `api.change_member_role`, which take `membership_role_enum`; the
-- ceiling (`app.ceiling_allows` over `app.role_rank`) is extended in 20261018000019.

alter type public.membership_role_enum add value if not exists 'accountant';
alter type public.membership_role_enum add value if not exists 'third_party';
