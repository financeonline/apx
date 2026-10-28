import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { orgRows } from '@/db/rls';
import { newId, nowIso, orgRow } from '@/db/schema';
import { organizationDoc } from '@/modules/tenancy';
import { clientFor, createAuthUser, fs, rpc, serviceClientScoped, sqlstate } from './setup';
import { assign, dropAuditOf, dropOrg, dropUsers, makePlatformUser, rawCount, slugOf } from './tenancy-fixtures';

/**
 * The tenant-isolation cases the phase-3 exit gate names that had no test
 * (TEST_STRATEGY.md §4 cases 8, 9, 11, 13, 15).
 *
 * `rls-isolation.test.ts` covers the reads, the writes and the NOT-FOUND rule. These are the four
 * about IDENTITY CHANGING UNDER A LIVE SESSION and the two about telling a stranger nothing — the
 * cases where a system is most likely to leak by being helpful.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `i${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.isolation.itest.motion`;

let ownerA: string;
let orgA: string;
let slugA: string;
let employee: string;
let superAdmin: string;
let stranger: string;
let invitee: string;
const platformEvents: string[] = [];

beforeAll(async () => {
  ownerA = await createAuthUser(`owner-a@${DOMAIN}`);
  employee = await createAuthUser(`employee@${DOMAIN}`);
  superAdmin = await createAuthUser(`super@${DOMAIN}`);
  stranger = await createAuthUser(`stranger@${DOMAIN}`);

  const created = await rpc<string>(clientFor(ownerA), 'create_organization', { p_name: `ITest Isolation ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgA = created.data!;
  slugA = await slugOf(orgA);

  await makePlatformUser(employee, 'employee');
  await makePlatformUser(superAdmin, 'super_admin');
});

afterAll(async () => {
  if (orgA) {
    await dropAuditOf(orgA);
    await dropOrg(orgA);
  }
  for (const id of platformEvents) await fs().collection('audit_events').doc(id).delete();
  await dropUsers([ownerA, employee, superAdmin, stranger, invitee].filter(Boolean));
});

describe('case 8 — an unassigned employee sees nothing at all', () => {
  it('resolves no context for an organisation they were never assigned to', async () => {
    const e = clientFor(employee, { email: `employee@${DOMAIN}` });

    const { data: context, error } = await rpc(e, 'my_context', { p_slug: slugA });
    expect(error).toBeNull();
    expect(context, 'no assignment means no context, which the route renders as 404').toHaveLength(0);

    expect(await organizationDoc(e, orgA)).toBeNull();
  });

  it('has an empty portfolio, not an error', async () => {
    const e = clientFor(employee, { email: `employee@${DOMAIN}` });
    const { data, error } = await rpc(e, 'my_organizations');
    expect(error, 'an empty portfolio is a state, not a failure').toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});

describe('case 9 — an assignment revoked mid-session stops working on the next request', () => {
  it('sees the organisation, then does not, with no new sign-in in between', async () => {
    await assign(orgA, employee);
    // One figure the adviser can read while assigned, so "nothing afterwards" is a refusal.
    const periodId = newId();
    await orgRow(fs(), orgA, 'metric_current', `itest-${RUN}`).set({
      organization_id: orgA, period_id: periodId, metric_key: 'revenue', dimension_type: 'none',
      dimension_id: null, dimension_key: null, snapshot_id: newId(), calculation_run_id: newId(),
      previous_snapshot_id: null, updated_at: nowIso(),
    });

    // The SAME handle throughout: this is about the next request, not about a new session.
    const e = clientFor(employee, { email: `employee@${DOMAIN}` });

    const before = await rpc(e, 'my_context', { p_slug: slugA });
    expect(before.data, 'assigned: the context resolves').toHaveLength(1);
    expect(await orgRows(e, orgA, 'metric_current'), 'assigned: the figures are readable').toHaveLength(1);

    await orgRow(fs(), orgA, 'organization_assignments', employee).update({
      status: 'revoked', revoke_reason: 'itest', updated_at: nowIso(),
    });

    const after = await rpc(e, 'my_context', { p_slug: slugA });
    expect(after.error).toBeNull();
    expect(after.data, 'revoked: the very next request resolves nothing').toHaveLength(0);
    expect(await orgRows(e, orgA, 'metric_current'), 'and the data goes with it').toHaveLength(0);
  });
});

describe('case 11 — a super admin may look, and the looking is recorded', () => {
  it('resolves the context and can read the organisation', async () => {
    const s = clientFor(superAdmin, { email: `super@${DOMAIN}` });
    const { data, error } = await rpc<Array<{ role: string }>>(s, 'my_context', { p_slug: slugA });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.role).toBe('super_admin');
    expect(await organizationDoc(s, orgA)).not.toBeNull();
  });

  const viewed = async () => (await fs().collection('audit_events').where('organization_id', '==', orgA)
    .where('action', '==', 'org.data_viewed').get()).docs.map((d) => d.data());

  it('writes exactly one org.data_viewed audit row, attributed to the platform', async () => {
    const before = (await viewed()).length;
    const { error } = await rpc(serviceClientScoped(), 'record_access_event', {
      p_actor: superAdmin, p_org: orgA, p_action: 'org.data_viewed', p_target_table: null, p_target_id: null,
      p_metadata: {}, p_request_id: null,
    }, { server: true });
    expect(error).toBeNull();
    const after = await viewed();
    expect(after).toHaveLength(before + 1);
    expect(after.every((e) => e.actor_type === 'platform_admin')).toBe(true);
  });

  it('refuses the same event for somebody who is not a super admin', async () => {
    // The permission is checked against the ACTOR, not the session, so the server cannot assert it
    // on an ordinary member's behalf (ADR-043.2).
    const before = (await viewed()).length;
    const { error } = await rpc(serviceClientScoped(), 'record_access_event', {
      p_actor: ownerA, p_org: orgA, p_action: 'org.data_viewed', p_target_table: null, p_target_id: null,
      p_metadata: {}, p_request_id: null,
    }, { server: true });
    expect(sqlstate(error)).toBe('42501');
    expect(error?.message).toMatch(/super-admin event/);
    expect(await viewed()).toHaveLength(before);
  });
});

describe('case 13 — an invitation cannot be used twice', () => {
  it('the second acceptance is refused, and the membership count does not move', async () => {
    const invited = `invitee@${DOMAIN}`;
    invitee = await createAuthUser(invited);

    // `invitations` stores `token_hash` and never the token, so the raw value exists exactly once:
    // in this response. That is the property the test depends on and the reason it is stored that way.
    const sent = await rpc<Array<{ token: string }>>(clientFor(ownerA), 'invite_member_with_token', {
      p_org: orgA, p_email: invited, p_role: 'client',
    });
    expect(sent.error).toBeNull();
    const token = sent.data![0]!.token;

    const first = await rpc(clientFor(invitee, { email: invited }), 'accept_invitation', { p_token: token });
    expect(first.error, 'the first acceptance works').toBeNull();

    const members = await rawCount(orgA, 'organization_memberships');
    const second = await rpc(clientFor(invitee, { email: invited }), 'accept_invitation', { p_token: token });
    expect(second.error, 'the second is refused').not.toBeNull();
    expect(sqlstate(second.error)).toBe('P0002');
    expect(await rawCount(orgA, 'organization_memberships'), 'and nothing was added').toBe(members);
  });
});

describe('case 15 — a stranger cannot tell a real organisation from an invented one', () => {
  it('gives the same answer for an organisation that exists and one that does not', async () => {
    const s = clientFor(stranger, { email: `stranger@${DOMAIN}` });

    const real = await rpc(s, 'my_context', { p_slug: slugA });
    const invented = await rpc(s, 'my_context', { p_slug: `${slugA}-not-a-real-org` });

    expect(real.error).toBeNull();
    expect(invented.error).toBeNull();
    expect(real.data, 'a real organisation they cannot see resolves to nothing').toHaveLength(0);
    expect(invented.data, 'and so does one that does not exist').toHaveLength(0);
    expect(JSON.stringify(real.data)).toBe(JSON.stringify(invented.data));
  });

  it('answers a write attempt identically too', async () => {
    const s = clientFor(stranger, { email: `stranger@${DOMAIN}` });
    const invented = '00000000-0000-4000-8000-00000000beef';

    const real = await rpc(s, 'update_organization', { p_org: orgA, p_patch: { name: 'hijacked' } });
    const fake = await rpc(s, 'update_organization', { p_org: invented, p_patch: { name: 'hijacked' } });

    expect(sqlstate(real.error), 'NOT_FOUND, never FORBIDDEN').toBe('P0002');
    expect(sqlstate(fake.error), 'and the invented one is indistinguishable').toBe(sqlstate(real.error));
    expect(fake.error?.message).toBe(real.error?.message);
    expect((await fs().collection('organizations').doc(orgA).get()).get('name')).toBe(`ITest Isolation ${RUN}`);
  });
});

/**
 * A tenant user never reaches the platform's own trail (Phase 8 brief; SECURITY_MODEL.md §14;
 * ADR-088). `audit_events` carries both an organisation's own history and the platform's — the
 * latter with `organization_id` null. An owner holding `audit.view` for their own organisation
 * reads it through `api.org_audit_events`, which serves one organisation only.
 */
describe('a tenant user reads their own trail and none of the platform’s', () => {
  it('sees their organisation’s events, no platform events, and is refused the global search', async () => {
    const id = newId();
    platformEvents.push(id);
    await fs().collection('audit_events').doc(id).set({
      id, organization_id: null, actor_user_id: superAdmin, actor_type: 'platform_admin',
      action: 'platform.settings_changed', target_table: 'platform_settings', target_id: null, before: null,
      after: null, metadata: {}, ip: null, user_agent: null, request_id: newId(), created_at: nowIso(),
    });

    const o = clientFor(ownerA);
    const mine = await rpc<Array<{ id: string; action: string }>>(o, 'org_audit_events', { p_org: orgA, p_limit: 500 });
    expect(mine.error).toBeNull();
    expect((mine.data ?? []).length, 'an owner sees their own organisation’s trail').toBeGreaterThan(0);
    expect(mine.data!.some((e) => e.id === id), 'and nothing the platform did to itself').toBe(false);

    // The global search refuses outright rather than returning an empty list (ADR-088).
    const search = await rpc(o, 'platform_audit_events', {});
    expect(sqlstate(search.error)).toBe('42501');
  });
});
