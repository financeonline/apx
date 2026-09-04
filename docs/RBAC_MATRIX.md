# MOTION — RBAC Model & Permission Matrix

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-002, ADR-003, CD-13 to CD-17), `TENANCY_MODEL.md`
Consumed by: `SECURITY_MODEL.md`, `SERVICE_ARCHITECTURE.md`, `ROUTE_ARCHITECTURE.md`, `TEST_STRATEGY.md`

## 1. Roles

MOTION has two role families. A user may hold at most one platform role and at most one tenant role per organization. Platform staff are never also members of customer organizations (enforced by a check in `resolveAccess` and a DB constraint trigger on `organization_memberships`).

| Internal role key | User-facing name (from brief) | Family | Stored in | Scope |
|---|---|---|---|---|
| `platform_super_admin` | Super Admin | Platform | `platform_users.platform_role = 'super_admin'` | Whole platform |
| `platform_employee` | My Employee | Platform | `platform_users.platform_role = 'employee'` + rows in `organization_assignments` | Only explicitly assigned organizations |
| `tenant_owner` | Owner | Tenant | `organization_memberships.role = 'owner'` | One organization per row |
| `tenant_admin` | Admin | Tenant | `organization_memberships.role = 'admin'` | One organization per row |
| `tenant_client` | Client | Tenant | `organization_memberships.role = 'client'` | One organization per row |

**Effective role.** Inside a given organization a user resolves to exactly one of `super_admin | employee | owner | admin | client | none`. Resolution order (first match wins):

1. Active `platform_users` row with `super_admin` → `super_admin` (access audited, CD-13).
2. Active `platform_users` row with `employee` **and** an active `organization_assignments` row for this organization (status active, now within `starts_at`/`ends_at`) → `employee`.
3. Active `organization_memberships` row → its role.
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
| `users.view` | ✓ | ◐ | ✓ | ✓ | ✗ | Employee sees members of assigned org (names, roles), not emails of other orgs |
| `users.invite` | ✓ | ✗ | ✓ | ◐ | ✗ | Admin may invite `admin` or `client`, never `owner` |
| `users.manage` | ✓ | ✗ | ✓ | ◐ | ✗ | Admin may change/remove `admin`/`client`; cannot touch owners; cannot promote to owner |
| `assignments.view` | ✓ | ◐ | ✓ | ✓ | ✗ | Employee sees own assignments only |
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
2. **Role ceiling.** A user may never grant a role higher than their own effective role. Admin ceiling = admin. Enforced in `membership.service` and by an RLS `WITH CHECK` on `organization_memberships` that limits `role` to `('admin','client')` unless the actor is owner or super admin.
3. **No self-elevation; ownership transfer is a flow.** No user can raise their own role. Sole ownership moves through a two-step transfer (initiate → nominee accepts). Owners cannot demote themselves if they are the last owner; admins can demote themselves to client.
4. **Employee write scope.** RLS write policies treat `employee` like `admin` for data tables only. Membership, assignment, settings and organization tables have no employee write path.
5. **Platform staff exclusivity.** A user with an active `platform_users` row cannot be inserted into `organization_memberships` (trigger). If a platform employee needs to be a customer, they use a separate account.
6. **Super admin reads are audited.** Every `/app/[orgSlug]/*` request served to a super admin writes one `audit_events` row (`actor_type = 'platform_admin'`, `action = 'org.data_viewed'`, target = route). Reads under `/platform` are not individually audited.
7. **Suspended state.** `organizations.status = 'suspended'` reduces every member to `dashboard.view` with a banner; `organization_memberships.status = 'suspended'` resolves to `none`.
8. **AI acts as the user.** Tool calls run with the asking user's `AccessContext`. A client asking the AI for a source document link is refused by the tool exactly as the UI would refuse.

## 4. Permission enforcement points

| Layer | What it checks | Mechanism |
|---|---|---|
| Middleware | Session exists; route family (public/app/platform/portfolio) matches role family | `middleware.ts` reads session, calls `resolveAccess` for `[orgSlug]` |
| Layout / page | Effective role ≠ `none` for the org; feature flag for the module | Server component throws `NotFound` (not `Forbidden`, to avoid org enumeration) |
| Server action / route handler | `assertCan(ctx, key)` before any service call | Throws `PermissionDenied`, mapped to 403 JSON / toast |
| Service | Re-checks permission for privileged operations and applies row-level constraints (§3) | Explicit checks; services never trust callers |
| Database | RLS: org access on every read; `app.has_permission()` on every write; platform tables super-admin only | Policies in `DATABASE_ARCHITECTURE.md §11` |
| AI tools | Same `assertCan` on each tool invocation; tools inherit and never exceed the caller's permissions | `AI_ARCHITECTURE.md §4` |

A request must pass all applicable layers. Tests in `TEST_STRATEGY.md §2` assert that removing any single layer still blocks cross-tenant access.

## 5. UI behaviour per role

- Navigation items are hidden when the role lacks the *view* permission for the whole section (never partially rendered).
- Action buttons (Upload, Invite, Export, Assign) are hidden, not disabled, for roles without the permission; the server still enforces.
- Permission-denied on a deep link shows the friendly "You don't have access to this" state (`UX_ARCHITECTURE.md §8`) with a link back to Home. Organization existence is never confirmed to a non-member (404, not 403).

## 6. Permission map as code (shape only)

```ts
// src/core/permissions/catalogue.ts — every key in §2.1, nothing else compiles.
export const PERMISSIONS = ['dashboard.view', 'financials.view', /* … */ 'platform.jobs.view'] as const;
export type Permission = (typeof PERMISSIONS)[number];
// src/core/permissions/matrix.ts — the single source of the matrix above; deny-by-default.
export type EffectiveRole = 'super_admin' | 'employee' | 'owner' | 'admin' | 'client' | 'none';
export const ROLE_MATRIX: Record<Exclude<EffectiveRole,'none'>, ReadonlySet<Permission>>;
// src/core/permissions/check.ts
export function can(ctx: AccessContext, p: Permission): boolean;
export function assertCan(ctx: AccessContext, p: Permission): void; // throws PermissionDenied
```

`scripts/sync-permission-matrix.ts` renders `ROLE_MATRIX` into a migration that fills the read-only `role_permissions (role, permission)` table used by `app.has_permission(org_id, permission)` in RLS write policies. The pgTAP parity test fails CI if the table and the TypeScript matrix differ.

The ◐ restrictions are implemented as named guards next to the matrix (`canInviteRole(actorRole, targetRole)`, `canChangeRole(actorRole, fromRole, toRole)`, `canRevokeAssignment(ctx, assignment)`), each with its own unit tests.
