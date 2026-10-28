import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAccessEvent } from '@/core/db/server-rpc';
import { withOrgScope } from '@/core/db';
import { clientFor, createAuthUser, fs, rpc, serviceClientScoped, sqlstate } from './setup';
import { addMember, dropAuditOf, dropOrg, dropUsers, makeOrg } from './tenancy-fixtures';

/**
 * The organization scope on the server path (ADR-090; PHASE_1_7_INTEGRATION_AUDIT.md H1).
 *
 * `withOrgScope` is the only thing standing between a job draining organisation A and a write that
 * names organisation B. On Firestore the scope is the service actor's `scope`
 * (`src/core/db/service-client.ts`), carried ambiently to every `api_server.*` call made underneath,
 * and checked by `requireScope` and `prepareAudit` (`src/db/app/scope.ts`, `audit.ts`).
 *
 * What is asserted here is the property rather than the plumbing: a scoped server function acts
 * only when it has been told which organisation it is acting for, and only when that is the one it
 * is writing. Missing and wrong are both refusals, and the browser cannot supply either.
 */

const RUN = `s${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.scope.itest.motion`;
const NOT_AN_ORG = '00000000-0000-4000-8000-0000000000ff';

let orgA: string;
let orgB: string;
let ownerA: string;

beforeAll(async () => {
  ownerA = await createAuthUser(`owner@${DOMAIN}`);
  orgA = await makeOrg({ name: `ITest Scope A ${RUN}`, slug: `itest-${RUN}-scope-a` });
  orgB = await makeOrg({ name: `ITest Scope B ${RUN}`, slug: `itest-${RUN}-scope-b` });
  await addMember(orgA, ownerA, 'owner');
});

afterAll(async () => {
  for (const org of [orgA, orgB]) {
    if (!org) continue;
    await dropAuditOf(org);
    await dropOrg(org);
  }
  await dropUsers([ownerA].filter(Boolean));
});

/** `set_period_completeness` with empty arrays writes nothing, so it isolates the guard itself. */
async function completeness(client: ReturnType<typeof serviceClientScoped>, org: string) {
  return rpc(client, 'set_period_completeness', { p_org: org, p_periods: [], p_complete: [] }, { server: true });
}

const auditCount = async (field: string, value: string) =>
  (await fs().collection('audit_events').where(field, '==', value).count().get()).data().count;

describe('a scoped server function acts only on the organisation it was scoped to', () => {
  it('does the work when the scope is the organisation being written', async () => {
    const { data, error } = await completeness(serviceClientScoped(orgA), orgA);
    expect(error).toBeNull();
    expect(data).toBe(0);
  });

  it('refuses when no scope was established at all', async () => {
    const { error } = await completeness(serviceClientScoped(), orgA);
    expect(sqlstate(error)).toBe('42501');
    expect(error?.message).toMatch(/no organization scope/i);
  });

  it('refuses when the scope names a different organisation', async () => {
    const { error } = await completeness(serviceClientScoped(orgB), orgA);
    expect(sqlstate(error)).toBe('42501');
    expect(error?.message).toMatch(/does not match/i);
  });

  // PostgreSQL read the scope from a header and had to refuse one that was not a uuid; here it is a
  // typed field, and anything but the organisation being written is simply a mismatch.
  it('refuses a scope that is not an organisation id rather than reading it as "no scope"', async () => {
    const { error } = await completeness(serviceClientScoped('not-a-uuid'), orgA);
    expect(sqlstate(error)).toBe('42501');
    expect(error?.message).toMatch(/does not match/i);
  });

  it('refuses a scope naming an organisation that does not exist', async () => {
    const { error } = await completeness(serviceClientScoped(NOT_AN_ORG), orgA);
    expect(sqlstate(error)).toBe('42501');
  });
});

describe('the audit trail cannot cross the scope (ADR-043)', () => {
  const event = (client: ReturnType<typeof serviceClientScoped>, org: string | null) =>
    rpc(client, 'record_access_event', {
      p_actor: ownerA, p_org: org, p_action: 'document.quarantined',
      p_target_table: null, p_target_id: null, p_metadata: {}, p_request_id: null,
    }, { server: true });

  it('writes the event when the organisation is the scoped one', async () => {
    const before = await auditCount('organization_id', orgA);
    const { error } = await event(serviceClientScoped(orgA), orgA);
    expect(error).toBeNull();
    expect(await auditCount('organization_id', orgA)).toBe(before + 1);
  });

  it('refuses an event for another organisation, however the caller reached it', async () => {
    const before = await auditCount('organization_id', orgB);
    const { error } = await event(serviceClientScoped(orgA), orgB);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/does not match the scoped organization/i);
    expect(await auditCount('organization_id', orgB)).toBe(before);
  });

  it('refuses a platform-level event from inside a scope', async () => {
    const { error } = await event(serviceClientScoped(orgA), null);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/does not match the scoped organization/i);
  });
});

describe('the scope is a server fact, never a browser one', () => {
  it('does not let a signed-in user reach a scoped server function', async () => {
    const asUser = clientFor(ownerA, { email: `owner@${DOMAIN}` });
    const { error } = await rpc(asUser, 'set_period_completeness', {
      p_org: orgA, p_periods: [], p_complete: [],
    }, { server: true });
    expect(error).not.toBeNull();
    // `requireServer` stops it before any scope is consulted.
    expect(sqlstate(error)).toBe('42501');
    expect(error?.message).toMatch(/only by the server/i);
  });
});

describe('the server paths agree with each other', () => {
  /**
   * Entering `withOrgScope` scopes BOTH the handle it passes and every `api_server.*` call made
   * through `core/db/server-rpc.ts` underneath (the ambient scope, ADR-090).
   */
  it('carries the scope into an api_server call made through serverRpc', async () => {
    await expect(withOrgScope(orgA, async () => {
      await recordAccessEvent(
        { userId: ownerA, requestId: `${RUN}-ok` },
        { organizationId: orgA, action: 'document.quarantined' },
      );
    })).resolves.toBeUndefined();
    expect(await auditCount('request_id', `${RUN}-ok`)).toBe(1);
  });

  it('refuses a serverRpc call that names an organisation the job is not scoped to', async () => {
    await expect(withOrgScope(orgA, async () => {
      await recordAccessEvent(
        { userId: ownerA, requestId: `${RUN}-bad` },
        { organizationId: orgB, action: 'document.quarantined' },
      );
    })).rejects.toThrow(/does not match the scoped organization/i);
    expect(await auditCount('request_id', `${RUN}-bad`)).toBe(0);
  });

  it('leaves an unscoped server path unscoped: a page write still names its own organisation', async () => {
    // The audit id is a uuid string now (it was a bigint identity).
    await expect(recordAccessEvent(
      { userId: ownerA, requestId: `${RUN}-page` },
      { organizationId: orgA, action: 'document.quarantined' },
    )).resolves.toBeTypeOf('string');
  });
});
