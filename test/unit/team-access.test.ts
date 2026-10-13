import { describe, expect, it } from 'vitest';
import {
  NOT_EDITABLE_REASON,
  NOT_HELD_REASON,
  PERMISSION_GROUPS,
  accessPanel,
  asSwitchable,
  defaultInviteRole,
  grantFrom,
  requestView,
  roleOptions,
  splitRequests,
  switchView,
} from '@/app/app/[orgSlug]/settings/team/access-view';
import {
  ACCESS_REQUEST_STATUS_LABELS,
  ACTOR_TYPE_LABELS,
  AUDIT_ACTION_LABELS,
  MEMBERSHIP_ROLE_HINTS,
  MEMBERSHIP_ROLE_LABELS,
  PLATFORM_ROLE_LABELS,
  ROLE_LABELS,
  ROLE_PLURAL_LABELS,
} from '@/components/labels';
import {
  ROLE_NAMES,
  SWITCHABLE_PERMISSIONS,
  TENANT_ROLES,
  type AccessRequest,
  type MemberPermissions,
  type SwitchablePermission,
} from '@/modules/tenancy';

/**
 * The team page's per-person access (ADR-172): which switches are drawn on, changed, resettable or
 * locked, and why. The service decides what a viewer may do; these tests defend that the page draws
 * the service's answer faithfully — above all, that nothing the viewer does not hold is ever drawn
 * as something they can switch on.
 */

const CLIENT_DEFAULTS: readonly SwitchablePermission[] = [
  'dashboard.view', 'financials.view', 'banking.view', 'customers.view', 'reports.view', 'ai.use',
  'actions.view', 'actions.update_own', 'alerts.manage',
];

function person(over: Partial<MemberPermissions> = {}): MemberPermissions {
  return {
    userId: 'u2',
    name: 'Asha Patel',
    email: 'asha@example.com',
    role: 'client',
    defaults: CLIENT_DEFAULTS,
    overrides: [],
    effective: CLIENT_DEFAULTS,
    editable: true,
    grantable: [...SWITCHABLE_PERMISSIONS],
    ...over,
  };
}

describe('the switches are grouped as a person thinks about them', () => {
  it('lists every switchable permission exactly once', () => {
    const listed = PERMISSION_GROUPS.flatMap((group) => group.permissions);
    expect([...listed].sort()).toEqual([...SWITCHABLE_PERMISSIONS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('uses the six groups the owner asked for, in order', () => {
    expect(PERMISSION_GROUPS.map((group) => group.title)).toEqual([
      'Overview & figures', 'Data', 'Customers & reports', 'AI', 'Actions & alerts', 'Documents, export & audit',
    ]);
  });
});

describe('a switch shows the role default and whether it is changed', () => {
  it('draws a role default as unchanged, with nothing to reset', () => {
    const view = switchView(person(), 'financials.view');
    expect(view).toMatchObject({ on: true, byDefault: true, change: null, overridden: false, canReset: false });
    expect(view.title).toBe('Financial detail');
    expect(view.next).toBe('off');
    expect(view.lockedReason).toBeNull();
  });

  it('calls a permission switched on beyond the role "added", and pressing it goes back to the default', () => {
    const view = switchView(
      person({ overrides: [{ permission: 'data.export', granted: true }], effective: [...CLIENT_DEFAULTS, 'data.export'] }),
      'data.export',
    );
    expect(view).toMatchObject({ on: true, byDefault: false, change: 'added', overridden: true, canReset: true });
    expect(view.next).toBe('default');
  });

  it('calls a role default switched off "taken away"', () => {
    const view = switchView(
      person({
        overrides: [{ permission: 'ai.use', granted: false }],
        effective: CLIENT_DEFAULTS.filter((p) => p !== 'ai.use'),
      }),
      'ai.use',
    );
    expect(view).toMatchObject({ on: false, byDefault: true, change: 'taken_away', overridden: true, canReset: true });
    expect(view.next).toBe('default');
  });

  it('treats a stored switch that repeats the default as unchanged, but still resettable', () => {
    const view = switchView(person({ overrides: [{ permission: 'ai.use', granted: true }] }), 'ai.use');
    expect(view.change).toBeNull();
    expect(view.overridden).toBe(true);
    expect(view.canReset).toBe(true);
  });

  it('switches a permission the role leaves off ON as an addition, not as the default', () => {
    expect(switchView(person(), 'imports.create').next).toBe('on');
  });
});

describe('never beyond the viewer’s own rights', () => {
  const notHeld = person({ grantable: CLIENT_DEFAULTS });

  it('locks switching ON a permission the viewer does not hold, and says why', () => {
    const view = switchView(notHeld, 'audit.view');
    expect(view.on).toBe(false);
    expect(view.lockedReason).toBe(NOT_HELD_REASON);
  });

  it('still lets the viewer switch it OFF when the person has it', () => {
    const view = switchView(
      person({ grantable: [], overrides: [], effective: CLIENT_DEFAULTS }),
      'reports.view',
    );
    expect(view.on).toBe(true);
    expect(view.lockedReason).toBeNull();
  });

  it('does not offer "back to the default" when that would switch on something the viewer lacks', () => {
    const view = switchView(
      person({
        grantable: [],
        overrides: [{ permission: 'reports.view', granted: false }],
        effective: CLIENT_DEFAULTS.filter((p) => p !== 'reports.view'),
      }),
      'reports.view',
    );
    expect(view.change).toBe('taken_away');
    expect(view.canReset).toBe(false);
    expect(view.lockedReason).toBe(NOT_HELD_REASON);
  });

  it('locks every switch for a person the viewer may not change', () => {
    const panel = accessPanel(
      person({ editable: false, overrides: [{ permission: 'data.export', granted: true }], effective: [...CLIENT_DEFAULTS, 'data.export'] }),
    );
    const switches = panel.groups.flatMap((group) => group.switches);
    expect(switches.every((s) => s.lockedReason === NOT_EDITABLE_REASON)).toBe(true);
    expect(switches.some((s) => s.canReset)).toBe(false);
    expect(panel.resettable).toEqual([]);
  });
});

describe('the access panel', () => {
  it('counts the changes and lists what "Reset all" may put back', () => {
    const panel = accessPanel(
      person({
        grantable: CLIENT_DEFAULTS.filter((p) => p !== 'reports.view'),
        overrides: [
          { permission: 'data.export', granted: true },
          { permission: 'ai.use', granted: false },
          { permission: 'reports.view', granted: false },
        ],
        effective: [...CLIENT_DEFAULTS.filter((p) => p !== 'ai.use' && p !== 'reports.view'), 'data.export'],
      }),
    );
    expect(panel.roleName).toBe('Client');
    expect(panel.changedCount).toBe(3);
    // `reports.view` is taken away and the viewer lacks it: putting it back would be a grant.
    expect([...panel.resettable].sort()).toEqual(['ai.use', 'data.export']);
  });
});

describe('reading the switch forms', () => {
  it('accepts only switchable permissions', () => {
    expect(asSwitchable('data.export')).toBe('data.export');
    expect(asSwitchable('users.manage')).toBeNull();
    expect(asSwitchable('org.delete')).toBeNull();
    expect(asSwitchable('')).toBeNull();
  });

  it('reads on, off and the default, and nothing else', () => {
    expect(grantFrom('on')).toBe(true);
    expect(grantFrom('off')).toBe(false);
    expect(grantFrom('default')).toBeNull();
    expect(grantFrom('yes')).toBeUndefined();
  });
});

describe('roles', () => {
  it('offers the five company roles in order, each with its one line', () => {
    const options = roleOptions(() => true);
    expect(options.map((o) => o.role)).toEqual([...TENANT_ROLES]);
    expect(options.map((o) => o.name)).toEqual(['Owner', 'Admin', 'Accountant', 'Client', '3rd party']);
    expect(options.find((o) => o.role === 'accountant')?.description).toBe(
      'Data capture and compliance; no AI, team or settings.',
    );
    expect(options.find((o) => o.role === 'client')?.description).toBe('A limited view of the business.');
    expect(options.find((o) => o.role === 'third_party')?.description).toBe(
      'A lender, investor or partner: a read-only overview; can ask for more.',
    );
  });

  it('offers only what the ceiling allows', () => {
    const options = roleOptions((role) => role !== 'owner');
    expect(options.map((o) => o.role)).not.toContain('owner');
  });

  it('starts an invitation on the least a new person can be given', () => {
    expect(defaultInviteRole(roleOptions(() => true))).toBe('client');
    expect(defaultInviteRole(roleOptions((role) => role === 'admin' || role === 'third_party'))).toBe('third_party');
    expect(defaultInviteRole([])).toBeUndefined();
  });
});

function request(over: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: 'r1',
    requesterId: 'u3',
    requesterName: null,
    requesterEmail: 'lender@example.com',
    requesterRole: 'third_party',
    permissions: ['financials.view', 'documents.view'],
    message: 'For the facility review.',
    status: 'pending',
    createdAt: '2026-10-12T09:00:00Z',
    decidedBy: null,
    decidedAt: null,
    granted: [],
    note: null,
    ...over,
  };
}

describe('"Request more information"', () => {
  it('says who asked, as what, for what, in words', () => {
    const view = requestView(request(), () => true, () => null);
    expect(view.who).toBe('lender@example.com');
    expect(view.roleName).toBe('3rd party');
    expect(view.asked.map((a) => a.title)).toEqual(['Financial detail', 'Documents']);
    expect(view.askedOn).toBe('12 Oct 2026');
    expect(view.statusLabel).toBe('Waiting');
    expect(view.canApprove).toBe(true);
  });

  it('lets the viewer approve only what they hold', () => {
    const view = requestView(request(), (p) => p === 'financials.view', () => null);
    expect(view.asked.map((a) => [a.permission, a.approvable])).toEqual([
      ['financials.view', true],
      ['documents.view', false],
    ]);
    expect(view.canApprove).toBe(true);
    expect(requestView(request(), () => false, () => null).canApprove).toBe(false);
  });

  it('can approve a request made in words only', () => {
    expect(requestView(request({ permissions: [] }), () => false, () => null).canApprove).toBe(true);
  });

  it('shows a decided request with what was switched on, the note and who decided', () => {
    const view = requestView(
      request({
        status: 'approved', decidedBy: 'u1', decidedAt: '2026-10-13T10:00:00Z',
        granted: ['financials.view'], note: 'Documents on request.',
      }),
      () => true,
      (id) => (id === 'u1' ? 'Sam Owner' : null),
    );
    expect(view.statusLabel).toBe('Approved');
    expect(view.granted).toEqual(['Financial detail']);
    expect(view.decidedOn).toBe('13 Oct 2026');
    expect(view.decidedBy).toBe('Sam Owner');
    expect(view.note).toBe('Documents on request.');
  });

  it('lists waiting requests in the order they arrived, decided ones newest first', () => {
    const { pending, decided } = splitRequests([
      request({ id: 'b', createdAt: '2026-10-12T00:00:00Z' }),
      request({ id: 'old', status: 'declined', createdAt: '2026-10-01T00:00:00Z', decidedAt: '2026-10-02T00:00:00Z' }),
      request({ id: 'a', createdAt: '2026-10-10T00:00:00Z' }),
      request({ id: 'new', status: 'withdrawn', createdAt: '2026-10-05T00:00:00Z', decidedAt: '2026-10-11T00:00:00Z' }),
    ]);
    expect(pending.map((r) => r.id)).toEqual(['a', 'b']);
    expect(decided.map((r) => r.id)).toEqual(['new', 'old']);
  });
});

describe('role labels follow ADR-172', () => {
  it('calls the platform employee a Financial Analyst wherever a person reads it', () => {
    expect(ROLE_NAMES.employee).toBe('Financial Analyst');
    expect(ROLE_LABELS.employee).toBe('Financial Analyst');
    expect(PLATFORM_ROLE_LABELS.employee).toBe('Financial Analyst');
    expect(ACTOR_TYPE_LABELS.employee).toBe('Financial Analyst');
    expect(ROLE_PLURAL_LABELS.employee).toBe('Financial Analysts');
    expect(AUDIT_ACTION_LABELS['assignment.created']).toBe('Financial Analyst given access');
  });

  it('never says "adviser" or "employee" for the role', () => {
    const all = [
      ...Object.values(ROLE_LABELS), ...Object.values(PLATFORM_ROLE_LABELS), ...Object.values(ACTOR_TYPE_LABELS),
      ...Object.values(ROLE_PLURAL_LABELS), ...Object.values(AUDIT_ACTION_LABELS),
    ];
    expect(all.filter((label) => /adviser|employee/i.test(label))).toEqual([]);
  });

  it('names every company role as the contract does, with a one-line description', () => {
    for (const role of TENANT_ROLES) {
      expect(MEMBERSHIP_ROLE_LABELS[role]).toBe(ROLE_NAMES[role]);
      expect(ROLE_LABELS[role]).toBe(ROLE_NAMES[role]);
      expect(MEMBERSHIP_ROLE_HINTS[role]?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('words every request status', () => {
    for (const status of ['pending', 'approved', 'declined', 'withdrawn']) {
      expect(ACCESS_REQUEST_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});
