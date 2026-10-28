import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { auth } from '@/db/firestore';
import { globalRow } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc as call, sqlstate } from './setup';
import { addMember, dropOrg, slugOf } from './tenancy-fixtures';

/**
 * Governance over the path production uses (RBAC_MATRIX.md §4–§6, SECURITY_MODEL.md §14,
 * TEST_STRATEGY.md §4): a signed-in person's handle, through the `api.*` surface, and nothing more.
 *
 * Every refusal is asserted on its code (the old SQLSTATE, through `sqlstate`), not its message. A
 * check violation and a unique violation are both CONFLICT now, so both read `23505`.
 */

const PERMISSION_DENIED = '42501';
const NOT_FOUND = 'P0002';
const CONFLICT = '23505';

const RUN = `g${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.governance.itest.motion`;
const mail = (who: string) => `${who}@${DOMAIN}`;

let ownerId: string;
let adminId: string;
let clientId: string;
let outsiderId: string;
let orgId: string;
const orgs: string[] = [];
const users: string[] = [];

const rpc = (userId: string, fn: string, args: Record<string, unknown> = {}, jwt: { email?: string } = {}) =>
  call(clientFor(userId, jwt), fn, args);

async function user(who: string): Promise<string> {
  const id = await createAuthUser(mail(who));
  users.push(id);
  return id;
}

beforeAll(async () => {
  ownerId = await user('owner');
  adminId = await user('admin');
  clientId = await user('client');
  outsiderId = await user('outsider');

  // The organisation is created through the real api surface: the owner must come out of it.
  const { data, error } = await rpc(ownerId, 'create_organization', { p_name: `ITest Governance ${RUN}` });
  if (error) throw new Error(`fixture organization could not be created: ${error.message}`);
  orgId = data as string;
  orgs.push(orgId);

  // Seeded directly, so a test is not dependent on the invitation flow it does not exercise.
  await addMember(orgId, adminId, 'admin');
  await addMember(orgId, clientId, 'client');
});

afterAll(async () => {
  for (const id of orgs) await dropOrg(id);
  for (const id of users) {
    await auth().deleteUser(id).catch(() => undefined);
    await fs().collection('profiles').doc(id).delete();
  }
  for (const doc of (await fs().collection('api_rate_limits').get()).docs) {
    if (users.includes(String(doc.get('actor_user_id')))) await doc.ref.delete();
  }
});

describe('creating an organization', () => {
  it('makes the creator its owner, through api.my_organizations', async () => {
    const { data } = await rpc(ownerId, 'my_organizations');
    const rows = (data as { organization_id: string; role: string }[] | null) ?? [];
    expect(rows.find((r) => r.organization_id === orgId)?.role).toBe('owner');
  });

  it('seeds the standard chart and two years of months', async () => {
    const accounts = await fs().collection('organizations').doc(orgId).collection('accounts').count().get();
    const periods = await fs().collection('organizations').doc(orgId).collection('fiscal_periods').count().get();
    expect(accounts.data().count).toBe(26);
    expect(periods.data().count).toBe(24);
  });

  it('rate-limits repeated creation (ADR-044.5)', async () => {
    // The quota is 3 a day and one is already spent by the fixture.
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await rpc(ownerId, 'create_organization', { p_name: `ITest Governance Flood ${RUN} ${i}` });
      if (r.data) orgs.push(r.data as string);
      results.push(r);
    }
    const refused = results.filter((r) => r.error !== null);
    expect(refused.length, 'the throttle must refuse at least one attempt').toBeGreaterThan(0);
    expect(sqlstate(refused.at(-1)!.error)).toBe('53400');
  });
});

describe('role ceilings (RBAC_MATRIX.md §5)', () => {
  it('an admin cannot invite an owner', async () => {
    const { error } = await rpc(adminId, 'invite_member', { p_org: orgId, p_email: mail('nope'), p_role: 'owner' });
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('an owner may invite an admin', async () => {
    const { error } = await rpc(ownerId, 'invite_member', { p_org: orgId, p_email: mail('newadmin'), p_role: 'admin' });
    expect(error, error?.message).toBeNull();
  });

  it('a second pending invitation for the same address is a conflict', async () => {
    const { error } = await rpc(ownerId, 'invite_member', { p_org: orgId, p_email: mail('newadmin'), p_role: 'admin' });
    expect(sqlstate(error)).toBe(CONFLICT);
  });

  it('a client cannot invite anybody at all', async () => {
    const { error } = await rpc(clientId, 'invite_member', { p_org: orgId, p_email: mail('nope2'), p_role: 'client' });
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('an admin cannot promote themselves to owner (self-elevation)', async () => {
    const { error } = await rpc(adminId, 'change_member_role', { p_org: orgId, p_user: adminId, p_role: 'owner' });
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('an admin cannot demote an owner', async () => {
    const { error } = await rpc(adminId, 'change_member_role', { p_org: orgId, p_user: ownerId, p_role: 'client' });
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });
});

describe('the last owner cannot disappear (ADR-030)', () => {
  it('the sole owner cannot leave', async () => {
    const { error } = await rpc(ownerId, 'leave_organization', { p_org: orgId });
    expect(sqlstate(error)).toBe(CONFLICT);
  });

  // Nobody changes their OWN role (ADR-172 hardening), so the refusal comes before the last-owner
  // guard is reached: PERMISSION_DENIED rather than CONFLICT.
  it('the sole owner cannot demote themselves', async () => {
    const { error } = await rpc(ownerId, 'change_member_role', { p_org: orgId, p_user: ownerId, p_role: 'admin' });
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('nor be switched off', async () => {
    // The owner may not switch their own access off and leave the organisation with no owner.
    const { error } = await rpc(ownerId, 'set_member_status', { p_org: orgId, p_user: ownerId, p_status: 'suspended' });
    expect(sqlstate(error)).toBe(CONFLICT);
  });

  it('the organization still has exactly one active owner afterwards', async () => {
    const owners = await fs().collection('organizations').doc(orgId).collection('organization_memberships')
      .where('role', '==', 'owner').where('status', '==', 'active').get();
    expect(owners.size).toBe(1);
  });
});

describe('a member of another organization is told NOT FOUND, never FORBIDDEN', () => {
  it('an outsider governing the organization gets P0002', async () => {
    const { error } = await rpc(outsiderId, 'change_member_role', { p_org: orgId, p_user: clientId, p_role: 'admin' });
    expect(sqlstate(error), 'a 42501 here would confirm the organization exists to a stranger').toBe(NOT_FOUND);
  });

  it('an outsider updating the organization gets P0002', async () => {
    const { error } = await rpc(outsiderId, 'update_organization', { p_org: orgId, p_patch: { name: 'stolen' } });
    expect(sqlstate(error)).toBe(NOT_FOUND);
  });

  it('and the organization name is unchanged', async () => {
    expect((await globalRow(fs(), 'organizations', orgId).get()).get('name')).toBe(`ITest Governance ${RUN}`);
  });
});

describe('an invitation is bound to the address it was sent to (ADR-031)', () => {
  let token: string;

  beforeAll(async () => {
    const { data, error } = await rpc(ownerId, 'invite_member_with_token', {
      p_org: orgId, p_email: mail('invited'), p_role: 'client',
    });
    if (error) throw new Error(`invitation fixture failed: ${error.message}`);
    token = (data as { token: string }[])[0]!.token;
  });

  it('a different signed-in address cannot redeem it', async () => {
    const wrongPerson = await user('wrong');
    const { error } = await rpc(wrongPerson, 'accept_invitation', { p_token: token }, { email: mail('wrong') });
    expect(error, 'an unbound invitation is an account-takeover primitive').not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('a forged token is simply not found', async () => {
    const { error } = await rpc(outsiderId, 'accept_invitation', { p_token: 'not-a-real-token' }, { email: mail('outsider') });
    expect(sqlstate(error)).toBe(NOT_FOUND);
  });

  it('the invited address can redeem it exactly once', async () => {
    const invitee = await user('invited');
    const asInvitee = { email: mail('invited') };
    const first = await rpc(invitee, 'accept_invitation', { p_token: token }, asInvitee);
    expect(first.error, first.error?.message).toBeNull();
    expect(first.data).toBe(orgId);

    const second = await rpc(invitee, 'accept_invitation', { p_token: token }, asInvitee);
    expect(second.error, 'a redeemed invitation must not be replayable').not.toBeNull();
  });
});

describe('the two suspensions are different things (RBAC_MATRIX.md §7)', () => {
  let suspendedMemberId: string;
  let frozenOwnerId: string;
  let frozenOrgId: string;
  let frozenOrgSlug: string;

  beforeAll(async () => {
    // (a) A suspended MEMBERSHIP resolves to nothing at all — indistinguishable from a stranger.
    suspendedMemberId = await user('suspended');
    await addMember(orgId, suspendedMemberId, 'admin');
    const { error } = await rpc(ownerId, 'set_member_status', {
      p_org: orgId, p_user: suspendedMemberId, p_status: 'suspended',
    });
    if (error) throw new Error(`suspension fixture failed: ${error.message}`);

    // (b) A suspended ORGANIZATION freezes each member to `suspended_member`.
    frozenOwnerId = await user('frozen');
    const created = await rpc(frozenOwnerId, 'create_organization', { p_name: `ITest Governance Frozen ${RUN}` });
    if (created.error) throw new Error(`frozen fixture failed: ${created.error.message}`);
    frozenOrgId = created.data as string;
    orgs.push(frozenOrgId);
    await globalRow(fs(), 'organizations', frozenOrgId).update({ status: 'suspended' });
    frozenOrgSlug = await slugOf(frozenOrgId);
  });

  it('a suspended membership resolves to no access whatsoever', async () => {
    const { data, error } = await rpc(suspendedMemberId, 'my_context', { p_slug: await slugOf(orgId) });
    expect(error).toBeNull();
    expect(data ?? [], 'a suspended member is not a suspended_member — they are none').toHaveLength(0);
  });

  it('and their governance calls are NOT FOUND, like any stranger', async () => {
    const { error } = await rpc(suspendedMemberId, 'invite_member', { p_org: orgId, p_email: mail('x'), p_role: 'client' });
    expect(sqlstate(error)).toBe(NOT_FOUND);
  });

  it('a suspended organization freezes its owner to suspended_member', async () => {
    const { data } = await rpc(frozenOwnerId, 'my_context', { p_slug: frozenOrgSlug });
    expect((data as { role: string }[])[0]?.role).toBe('suspended_member');
  });

  it('the frozen owner can no longer invite anyone', async () => {
    const { error } = await rpc(frozenOwnerId, 'invite_member', { p_org: frozenOrgId, p_email: mail('y'), p_role: 'client' });
    expect(error, 'suspension must remove every write').not.toBeNull();
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });

  it('nor rename the organization', async () => {
    const { error } = await rpc(frozenOwnerId, 'update_organization', { p_org: frozenOrgId, p_patch: { name: 'renamed while frozen' } });
    expect(sqlstate(error)).toBe(PERMISSION_DENIED);
  });
});

describe('every governed mutation leaves an audit trail (ADR-035)', () => {
  it('the role change that succeeded was recorded', async () => {
    const { error } = await rpc(ownerId, 'change_member_role', { p_org: orgId, p_user: clientId, p_role: 'admin' });
    expect(error, error?.message).toBeNull();

    const rows = await fs().collection('audit_events').where('organization_id', '==', orgId)
      .where('actor_user_id', '==', ownerId).get();
    const actions = rows.docs.map((d) => String(d.get('action')));
    expect(actions).toContain('member.role_changed');
    expect(actions).toContain('db.organization_memberships.update');
  });

  it('the log reads back through api.org_audit_events, newest first, with uuid ids', async () => {
    const { data, error } = await rpc(ownerId, 'org_audit_events', { p_org: orgId, p_limit: 5 });
    expect(error, error?.message).toBeNull();
    const rows = data as Array<{ id: string; created_at: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    const times = rows.map((r) => r.created_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  // The audit log has no update path at all: no `api.*` function edits an event, and the browser
  // cannot reach Firestore (firebase/firestore.rules deny everything). The PostgreSQL assertion that
  // an UPDATE from the user's token was refused (42501) has no Firestore equivalent to exercise.
});
