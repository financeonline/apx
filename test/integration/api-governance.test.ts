import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { adminSql, clientFor, createAuthUser, resetFixtures, sqlstate } from './setup';

/**
 * Governance over the real wire (RBAC_MATRIX.md §4–§6, SECURITY_MODEL.md §14, TEST_STRATEGY.md §4).
 *
 * The pgTAP suite proves these rules hold inside the database. This file proves they hold on the
 * path production actually uses: a browser-shaped PostgREST call carrying a user JWT, through the
 * `api.*` surface, with `authenticated` privileges and nothing more.
 *
 * Every refusal is asserted on its SQLSTATE, not its message. The message is for humans; the code
 * is the contract core/errors/fromPostgresError() maps.
 */

const PERMISSION_DENIED = '42501';
const NOT_FOUND = 'P0002';
const CONFLICT = '23514';

let ownerId: string;
let adminId: string;
let clientId: string;
let outsiderId: string;
let orgId: string;

const rpc = (
  userId: string,
  fn: string,
  args: Record<string, unknown> = {},
  jwt: { email?: string; aal?: 'aal1' | 'aal2' } = {},
) => clientFor(userId, jwt).schema('api').rpc(fn, args);

/** Seed a member directly, so a test is not dependent on the invitation flow it does not exercise. */
function seedMember(userId: string, role: 'owner' | 'admin' | 'client'): void {
  adminSql(`
    set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role)
    values ('${orgId}', '${userId}', '${role}');
  `);
}

beforeAll(async () => {
  resetFixtures();
  ownerId = createAuthUser('gov-owner@itest.motion');
  adminId = createAuthUser('gov-admin@itest.motion');
  clientId = createAuthUser('gov-client@itest.motion');
  outsiderId = createAuthUser('gov-outsider@itest.motion');

  // The organization is created through the real api surface: the owner must come out of it.
  const { data, error } = await rpc(ownerId, 'create_organization', { p_name: 'ITest Governance' });
  if (error) throw new Error(`fixture organization could not be created: ${error.message}`);
  orgId = data as unknown as string;

  seedMember(adminId, 'admin');
  seedMember(clientId, 'client');
});

afterAll(() => {
  resetFixtures();
});

describe('creating an organization', () => {
  it('makes the creator its owner, through api.my_context', async () => {
    const { data } = await clientFor(ownerId).schema('api').rpc('my_organizations');
    const rows = (data as { organization_id: string; role: string }[] | null) ?? [];
    expect(rows.find((r) => r.organization_id === orgId)?.role).toBe('owner');
  });

  it('rate-limits repeated creation (ADR-044.5)', async () => {
    // The quota is 3 a day and one is already spent by the fixture.
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await rpc(ownerId, 'create_organization', { p_name: `ITest Flood ${i}` }));
    }
    const refused = results.filter((r) => r.error !== null);
    expect(refused.length, 'the throttle must refuse at least one attempt').toBeGreaterThan(0);
    expect(sqlstate(refused.at(-1)!.error)).toBe('53400');
  });
});

describe('role ceilings (RBAC_MATRIX.md §5)', () => {
  it('an admin cannot invite an owner', async () => {
    const { error } = await rpc(adminId, 'invite_member', {
      p_org: orgId,
      p_email: 'nope@itest.motion',
      p_role: 'owner',
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('an owner may invite an admin', async () => {
    const { error } = await rpc(ownerId, 'invite_member', {
      p_org: orgId,
      p_email: 'newadmin@itest.motion',
      p_role: 'admin',
    });
    expect(error, error?.message).toBeNull();
  });

  it('a client cannot invite anybody at all', async () => {
    const { error } = await rpc(clientId, 'invite_member', {
      p_org: orgId,
      p_email: 'nope2@itest.motion',
      p_role: 'client',
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('an admin cannot promote themselves to owner (self-elevation)', async () => {
    const { error } = await rpc(adminId, 'change_member_role', {
      p_org: orgId,
      p_user: adminId,
      p_role: 'owner',
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('an admin cannot demote an owner', async () => {
    const { error } = await rpc(adminId, 'change_member_role', {
      p_org: orgId,
      p_user: ownerId,
      p_role: 'client',
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });
});

describe('the last owner cannot disappear (ADR-030)', () => {
  it('the sole owner cannot leave', async () => {
    const { error } = await rpc(ownerId, 'leave_organization', { p_org: orgId });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe(CONFLICT);
  });

  it('the sole owner cannot demote themselves', async () => {
    const { error } = await rpc(ownerId, 'change_member_role', {
      p_org: orgId,
      p_user: ownerId,
      p_role: 'admin',
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe(CONFLICT);
  });

  it('the organization still has exactly one active owner afterwards', () => {
    const count = adminSql(`
      select count(*) from public.organization_memberships
       where organization_id = '${orgId}' and role = 'owner' and status = 'active'
    `);
    expect(count).toBe('1');
  });
});

describe('a member of another organization is told NOT FOUND, never FORBIDDEN', () => {
  it('an outsider governing the organization gets P0002', async () => {
    const { error } = await rpc(outsiderId, 'change_member_role', {
      p_org: orgId,
      p_user: clientId,
      p_role: 'admin',
    });
    expect(error).not.toBeNull();
    expect(
      sqlstate(error),
      'a 42501 here would confirm the organization exists to a stranger',
    ).toBe(NOT_FOUND);
  });

  it('an outsider updating the organization gets P0002', async () => {
    const { error } = await rpc(outsiderId, 'update_organization', {
      p_org: orgId,
      p_patch: { name: 'stolen' },
    });
    expect(sqlstate(error)).toBe(NOT_FOUND);
  });

  it('and the organization name is unchanged', () => {
    expect(adminSql(`select name from public.organizations where id = '${orgId}'`)).toBe(
      'ITest Governance',
    );
  });
});

describe('an invitation is bound to the address it was sent to (ADR-031)', () => {
  let token: string;

  beforeAll(async () => {
    const { data, error } = await rpc(ownerId, 'invite_member_with_token', {
      p_org: orgId,
      p_email: 'invited@itest.motion',
      p_role: 'client',
    });
    if (error) throw new Error(`invitation fixture failed: ${error.message}`);
    token = (data as { token: string }[])[0]!.token;
  });

  it('a different signed-in address cannot redeem it', async () => {
    const wrongPerson = createAuthUser('wrong@itest.motion');
    const { error } = await rpc(
      wrongPerson,
      'accept_invitation',
      { p_token: token },
      { email: 'wrong@itest.motion' },
    );
    expect(error, 'an unbound invitation is an account-takeover primitive').not.toBeNull();
  });

  it('a forged token is simply not found', async () => {
    const { error } = await rpc(outsiderId, 'accept_invitation', { p_token: 'not-a-real-token' });
    expect(sqlstate(error)).toBe(NOT_FOUND);
  });

  it('the invited address can redeem it exactly once', async () => {
    const invitee = createAuthUser('invited@itest.motion');
    const asInvitee = { email: 'invited@itest.motion' };
    const first = await rpc(invitee, 'accept_invitation', { p_token: token }, asInvitee);
    expect(first.error, first.error?.message).toBeNull();

    const second = await rpc(invitee, 'accept_invitation', { p_token: token }, asInvitee);
    expect(second.error, 'a redeemed invitation must not be replayable').not.toBeNull();
  });
});

describe('the two suspensions are different things (RBAC_MATRIX.md §7)', () => {
  let suspendedMemberId: string;
  let frozenOwnerId: string;
  let frozenOrgSlug: string;

  beforeAll(async () => {
    // (a) A suspended MEMBERSHIP resolves to nothing at all — the member is, to the database,
    //     indistinguishable from a stranger.
    suspendedMemberId = createAuthUser('gov-suspended@itest.motion');
    seedMember(suspendedMemberId, 'admin');
    const { error } = await rpc(ownerId, 'set_member_status', {
      p_org: orgId,
      p_user: suspendedMemberId,
      p_status: 'suspended',
    });
    if (error) throw new Error(`suspension fixture failed: ${error.message}`);

    // (b) A suspended ORGANIZATION freezes each member to `suspended_member`: still able to open
    //     the frozen Home and see the banner, able to govern nothing.
    frozenOwnerId = createAuthUser('gov-frozen@itest.motion');
    const created = await rpc(frozenOwnerId, 'create_organization', { p_name: 'ITest Frozen' });
    if (created.error) throw new Error(`frozen fixture failed: ${created.error.message}`);
    const frozenOrgId = created.data as unknown as string;
    adminSql(`update public.organizations set status = 'suspended' where id = '${frozenOrgId}'`);
    frozenOrgSlug = adminSql(`select slug from public.organizations where id = '${frozenOrgId}'`);
  });

  it('a suspended membership resolves to no access whatsoever', async () => {
    const slug = adminSql(`select slug from public.organizations where id = '${orgId}'`);
    const { data, error } = await clientFor(suspendedMemberId)
      .schema('api')
      .rpc('my_context', { p_slug: slug });
    expect(error).toBeNull();
    expect(data ?? [], 'a suspended member is not a suspended_member — they are none').toHaveLength(0);
  });

  it('and their governance calls are NOT FOUND, like any stranger', async () => {
    const { error } = await rpc(suspendedMemberId, 'invite_member', {
      p_org: orgId,
      p_email: 'x@itest.motion',
      p_role: 'client',
    });
    expect(sqlstate(error)).toBe(NOT_FOUND);
  });

  it('a suspended organization freezes its owner to suspended_member', async () => {
    const { data } = await clientFor(frozenOwnerId)
      .schema('api')
      .rpc('my_context', { p_slug: frozenOrgSlug });
    expect((data as { role: string }[])[0]?.role).toBe('suspended_member');
  });

  it('the frozen owner can no longer invite anyone', async () => {
    const frozenOrgId = adminSql(
      `select id from public.organizations where slug = '${frozenOrgSlug}'`,
    );
    const { error } = await rpc(frozenOwnerId, 'invite_member', {
      p_org: frozenOrgId,
      p_email: 'y@itest.motion',
      p_role: 'client',
    });
    expect(error, 'suspension must remove every write').not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('nor rename the organization', async () => {
    const frozenOrgId = adminSql(
      `select id from public.organizations where slug = '${frozenOrgSlug}'`,
    );
    const { error } = await rpc(frozenOwnerId, 'update_organization', {
      p_org: frozenOrgId,
      p_patch: { name: 'renamed while frozen' },
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });
});

describe('every governed mutation leaves an audit trail (ADR-035)', () => {
  it('the role change that succeeded was recorded', async () => {
    const { error } = await rpc(ownerId, 'change_member_role', {
      p_org: orgId,
      p_user: clientId,
      p_role: 'admin',
    });
    expect(error, error?.message).toBeNull();

    const rows = adminSql(`
      select count(*) from public.audit_events
       where organization_id = '${orgId}'
         and actor_user_id = '${ownerId}'
         and action like '%role%'
    `);
    expect(Number(rows)).toBeGreaterThan(0);
  });

  it('the audit row cannot be edited afterwards, even by the owner', async () => {
    const { error } = await clientFor(ownerId)
      .from('audit_events')
      .update({ action: 'tampered' })
      .eq('organization_id', orgId);
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });
});
