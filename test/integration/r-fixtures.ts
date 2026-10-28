import { newId, nowIso, orgRow } from '@/db/schema';
import { writeStandardChart } from '@/db/app/shared';
import { fs } from './setup';

/**
 * Fixtures shared by Team R's suites (actions, alerts, evidence, reporting, investment, home): an
 * organisation and its people written straight into Firestore, in the shapes FIRESTORE_DATA_MODEL.md
 * §3 gives — what `api.create_organization` and an accepted invitation would leave behind, without
 * depending on those functions. Only fixtures are written this way; every assertion still goes
 * through `clientFor` and the real `api.*` functions and `src/db/rls.ts` reads.
 */

export type MemberRole = 'owner' | 'admin' | 'accountant' | 'client' | 'third_party';

export interface OrgFixture {
  readonly id: string;
  readonly slug: string;
}

export async function createOrgFixture(input: {
  name: string;
  ownerId: string;
  members?: ReadonlyArray<{ userId: string; role: MemberRole }>;
  features?: Record<string, unknown>;
  baseCurrency?: string;
  timezone?: string;
  fiscalYearStartMonth?: number;
  status?: string;
  /** Seed the standard chart of accounts, as create_organization does (default true). */
  chart?: boolean;
}): Promise<OrgFixture> {
  const id = newId();
  const slug = `itest-${id.slice(0, 8)}`;
  const now = nowIso();
  await fs().collection('organizations').doc(id).set({
    id, slug, name: input.name, legal_name: null, country_code: 'GB',
    base_currency: input.baseCurrency ?? 'GBP', fiscal_year_start_month: input.fiscalYearStartMonth ?? 1,
    industry: null, kind: 'customer', status: input.status ?? 'active', plan: 'trial',
    features: input.features ?? {}, settings: {}, timezone: input.timezone ?? 'Europe/London',
    deletion_requested_at: null, created_by: input.ownerId, deleted_at: null, created_at: now, updated_at: now,
  });
  await addMember(id, input.ownerId, 'owner');
  for (const m of input.members ?? []) await addMember(id, m.userId, m.role);
  if (input.chart !== false) {
    await fs().runTransaction(async (tx) => { writeStandardChart(tx, fs(), id); });
  }
  return { id, slug };
}

export async function addMember(orgId: string, userId: string, role: MemberRole, status = 'active'): Promise<void> {
  const now = nowIso();
  await orgRow(fs(), orgId, 'organization_memberships', userId).set({
    id: newId(), organization_id: orgId, user_id: userId, role, status, invited_by: null, joined_at: now,
    created_at: now, updated_at: now, departments: [], departments_set_by_owner: false,
  });
}

/** A platform employee assigned to the organisation (the Financial Analyst). */
export async function assignEmployee(orgId: string, userId: string): Promise<void> {
  const now = nowIso();
  await fs().collection('platform_users').doc(userId).set({
    user_id: userId, platform_role: 'employee', status: 'active', granted_by: null, notes: null,
    created_at: now, updated_at: now,
  });
  await orgRow(fs(), orgId, 'organization_assignments', userId).set({
    id: newId(), organization_id: orgId, employee_user_id: userId, assigned_by: null,
    grantor_organization_id: null, status: 'active', starts_at: null,
    ends_at: new Date(Date.now() + 365 * 86_400_000).toISOString(), revoked_by: null, revoked_reason: null,
    created_at: now, updated_at: now,
  });
}

/** Sets a per-person permission switch (ADR-172). */
export async function setOverride(orgId: string, userId: string, permission: string, granted: boolean): Promise<void> {
  await orgRow(fs(), orgId, 'member_permission_overrides', `${userId}__${permission}`).set({
    organization_id: orgId, user_id: userId, permission, granted, created_at: nowIso(), updated_at: nowIso(),
  });
}

/** The organisation's audit events, oldest first (for assertions on what a function recorded). */
export async function auditEvents(orgId: string, action?: string): Promise<FirebaseFirestore.DocumentData[]> {
  let q: FirebaseFirestore.Query = fs().collection('audit_events').where('organization_id', '==', orgId);
  if (action) q = q.where('action', '==', action);
  const snap = await q.get();
  return snap.docs.map((d) => d.data()).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/** Removes the platform_users rows a suite created (deleteOrg removes everything under the org). */
export async function deletePlatformUser(userId: string): Promise<void> {
  await fs().collection('platform_users').doc(userId).delete();
}
