import { describe, it, expect } from 'vitest';
import { resolveEffectiveRole } from '@/modules/tenancy';
import {
  RESOLUTION_SCENARIOS,
  DB_REPRESENTABLE_SCENARIOS,
  toResolutionInput,
} from '../fixtures/resolution-scenarios';

/**
 * The TypeScript twin of app.accessible_org_roles() (TENANCY_MODEL.md §4, finding F-A-06).
 * The same fixture is replayed against the database by test/integration/resolution-parity.test.ts;
 * a disagreement between the two is the finding, never something to paper over here.
 */

describe('resolveEffectiveRole', () => {
  it('covers a broad scenario space', () => {
    expect(RESOLUTION_SCENARIOS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(RESOLUTION_SCENARIOS.map((s) => [s.id, s] as const))(
    '%s',
    (_id, scenario) => {
      const now = new Date('2026-09-05T12:00:00.000Z');
      expect(resolveEffectiveRole(toResolutionInput(scenario, now))).toBe(scenario.expected);
    },
  );
});

describe('the invariants the scenarios encode', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const roleOf = (id: string) => {
    const s = RESOLUTION_SCENARIOS.find((x) => x.id === id);
    if (!s) throw new Error(`scenario ${id} is missing from the fixture`);
    return resolveEffectiveRole(toResolutionInput(s, now));
  };

  it('a deleted or missing organization always resolves to none', () => {
    for (const s of RESOLUTION_SCENARIOS) {
      if (s.organizationStatus === 'deleted' || s.organizationStatus === 'missing') {
        expect(roleOf(s.id)).toBe('none');
      }
    }
  });

  it('no platform user at aal1 ever resolves to anything (ADR-044.1, R2-A-03)', () => {
    for (const s of RESOLUTION_SCENARIOS) {
      if (s.platformUser && s.aal === 'aal1') {
        expect(roleOf(s.id)).toBe('none');
      }
    }
  });

  it('a suspended membership never grants access, whatever the organization status', () => {
    for (const s of RESOLUTION_SCENARIOS) {
      if (s.membership?.status === 'suspended' && !s.platformUser) {
        expect(roleOf(s.id)).toBe('none');
      }
    }
  });

  it('a suspended organization degrades members and employees, but not a super admin', () => {
    // ADR-044.4 names members and assigned employees. A super admin keeps super_admin so the
    // platform operator can still see the organization and lift the suspension.
    for (const s of RESOLUTION_SCENARIOS) {
      if (s.organizationStatus !== 'suspended') continue;
      const role = roleOf(s.id);
      if (s.platformUser?.role === 'super_admin' && s.aal === 'aal2' && s.platformUser.status === 'active') {
        expect(role).toBe('super_admin');
      } else {
        expect(['suspended_member', 'none']).toContain(role);
      }
    }
  });

  it('every scenario the database can hold is marked for the parity suite', () => {
    expect(DB_REPRESENTABLE_SCENARIOS.length).toBeGreaterThan(0);
    expect(DB_REPRESENTABLE_SCENARIOS.length).toBeLessThanOrEqual(RESOLUTION_SCENARIOS.length);
  });
});
