# MOTION — RBAC Model & Permission Matrix

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-002, ADR-003, ADR-026, ADR-037, ADR-038, CD-13 to CD-17), `TENANCY_MODEL.md`
Consumed by: `SECURITY_MODEL.md`, `SERVICE_ARCHITECTURE.md`, `ROUTE_ARCHITECTURE.md`, `TEST_STRATEGY.md`

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026 (every permission re-checked inside `api.*` functions; no direct table writes), ADR-037 (Data menu; Employee `users.view` ✗), ADR-038 (suspension at the database, sole-owner disable guard, invitation email binding, MFA and re-authentication for platform users, audited `/platform` tenant views, signed-URL-only Storage). Findings addressed: F-A-01, F-A-02, F-A-04, F-A-06, F-A-07, F-A-10, F-A-12, F-D-07, F-D-14. See `RED_TEAM_REVIEW.md`.

> **Revision 1.7 (ADR-187, 2026-11-05).** A Financial Analyst creates companies and manages the companies they created or the super admin gave them: the people (`users.view`, `users.invite`, `users.manage`, with the owner's ceiling), the company's settings (`settings.manage`), the owner's login and the company's active/deactivated switch. The super admin sets each analyst's departments and permission switches per company (§7). Never `org.delete`, `billing.manage` or `audit.view` unless switched on.

> **Revision 1.3 (ADR-172, 2026-10-14).** Two new company roles, `accountant` and `third_party`; the platform `employee` is shown as **Financial Analyst**; per-person permission switches set by the owner or an admin (§7); "Request more information" (§7.3); and every tenant-data read policy now names a PERMISSION instead of a list of roles, so a switch opens or closes a table for one person (§8). Contract: `src/modules/tenancy/domain/member-access.ts`. Migrations `20261018000017`–`20261018000019`.

> **Revision 1.4 (ADR-172 hardening, independent security review, 2026-10-14).** Never beyond one's own rights on EVERY path that sets access, not only the switch: nobody changes their own role; an owner's switch is locked against admins and survives a role change; a role change and an invitation switch off whatever of the new role's defaults the actor lacks (§3.15–3.18, §7). Detail stored a second time — the audit trail's row copies, raw import text, the overview's jsonb payloads, per-customer pointers — is gated like the detail itself, and a suspended company shows each person what they saw before, no more (§8). Migrations `20261018000032`–`20261018000035`; pgTAP `31_member_access_hardening`.

> **Revision 1.5 (ADR-172 addendum, the owner's decision, 2026-10-14).** The Monthly Management Report has two editions. The FULL report (alerts, open action titles) and its stored PDF need `financials.view` as well as `reports.view`; a reader without it — a 3rd party by default, or anyone whose switch is off — gets the SUMMARY EDITION (figures and Business Health Score only), rendered on request from the overview and never stored (§8.3). Migration `20261018000036`; pgTAP `32_report_variants`.

> **Revision 1.6 (ADR-174, the owner's decision, 2026-10-14).** Only the company's owner creates team members: the admin role no longer holds `users.invite`, and `app.check_member_login_role` refuses every creator but an owner. An admin still manages the people the owner created. Migration `20261018000038`.

> **Revision 1.2 (red-team round 2, 2026-09-05).** Applies ADR-043 (`api` vs `api_server`), ADR-044 (MFA at the database for employees, ownership-transfer invariants, allow-list principle, throttles, `suspended_member` in the code type). Findings addressed: R2-A-01, R2-A-03, R2-A-07, R2-A-08, R2-A-11. See `RED_TEAM_REVIEW.md §6`.

## 1. Roles

MOTION has two role families. A user may hold at most one platform role and at most one tenant role per organization. Platform staff are never also members of customer organizations (enforced by a check in `resolveAccess` and a DB constraint trigger on `organization_memberships`).

| Internal role key | User-facing name (from brief) | Family | Stored in | Scope |
|---|---|---|---|---|
| `platform_super_admin` | Super Admin | Platform | `platform_users.platform_role = 'super_admin'` | Whole platform |
| `platform_employee` | Financial Analyst (was "My Employee"; ADR-172 — the label only, the key stays `employee`) | Platform | `platform_users.platform_role = 'employee'` + rows in `organization_assignments` | Only explicitly assigned organizations |
| `tenant_owner` | Owner | Tenant | `organization_memberships.role = 'owner'` | One organization per row |
| `tenant_admin` | Admin | Tenant | `organization_memberships.role = 'admin'` | One organization per row |
| `tenant_accountant` | Accountant (ADR-172) — the company's own or outside accountant: data capture and compliance | Tenant | `organization_memberships.role = 'accountant'` | One organization per row |
| `tenant_client` | Client | Tenant | `organization_memberships.role = 'client'` | One organization per row |
| `tenant_third_party` | 3rd party (ADR-172) — a lender, investor or partner: a read-only overview | Tenant | `organization_memberships.role = 'third_party'` | One organization per row |

**Effective role.** Inside a given organization a user resolves to exactly one of `super_admin | employee | owner | admin | accountant | client | third_party | suspended_member | none`. Resolution order (first match wins):

1. Active `platform_users` row with `super_admin` **and** a session at `aal2` → `super_admin` (access audited, CD-13).
2. Active `platform_users` row with `employee` **and** a session at `aal2` **and** an active `organization_assignments` row for this organization (status active, now within `starts_at`/`ends_at`) → `employee`. A platform user at `aal1` resolves to `none` everywhere (ADR-044.1).
3. Active `organization_memberships` row → its role; if the organization's `status = 'suspended'`, → `suspended_member` (ADR-044.4).
4. Otherwise `none`. No implicit access exists anywhere.

An employee with no assignment for an organization is `none` for it, identical to a stranger.

## 2. Permission keys

All keys live in `src/core/permissions/catalogue.ts` as a `const` union; the role map is `matrix.ts`; checks are `check.ts` (`can`, `assertCan`). Code never branches on role names, only on permissions (ADR-003). Keys are `resource.verb`. The required minimum set from the brief plus the additions needed to answer the brief's questions.

### 2.1 Matrix

✓ = granted · ◐ = granted with the restriction in the notes column · ✗ = denied

| Permission | super_admin | employee | owner | admin | accountant | client | third_party | Notes |
|---|---|---|---|---|---|---|---|---|
| `dashboard.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Home: the Business Health Score and the CURRENT headline figures (undimensioned and by standard category) — §8 |
| `financials.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | Ledger, invoices, period balances, bank lines, evidence, forecasts, every metric snapshot (§8) |
| `financials.edit` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Recategorise, correct, soft-reject records, map accounts |
| `imports.create` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Upload files, start batches |
| `imports.review` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Map, resolve issues, commit, roll back |
| `banking.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| `banking.reconcile` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Categorise, pair/unpair transfers on the transaction page (Phase 13); line matching post-MVP. Adding a bank account is `financials.edit`; opening the statement itself is `documents.view`; the banking pages and tools 20–23 need only `banking.view` |
| `customers.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| `customers.edit` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Merge/rename counterparties, set kind; Phase 14 (ADR-102): record products, invoice lines, channels, campaigns, spend and opportunities |
| `reports.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Funding Readiness, the Monthly Management Report, Marketing and Investment; the daily, weekly and adviser reports also need `financials.view` (§8.3) |
| `reports.generate` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Enqueue report render |
| `ai.use` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | Subject to org quota (CD-24) |
| `actions.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| `actions.create` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |  |
| `actions.assign` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | Assignee must be an active member or assigned employee of the org who holds `actions.view`; naming somebody else as the owner when CREATING an action is assigning too (rev 1.4, `app.check_action_owner`) |
| `actions.update_own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | Status + outcome on actions where `owner_user_id = self` |
| `alerts.manage` | ✓ | ✓ | ✓ | ✓ | ◐ | ◐ | ✗ | Acknowledge/resolve/dismiss alerts; client and accountant may acknowledge only (a 3rd party too, if switched on) |
| `intelligence.recompute` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Trigger a manual calculation run |
| `users.view` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | A Financial Analyst manages the people of the companies they created or were given (rev 1.7, ADR-187) |
| `users.invite` | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | The owner, the company's Financial Analysts and the super admin create team members (rev 1.7, ADR-187; was owner only, ADR-174): `api.begin_member_login`/`finish_member_login` refuse anyone else |
| `users.manage` | ✓ | ✓ | ✓ | ◐ | ✗ | ✗ | ✗ | Admin may change/remove `admin`/`accountant`/`client`/`third_party`; cannot touch owners; cannot promote to owner. A Financial Analyst has the owner's reach in their companies (rev 1.7, ADR-187). Also: per-person switches and answering access requests (§7) |
| `assignments.view` | ✓ | ◐ | ✓ | ✓ | ✗ | ✗ | ✗ | Employee sees own assignments only, served by `/portfolio` (ADR-037) |
| `assignments.manage` | ✓ | ✗ | ◐ | ✗ | ✗ | ✗ | ✗ | Only super admin creates; owner may **revoke** an employee's assignment to their org |
| `documents.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Open/download source documents; audited. Switchable: e.g. on for one client (§7) |
| `data.export` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | CSV/XLSX export; audited |
| `audit.view` | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | Org-scoped audit log; super admin sees all |
| `settings.manage` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | Org name, fiscal year, currency, alert prefs; a Financial Analyst in their companies (rev 1.7, ADR-187) |
| `billing.manage` | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | Plan, invoices (billing itself is post-MVP) |
| `org.delete` | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | Soft delete + purge job (CD-23) |
| `system.manage` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Everything under `/platform` |
| `platform.orgs.manage` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Create/suspend/feature-flag organizations |
| `platform.users.manage` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Grant/revoke platform roles |
| `platform.ai_feedback.review` | ✓ | ◐ | ✗ | ✗ | ✗ | ✗ | ✗ | Employee reviews feedback for assigned orgs only |
| `platform.jobs.view` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |

Every permission in this table is checked twice on a write: by `assertCan` in the TypeScript service and again inside the `api.*` SECURITY DEFINER function that performs the write (`DATABASE_ARCHITECTURE.md §14`, ADR-026). `authenticated` holds no INSERT/UPDATE/DELETE privilege on any table, so there is no write that a permission bit alone can authorise.

### 2.2 The brief's explicit questions, answered

| Question | Answer |
|---|---|
| Who can invite users | Only the company's Owner creates team members, accountants and 3rd parties (rev 1.6, ADR-174), as logins with a password (ADR-173). The Super Admin invites a new company's owner. Admins, employees, accountants, clients and 3rd parties cannot. |
| Who can remove users | Owner (anyone except last owner), Admin (admins, accountants, clients, 3rd parties), Super Admin. Users may leave an org themselves unless they are the last owner. |
| Who can change roles | Owner (any, including promote to owner and demote another owner), Admin (among admin, accountant, client and 3rd party), Super Admin (break-glass, audited) — never their OWN role (rev 1.4; leaving is "Leave", an owner steps down by the ownership transfer). A role change keeps the switches an owner set, clears the others, and switches off whatever of the new role's defaults the person changing it does not hold (§7.2). |
| Who can switch a person's permissions | The owner and admins (`users.manage`), for any member within their ceiling except an owner and except themselves, and only ever switching ON what they hold themselves; an admin never changes or resets a switch an owner set (§7). |
| Who answers "Request more information" | The owner and admins, under the same rules as a switch; the requester may withdraw (§7.3). |
| Who can assign employees to clients | Super Admin only. Owner can revoke. Admin can see. |
| Who can access financial source documents | Owner, Admin, Accountant, Employee, Super Admin — and anyone the owner or an admin switches `documents.view` on for. Client sees evidence down to transaction level but not the file; a 3rd party sees neither. |
| Who can export data | Owner, Admin, Accountant, Employee, Super Admin. All exports audited; an export reads under the exporter's RLS. |
| Who can use AI | Owner, Admin, Client, Employee, Super Admin, within organization quota — not an Accountant or a 3rd party unless switched on. |
| Who can view audit logs | Owner and Admin for their organization; Super Admin for all; anyone `audit.view` is switched on for. Employees, Accountants, Clients and 3rd parties cannot by default. |
| Who can change organization settings | Owner, Admin, Super Admin. |
| Who can access platform administration | Super Admin only. Employees get `/portfolio`, not `/platform`. `/portfolio` is the Command Centre (ADR-112) and is APX staff only (owner, 2026-10-14; ADR-112 addendum): the super admin over every organisation and employees over their assigned ones. Company logins (owner, admin, client and any other company role) never have one — the uniform 404, even over their own companies — and the database's `api.portfolio_*` functions return them nothing. |

## 3. Role-specific constraints beyond the matrix

These cannot be expressed as a permission bit and are enforced in services (and where noted, in the DB).

1. **Last-owner protection.** DB trigger on `organization_memberships` rejects UPDATE/DELETE that would leave zero active owners. Service returns a friendly error.
2. **Role ceiling.** A user may never grant a role higher than their own effective role, nor act on a member whose current role is above their own. Admin ceiling = admin. Enforced in `membership.service` and inside `api.invite_member`, `api.change_member_role`, `api.remove_member` and `api.set_member_status`, which check the ceiling on the current **and** the target role (ADR-026; F-A-02).
3. **No self-elevation; ownership transfer is a flow with invariants.** No user can raise their own role. Sole ownership moves through `ownership_transfers` (ADR-044.7): an owner initiates to an active admin (one pending transfer per organization, 7-day expiry); acceptance requires `auth.uid()` = nominee, transfer pending and unexpired, the nominee **currently** an active admin and the initiator **currently** an active owner, all checked in `api.accept_ownership_transfer` under the org lock; the initiator or any owner may cancel. Nobody changes their own role (rev 1.4): a self-demotion used to clear the switches the owner had set on that person. Leaving is `api.leave_organization` (refused for the last owner); an owner steps down through the ownership transfer.
4. **Employee write scope.** `role_permissions` grants `employee` the data-table permissions in §2.1 and none of the governance permissions, so the `api.*` functions that write memberships, assignments, settings and organizations refuse an employee; there is no other write path (ADR-026).
5. **Platform staff exclusivity.** A user with an active `platform_users` row cannot be inserted into `organization_memberships` (trigger). If a platform employee needs to be a customer, they use a separate account.
6. **Super admin reads are audited.** Every `/app/[orgSlug]/*` request served to a super admin writes one `audit_events` row (`actor_type = 'platform_admin'`, `action = 'org.data_viewed'`, target = route). Under `/platform`, any surface that renders tenant content — opening an item in `/platform/ai-feedback`, expanding an audit row's `before/after`, viewing `/platform/organizations/[orgId]` — writes `org.data_viewed {surface, target_id}` as well; list views that show only organization names, types and dates do not (ADR-038.6).
7. **Suspended state — one semantic, enforced at the database.** `app.org_role()` returns `suspended_member` for members and assigned employees of an organization whose `status = 'suspended'`; `role_permissions` maps it to `dashboard.view` only; the accessible set still contains the organization, but only the frozen-Home tables admit `suspended_member` — `organizations`, `metric_current`, `health_current`, `health_scores`, `alerts`, plus (ADR-068) `fiscal_periods` and the `metric_snapshots` rows `metric_current` points at, because the two pointer tables hold no figures and no month — every other tenant-data policy names a permission `suspended_member` does not hold (since ADR-172; before, an allow-list of the five real roles), so RLS reads actually shrink to the frozen Home and every `api.*` write is refused (ADR-044.4). Role checks in policies and in code are **allow-lists**, never `<> 'client'`, so suspension can never widen a client's access. `organization_memberships.status = 'suspended'` resolves to NULL/`none`. The UI adds the banner.
9. **Sole-owner disable guard.** `api.disable_user` refuses to disable a user who is the only active owner of any organization unless another owner exists; a super admin must reassign ownership first (ADR-038.12).
10. **Invitation binding.** `api.accept_invitation` compares `invitations.email` with `auth.jwt()->>'email'` (confirmed) — never with `profiles.email`, which users cannot edit (ADR-038.3) — and re-checks that the inviter is still an active owner/admin with a ceiling ≥ the invited role (F-A-02).
11. **Platform users need MFA — at the database.** Super admins and employees must enrol TOTP before any `/platform` or `/portfolio` access; `app.is_platform_user()` (active row **and** `aal2`) gates both the super-admin and the employee branches of `app.accessible_org_ids()` and `app.org_role()`, so an employee's password alone yields a JWT that reads nothing and can execute no data function (ADR-044.1; R2-A-03); magic-link sign-in is refused for platform users; `platform.users.manage`, suspend, `org.delete` and creating assignments require re-authentication within 10 minutes, checked against the latest `amr` entry with method `totp`/`password` (ADR-044.3).
12. **User-intent vs server-asserted writes.** `api.*` functions accept only what the user legitimately chooses; anything the server observed (a grounding result, a scan result, a tool-call log, a download) is written through `api_server.*`, executable only by the service role from `core/db/server-rpc.ts` with the human actor passed explicitly (ADR-043; R2-A-01). A user JWT can never write a "passed" AI answer or register an unscanned document.
13. **Throttled at the database.** Every `api.*` function starts with `app.throttle()`; the RPC surface is reachable on the Supabase host without passing the Vercel edge, so edge limits alone are not limits (ADR-044.5; R2-A-08).
14. **Per-person switches never reach an owner, APX staff or a suspended organisation (ADR-172).** `app.effective_permission` applies a switch only for `admin`, `accountant`, `client` and `third_party` (`app.overridable_role`, an allow-list), so a switch stored against anyone else is ignored, and `api.set_member_permission` refuses to store one. A suspended organisation resolves everyone to `suspended_member`, whose one permission no switch changes.
15. **Never beyond one's own rights (ADR-172; rev 1.4 on every path).** Switching a permission ON, approving a request for it, or resetting a switch to a default that would give it, needs the caller to hold that permission at that moment (`app.apply_member_permission`). Switching OFF does not — taking access away is always within an owner's or admin's remit for the members they govern. The same ceiling now applies to the other paths that set a person's access: a ROLE CHANGE switches off every default of the new role the actor does not effectively hold (`app.member_role_changed`), and an INVITATION does the same for the inviter, at invite time and again at acceptance (`invitations.withheld_permissions`, `api.accept_invitation`). These switch-offs are stored as ordinary switches marked `ceiling_withhold`; an owner (or an admin who holds the permission) can switch them on. An owner or the super admin holds everything and so withholds nothing.
16. **A role change keeps the owner's decisions (ADR-172; rev 1.4).** The `member_role_changed` trigger CARRIES the switches an owner or the super admin set into the new role — dropping them only for a promotion to owner, which takes no switches — deletes every other switch, applies rule 15's ceiling, and closes the waiting request; audited `member.permissions_reset` (before, after, carried, cleared, withheld). Before rev 1.4 it cleared every switch, so an admin's role round trip (client → accountant → client) undid the owner's switch-off. Removal deletes switches and requests (foreign keys). A deactivation keeps them (it resolves to no access anyway).
17. **An owner's switch is the owner's (rev 1.4).** Each switch records whether an owner (or the super admin) set it (`set_by_owner`, stored when set, never derived later). An admin may not change, reset or approve a request over it (`app.apply_member_permission`), and the team page shows it locked (`MemberPermissions.ownerLocked`).
18. **Nobody changes their own role (rev 1.4).** `api.change_member_role` and `changeMemberRole` refuse it in either direction (rule 3).
8. **AI acts as the user.** Tool calls run with the asking user's `AccessContext`. A client asking the AI for a source document link is refused by the tool exactly as the UI would refuse.

## 4. Permission enforcement points

| Layer | What it checks | Mechanism |
|---|---|---|
| Middleware | Session exists; route family (public/app/platform/portfolio) matches role family | `middleware.ts` reads session, calls `resolveAccess` for `[orgSlug]` |
| Layout / page | Effective role ≠ `none` for the org; feature flag for the module | Server component throws `NotFound` (not `Forbidden`, to avoid org enumeration) |
| Server action / route handler | `assertCan(ctx, key)` before any service call | Throws `PermissionDenied`, mapped to 403 JSON / toast |
| Service | Re-checks permission for privileged operations and applies row-level constraints (§3) | Explicit checks; services never trust callers |
| Database — reads | RLS bounds every read to the accessible set and to the PERMISSION the table's pages need, evaluated per person with their switches (§8; ADR-172) — never a list of roles; column privileges hide raw imported text; suspended organizations expose only the frozen-Home tables; platform users at `aal1` read nothing | `DATABASE_ARCHITECTURE.md §11` (ADR-044, ADR-172) |
| Database — user-intent writes | **no direct table writes** for `authenticated`; every write is an `api.*` SECURITY DEFINER function that throttles, re-checks the permission, the role ceiling and the row invariants, and writes the audit event in the same transaction; platform functions require `aal2` and, where marked, step-up re-authentication | `DATABASE_ARCHITECTURE.md §14.1` (ADR-026, ADR-044) |
| Database — server-asserted writes | facts the server observed are written only by `api_server.*`, executable by the service role alone, with the human actor passed and re-validated | `DATABASE_ARCHITECTURE.md §14.2` (ADR-043) |
| Storage | No Storage policies for `authenticated`; every document or report read is a 60-second signed URL minted by the server after `documents.view`/`reports.view` and an audit event | `TENANCY_MODEL.md §8`, `SECURITY_MODEL.md §7` (ADR-038.1) |
| AI tools | Same `assertCan` on each tool invocation, with `resolveAccess` re-run before every tool call; tools inherit and never exceed the caller's permissions | `AI_ARCHITECTURE.md §4` |

A request must pass all applicable layers. Tests in `TEST_STRATEGY.md §2` assert that removing any single layer still blocks cross-tenant access.

## 5. UI behaviour per role

- Navigation items are hidden when the role lacks the *view* permission for the whole section (never partially rendered). The header **Data** menu (Add data · Imports · Documents · Accounts) is shown to whoever holds `imports.review` — by default Owner, Admin, Accountant, Employee, Super Admin, never Client or 3rd party (ADR-037; ADR-172: a switch can change it for one person, and the menu follows `can()`); the Settings gear is shown only with `settings.manage`.
- Action buttons (Upload, Invite, Export, Assign) are hidden, not disabled, for roles without the permission; the server still enforces.
- Permission-denied on a deep link shows the friendly "You don't have access to this" state (`UX_ARCHITECTURE.md §8`) with a link back to Home. Organization existence is never confirmed to a non-member (404, not 403).

## 6. Permission map as code (shape only)

```ts
// src/core/permissions/catalogue.ts — every key in §2.1, nothing else compiles.
export const PERMISSIONS = ['dashboard.view', 'financials.view', /* … */ 'platform.jobs.view'] as const;
export type Permission = (typeof PERMISSIONS)[number];
// src/core/permissions/matrix.ts — the single source of the matrix above; deny-by-default.
export type EffectiveRole = 'super_admin' | 'employee' | 'owner' | 'admin' | 'accountant' | 'client' | 'third_party' | 'suspended_member' | 'none';
export const ROLE_MATRIX: Record<Exclude<EffectiveRole,'none'>, ReadonlySet<Permission>>; // ROLE_MATRIX.suspended_member = {'dashboard.view'}
// Code tests can(ctx, permission), never role === 'client' — a `<> 'client'` branch would widen access for suspended_member (R2-A-07).
// src/core/permissions/check.ts
export function can(ctx: AccessContext, p: Permission): boolean;
export function assertCan(ctx: AccessContext, p: Permission): void; // throws PermissionDenied
```

`AccessContext.permissions` is NOT `ROLE_MATRIX[role]` any more (ADR-172): it is the role's row with the person's switches applied (`resolvePermissions` in `modules/tenancy/domain/permissions.ts`), intersected with the database's own answer from `api.my_access` — §7.4.

`scripts/sync-permission-matrix.ts` renders `ROLE_MATRIX` into a migration (since ADR-172, `20261018000018_role_permissions_tenant_roles.sql`; applied migrations are never edited) that fills the read-only `role_permissions (role, permission)` table used by `app.has_permission(org_id, permission)` inside every `api.*` mutation function (ADR-026). The pgTAP parity test fails CI if the table and the TypeScript matrix differ.

The ◐ restrictions are implemented as named guards next to the matrix (`canInviteRole(actorRole, targetRole)`, `canChangeRole(actorRole, fromRole, toRole)`, `canRevokeAssignment(ctx, assignment)`), each with its own unit tests.

## 7. Per-person permissions and "Request more information" (ADR-172)

Contract: `src/modules/tenancy/domain/member-access.ts` (`SWITCHABLE_PERMISSIONS`, `MemberPermissions`, `AccessRequest`). Services: `src/modules/tenancy/services/member-access.ts`. Database: `member_permission_overrides`, `access_requests`, migration `20261018000019`.

### 7.1 Switches

Each role has the defaults in §2.1. The owner or an admin may switch an individual **switchable** permission on or off for one member of their company — the 21 keys in `SWITCHABLE_PERMISSIONS`: everything a page or tool needs, and `audit.view`. Never switchable: the team keys (`users.*` — making someone a team manager is a role change), analyst assignments, settings, billing, deleting the company and every platform key.

| Rule | Where it is enforced |
|---|---|
| The caller holds `users.manage` | `assertCan` in `setMemberPermission`; `app.require_permission` in `api.set_member_permission` |
| The member is an ACTIVE member of this company, within the caller's ceiling (an admin may switch another admin, an accountant, a client or a 3rd party; a super admin anyone but an owner) | `app.apply_member_permission` (row-locked) |
| Never an owner — an owner holds everything | the same, and `app.overridable_role` ignores any switch stored against an owner |
| Never oneself | `setMemberPermission`; `app.apply_member_permission` |
| Never a switch an OWNER set, unless the caller is an owner or the super admin — no change, no reset, no approval over it (rev 1.4) | `app.apply_member_permission`; `listMemberPermissions` (`ownerLocked`, `grantable`), `resetMemberPermissions` skips them |
| Never beyond one's own rights: switching ON, or resetting to a default that gives the permission back, needs the caller to hold it. Switching OFF does not | `withinOwnRights` (for drawing the page); `app.apply_member_permission` |
| Only for company roles: never platform staff (they are not members), never a suspended organisation | `app.effective_permission` |
| Audited `member.permission_changed` with the switch and the effective answer before and after; throttled | `app.apply_member_permission`; `api.set_member_permission` |

### 7.2 Lifecycle

A **role change** (rev 1.4) keeps the switches an OWNER set — the owner's decision about the person, which an admin's role change must not undo — and clears every other switch, which was chosen against the old role; a promotion to owner drops them all. It then switches off every default of the new role the person making the change does not hold (§3.15), and closes the waiting request (trigger `member_role_changed`, audited `member.permissions_reset`). Nobody changes their own role. An **invitation** carries the inviter's ceiling the same way: what the inviter lacks is switched off on acceptance. **Removal** deletes switches and requests (foreign keys to the membership). **Deactivation** keeps them; the member resolves to no access while deactivated and gets exactly their old access back when switched on again.

### 7.3 "Request more information"

Any member whose role takes switches (admin, accountant, client, 3rd party) may ask for permissions they lack and/or write a message (≤ 1,000 characters). Permissions they already hold are dropped. One waiting request per person per company (a second is refused, never merged); five a day. Every owner and admin is told in their inbox (`access_request`, linking `/app/<slug>/settings/team#requests`). The owner or an admin approves — switching on the chosen permissions, a subset of those asked, each one they hold, all or nothing — or declines, with a note the requester reads (`access_decision`). The requester may withdraw a waiting request. A role change closes a waiting request as declined. Owners cannot ask (they hold everything); APX staff and a suspended organisation cannot either. Audited `member.access_requested`, `member.access_request_decided`, `member.access_request_withdrawn`.

### 7.4 Effective permissions everywhere

`AccessContext.permissions` = the role's defaults ± the person's switches, built once per request from ONE round trip (`api.my_access`: role, switches, the organisation's systems, and the database's own effective set). The TypeScript twin (`resolvePermissions`) and the SQL (`app.effective_permission`) are the same rule; the resolver keeps only permissions BOTH grant and logs any difference, so the interface can only ever show less than the database allows. `can(ctx, …)` therefore hides and shows by itself; no page or service compares role names (lint `motion/no-role-name-literals`; identity predicates live in `core/permissions` and `modules/tenancy/domain`). The AI's per-tool re-resolution (`resolveAccessFresh`) sees a switch made mid-turn and aborts the turn.

`/portfolio` (the Command Centre) is APX staff only; an accountant or a 3rd party never has one, whatever their switches (`app.adviser_org_ids()` is a role allow-list of `super_admin` and `employee`).

## 8. Who reads which table (ADR-172)

**Rev 1.4 — detail stored twice is gated once.** A switch that closes a detail table must close every copy of that detail: rev 1.4 found four copies the policies did not reach (the audit trail's row copies, raw import text, the overview's jsonb payloads, per-customer pointers) and gates each with the permission of the table it copies — by column privilege plus a definer view that redacts, so the overview a 3rd party reads keeps its figures and loses the names. And a suspended company's frozen Home now follows each person's real role and switches (`app.frozen_org_ids_with_any_permission`) rather than the blanket `suspended_member`, which had given a 3rd party the alerts and per-customer figures the moment their company was suspended.

Every tenant-data SELECT policy names the permission its pages need, through `app.org_ids_with_permission(p)` or `app.org_ids_with_any_permission(p, …)` (switch-aware, set-shaped, evaluated once per statement). Before ADR-172 most of these were the five-role list `owner, admin, employee, super_admin, client`. Under the defaults, owner, admin, employee, super admin and client read exactly what they read before (all hold every permission named below except where stated); the accountant reads the detail; a 3rd party reads only the rows marked **3P**.

### 8.1 Detail (no 3rd party by default)

| Table | Before | After |
|---|---|---|
| `ledger_entries`, `period_balances`, `account_category_history`, `record_status_events`, `budget_lines` | five roles | `financials.view` |
| `forecast_runs`, `forecast_values`, `scenario_runs`, `scenario_values` | five roles | `financials.view` |
| `accounts` | five roles | `financials.view` or `banking.view` (bank lines show their category) |
| `bank_accounts`, `bank_transactions`, `recurring_payment_groups`, `category_history` | five roles | `banking.view` or `financials.view` (the cash pages) |
| `invoices`, `invoice_lines` | five roles | `financials.view` or `customers.view` |
| `counterparties` | five roles | `financials.view`, `banking.view` or `customers.view` |
| `products`, `campaigns`, `campaign_spend`, `marketing_channels`, `opportunities` | five roles | `customers.view` or `financials.view` |
| `source_documents` | owner, admin, employee, super admin | `documents.view` or `imports.review` (the review pages name the file; opening it is a signed URL after `documents.view`) |
| `evidence_bundles` (and `evidence_items` through it) | five roles; `ai_response` bundles owner/admin/super admin or the message's own author | `financials.view`; the `ai_response` rule unchanged |
| `alerts` | every resolved role | `financials.view` or `alerts.manage`; in a suspended company, the frozen Home shows them to whoever's REAL role and switches hold one of the two (rev 1.4; was every `suspended_member`). Alert sentences name customers and suppliers |
| `alert_revisions` | five roles | `financials.view` or `alerts.manage` |
| `actions` | five roles | `actions.view` |
| `audit_events` | owner, admin, super admin | `audit.view` (switchable); platform events super admin. Rev 1.4: `before`/`after` (whole row copies: bank lines, ledger, invoices, members' e-mails), `ip`, `user_agent` are not selectable at all; the log is read through `api.org_audit_events` (who, what, which row, when) |
| `ai_conversations`, `ai_feedback` | own, or owner/admin/employee/super admin | `ai.use` AND (own, or owner/admin/employee/super admin) |
| `ai_tool_calls` | owner/admin/employee/super admin | the same AND `ai.use` |
| `org_member_profiles` (view: member names) | every member | `users.view` or `actions.view` holders |
| `import_batches`, `import_mappings`, `report_completeness_attestations` | `imports.review` | unchanged (now switch-aware) |
| `import_rows` | `imports.review` | `imports.review` AND (`banking.view` or `financials.view`) (rev 1.4); `raw_data`/`mapped_data` only through `import_rows_review`, while the batch is in review |
| `bank_transactions_raw` (view: raw statement text) | `imports.review`, every line | rev 1.4: `imports.review` AND (`banking.view` or `financials.view`), and only lines a batch IN REVIEW is about (its own, or the line a row under review duplicates); after commit nobody reads raw text |
| `counterparties_contact` (view: e-mails, notes) | `customers.edit` | `customers.edit` AND `customers.view` (rev 1.4) |
| `action_comments`, `engagement_items`, `engagement_events` | `actions.view` | unchanged (now switch-aware) |

### 8.2 The overview (3P)

| Table | Before | After |
|---|---|---|
| `organizations` | every resolved role | unchanged **3P** |
| `fiscal_periods` | five roles + `suspended_member` | every resolved role **3P** (months hold no figures) |
| `metric_current` (pointers, no figures) | every resolved role | undimensioned and standard-category pointers: every resolved role **3P**; per-counterparty: `financials.view` or `customers.view`; per account / bank account: `financials.view` (rev 1.4 — they named every customer and account) |
| `metric_snapshots` | five roles; `suspended_member` the current rows | `financials.view`: every snapshot; `customers.view`: also the per-customer rows; `dashboard.view`: the CURRENT rows of undimensioned and standard-category figures only **3P** — never per account or per counterparty; a suspended company's frozen Home: the current rows each person's REAL role and switches read before (rev 1.4; was every current row). `components`/`evidence_query` are not selectable; `metric_snapshot_payloads` serves them WHOLE to a detail reader and REDACTED (numbers and dates only; no descriptor) to a `dashboard.view` reader |
| `health_scores`, `health_current` | every resolved role | `dashboard.view` **3P** (`suspended_member` holds it). `health_scores.breakdown` is not selectable; `health_score_breakdowns` serves it whole with `financials.view`, and REDACTED otherwise — no condition subjects (bank descriptions naming customers and suppliers), no record or snapshot ids (rev 1.4) |
| `calculation_runs` | five roles | `financials.view` or `reports.view` **3P** |

### 8.3 Reports (3P where stated)

| Table | Before | After |
|---|---|---|
| `reports` | `reports.view`; custom AI report its author's; Funding Readiness while Funding is on | the same, AND the Daily Brief, Weekly Intelligence and Accountant/CFO (adviser) reports also need `financials.view` — they are lists of the day's alerts and overdue actions, movements by account and customer and bank account names. **3P**: Funding Readiness. Rev 1.4: `api_server.record_access_event` applies the same rule to the actor before a download is recorded (and so before the signer will sign). The policy's `monthly_management` branch can never match — the `reports` CHECK keeps that kind out of the table (its PDF is a `report_files` row with no report) — and is left as harmless |
| `report_files` | `reports.view` and the report readable | follows `reports`; the Monthly Management Report PDF (no report row) — the FULL report — also needs `financials.view` (rev 1.5; was **3P**). A 3rd party gets the summary edition instead, which is not stored (below) |
| `funding_assessments`, `funding_current` | five roles while Funding is on | `reports.view` while Funding is on **3P** |
| `marketing_reports`, `investment_reports` | `reports.view` while the system is on | unchanged **3P** |
| `organization_profiles` | five roles | `reports.view` or `customers.view` **3P** (the company description Marketing and Investment show) |

**What `reports.view` shows a 3rd party, and what to watch.** Funding Readiness, Marketing and Investment are written for exactly this reader. Two things in them are commercially sensitive and are shown to a 3rd party by the owner's decision ("reports"): the **Marketing report** carries sales by product line and the largest cost lines by name; the **Investment pack** carries the surplus and the proposed allocation.

**The Monthly Management Report's two editions (rev 1.5; ADR-172 addendum).** The full report prints the month's alerts (their sentences name customers and suppliers) and the titles of open actions, so it is detail: the on-screen report (`getMonthlyReport`), its stored PDF (`report_files_select`) and the PDF's download (`api_server.record_access_event`, so the signer has no audit id to sign with) all need `financials.view`. Without it — a 3rd party by default, a client, accountant or admin switched off — the reader gets the **summary edition**: the headline figures, the Business Health Score area by area (the engine's sentences, no conditions), the report's own sentence, and a cover line "Summary edition for external readers: figures and Business Health Score only". It is built only from the overview — undimensioned figures, the score and its breakdown — with the reader's own client, never by filtering the full report, and rendered on request at `GET /api/reports/summary/[periodId]` (not stored; its download is recorded against the month, `reports.view`). The Reports page shows such a reader "Monthly management report — summary edition" and nothing that links to the full report; `/reports/monthly/[period]` shows them the summary edition. A full reader keeps the full report and may download the summary edition too, to send on.

### 8.4 Governance (unchanged)

`invitations`, `organization_memberships` (plus one's own row), `organization_assignments` (plus one's own), `ownership_transfers` (plus the nominee): owner, admin, super admin — the holders of `users.view`, which is never switched. `member_permission_overrides`: one's own, and `users.view` holders. `access_requests`: one's own, and `users.manage` holders.

