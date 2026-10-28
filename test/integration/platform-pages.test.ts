import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { auth } from '@/db/firestore';
import { globalRow, newId, nowIso, orgRow } from '@/db/schema';
import {
  loadOrganizationDetail, loadPlatformSettings, searchAudit, updateOrgQuotas,
  updateOrganizationAsPlatform, updatePlatformSetting,
} from '@/modules/platform';
import type { AccessContext } from '@/modules/tenancy';
import { clientFor, createAuthUser, deleteOrg, fs, rpc } from './setup';

/**
 * The platform pages' reads and writes (ROUTE_ARCHITECTURE.md §150, §155, §156; ADR-088).
 *
 * What a super admin may see and change, and — the point of the suite — what everybody else
 * may not: an organisation's own owner, and an employee assigned to it, are both refused the
 * platform's surfaces, and the refusal comes from the data layer, not from the page.
 */

const RUN = `pp${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.platform.itest.motion`;

let ownerId: string;
let adminId: string;
let employeeId: string;
let orgId: string;
let orgName: string;
/** A default the platform's first migration seeded, created here only when the emulator lacks it. */
let seededDefault = false;

function platformContext(userId: string, role: 'super_admin' | 'employee'): AccessContext {
  return {
    userId, orgId: null, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: role === 'super_admin' ? 'platform_admin' : 'employee',
    db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: null,
  };
}

function orgContext(userId: string, role: EffectiveRole): AccessContext {
  return {
    userId, orgId, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
  };
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  adminId = await createAuthUser(`super_admin@${DOMAIN}`);
  employeeId = await createAuthUser(`employee@${DOMAIN}`);
  orgName = `ITest Platform ${RUN}`;
  const created = await rpc<string>(clientFor(ownerId), 'create_organization', { p_name: orgName });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data!;

  const now = nowIso();
  for (const [uid, role] of [[adminId, 'super_admin'], [employeeId, 'employee']] as const) {
    await globalRow(fs(), 'platform_users', uid).set({
      user_id: uid, platform_role: role, status: 'active', granted_by: null, notes: null, created_at: now, updated_at: now,
    });
  }
  await orgRow(fs(), orgId, 'organization_assignments', employeeId).set({
    id: newId(), organization_id: orgId, employee_user_id: employeeId, assigned_by: adminId,
    grantor_organization_id: null, status: 'active', starts_at: null,
    ends_at: new Date(Date.now() + 365 * 86_400_000).toISOString(), revoked_by: null, revoked_reason: null,
    created_at: now, updated_at: now,
  });

  // The SQL migration seeded `ai_quota_daily` = 100; the emulator starts empty.
  const setting = globalRow(fs(), 'platform_settings', 'ai_quota_daily');
  if (!(await setting.get()).exists) {
    seededDefault = true;
    await setting.set({ key: 'ai_quota_daily', value: 100, updated_by: null, created_at: now, updated_at: now });
  }
});

afterAll(async () => {
  await deleteOrg(orgId);
  if (seededDefault) await globalRow(fs(), 'platform_settings', 'ai_quota_daily').delete();
  for (const id of [ownerId, adminId, employeeId]) {
    await fs().collection('platform_users').doc(id).delete();
    await fs().collection('profiles').doc(id).delete();
  }
  await auth().deleteUsers([ownerId, adminId, employeeId]);
});

describe('the organisation detail page', () => {
  it('shows a super admin who is in it, what it may do and what is in it', async () => {
    const detail = await loadOrganizationDetail(platformContext(adminId, 'super_admin'), orgId);
    expect(detail.organization.name).toBe(orgName);
    expect(detail.organization.status).toBe('active');
    expect(detail.members.map((m) => m.email)).toContain(`owner@${DOMAIN}`);
    expect(detail.assignments.map((a) => a.employeeUserId)).toContain(employeeId);
    expect(detail.counts.documents).toBe(0);
    // No override yet: every limit is the platform's default.
    expect(detail.quotas).toEqual({ aiQuotaDaily: null, aiTokenCeilingMonthly: null, aiExtractionPagesPerDay: null, notes: null });
  });

  it('suspends and reactivates, and gives the organisation its own limits and flags', async () => {
    const ctx = platformContext(adminId, 'super_admin');
    await updateOrganizationAsPlatform(ctx, orgId, { status: 'suspended' });
    expect((await globalRow(fs(), 'organizations', orgId).get()).get('status')).toBe('suspended');
    await updateOrganizationAsPlatform(ctx, orgId, { status: 'active' });

    await updateOrganizationAsPlatform(ctx, orgId, { features: { ai_pdf_extraction: true } });
    await updateOrgQuotas(ctx, orgId, { ai_quota_daily: 25, notes: 'Trial customer' });

    const detail = await loadOrganizationDetail(ctx, orgId);
    expect(detail.organization.status).toBe('active');
    expect(detail.organization.features.ai_pdf_extraction).toBe(true);
    expect(detail.quotas.aiQuotaDaily).toBe(25);
    expect(detail.quotas.notes).toBe('Trial customer');
    // The change is on the record, in the organisation's own trail.
    const events = await fs().collection('audit_events').where('organization_id', '==', orgId)
      .where('action', '==', 'platform.org_settings_changed').get();
    expect(events.size).toBeGreaterThan(0);
  });

  it('is refused to the organisation’s own owner', async () => {
    await expect(loadOrganizationDetail(orgContext(ownerId, 'owner'), orgId)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('the global audit trail', () => {
  it('spans organisations and the platform, names the actor, and filters by family', async () => {
    const ctx = platformContext(adminId, 'super_admin');
    // Other suites write to the same emulator at the same time, so the organisation's own trail is
    // read through the organisation filter rather than hoped for among everyone's newest 200.
    const all = await searchAudit(ctx, { limit: 200 });
    expect(all.length).toBeGreaterThan(0);
    const mine = await searchAudit(ctx, { organizationId: orgId, limit: 200 });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.organizationId === orgId)).toBe(true);
    // `profiles` is own-row-only; the name comes from the function (ADR-088).
    const created = mine.find((e) => e.action === 'org.created');
    expect(created?.actorName).toBe(`owner@${DOMAIN}`);

    const platformOnly = await searchAudit(ctx, { action: 'platform.', organizationId: orgId });
    expect(platformOnly.length).toBeGreaterThan(0);
    expect(platformOnly.every((e) => e.action.startsWith('platform.'))).toBe(true);
    expect(await searchAudit(ctx, { action: 'nothing.matches' })).toEqual([]);
  });

  it('is refused to an owner and to an assigned employee', async () => {
    await expect(searchAudit(orgContext(ownerId, 'owner'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(searchAudit(platformContext(employeeId, 'employee'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('platform settings', () => {
  it('reads the defaults and changes one, audited', async () => {
    const ctx = platformContext(adminId, 'super_admin');
    const before = await loadPlatformSettings(ctx);
    expect(before.map((s) => s.key)).toContain('ai_quota_daily');
    const original = before.find((s) => s.key === 'ai_quota_daily')!.value;

    await updatePlatformSetting(ctx, 'ai_quota_daily', 123);
    expect((await globalRow(fs(), 'platform_settings', 'ai_quota_daily').get()).get('value')).toBe(123);
    const events = await fs().collection('audit_events').where('actor_user_id', '==', adminId)
      .where('action', '==', 'platform.settings_changed').get();
    expect(events.docs.some((d) => d.get('organization_id') === null)).toBe(true);

    await updatePlatformSetting(ctx, 'ai_quota_daily', original);
  });

  it('is refused to an owner and to an employee', async () => {
    await expect(loadPlatformSettings(orgContext(ownerId, 'owner'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(loadPlatformSettings(platformContext(employeeId, 'employee'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
