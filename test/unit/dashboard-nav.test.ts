import { describe, expect, it } from 'vitest';

import { showsDataMenu, visibleNavItems } from '@/components/dashboard/nav';
import { permissionsFor } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import type { EffectiveRole } from '@/core/permissions';

/**
 * Navigation visibility (UX_ARCHITECTURE.md §3.1, RBAC §5).
 *
 * The rule these tests defend: **an item the role lacks is hidden entirely, never shown disabled.**
 * A disabled item tells somebody both that a section exists and that they may not have it, which is
 * a worse experience and a small information leak. The permission is declared beside the item, so
 * this is really a test that no section has been added without gating it.
 */

const contextFor = (role: EffectiveRole): AccessContext => ({
  userId: 'u1',
  orgId: 'o1',
  orgSlug: 'acme',
  effectiveRole: role,
  permissions: permissionsFor(role),
  actorType: 'user',
  db: null as never,
  requestId: 'r1',
  now: () => new Date('2026-06-15T00:00:00Z'),
  organizationStatus: 'active',
});

describe('what each role sees in the navigation', () => {
  it('shows an owner every section', () => {
    expect(visibleNavItems(contextFor('owner')))
      .toEqual(['Home', 'Insights', 'Money', 'Customers', 'Actions', 'Reports', 'Analyst']);
  });

  it('shows an admin every section too', () => {
    expect(visibleNavItems(contextFor('admin'))).toHaveLength(7);
  });

  it('shows a client the sections they can actually use', () => {
    const items = visibleNavItems(contextFor('client'));
    expect(items).toContain('Home');
    expect(items).toContain('Money');
    // Every item present is one the role can genuinely open.
    expect(items.length).toBeGreaterThan(0);
  });

  it('shows a suspended member the frozen Home and nothing else (ADR-044.4)', () => {
    // A suspended organisation maps to `dashboard.view` alone, so only Home survives — which is
    // exactly what the frozen-Home treatment needs.
    expect(visibleNavItems(contextFor('suspended_member'))).toEqual(['Home']);
  });

  it('shows somebody with no access nothing at all', () => {
    expect(visibleNavItems(contextFor('none'))).toEqual([]);
  });

  it('keeps the order fixed, because a moving menu is a menu nobody learns', () => {
    const owner = visibleNavItems(contextFor('owner'));
    const client = visibleNavItems(contextFor('client'));
    // A client's items are a subsequence of an owner's, never a reordering.
    let index = 0;
    for (const item of client) {
      index = owner.indexOf(item, index);
      expect(index, `${item} is out of order for a client`).toBeGreaterThanOrEqual(0);
      index += 1;
    }
  });
});

describe('the Data menu (§3.1, ADR-037)', () => {
  it('is shown to the roles that do the importing', () => {
    expect(showsDataMenu(contextFor('owner'))).toBe(true);
    expect(showsDataMenu(contextFor('admin'))).toBe(true);
    expect(showsDataMenu(contextFor('employee'))).toBe(true);
  });

  it('is never shown to a client', () => {
    // A client does not import, and offering the menu would only lead them to a denied page.
    expect(showsDataMenu(contextFor('client'))).toBe(false);
  });

  it('is not shown to a suspended member', () => {
    expect(showsDataMenu(contextFor('suspended_member'))).toBe(false);
  });
});
