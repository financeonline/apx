import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAccessEvent } from '@/core/db/server-rpc';
import { withOrgScope } from '@/core/db';
import {
  adminSql, clientFor, createAuthUser, serviceClientScoped, sqlstate,
} from './setup';

/**
 * The organization scope on the server path (ADR-090; PHASE_1_7_INTEGRATION_AUDIT.md H1).
 *
 * `withOrgScope` is the only thing standing between a job draining organisation A and a write that
 * names organisation B, and until this suite existed it stood there without being tested — the
 * mechanism it used (`set_config('app.current_org', …)`) had never once executed, because
 * `set_config` is not in an exposed schema and because the scope was asserted on a different client
 * from the one making every `api_server.*` call.
 *
 * What is asserted here is the property rather than the plumbing: a scoped server function acts
 * only when it has been told which organisation it is acting for, and only when that is the one it
 * is writing. Missing and wrong are both refusals, and the browser cannot supply either.
 */

const RUN = `s${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.scope.itest`;
const NOT_AN_ORG = '00000000-0000-4000-8000-0000000000ff';

let orgA: string;
let orgB: string;
let ownerA: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

beforeAll(() => {
  ownerA = createAuthUser(`owner@${DOMAIN}`);
  orgA = one(`
    insert into public.organizations (name, slug, country_code, base_currency, fiscal_year_start_month, timezone)
    values ('Scope A ${RUN}', 'scope-a-${RUN}', 'GB', 'GBP', 1, 'Europe/London') returning id::text`);
  orgB = one(`
    insert into public.organizations (name, slug, country_code, base_currency, fiscal_year_start_month, timezone)
    values ('Scope B ${RUN}', 'scope-b-${RUN}', 'GB', 'GBP', 1, 'Europe/London') returning id::text`);
  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgA}', '${ownerA}', 'owner', 'active')`);
});

afterAll(() => {
  adminSql(`delete from public.organizations where id in ('${orgA}', '${orgB}')`);
  adminSql(`delete from auth.users where email like '%@${DOMAIN}'`);
});

/** `set_period_completeness` with empty arrays writes nothing, so it isolates the guard itself. */
async function completeness(client: ReturnType<typeof serviceClientScoped>, org: string) {
  return client.schema('api_server').rpc('set_period_completeness', {
    p_org: org, p_periods: [], p_complete: [],
  });
}

describe('a scoped server function acts only on the organisation it was scoped to', () => {
  it('does the work when the scope is the organisation being written', async () => {
    const { data, error } = await completeness(serviceClientScoped(orgA), orgA);
    expect(error).toBeNull();
    expect(data).toBe(0);
  });

  it('refuses when no scope was established at all', async () => {
    const { error } = await completeness(serviceClientScoped(), orgA);
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('42501');
    expect(error?.message).toMatch(/no organization scope/i);
  });

  it('refuses when the scope names a different organisation', async () => {
    const { error } = await completeness(serviceClientScoped(orgB), orgA);
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('42501');
    expect(error?.message).toMatch(/does not match/i);
  });

  it('refuses a scope that is not a uuid rather than reading it as "no scope"', async () => {
    const { error } = await completeness(serviceClientScoped('not-a-uuid'), orgA);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/scope header is not a uuid/i);
  });

  it('refuses a scope naming an organisation that does not exist', async () => {
    const { error } = await completeness(serviceClientScoped(NOT_AN_ORG), orgA);
    expect(sqlstate(error)).toBe('42501');
  });
});

describe('the audit trail cannot cross the scope (ADR-043)', () => {
  const event = (client: ReturnType<typeof serviceClientScoped>, org: string | null) =>
    client.schema('api_server').rpc('record_access_event', {
      p_actor: ownerA, p_org: org, p_action: 'document.quarantined',
      p_target_table: null, p_target_id: null, p_metadata: {}, p_request_id: null,
    });

  it('writes the event when the organisation is the scoped one', async () => {
    const before = Number(one(
      `select count(*) from public.audit_events where organization_id = '${orgA}'`));
    const { error } = await event(serviceClientScoped(orgA), orgA);
    expect(error).toBeNull();
    expect(Number(one(
      `select count(*) from public.audit_events where organization_id = '${orgA}'`))).toBe(before + 1);
  });

  it('refuses an event for another organisation, however the caller reached it', async () => {
    const before = Number(one(
      `select count(*) from public.audit_events where organization_id = '${orgB}'`));
    const { error } = await event(serviceClientScoped(orgA), orgB);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/does not match the scoped organization/i);
    expect(Number(one(
      `select count(*) from public.audit_events where organization_id = '${orgB}'`))).toBe(before);
  });

  it('refuses a platform-level event from inside a scope', async () => {
    const { error } = await event(serviceClientScoped(orgA), null);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/does not match the scoped organization/i);
  });
});

describe('the scope is a server fact, never a browser one', () => {
  it('does not let a signed-in user reach a scoped server function, header or no header', async () => {
    const asUser = clientFor(ownerA, { email: `owner@${DOMAIN}` });
    const { error } = await asUser.schema('api_server').rpc('set_period_completeness', {
      p_org: orgA, p_periods: [], p_complete: [],
    });
    expect(error).not.toBeNull();
    // The grant stops it before any scope is consulted: `authenticated` holds no EXECUTE here.
    expect(sqlstate(error)).toBe('42501');
  });

  it('gives `authenticated` no way to read or assert a scope', () => {
    expect(one(`
      select has_function_privilege('authenticated', 'app.scope_org()', 'execute')::text
             || '|' ||
             has_function_privilege('authenticated', 'app.require_scope(uuid)', 'execute')::text`))
      .toBe('false|false');
  });
});

describe('the server paths agree with each other', () => {
  /**
   * The fix that matters. `core/db/server-rpc.ts` keeps its own client, so before ADR-090 an
   * `api_server.*` call made from inside a job carried no scope at all — even though `scope.db` had
   * one. These two assert that entering `withOrgScope` now scopes BOTH.
   */
  it('carries the scope into an api_server call made through serverRpc', async () => {
    await expect(withOrgScope(orgA, async () => {
      await recordAccessEvent(
        { userId: ownerA, requestId: `${RUN}-ok` },
        { organizationId: orgA, action: 'document.quarantined' },
      );
    })).resolves.toBeUndefined();

    expect(one(`
      select count(*) from public.audit_events
       where organization_id = '${orgA}' and request_id = '${RUN}-ok'`)).toBe('1');
  });

  it('refuses a serverRpc call that names an organisation the job is not scoped to', async () => {
    await expect(withOrgScope(orgA, async () => {
      await recordAccessEvent(
        { userId: ownerA, requestId: `${RUN}-bad` },
        { organizationId: orgB, action: 'document.quarantined' },
      );
    })).rejects.toThrow(/does not match the scoped organization/i);

    expect(one(`
      select count(*) from public.audit_events where request_id = '${RUN}-bad'`)).toBe('0');
  });

  it('leaves an unscoped server path unscoped: a page write still names its own organisation', async () => {
    await expect(recordAccessEvent(
      { userId: ownerA, requestId: `${RUN}-page` },
      { organizationId: orgA, action: 'document.quarantined' },
    )).resolves.toBeTypeOf('number');
  });
});
