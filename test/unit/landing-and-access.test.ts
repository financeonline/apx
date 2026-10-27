import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type Permission } from '@/core/permissions';
import {
  DEPARTMENTS_PERMISSION,
  landingPath,
  landingPathForRole,
  landingSection,
  type AccessRequest,
  type SwitchablePermission,
} from '@/modules/tenancy';
import {
  NOTIFICATION_KIND_PERMISSION,
  notificationHref,
  readableNotificationKinds,
} from '@/modules/engagement';
import {
  askablePermissions,
  heldPermissions,
  myRequestView,
  pendingRequest,
  plainRequestRefusal,
} from '@/app/app/[orgSlug]/access/access-view';
import { corporationTaxDueDate } from '@/modules/tax';
import { NOTIFICATION_KIND_LABELS, AUDIT_ACTION_LABELS } from '@/components/labels';

/**
 * ADR-172's follow-ups, the pure parts: where a person lands, which notifications they may read,
 * the requester's "Your access" page, and the shared Corporation Tax date rule.
 */

describe('where a person lands in a company', () => {
  it('is Home, the client lobby, whatever they hold (ADR-176)', () => {
    expect(DEPARTMENTS_PERMISSION).toBe('financials.view');
    expect(landingSection(new Set<Permission>(['dashboard.view', 'financials.view']))).toBe('home');
    expect(landingSection(new Set<Permission>(['dashboard.view', 'reports.view']))).toBe('home');
    expect(landingPath('acme', new Set<Permission>())).toBe('/app/acme/home');
  });

  it('sends every role Home — a 3rd party, a suspended organisation and the owner alike', () => {
    for (const role of ['third_party', 'suspended_member', 'owner', 'admin', 'accountant', 'client', 'employee', 'super_admin']) {
      expect(landingPathForRole('acme', role), role).toBe('/app/acme/home');
    }
  });

  it('agrees with the matrix for every granted role: each holds dashboard.view, which Home asks for', () => {
    for (const [role, permissions] of Object.entries(ROLE_MATRIX)) {
      expect(permissions.has('dashboard.view'), role).toBe(true);
      expect(landingPathForRole('x', role)).toBe('/app/x/home');
    }
  });

  it('sends an unknown role Home, whose own check decides', () => {
    expect(landingPathForRole('acme', 'mystery')).toBe('/app/acme/home');
  });
});

describe('the inbox shows only what the reader may still open', () => {
  const kinds = (held: readonly Permission[]) => readableNotificationKinds((p) => held.includes(p));

  it('gives a 3rd party only the answer to their own request and report-ready notices', () => {
    expect(kinds(['dashboard.view', 'reports.view']).sort()).toEqual(['access_decision', 'report_ready']);
  });

  it('gives an owner every kind', () => {
    expect(kinds([...ROLE_MATRIX.owner]).sort()).toEqual(Object.keys(NOTIFICATION_KIND_PERMISSION).sort());
  });

  it('drops the Action Centre kinds once actions.view is switched off', () => {
    const client = [...ROLE_MATRIX.client].filter((p) => p !== 'actions.view');
    const shown = kinds(client);
    expect(shown).not.toContain('action_comment');
    expect(shown).not.toContain('engagement_created');
    expect(shown).toContain('data_added');
  });

  it('opens the answer to an access request on "Your access", and every other kind where it was written', () => {
    expect(notificationHref('access_decision', '/app/acme/home', 'acme')).toBe('/app/acme/access');
    expect(notificationHref('report_ready', '/app/acme/marketing', 'acme')).toBe('/app/acme/marketing');
    expect(notificationHref('data_added', null, 'acme')).toBeNull();
  });

  it('has a label for every kind it knows', () => {
    for (const kind of Object.keys(NOTIFICATION_KIND_PERMISSION)) {
      expect(NOTIFICATION_KIND_LABELS[kind], kind).toBeTruthy();
    }
  });

  it('names the ADR-172 audit actions in words', () => {
    for (const action of [
      'member.permission_changed', 'member.permissions_reset', 'member.access_requested',
      'member.access_request_decided', 'member.access_request_withdrawn',
    ]) {
      expect(AUDIT_ACTION_LABELS[action], action).toBeTruthy();
    }
  });
});

function request(over: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: 'r1',
    requesterId: 'u1',
    requesterName: 'Lena Lender',
    requesterEmail: 'lena@example.com',
    requesterRole: 'third_party',
    permissions: ['financials.view', 'documents.view'],
    message: 'For the loan review.',
    status: 'pending',
    createdAt: '2026-10-14T09:00:00Z',
    decidedBy: null,
    decidedAt: null,
    granted: [],
    note: null,
    ...over,
  };
}

describe('"Your access"', () => {
  const thirdParty = (p: SwitchablePermission) => p === 'dashboard.view' || p === 'reports.view';

  it('lists what is held in plain words, and offers everything else', () => {
    expect(heldPermissions(thirdParty).map((p) => p.title)).toEqual(['Overview', 'Reports']);
    const askable = askablePermissions(thirdParty).map((p) => p.permission);
    expect(askable).toContain('financials.view');
    expect(askable).not.toContain('reports.view');
    expect(askable.length + 2).toBe(21);
  });

  it('shows a waiting request with Withdraw and no answer date', () => {
    const view = myRequestView(request());
    expect(view).toMatchObject({ statusLabel: 'Waiting', canWithdraw: true, answeredOn: null, askedOn: '14 Oct 2026' });
    expect(view.asked).toEqual(['Financial detail', 'Documents']);
    expect(view.outcome).toMatch(/^Waiting/);
  });

  it('shows an approval with what was switched on and what was not', () => {
    const view = myRequestView(request({
      status: 'approved', decidedAt: '2026-10-15T10:00:00Z', granted: ['financials.view'], note: 'Bank pages only.',
    }));
    expect(view.canWithdraw).toBe(false);
    expect(view.granted).toEqual(['Financial detail']);
    expect(view.notGranted).toEqual(['Documents']);
    expect(view.outcome).toBe('Approved: Financial detail is now switched on for you.');
    expect(view.answeredOn).toBe('15 Oct 2026');
    expect(view.tone).toBe('good');
  });

  it('does not call a withdrawal an answer', () => {
    const view = myRequestView(request({ status: 'withdrawn', decidedAt: '2026-10-15T10:00:00Z' }));
    expect(view.answeredOn).toBeNull();
    expect(view.outcome).toBe('You withdrew this request.');
  });

  it('finds the one waiting request', () => {
    expect(pendingRequest([request({ id: 'a', status: 'declined' }), request({ id: 'b' })])?.id).toBe('b');
    expect(pendingRequest([request({ status: 'approved' })])).toBeNull();
  });

  it('puts the database refusals into plain words', () => {
    expect(plainRequestRefusal({ code: 'QUOTA', message: 'too many access_request requests' }).message)
      .toBe('You can ask for more access five times a day. Please try again tomorrow.');
    expect(plainRequestRefusal({ code: 'QUOTA', message: 'too many rpc requests' }).message).toMatch(/wait a minute/);
    expect(plainRequestRefusal({
      code: 'CONFLICT', message: 'you already have a request waiting; withdraw it or wait for an answer',
    }).message).toMatch(/^You already have a request waiting\./);
    const other = { code: 'VALIDATION' as const, message: 'Keep the message to 1,000 characters.' };
    expect(plainRequestRefusal(other)).toBe(other);
  });
});

describe('Corporation Tax is due on one rule', () => {
  it('nine months and a day in the UK, nine months in the UAE, none elsewhere', () => {
    expect(corporationTaxDueDate('GB', '2026-03-31')).toBe('2027-01-01');
    expect(corporationTaxDueDate('GB', '2025-12-31')).toBe('2026-10-01');
    expect(corporationTaxDueDate('AE', '2025-12-31')).toBe('2026-09-30');
    expect(corporationTaxDueDate('IE', '2025-12-31')).toBeNull();
  });
});
