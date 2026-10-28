import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { DB_REPRESENTABLE_SCENARIOS, type ResolutionScenario } from '../fixtures/resolution-scenarios';
import { clientFor, rpc } from './setup';
import { addMember, assign, dropOrg, dropPlatformUser, makeOrg, makePlatformUser } from './tenancy-fixtures';

/**
 * Resolution parity (TEST_STRATEGY.md §3, finding F-A-06).
 *
 * `resolveEffectiveRole()` (the pure TypeScript twin) and `orgRoleOf` / `accessibleOrgRoles`
 * (`src/db/app/access.ts`, the port of `app.accessible_org_roles()` that every read policy and
 * every `api.*` function consults) both decide what a caller is inside one organisation. Two
 * implementations of one rule drift apart silently, and the failure mode is a user seeing an
 * organisation they should not. So the same fixture table drives both:
 * test/unit/resolve-effective-role.test.ts asserts the pure twin, and this file replays every
 * representable row against the Firestore emulator through `api.my_context` and
 * `api.my_organizations`, as a signed-in user.
 *
 * A disagreement here is the finding. Neither side may be adjusted to make a row pass.
 */

interface Materialised {
  readonly scenario: ResolutionScenario;
  readonly userId: string;
  readonly slug: string;
}

const RUN = `p${Date.now().toString(36)}`;
const materialised: Materialised[] = [];
const orgIds: string[] = [];
const platformIds: string[] = [];
/** Organisations that deliberately do not exist, to prove a slug swap resolves to nothing. */
const MISSING_SLUG_PREFIX = `itest-${RUN}-missing-`;

const at = (minutes: number | null): string | null =>
  minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString();

/**
 * Each scenario gets its own organisation and its own user (a Firebase-style uid, not a uuid), so
 * no scenario can be contaminated by another's rows. The rows are written as the data model stores
 * them; the platform-exclusivity rule lives in the writing functions now, and the fixture table
 * already marks every combination it forbids as not representable.
 */
async function buildFixtures(): Promise<void> {
  for (const [index, scenario] of DB_REPRESENTABLE_SCENARIOS.entries()) {
    const userId = `${RUN}u${index}`;
    const slug = scenario.organizationStatus === 'missing' ? `${MISSING_SLUG_PREFIX}${index}` : `itest-${RUN}-${index}`;
    materialised.push({ scenario, userId, slug });

    if (scenario.platformUser) {
      await makePlatformUser(userId, scenario.platformUser.role, scenario.platformUser.status as 'active' /* stored as given: 'active' | 'suspended' */);
      platformIds.push(userId);
    }
    // 'missing' means the slug resolves to no organisation at all: nothing to write.
    if (scenario.organizationStatus === 'missing') continue;
    const orgId = await makeOrg({ name: `ITest Parity ${RUN} ${index}`, slug, status: scenario.organizationStatus });
    orgIds.push(orgId);
    if (scenario.membership) {
      await addMember(orgId, userId, scenario.membership.role, { status: scenario.membership.status });
    }
    if (scenario.assignment) {
      await assign(orgId, userId, {
        status: scenario.assignment.status,
        startsAt: at(scenario.assignment.startsAtMinutes),
        endsAt: at(scenario.assignment.endsAtMinutes),
      });
    }
  }
}

beforeAll(async () => {
  await buildFixtures();
}, 120_000);

afterAll(async () => {
  for (const id of orgIds) await dropOrg(id);
  for (const id of platformIds) await dropPlatformUser(id);
});

describe('the data-layer resolver and the pure resolver agree on every scenario', () => {
  it('materialised every DB-representable scenario', () => {
    expect(materialised).toHaveLength(DB_REPRESENTABLE_SCENARIOS.length);
    expect(materialised.length).toBeGreaterThan(30);
  });

  it.each(DB_REPRESENTABLE_SCENARIOS.map((s, i) => [s.id, i] as const))(
    'api.my_context resolves %s exactly as the pure resolver does',
    async (_id, index) => {
      const { scenario, userId, slug } = materialised[index]!;
      const { data, error } = await rpc(clientFor(userId), 'my_context', { p_slug: slug });
      expect(error, `${scenario.id} should resolve without error`).toBeNull();

      const row = (data as { role: string }[] | null)?.[0];
      const actual = row?.role ?? 'none';

      expect(
        actual,
        `${scenario.id} — ${scenario.description}: the data layer said "${actual}", the fixture expects "${scenario.expected}"`,
      ).toBe(scenario.expected);
    },
  );

  it('a caller with no access sees no row rather than an error (SECURITY_MODEL.md §14)', async () => {
    const denied = materialised.filter((m) => m.scenario.expected === 'none');
    expect(denied.length, 'the fixture must contain denial cases').toBeGreaterThan(0);

    for (const { scenario, userId, slug } of denied) {
      const { data, error } = await rpc(clientFor(userId), 'my_context', { p_slug: slug });
      expect(error, `${scenario.id} must not raise`).toBeNull();
      expect(data ?? [], `${scenario.id} must return no row`).toHaveLength(0);
    }
  });

  it('api.my_organizations never lists an organization my_context denies', async () => {
    for (const { scenario, userId, slug } of materialised) {
      const { data } = await rpc(clientFor(userId), 'my_organizations');
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
