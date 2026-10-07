import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import {
  loadOrganizationDetail, loadPlatformSettings, searchAudit, updateOrgQuotas,
  updateOrganizationAsPlatform, updatePlatformSetting,
} from '@/modules/platform';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, withPlatformMfaRequired } from './setup';

/**
 * The platform pages' reads and writes (ROUTE_ARCHITECTURE.md §150, §155, §156; ADR-088).
 *
 * What a super admin at aal2 may see and change, and — the point of the suite — what everybody else
 * may not: an organisation's own owner, and an employee assigned to it, are both refused the
 * platform's surfaces, and the refusal comes from the database, not from the page.
 */

const RUN = `pp${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.platform.itest`;

let ownerId: string;
let adminId: string;
let employeeId: string;
let orgId: string;
let orgName: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function platformContext(userId: string, role: 'super_admin' | 'employee', aal: 'aal1' | 'aal2' = 'aal2'): AccessContext {
  return {
    userId, orgId: null, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: role === 'super_admin' ? 'platform_admin' : 'employee',
    db: clientFor(userId, { email: `${role}@${DOMAIN}`, aal }),
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
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  adminId = createAuthUser(`super_admin@${DOMAIN}`);
  employeeId = createAuthUser(`employee@${DOMAIN}`);
  orgName = `ITest Platform ${RUN}`;
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: orgName });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  adminSql(`
    insert into public.platform_users (user_id, platform_role, status) values
      ('${adminId}', 'super_admin', 'active'), ('${employeeId}', 'employee', 'active');
    insert into public.organization_assignments (organization_id, employee_user_id, assigned_by, status)
    values ('${orgId}', '${employeeId}', '${adminId}', 'active');`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Platform%${RUN}';
    delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';`);
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
    expect(one(`select status::text from public.organizations where id = '${orgId}'`)).toBe('suspended');
    await updateOrganizationAsPlatform(ctx, orgId, { status: 'active' });

    await updateOrganizationAsPlatform(ctx, orgId, { features: { ai_pdf_extraction: true } });
    await updateOrgQuotas(ctx, orgId, { ai_quota_daily: 25, notes: 'Trial customer' });

    const detail = await loadOrganizationDetail(ctx, orgId);
    expect(detail.organization.status).toBe('active');
    expect(detail.organization.features.ai_pdf_extraction).toBe(true);
    expect(detail.quotas.aiQuotaDaily).toBe(25);
    expect(detail.quotas.notes).toBe('Trial customer');
    // The change is on the record, in the organisation's own trail.
    expect(Number(one(`select count(*) from public.audit_events where organization_id = '${orgId}' and action = 'platform.org_settings_changed'`))).toBeGreaterThan(0);
  });

  it('is refused to the organisation’s own owner', async () => {
    await expect(loadOrganizationDetail(orgContext(ownerId, 'owner'), orgId)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('the global audit trail', () => {
  it('spans organisations and the platform, names the actor, and filters by family', async () => {
    const ctx = platformContext(adminId, 'super_admin');
    const all = await searchAudit(ctx, { limit: 200 });
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((e) => e.organizationId === orgId)).toBe(true);
    // `profiles` is own-row-only; the name comes from the definer (ADR-088).
    const created = all.find((e) => e.organizationId === orgId && e.action === 'org.created');
    expect(created?.actorName).toBe(`owner@${DOMAIN}`);

    const platformOnly = await searchAudit(ctx, { action: 'platform.', organizationId: orgId });
    expect(platformOnly.every((e) => e.action.startsWith('platform.'))).toBe(true);
    expect(await searchAudit(ctx, { action: 'nothing.matches' })).toEqual([]);
  });

  it('is refused to an owner, to an assigned employee, and to a super admin without a second factor', async () => {
    await expect(searchAudit(orgContext(ownerId, 'owner'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(searchAudit(platformContext(employeeId, 'employee'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await withPlatformMfaRequired(true, async () => {
      await expect(searchAudit(platformContext(adminId, 'super_admin', 'aal1'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });
  });
});

describe('platform settings', () => {
  it('reads the defaults and changes one, audited', async () => {
    const ctx = platformContext(adminId, 'super_admin');
    const before = await loadPlatformSettings(ctx);
    expect(before.map((s) => s.key)).toContain('ai_quota_daily');
    const original = before.find((s) => s.key === 'ai_quota_daily')!.value;

    await updatePlatformSetting(ctx, 'ai_quota_daily', 123);
    expect(one(`select value::text from public.platform_settings where key = 'ai_quota_daily'`)).toBe('123');
    expect(Number(one(`select count(*) from public.audit_events where organization_id is null and action = 'platform.settings_changed'`))).toBeGreaterThan(0);

    await updatePlatformSetting(ctx, 'ai_quota_daily', original);
  });

  it('is refused to an owner and to an employee', async () => {
    await expect(loadPlatformSettings(orgContext(ownerId, 'owner'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(loadPlatformSettings(platformContext(employeeId, 'employee'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
