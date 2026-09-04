# MOTION — Tenancy Model

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-001, ADR-002, ADR-013, ADR-014, CD-02, CD-13, CD-29)
Consumed by: `DATABASE_ARCHITECTURE.md`, `SECURITY_MODEL.md`, `SERVICE_ARCHITECTURE.md`

## 1. Hierarchy

```
Platform (MOTION)
└── Organization  ← the tenant boundary, one customer business
    ├── Members        (owner / admin / client)  via organization_memberships
    ├── Assigned staff (platform employees)      via organization_assignments
    └── All financial, banking, document, import, intelligence, AI, action and audit data
```

There is **no Entity and no Business Unit level** (ADR-001). Evaluation of the alternatives:

| Option | Verdict | Reason |
|---|---|---|
| Platform → Org → Entity → Business Unit | Rejected | SOW never defines Entity separately from company; every extra level doubles RLS complexity and every query joins one more table. Nothing in the MVP journey needs it. |
| Platform → Org → Entity | Rejected for MVP | Multi-company groups are "Enterprise plans" (§29), post-MVP. A group is modelled later as `organization_groups` linking organizations; consolidation is read-time aggregation. |
| Platform → Organization | **Adopted** | One predicate, `organization_id = …`, on every tenant table. |

"Business unit" analysis, if ever needed, is a *dimension* (a tag on accounts/transactions), not a tenancy level.

## 2. Organization

`organizations` is the root of every tenant. Key attributes: `id`, `slug` (URL-safe, unique, immutable after creation), `name`, `legal_name`, `country_code`, `base_currency`, `fiscal_year_start_month`, `status ∈ {active, suspended, pending_deletion, deleted}`, `plan`, `features JSONB`, `settings JSONB`, `created_by`, `deleted_at`.

Lifecycle: `active` → (`suspended` ↔ `active`) → `pending_deletion` (30-day grace, owner or super admin) → `deleted` (purge job removes Storage objects and hard-deletes tenant rows; `audit_events` and the `organizations` row survive with payloads nulled).

Creation paths:
- Self-serve: a signed-up user creates an organization and becomes its first owner (single transaction: insert org, insert owner membership, seed standard accounts, seed fiscal periods).
- Platform: a super admin creates an organization and invites the owner by email; until accepted the org has zero members and is administrable only from `/platform`.

## 3. How users reach an organization

| Path | Table | Created by | Ends by |
|---|---|---|---|
| Membership | `organization_memberships (organization_id, user_id, role, status)` | Invitation acceptance, org creation, super admin | Removal, leaving, suspension, org deletion |
| Assignment | `organization_assignments (organization_id, employee_user_id, status, starts_at, ends_at, assigned_by, grantor_organization_id NULL)` | Super admin only | Super admin revoke, owner revoke, `ends_at` passing, employee role revoked |

`grantor_organization_id` is NULL in MVP. Post-MVP external adviser firms (CD-02) populate it with the adviser organization's id; the access resolver and RLS do not change.

Both tables have `UNIQUE (organization_id, user_id)` so a user has one relationship of each kind per organization, and a trigger prevents a platform user from also being a member (RBAC §3.5).

## 4. Access resolution — the one function

```sql
-- Returns every organization the current JWT subject may read.
create function app.accessible_org_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select organization_id from organization_memberships
   where user_id = auth.uid() and status = 'active'
  union
  select organization_id from organization_assignments a
    join platform_users p on p.user_id = a.employee_user_id
   where a.employee_user_id = auth.uid() and a.status = 'active' and p.status = 'active'
     and p.platform_role = 'employee'
     and (a.starts_at is null or a.starts_at <= now())
     and (a.ends_at   is null or a.ends_at   >  now())
  union
  select id from organizations where app.is_super_admin() and status <> 'deleted';
$$;

create function app.is_super_admin() returns boolean … -- active platform_users row with role super_admin
create function app.org_role(org uuid) returns text …  -- 'super_admin'|'employee'|'owner'|'admin'|'client'|null
```

The TypeScript twin `resolveAccess(userId, orgId): AccessContext` implements the identical order (RBAC §1) and is tested against the SQL function with the same fixtures so the two can never disagree silently.

Performance: both functions are `STABLE`, and Postgres caches them per statement. Indexes on `(user_id, status)` for memberships and `(employee_user_id, status)` for assignments keep the resolver sub-millisecond. The set is small (a user belongs to a handful of organizations), so `organization_id IN (select app.accessible_org_ids())` is cheap.

## 5. Platform employee access without breaking isolation

The concern: an internal adviser must work inside customer data while the customer keeps ownership and visibility.

1. **Explicit grant.** Only a super admin can insert into `organization_assignments`. There is no "all organizations" flag for employees. An employee with ten clients has ten rows.
2. **Same door as members.** The resolver unions assignments with memberships. Employees get no special client, no service role, no bypass. `app.has_permission()` grants them the data-table permissions in `RBAC_MATRIX.md §2.1` and none of the governance permissions.
3. **Visible to the tenant.** Owners and admins see assigned staff by name with a "MOTION adviser" badge under Settings → Team → "MOTION advisers", with the assignment date and who assigned them. (The baseline's anonymous "MOTION Support" label is the alternative if CD-16 resolves to read-only support staff.)
4. **Revocable by the tenant.** Owner may revoke; the row is set `status = 'revoked'`, an audit event is written to both the org's log and the platform log, and the employee loses access on their next request (context is resolved per request, not cached in the session).
5. **Time-boxed by default.** `ends_at` defaults to 12 months; expiry is enforced in the resolver, not by a cleanup job.
6. **Portfolio view is a projection, not a bypass.** `/portfolio` lists the employee's assigned organizations by querying `organization_assignments` for self, then reads each organization's current health score and open alerts through the normal org-scoped services, one organization at a time, with the same `AccessContext`. Cross-organization aggregation happens in application memory; no query ever spans organizations.
7. **No cross-tenant AI.** An AI conversation belongs to exactly one organization. The tools receive `orgId` from the context, never from the model.

## 6. Tenant-owned tables — requirements table

Every table in the "tenant" class must satisfy all columns below. `DATABASE_ARCHITECTURE.md` gives the full schema; this is the rule set.

| Requirement | Rule |
|---|---|
| `organization_id` | `uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`, first column after PK |
| Denormalised org id on child tables | Child tables (`import_rows`, `evidence_items`, `ai_messages`, `ai_tool_calls`) carry `organization_id` too, so every RLS policy is a single-table predicate and no policy needs a join |
| Cross-org FK protection | Composite FK `(organization_id, parent_id) REFERENCES parent(organization_id, id)` on every tenant→tenant foreign key so a row can never reference a parent in another organization even under service role |
| RLS | `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`; SELECT policy `organization_id IN (select app.accessible_org_ids())`; write policies call `app.has_permission(organization_id, '<permission>')` with the permission named in `DATABASE_ARCHITECTURE.md §11` (ADR-003) |
| Ownership | Rows are owned by the organization, not by the creating user; `created_by` is informational. Removing a user never deletes their rows |
| Indexes | Every index on a tenant table leads with `organization_id` (or is a unique index that includes it) |
| Audit | Governance tables: trigger-level diff; data tables: service-level events on commit/reject/edit; read audit only for documents, exports and super-admin views |
| Soft delete | Financial records are never hard-deleted while the organization exists; `record_status = 'rejected'` instead |

Table classes:

| Class | Tables | RLS shape |
|---|---|---|
| Global identity | `profiles` | Own row; plus name/avatar of users sharing an organization via a security-definer view |
| Platform | `platform_users`, `jobs` (org nullable), `platform_settings` | `app.is_super_admin()` only; employees read own `platform_users` row |
| Tenant root | `organizations` | Read if in accessible set; write owner/admin (limited columns) or super admin |
| Tenant governance | `organization_memberships`, `organization_assignments`, `invitations` | Read: members owner/admin + super admin (+ employee for assignments about self); write: owner/admin (ceiling rules) / super admin |
| Tenant data | everything else with `organization_id` | Read: accessible set; write: `app.has_permission()` for the owning permission (owner/admin/employee/super admin in practice); client writes only via `app.action_update_own`, `app.alert_set_status` (acknowledge) and own `ai_conversations`/`ai_messages`/`ai_feedback` rows |
| Append-only | `audit_events` | Insert by services/triggers; select owner/admin (own org) + super admin; no update/delete |

## 7. Tenant context in the application

- The org is selected by URL: `/app/[orgSlug]/…`. The slug is resolved to an id server-side; the id is never accepted from the client body.
- `AccessContext` is built in the root `app/[orgSlug]/layout.tsx` and in each route handler from the session + slug; cached per request with `React.cache`.
- `profiles.last_active_org_id` remembers the last organization for the redirect after sign-in. Users with exactly one organization skip the org switcher.
- Service-role code (`withOrgScope(orgId, fn)`) sets `set_config('app.current_org', orgId)` and every service-role query includes an explicit `organization_id` filter; a lint rule (`no-unscoped-service-query`) fails CI when a service-role query omits it.

## 8. Storage tenancy

Bucket `source-documents` (private). Object path: `{organization_id}/{document_id}/{original-filename}`. Storage RLS policies mirror table RLS using `(storage.foldername(name))[1]::uuid IN (select app.accessible_org_ids())` for read, and only server-side service code writes. Downloads are always via 60-second signed URLs minted after `documents.view` passes and an audit event is written.

## 9. Post-MVP extensions that require no migration of the model

| Extension | How it attaches |
|---|---|
| External adviser firms | `organizations.kind = 'adviser'` + `organization_assignments.grantor_organization_id` |
| Groups / consolidation | `organization_groups` + `organization_group_members`; read-time aggregation |
| Time-boxed super admin support access | Replace the third UNION branch in `app.accessible_org_ids()` with a lookup on `support_access_grants` |
| Billing | `subscriptions` keyed by `organization_id` |
