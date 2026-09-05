# MOTION — RBAC Model & Permission Matrix

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-002, ADR-003, ADR-026, ADR-037, ADR-038, CD-13 to CD-17), `TENANCY_MODEL.md`
Consumed by: `SECURITY_MODEL.md`, `SERVICE_ARCHITECTURE.md`, `ROUTE_ARCHITECTURE.md`, `TEST_STRATEGY.md`

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026 (every permission re-checked inside `api.*` functions; no direct table writes), ADR-037 (Data menu; Employee `users.view` ✗), ADR-038 (suspension at the database, sole-owner disable guard, invitation email binding, MFA and re-authentication for platform users, audited `/platform` tenant views, signed-URL-only Storage). Findings addressed: F-A-01, F-A-02, F-A-04, F-A-06, F-A-07, F-A-10, F-A-12, F-D-07, F-D-14. See `RED_TEAM_REVIEW.md`.

> **Revision 1.2 (red-team round 2, 2026-09-05).** Applies ADR-043 (`api` vs `api_server`), ADR-044 (MFA at the database for employees, ownership-transfer invariants, allow-list principle, throttles, `suspended_member` in the code type). Findings addressed: R2-A-01, R2-A-03, R2-A-07, R2-A-08, R2-A-11. See `RED_TEAM_REVIEW.md §6`.

## 1. Roles

MOTION has two role families. A user may hold at most one platform role and at most one tenant role per organization. Platform staff are never also members of customer organizations (enforced by a check in `resolveAccess` and a DB constraint trigger on `organization_memberships`).

| Internal role key | User-facing name (from brief) | Family | Stored in | Scope |
|---|---|---|---|---|
| `platform_super_admin` | Super Admin | Platform | `platform_users.platform_role = 'super_admin'` | Whole platform |
| `platform_employee` | My Employee | Platform | `platform_users.platform_role = 'employee'` + rows in `organization_assignments` | Only explicitly assigned organizations |
| `tenant_owner` | Owner | Tenant | `organization_memberships.role = 'owner'` | One organization per row |
| `tenant_admin` | Admin | Tenant | `organization_memberships.role = 'admin'` | One organization per row |
| `tenant_client` | Client | Tenant | `organization_memberships.role = 'client'` | One organization per row |

**Effective role.** Inside a given organization a user resolves to exactly one of `super_admin | employee | owner | admin | client | suspended_member | none`. Resolution order (first match wins):

1. Active `platform_users` row with `super_admin` **and** a session at `aal2` → `super_admin` (access audited, CD-13).
2. Active `platform_users` row with `employee` **and** a session at `aal2` **and** an active `organization_assignments` row for this organization (status active, now within `starts_at`/`ends_at`) → `employee`. A platform user at `aal1` resolves to `none` everywhere (ADR-044.1).
3. Active `organization_memberships` row → its role; if the organization's `status = 'suspended'`, → `suspended_member` (ADR-044.4).
4. Otherwise `none`. No implicit access exists anywhere.

An employee with no assignment for an organization is `none` for it, identical to a stranger.

## 2. Permission keys

All keys live in `src/core/permissions/catalogue.ts` as a `const` union; the role map is `matrix.ts`; checks are `check.ts` (`can`, `assertCan`). Code never branches on role names, only on permissions (ADR-003). Keys are `resource.verb`. The required minimum set from the brief plus the additions needed to answer the brief's questions.

### 2.1 Matrix

✓ = granted · ◐ = granted with the restriction in the notes column · ✗ = denied

| Permission | super_admin | employee | owner | admin | client | Notes |
|---|---|---|---|---|---|---|
| `dashboard.view` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `financials.view` | ✓ | ✓ | ✓ | ✓ | ✓ | Metric snapshots, ledger, invoices, period balances |
| `financials.edit` | ✓ | ✓ | ✓ | ✓ | ✗ | Recategorise, correct, soft-reject records, map accounts |
| `imports.create` | ✓ | ✓ | ✓ | ✓ | ✗ | Upload files, start batches |
| `imports.review` | ✓ | ✓ | ✓ | ✓ | ✗ | Map, resolve issues, commit, roll back |
| `banking.view` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `banking.reconcile` | ✓ | ✓ | ✓ | ✓ | ✗ | Categorise, flag transfers; matching post-MVP |
| `customers.view` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `customers.edit` | ✓ | ✓ | ✓ | ✓ | ✗ | Merge/rename counterparties, set kind |
| `reports.view` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `reports.generate` | ✓ | ✓ | ✓ | ✓ | ✗ | Enqueue report render |
| `ai.use` | ✓ | ✓ | ✓ | ✓ | ✓ | Subject to org quota (CD-24) |
| `actions.view` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `actions.create` | ✓ | ✓ | ✓ | ✓ | ✗ | |
| `actions.assign` | ✓ | ✓ | ✓ | ✓ | ✗ | Assignee must be a member/employee of the org |
| `actions.update_own` | ✓ | ✓ | ✓ | ✓ | ✓ | Status + outcome on actions where `owner_user_id = self` |
| `alerts.manage` | ✓ | ✓ | ✓ | ✓ | ◐ | Acknowledge/resolve/dismiss alerts; client may acknowledge only |
| `intelligence.recompute` | ✓ | ✓ | ✓ | ✓ | ✗ | Trigger a manual calculation run |
| `users.view` | ✓ | ✗ | ✓ | ✓ | ✗ | Employee has no member-list page; member names appear only in assignee pickers via `org_member_profiles` (ADR-037) |
| `users.invite` | ✓ | ✗ | ✓ | ◐ | ✗ | Admin may invite `admin` or `client`, never `owner` |
| `users.manage` | ✓ | ✗ | ✓ | ◐ | ✗ | Admin may change/remove `admin`/`client`; cannot touch owners; cannot promote to owner |
| `assignments.view` | ✓ | ◐ | ✓ | ✓ | ✗ | Employee sees own assignments only, served by `/portfolio` (ADR-037) |
| `assignments.manage` | ✓ | ✗ | ◐ | ✗ | ✗ | Only super admin creates; owner may **revoke** an employee's assignment to their org |
| `documents.view` | ✓ | ✓ | ✓ | ✓ | ✗ | Open/download source documents; audited |
| `data.export` | ✓ | ✓ | ✓ | ✓ | ✗ | CSV/XLSX export; audited |
| `audit.view` | ✓ | ✗ | ✓ | ✓ | ✗ | Org-scoped audit log; super admin sees all |
| `settings.manage` | ✓ | ✗ | ✓ | ✓ | ✗ | Org name, fiscal year, currency, alert prefs |
| `billing.manage` | ✓ | ✗ | ✓ | ✗ | ✗ | Plan, invoices (billing itself is post-MVP) |
| `org.delete` | ✓ | ✗ | ✓ | ✗ | ✗ | Soft delete + purge job (CD-23) |
| `system.manage` | ✓ | ✗ | ✗ | ✗ | ✗ | Everything under `/platform` |
| `platform.orgs.manage` | ✓ | ✗ | ✗ | ✗ | ✗ | Create/suspend/feature-flag organizations |
| `platform.users.manage` | ✓ | ✗ | ✗ | ✗ | ✗ | Grant/revoke platform roles |
| `platform.ai_feedback.review` | ✓ | ◐ | ✗ | ✗ | ✗ | Employee reviews feedback for assigned orgs only |
| `platform.jobs.view` | ✓ | ✗ | ✗ | ✗ | ✗ | |

Every permission in this table is checked twice on a write: by `assertCan` in the TypeScript service and again inside the `api.*` SECURITY DEFINER function that performs the write (`DATABASE_ARCHITECTURE.md §14`, ADR-026). `authenticated` holds no INSERT/UPDATE/DELETE privilege on any table, so there is no write that a permission bit alone can authorise.

### 2.2 The brief's explicit questions, answered

| Question | Answer |
|---|---|
| Who can invite users | Owner (any tenant role), Admin (admin/client only), Super Admin (any). Employees cannot. |
| Who can remove users | Owner (anyone except last owner), Admin (admins and clients), Super Admin. Users may leave an org themselves unless they are the last owner. |
| Who can change roles | Owner (any, including promote to owner and demote another owner), Admin (between admin ↔ client only), Super Admin (break-glass, audited). |
| Who can assign employees to clients | Super Admin only. Owner can revoke. Admin can see. |
| Who can access financial source documents | Owner, Admin, Employee, Super Admin. Client sees evidence down to transaction level but not the file. |
| Who can export data | Owner, Admin, Employee, Super Admin. All exports audited. |
| Who can use AI | Every effective role except `none`, within organization quota. |
| Who can view audit logs | Owner and Admin for their organization; Super Admin for all. Employees and Clients cannot. |
| Who can change organization settings | Owner, Admin, Super Admin. |
| Who can access platform administration | Super Admin only. Employees get `/portfolio`, not `/platform`. |

## 3. Role-specific constraints beyond the matrix

These cannot be expressed as a permission bit and are enforced in services (and where noted, in the DB).

1. **Last-owner protection.** DB trigger on `organization_memberships` rejects UPDATE/DELETE that would leave zero active owners. Service returns a friendly error.
2. **Role ceiling.** A user may never grant a role higher than their own effective role, nor act on a member whose current role is above their own. Admin ceiling = admin. Enforced in `membership.service` and inside `api.invite_member`, `api.change_member_role`, `api.remove_member` and `api.set_member_status`, which check the ceiling on the current **and** the target role (ADR-026; F-A-02).
3. **No self-elevation; ownership transfer is a flow with invariants.** No user can raise their own role. Sole ownership moves through `ownership_transfers` (ADR-044.7): an owner initiates to an active admin (one pending transfer per organization, 7-day expiry); acceptance requires `auth.uid()` = nominee, transfer pending and unexpired, the nominee **currently** an active admin and the initiator **currently** an active owner, all checked in `api.accept_ownership_transfer` under the org lock; the initiator or any owner may cancel. Owners cannot demote themselves if they are the last owner; admins can demote themselves to client.
4. **Employee write scope.** `role_permissions` grants `employee` the data-table permissions in §2.1 and none of the governance permissions, so the `api.*` functions that write memberships, assignments, settings and organizations refuse an employee; there is no other write path (ADR-026).
5. **Platform staff exclusivity.** A user with an active `platform_users` row cannot be inserted into `organization_memberships` (trigger). If a platform employee needs to be a customer, they use a separate account.
6. **Super admin reads are audited.** Every `/app/[orgSlug]/*` request served to a super admin writes one `audit_events` row (`actor_type = 'platform_admin'`, `action = 'org.data_viewed'`, target = route). Under `/platform`, any surface that renders tenant content — opening an item in `/platform/ai-feedback`, expanding an audit row's `before/after`, viewing `/platform/organizations/[orgId]` — writes `org.data_viewed {surface, target_id}` as well; list views that show only organization names, types and dates do not (ADR-038.6).
7. **Suspended state — one semantic, enforced at the database.** `app.org_role()` returns `suspended_member` for members and assigned employees of an organization whose `status = 'suspended'`; `role_permissions` maps it to `dashboard.view` only; the accessible set still contains the organization, but only `organizations`, `metric_current`, `health_current`, `health_scores` and `alerts` have policies that admit `suspended_member` — every other tenant-data policy is an allow-list of the five real roles, so RLS reads actually shrink to the frozen Home and every `api.*` write is refused (ADR-044.4). Role checks in policies and in code are **allow-lists**, never `<> 'client'`, so suspension can never widen a client's access. `organization_memberships.status = 'suspended'` resolves to NULL/`none`. The UI adds the banner.
9. **Sole-owner disable guard.** `api.disable_user` refuses to disable a user who is the only active owner of any organization unless another owner exists; a super admin must reassign ownership first (ADR-038.12).
10. **Invitation binding.** `api.accept_invitation` compares `invitations.email` with `auth.jwt()->>'email'` (confirmed) — never with `profiles.email`, which users cannot edit (ADR-038.3) — and re-checks that the inviter is still an active owner/admin with a ceiling ≥ the invited role (F-A-02).
11. **Platform users need MFA — at the database.** Super admins and employees must enrol TOTP before any `/platform` or `/portfolio` access; `app.is_platform_user()` (active row **and** `aal2`) gates both the super-admin and the employee branches of `app.accessible_org_ids()` and `app.org_role()`, so an employee's password alone yields a JWT that reads nothing and can execute no data function (ADR-044.1; R2-A-03); magic-link sign-in is refused for platform users; `platform.users.manage`, suspend, `org.delete` and creating assignments require re-authentication within 10 minutes, checked against the latest `amr` entry with method `totp`/`password` (ADR-044.3).
12. **User-intent vs server-asserted writes.** `api.*` functions accept only what the user legitimately chooses; anything the server observed (a grounding result, a scan result, a tool-call log, a download) is written through `api_server.*`, executable only by the service role from `core/db/server-rpc.ts` with the human actor passed explicitly (ADR-043; R2-A-01). A user JWT can never write a "passed" AI answer or register an unscanned document.
13. **Throttled at the database.** Every `api.*` function starts with `app.throttle()`; the RPC surface is reachable on the Supabase host without passing the Vercel edge, so edge limits alone are not limits (ADR-044.5; R2-A-08).
8. **AI acts as the user.** Tool calls run with the asking user's `AccessContext`. A client asking the AI for a source document link is refused by the tool exactly as the UI would refuse.

## 4. Permission enforcement points

| Layer | What it checks | Mechanism |
|---|---|---|
| Middleware | Session exists; route family (public/app/platform/portfolio) matches role family | `middleware.ts` reads session, calls `resolveAccess` for `[orgSlug]` |
| Layout / page | Effective role ≠ `none` for the org; feature flag for the module | Server component throws `NotFound` (not `Forbidden`, to avoid org enumeration) |
| Server action / route handler | `assertCan(ctx, key)` before any service call | Throws `PermissionDenied`, mapped to 403 JSON / toast |
| Service | Re-checks permission for privileged operations and applies row-level constraints (§3) | Explicit checks; services never trust callers |
| Database — reads | RLS bounds every read to the accessible set with allow-list role checks (narrower per table where stated); column privileges hide raw imported text; suspended organizations expose only the frozen-Home tables; platform users at `aal1` read nothing | `DATABASE_ARCHITECTURE.md §11` (ADR-044) |
| Database — user-intent writes | **no direct table writes** for `authenticated`; every write is an `api.*` SECURITY DEFINER function that throttles, re-checks the permission, the role ceiling and the row invariants, and writes the audit event in the same transaction; platform functions require `aal2` and, where marked, step-up re-authentication | `DATABASE_ARCHITECTURE.md §14.1` (ADR-026, ADR-044) |
| Database — server-asserted writes | facts the server observed are written only by `api_server.*`, executable by the service role alone, with the human actor passed and re-validated | `DATABASE_ARCHITECTURE.md §14.2` (ADR-043) |
| Storage | No Storage policies for `authenticated`; every document or report read is a 60-second signed URL minted by the server after `documents.view`/`reports.view` and an audit event | `TENANCY_MODEL.md §8`, `SECURITY_MODEL.md §7` (ADR-038.1) |
| AI tools | Same `assertCan` on each tool invocation, with `resolveAccess` re-run before every tool call; tools inherit and never exceed the caller's permissions | `AI_ARCHITECTURE.md §4` |

A request must pass all applicable layers. Tests in `TEST_STRATEGY.md §2` assert that removing any single layer still blocks cross-tenant access.

## 5. UI behaviour per role

- Navigation items are hidden when the role lacks the *view* permission for the whole section (never partially rendered). The header **Data** menu (Add data · Imports · Documents · Accounts) is shown to roles with `imports.review` — Owner, Admin, Employee, Super Admin — and never to Client (ADR-037); the Settings gear is shown only with `settings.manage`.
- Action buttons (Upload, Invite, Export, Assign) are hidden, not disabled, for roles without the permission; the server still enforces.
- Permission-denied on a deep link shows the friendly "You don't have access to this" state (`UX_ARCHITECTURE.md §8`) with a link back to Home. Organization existence is never confirmed to a non-member (404, not 403).

## 6. Permission map as code (shape only)

```ts
// src/core/permissions/catalogue.ts — every key in §2.1, nothing else compiles.
export const PERMISSIONS = ['dashboard.view', 'financials.view', /* … */ 'platform.jobs.view'] as const;
export type Permission = (typeof PERMISSIONS)[number];
// src/core/permissions/matrix.ts — the single source of the matrix above; deny-by-default.
export type EffectiveRole = 'super_admin' | 'employee' | 'owner' | 'admin' | 'client' | 'suspended_member' | 'none';
export const ROLE_MATRIX: Record<Exclude<EffectiveRole,'none'>, ReadonlySet<Permission>>; // ROLE_MATRIX.suspended_member = {'dashboard.view'}
// Code tests can(ctx, permission), never role === 'client' — a `<> 'client'` branch would widen access for suspended_member (R2-A-07).
// src/core/permissions/check.ts
export function can(ctx: AccessContext, p: Permission): boolean;
export function assertCan(ctx: AccessContext, p: Permission): void; // throws PermissionDenied
```

`scripts/sync-permission-matrix.ts` renders `ROLE_MATRIX` into a migration that fills the read-only `role_permissions (role, permission)` table used by `app.has_permission(org_id, permission)` inside every `api.*` mutation function (ADR-026). The pgTAP parity test fails CI if the table and the TypeScript matrix differ.

The ◐ restrictions are implemented as named guards next to the matrix (`canInviteRole(actorRole, targetRole)`, `canChangeRole(actorRole, fromRole, toRole)`, `canRevokeAssignment(ctx, assignment)`), each with its own unit tests.
