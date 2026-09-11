import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { adminSql, clientFor, createAuthUser, sqlstate } from './setup';

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
const DOMAIN = `${RUN}.isolation.itest`;

let ownerA: string;
let orgA: string;
let slugA: string;
let employee: string;
let superAdmin: string;
let stranger: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

beforeAll(async () => {
  ownerA = createAuthUser(`owner-a@${DOMAIN}`);
  employee = createAuthUser(`employee@${DOMAIN}`);
  superAdmin = createAuthUser(`super@${DOMAIN}`);
  stranger = createAuthUser(`stranger@${DOMAIN}`);

  const created = await clientFor(ownerA).schema('api').rpc('create_organization', {
    p_name: `ITest Isolation ${RUN}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgA = created.data as unknown as string;
  slugA = one(`select slug from public.organizations where id = '${orgA}'`);

  adminSql(`insert into public.platform_users (user_id, platform_role) values ('${employee}','employee')`);
  adminSql(`insert into public.platform_users (user_id, platform_role) values ('${superAdmin}','super_admin')`);
  /*
   * `app.actor_has_aal2` reads `profiles.mfa_enrolled_at`, not the session's `aal` claim — the
   * server-asserted path has no session to read (ADR-043.2, ADR-044.1). Platform staff therefore
   * need an enrolled factor before any of their access resolves at all.
   */
  adminSql(`
    update public.profiles set mfa_enrolled_at = now()
     where id in ('${employee}', '${superAdmin}')`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Isolation%${RUN}';
    delete from public.platform_users where user_id in
      (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Isolation %' and created_at < now() - interval '1 hour';`);
});

describe('case 8 — an unassigned employee sees nothing at all', () => {
  it('resolves no context for an organisation they were never assigned to', async () => {
    const e = clientFor(employee, { aal: 'aal2', email: `employee@${DOMAIN}` });

    const { data: context, error } = await e.schema('api').rpc('my_context', { p_slug: slugA });
    expect(error).toBeNull();
    expect(context, 'no assignment means no context, which the route renders as 404').toHaveLength(0);

    const { data: orgs } = await e.from('organizations').select('id').eq('id', orgA);
    expect(orgs ?? []).toHaveLength(0);
  });

  it('has an empty portfolio, not an error', async () => {
    const e = clientFor(employee, { aal: 'aal2', email: `employee@${DOMAIN}` });
    const { data, error } = await e.schema('api').rpc('my_organizations');
    expect(error, 'an empty portfolio is a state, not a failure').toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});

describe('case 9 — an assignment revoked mid-session stops working on the next request', () => {
  it('sees the organisation, then does not, with no new sign-in in between', async () => {
    adminSql(`
      insert into public.organization_assignments (organization_id, employee_user_id)
      values ('${orgA}', '${employee}')`);

    // The SAME token throughout: this is about the next request, not about a new session.
    const e = clientFor(employee, { aal: 'aal2', email: `employee@${DOMAIN}` });

    const before = await e.schema('api').rpc('my_context', { p_slug: slugA });
    expect(before.data, 'assigned: the context resolves').toHaveLength(1);

    adminSql(`
      update public.organization_assignments
         set status = 'revoked', revoked_reason = 'itest'
       where organization_id = '${orgA}' and employee_user_id = '${employee}'`);

    const after = await e.schema('api').rpc('my_context', { p_slug: slugA });
    expect(after.error).toBeNull();
    expect(after.data, 'revoked: the very next request resolves nothing').toHaveLength(0);

    const { data: rows } = await e.from('metric_current').select('period_id').eq('organization_id', orgA);
    expect(rows ?? [], 'and the data goes with it').toHaveLength(0);
  });
});

describe('case 11 — a super admin may look, and the looking is recorded', () => {
  it('resolves the context and can read the organisation', async () => {
    const s = clientFor(superAdmin, { aal: 'aal2', email: `super@${DOMAIN}` });
    const { data, error } = await s.schema('api').rpc('my_context', { p_slug: slugA });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data as Array<{ role: string }>)[0]!.role).toBe('super_admin');
  });

  it('writes exactly one org.data_viewed audit row, attributed to the platform', async () => {
    const before = Number(one(`
      select count(*) from public.audit_events
       where organization_id = '${orgA}' and action = 'org.data_viewed'`));

    adminSql(`
      select set_config('request.jwt.claims', '{"role":"service_role"}', false);
      select api_server.record_access_event(
        '${superAdmin}', '${orgA}', 'org.data_viewed', null, null, '{}'::jsonb, null)`);

    const rows = one(`
      select count(*)::text || '|' || max(actor_type::text)
        from public.audit_events
       where organization_id = '${orgA}' and action = 'org.data_viewed'`);
    expect(rows).toBe(`${before + 1}|platform_admin`);
  });

  it('refuses the same event for somebody who is not a super admin', async () => {
    // The permission is checked against the ACTOR, not the session, so a service-role caller
    // cannot assert it on an ordinary member's behalf (ADR-043.2).
    expect(() => adminSql(`
      select set_config('request.jwt.claims', '{"role":"service_role"}', false);
      select api_server.record_access_event(
        '${ownerA}', '${orgA}', 'org.data_viewed', null, null, '{}'::jsonb, null)`))
      .toThrow(/PERMISSION_DENIED/);
  });
});

describe('case 13 — an invitation cannot be used twice', () => {
  it('the second acceptance is refused, and the membership count does not move', async () => {
    const invited = `invitee@${DOMAIN}`;
    const invitee = createAuthUser(invited);

    // `invitations` stores `token_hash` and never the token, so the raw value exists exactly once:
    // in this response. That is the property the test depends on and the reason it is stored that way.
    const sent = await clientFor(ownerA).schema('api').rpc('invite_member_with_token', {
      p_org: orgA, p_email: invited, p_role: 'client',
    });
    expect(sent.error).toBeNull();
    const token = (sent.data as Array<{ token: string }>)[0]!.token;

    const first = await clientFor(invitee, { email: invited }).schema('api')
      .rpc('accept_invitation', { p_token: token });
    expect(first.error, 'the first acceptance works').toBeNull();

    const members = one(`
      select count(*)::text from public.organization_memberships
       where organization_id = '${orgA}'`);

    const second = await clientFor(invitee, { email: invited }).schema('api')
      .rpc('accept_invitation', { p_token: token });
    expect(second.error, 'the second is refused').not.toBeNull();

    expect(one(`
      select count(*)::text from public.organization_memberships
       where organization_id = '${orgA}'`), 'and nothing was added').toBe(members);
  });
});

describe('case 15 — a stranger cannot tell a real organisation from an invented one', () => {
  it('gives the same answer for an organisation that exists and one that does not', async () => {
    const s = clientFor(stranger, { email: `stranger@${DOMAIN}` });

    const real = await s.schema('api').rpc('my_context', { p_slug: slugA });
    const invented = await s.schema('api').rpc('my_context', { p_slug: `${slugA}-not-a-real-org` });

    expect(real.error).toBeNull();
    expect(invented.error).toBeNull();
    expect(real.data, 'a real organisation they cannot see resolves to nothing').toHaveLength(0);
    expect(invented.data, 'and so does one that does not exist').toHaveLength(0);
    // Identical shape AND identical error: the two are indistinguishable to the caller.
    expect(JSON.stringify(real.data)).toBe(JSON.stringify(invented.data));
  });

  it('answers a write attempt identically too', async () => {
    const s = clientFor(stranger, { email: `stranger@${DOMAIN}` });
    const invented = '00000000-0000-4000-8000-00000000beef';

    const real = await s.schema('api').rpc('update_organization', {
      p_org: orgA, p_patch: { name: 'hijacked' },
    });
    const fake = await s.schema('api').rpc('update_organization', {
      p_org: invented, p_patch: { name: 'hijacked' },
    });

    expect(sqlstate(real.error), 'NOT_FOUND, never FORBIDDEN').toBe('P0002');
    expect(sqlstate(fake.error), 'and the invented one is indistinguishable')
      .toBe(sqlstate(real.error));
    expect(one(`select name from public.organizations where id = '${orgA}'`))
      .toBe(`ITest Isolation ${RUN}`);
  });
});

/**
 * A tenant user never reaches the platform's own trail (Phase 8 brief; SECURITY_MODEL.md §14;
 * ADR-088).
 *
 * `audit_events` carries both an organisation's own history and the platform's — the latter with
 * `organization_id IS NULL`. One policy separates them, and an owner holding `audit.view` for their
 * own organisation must not cross it. Asserted here because the two live in one table: a policy
 * rewritten later could widen the tenant's half without anyone noticing.
 */
describe('a tenant user reads their own trail and none of the platform’s', () => {
  it('sees their organisation’s events, no platform events, and is refused the global search', async () => {
    adminSql(`
      insert into public.audit_events (organization_id, actor_user_id, actor_type, action, target_table)
      values (null, '${superAdmin}', 'platform_admin', 'platform.settings_changed', 'platform_settings')`);

    const o = clientFor(ownerA);
    const mine = await o.from('audit_events').select('id').eq('organization_id', orgA);
    expect(mine.error).toBeNull();
    expect((mine.data ?? []).length, 'an owner sees their own organisation’s trail').toBeGreaterThan(0);

    const platform = await o.from('audit_events').select('id').is('organization_id', null);
    expect(platform.error).toBeNull();
    expect(platform.data ?? [], 'and nothing the platform did to itself').toHaveLength(0);

    // The global search refuses outright rather than returning an empty list (ADR-088).
    const search = await o.schema('api').rpc('platform_audit_events', {});
    expect(sqlstate(search.error)).toBe('42501');
  });
});
