# MOTION — Tenancy Model

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-001, ADR-002, ADR-013, ADR-014, ADR-026, ADR-038, CD-02, CD-13, CD-29)
Consumed by: `DATABASE_ARCHITECTURE.md`, `SECURITY_MODEL.md`, `SERVICE_ARCHITECTURE.md`

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026 (no table writes for `authenticated`; writes via `api.*`), ADR-038 (suspension resolved at the database, `aal2` for super admins, `search_path = ''`, read-only aggregate projections for the portfolio, signed-URL-only Storage with a `reports` bucket, softened index rule, deletion lifecycle). Findings addressed: F-A-01, F-A-04, F-A-06, F-A-13, F-A-16, F-D-05, F-D-14, F-D-16. See `RED_TEAM_REVIEW.md`.

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

Lifecycle: `active` → (`suspended` ↔ `active`) → `pending_deletion` (`api.request_deletion`; `deletion_requested_at` set; a trigger enqueues `org.purge` with `run_after = now() + 30 days`; `api.cancel_deletion` returns to `active` and cancels the job) → `deleted` (the purge job waits for zero running jobs of the organization, re-verifies status and age, removes Storage objects under `source-documents/{org}/` and `reports/{org}/`, hard-deletes tenant rows, and redacts `audit_events.before/after/metadata/ip/user_agent`; the events and the `organizations` row survive). While `suspended`, every member and assigned employee resolves to `suspended_member` at the database (§4) and background jobs for the organization are deferred (ADR-038.12).

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
-- Internal schema `app` (never exposed to PostgREST); EXECUTE granted to authenticated only
-- because RLS policies reference it. search_path is empty and every name is qualified (ADR-038.10).
create function app.accessible_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.organization_id
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
   where m.user_id = auth.uid() and m.status = 'active'
     and o.status in ('active', 'suspended', 'pending_deletion')      -- suspended orgs stay readable, role shrinks (below)
  union
  select a.organization_id
    from public.organization_assignments a
    join public.platform_users p on p.user_id = a.employee_user_id
    join public.organizations o on o.id = a.organization_id
   where a.employee_user_id = auth.uid() and a.status = 'active' and p.status = 'active'
     and p.platform_role = 'employee'
     and (a.starts_at is null or a.starts_at <= now())
     and (a.ends_at   is null or a.ends_at   >  now())
     and o.status in ('active', 'suspended', 'pending_deletion')
  union
  select o.id from public.organizations o where app.is_super_admin() and o.status <> 'deleted';
$$;
revoke all on function app.accessible_org_ids() from public;
grant execute on function app.accessible_org_ids() to authenticated;

-- True only for an active super_admin row AND a session at authenticator assurance level 2 (TOTP), ADR-038.8.
create function app.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_users p
                  where p.user_id = auth.uid() and p.platform_role = 'super_admin' and p.status = 'active')
     and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

-- Effective role of the caller in one organization, in RBAC §1 order.
-- Returns 'super_admin' | 'employee' | 'owner' | 'admin' | 'client' | 'suspended_member' | null.
-- 'suspended_member' is returned for any member or assigned employee of an organization whose
-- status = 'suspended'; role_permissions maps it to dashboard.view only (ADR-038.2).
-- A membership with status = 'suspended' returns null.
create function app.org_role(org uuid) returns text
language sql stable security definer set search_path = '' as $$ … $$;

-- Used inside every api.* mutation function (never per row in a policy): ADR-026.
create function app.has_permission(org uuid, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.role_permissions rp
                  where rp.role = app.org_role(org) and rp.permission = perm);
$$;
```

The TypeScript twin `resolveAccess(userId, orgId): AccessContext` implements the identical order (RBAC §1), including organization status and membership status, and is tested against `app.accessible_org_ids()` **and** `app.org_role()` with the same 40-scenario fixture (membership × assignment × status × dates × organization status) so the two can never disagree silently.

Performance: the helpers are `STABLE`; `organization_id IN (select app.accessible_org_ids())` is an uncorrelated sub-select evaluated once per statement, and the set is small (a user belongs to a handful of organizations). `app.has_permission()` is called once per `api.*` invocation, never per row (ADR-026), so write cost no longer scales with row count. Indexes on `(user_id, status)` for memberships and `(employee_user_id, status)` for assignments keep the resolver sub-millisecond.

## 5. Platform employee access without breaking isolation

The concern: an internal adviser must work inside customer data while the customer keeps ownership and visibility.

1. **Explicit grant.** Only a super admin can insert into `organization_assignments`. There is no "all organizations" flag for employees. An employee with ten clients has ten rows.
2. **Same door as members.** The resolver unions assignments with memberships. Employees get no special client, no service role, no bypass. `app.has_permission()` grants them the data-table permissions in `RBAC_MATRIX.md §2.1` and none of the governance permissions.
3. **Visible to the tenant.** Owners and admins see assigned staff by name with a "MOTION adviser" badge under Settings → Team → "MOTION advisers", with the assignment date and who assigned them. (The baseline's anonymous "MOTION Support" label is the alternative if CD-16 resolves to read-only support staff.)
4. **Revocable by the tenant.** Owner may revoke; the row is set `status = 'revoked'`, an audit event is written to both the org's log and the platform log, and the employee loses access on their next request (context is resolved per request, not cached in the session).
5. **Time-boxed by default.** `ends_at` defaults to 12 months; expiry is enforced in the resolver, not by a cleanup job.
6. **Portfolio view is a read-only projection, not a bypass.** `/portfolio` (and `/platform/organizations`) use *aggregate projections*: one statement each over `health_current`/`health_scores`, open-alert counts and last committed `import_batches`, filtered by `organization_id IN (select app.accessible_org_ids())`, cached per organization tag (ADR-038.13). RLS already restricts the rows to the caller's accessible set, so one statement across N organizations is exactly as isolated as N statements; what remains per-organization is context resolution when the employee navigates *into* an organization. Projections are read-only services in `tenancy` (`portfolio.list(ctx)`); no write and no AI tool ever spans organizations.
7. **No cross-tenant AI.** An AI conversation belongs to exactly one organization. The tools receive `orgId` from the context, never from the model.

## 6. Tenant-owned tables — requirements table

Every table in the "tenant" class must satisfy all columns below. `DATABASE_ARCHITECTURE.md` gives the full schema; this is the rule set.

| Requirement | Rule |
|---|---|
| `organization_id` | `uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`, first column after PK |
| Denormalised org id on child tables | Child tables (`import_rows`, `evidence_items`, `ai_messages`, `ai_tool_calls`) carry `organization_id` too, so every RLS policy is a single-table predicate and no policy needs a join |
| Cross-org FK protection | Composite FK `(organization_id, parent_id) REFERENCES parent(organization_id, id)` on every plain tenant→tenant foreign key, and a `same_org_ref` trigger on every polymorphic reference column (`evidence_items.ref_id`, `evidence_bundles.origin_id`, `alerts.subject_id`, `actions.source_id`, `calculation_runs.trigger_ref_id`, `ai_feedback.*_id`, `import_rows.duplicate_of_id`), so a row can never reference a parent in another organization even under service role (ADR-034). pgTAP enumerates every FK column on tenant tables and fails on any exception |
| RLS and writes | `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`; SELECT policy `organization_id IN (select app.accessible_org_ids())` (narrower where the table says so); **no INSERT/UPDATE/DELETE privilege for `authenticated`** — every write is an `api.*` SECURITY DEFINER function that checks `app.has_permission(organization_id, '<permission>')` once and enforces the row invariants (`DATABASE_ARCHITECTURE.md §11, §14`, ADR-026) |
| Ownership | Rows are owned by the organization, not by the creating user; `created_by` is informational. Removing a user never deletes their rows |
| Indexes | Every index on a tenant table leads with `organization_id`, or with a column that is itself org-scoped by a composite FK (`batch_id`, `conversation_id`, `bundle_id`, `message_id`), or is a unique index that includes `organization_id` |
| Audit | Governance tables and the four financial record tables: trigger-level diff (`audit_diff`); every `api.*` function writes its own event in the same transaction; read audit for documents, reports, exports and super-admin views (including `/platform` surfaces that render tenant content) |
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

Two private buckets: `source-documents` (object path `{organization_id}/{document_id}/{original-filename}` and `{organization_id}/{document_id}/text.json`) and `reports` (`{organization_id}/{period}/{job_id}.pdf`). **There are no `storage.objects` policies for `authenticated` or `anon`** (ADR-038.1): a user JWT cannot list or fetch objects. The only reader and writer is `src/core/storage/signer.ts`, a storage-scoped service client that asserts every key starts with the caller's `organization_id`, requires the id of an audit event written in the same request, and mints 60-second signed URLs after `documents.view` / `reports.view` have passed. Uploads pass through the server (validation first, then the signer writes, then `api.register_document`); deletes remove the object before the row; `storage.cleanup_orphans` removes objects with no row; the purge job deletes both prefixes for the organization.

## 9. Post-MVP extensions that require no migration of the model

| Extension | How it attaches |
|---|---|
| External adviser firms | `organizations.kind = 'adviser'` + `organization_assignments.grantor_organization_id` |
| Groups / consolidation | `organization_groups` + `organization_group_members`; read-time aggregation |
| Time-boxed super admin support access | Replace the third UNION branch in `app.accessible_org_ids()` with a lookup on `support_access_grants (super_admin_user_id, organization_id, reason, expires_at)`; `org.data_viewed` auditing stays |
| Billing | `subscriptions` keyed by `organization_id` |
