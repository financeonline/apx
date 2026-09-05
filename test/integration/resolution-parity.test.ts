import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { DB_REPRESENTABLE_SCENARIOS, type ResolutionScenario } from '../fixtures/resolution-scenarios';
import { adminSql, clientFor, resetFixtures } from './setup';

/**
 * Resolution parity (TEST_STRATEGY.md §3, finding F-A-06).
 *
 * `resolveEffectiveRole()` in TypeScript and `app.accessible_org_roles()` in SQL both decide what a
 * caller is inside one organization. Two implementations of one rule drift apart silently, and the
 * failure mode is a user seeing an organization they should not. So the same fixture table drives
 * both: test/unit/resolve-effective-role.test.ts asserts the TypeScript twin, and this file replays
 * every DB-representable row against the real database through a real user JWT.
 *
 * A disagreement here is the finding. Neither side may be adjusted to make a row pass.
 */

interface Materialised {
  readonly scenario: ResolutionScenario;
  readonly userId: string;
  readonly slug: string;
}

const materialised: Materialised[] = [];
/** Organizations that deliberately do not exist, to prove a slug swap resolves to nothing. */
const MISSING_SLUG_PREFIX = 'itest-parity-missing-';

const sqlTimestamp = (minutes: number | null): string =>
  minutes === null ? 'null' : `now() + interval '${minutes} minutes'`;

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Build every scenario in ONE round trip. Each gets its own organization and its own user, so no
 * scenario can be contaminated by another's rows.
 */
function buildFixtures(): void {
  const statements: string[] = [];

  DB_REPRESENTABLE_SCENARIOS.forEach((scenario, index) => {
    const userId = uuid();
    const orgId = uuid();
    const slug =
      scenario.organizationStatus === 'missing'
        ? `${MISSING_SLUG_PREFIX}${index}`
        : `itest-parity-${index}`;

    materialised.push({ scenario, userId, slug });

    statements.push(`
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, created_at, updated_at)
      values ('${userId}','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
              'parity-${index}@itest.motion','x', now(), now(), now());
    `);

    // 'missing' means the slug resolves to no organization at all: nothing to insert.
    if (scenario.organizationStatus !== 'missing') {
      statements.push(`
        insert into public.organizations (id, slug, name, status)
        values ('${orgId}', '${slug}', 'ITest Parity ${index}', '${scenario.organizationStatus}');
      `);
    }

    if (scenario.platformUser) {
      statements.push(`
        insert into public.platform_users (user_id, platform_role, status)
        values ('${userId}', '${scenario.platformUser.role}', '${scenario.platformUser.status}');
      `);
    }

    if (scenario.membership && scenario.organizationStatus !== 'missing') {
      statements.push(`
        insert into public.organization_memberships (organization_id, user_id, role, status)
        values ('${orgId}', '${userId}', '${scenario.membership.role}', '${scenario.membership.status}');
      `);
    }

    if (scenario.assignment && scenario.organizationStatus !== 'missing') {
      statements.push(`
        insert into public.organization_assignments
               (organization_id, employee_user_id, status, starts_at, ends_at)
        values ('${orgId}', '${userId}', '${scenario.assignment.status}',
                ${sqlTimestamp(scenario.assignment.startsAtMinutes)},
                ${sqlTimestamp(scenario.assignment.endsAtMinutes)});
      `);
    }
  });

  // The membership and assignment triggers are the contract too: if one of these inserts is
  // refused, the fixture claims something the database forbids and the suite must fail loudly
  // rather than silently testing fewer rows.
  adminSql(`set local app.bootstrap = 'on'; ${statements.join('\n')}`);
}

beforeAll(() => {
  resetFixtures();
  buildFixtures();
});

afterAll(() => {
  resetFixtures();
});

describe('the SQL resolver and the TypeScript resolver agree on every scenario', () => {
  it('materialised every DB-representable scenario', () => {
    expect(materialised).toHaveLength(DB_REPRESENTABLE_SCENARIOS.length);
    expect(materialised.length).toBeGreaterThan(30);
  });

  it.each(DB_REPRESENTABLE_SCENARIOS.map((s, i) => [s.id, i] as const))(
    'api.my_context resolves %s exactly as the pure resolver does',
    async (_id, index) => {
      const { scenario, userId, slug } = materialised[index]!;
      const client = clientFor(userId, { aal: scenario.aal });

      const { data, error } = await client.schema('api').rpc('my_context', { p_slug: slug });
      expect(error, `${scenario.id} should resolve without error`).toBeNull();

      const row = (data as { role: string }[] | null)?.[0];
      const actual = row?.role ?? 'none';

      expect(
        actual,
        `${scenario.id} — ${scenario.description}: SQL said "${actual}", the fixture expects "${scenario.expected}"`,
      ).toBe(scenario.expected);
    },
  );

  it('a caller with no access sees no row rather than an error (SECURITY_MODEL.md §14)', async () => {
    const denied = materialised.filter((m) => m.scenario.expected === 'none');
    expect(denied.length, 'the fixture must contain denial cases').toBeGreaterThan(0);

    for (const { scenario, userId, slug } of denied) {
      const client = clientFor(userId, { aal: scenario.aal });
      const { data, error } = await client.schema('api').rpc('my_context', { p_slug: slug });
      expect(error, `${scenario.id} must not raise`).toBeNull();
      expect(data ?? [], `${scenario.id} must return no row`).toHaveLength(0);
    }
  });

  it('api.my_organizations never lists an organization my_context denies', async () => {
    for (const { scenario, userId, slug } of materialised) {
      const client = clientFor(userId, { aal: scenario.aal });
      const { data } = await client.schema('api').rpc('my_organizations');
      const listed = (data as { slug: string; role: string }[] | null) ?? [];
      const match = listed.find((o) => o.slug === slug);

      if (scenario.expected === 'none') {
        expect(match, `${scenario.id} must not appear in the switcher`).toBeUndefined();
      } else {
        expect(match?.role, `${scenario.id} must be listed with the same role`).toBe(
          scenario.expected,
        );
      }
    }
  });
});
