import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import {
  addActionComment, commentEngagementItem, createEngagementItem, getEngagementItem, listNotifications,
  markNotificationsRead, unreadCount, updateEngagementStatus,
} from '@/modules/engagement';
import type { AccessContext } from '@/modules/tenancy';
import { prepareDataAdded } from '@/db/app/imports-commit';
import { orgRows } from '@/db/rls';
import { newId, nowIso, orgRow } from '@/db/schema';
import { runTx } from '@/db/tx';
import { clientFor, createAuthUser, fs, rpc, serviceClientScoped } from './setup';
import { addMember, dropFixtures, makeOrg, rowOf, rowsOf, seedBatch, seedDocument } from './f-fixtures';

/**
 * Team/Client Management, in-app (ADR-144): requests, deliverables, comments and the inbox — who
 * may do what, who is told, and that nobody is told about their own doing or about something they
 * may not open. Run-unique fixtures (ADR-052.12).
 */

const RUN = `e${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.engagement.itest.motion`;
let ownerId: string;
let adminId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let otherOrgId: string;

const ctxFor = (userId: string, role: EffectiveRole, org = orgId): AccessContext => ({
  userId, orgId: org, orgSlug: 'eng', effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}-${userId.slice(0, 4)}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
});
const owner = () => ctxFor(ownerId, 'owner');
const admin = () => ctxFor(adminId, 'admin');
const client = () => ctxFor(clientId, 'client');
const inbox = async (ctx: AccessContext) => (await listNotifications(ctx)).map((n) => n.kind + ':' + n.title);

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  adminId = await createAuthUser(`admin@${DOMAIN}`);
  clientId = await createAuthUser(`client@${DOMAIN}`);
  strangerId = await createAuthUser(`stranger@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Engagement ${RUN}`);
  otherOrgId = await makeOrg(strangerId, `ITest Engagement Other ${RUN}`);
  await addMember(orgId, adminId, 'admin');
  await addMember(orgId, clientId, 'client');
}, 60_000);

afterAll(async () => {
  await dropFixtures([orgId, otherOrgId], DOMAIN);
}, 60_000);

describe('a client\'s request', () => {
  let requestId: string;

  it('is raised by the client and told to the team, not to the client', async () => {
    requestId = await createEngagementItem(client(), { kind: 'request', title: 'Please explain the June dip', detail: 'Sales fell.', dueDate: '2026-10-31' });
    expect(await inbox(owner())).toContain('engagement_created:New request: Please explain the June dip');
    expect(await inbox(admin())).toContain('engagement_created:New request: Please explain the June dip');
    expect(await inbox(client())).toEqual([]);
  });

  it('is moved by the team, and the client is told, with the note', async () => {
    await updateEngagementStatus(owner(), requestId, 'in_progress', 'Looking at it now');
    const notes = await listNotifications(client());
    expect(notes[0]).toMatchObject({ kind: 'engagement_status', title: '"Please explain the June dip" is now in progress', body: 'Looking at it now' });
    const found = await getEngagementItem(client(), requestId);
    expect(found?.events.map((e) => e.event)).toEqual(['created', 'status_changed']);
  });

  it('cannot be moved along by the client — only withdrawn', async () => {
    await expect(updateEngagementStatus(client(), requestId, 'delivered', null)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await updateEngagementStatus(client(), requestId, 'closed', 'Answered on a call');
    const item = await rowOf(orgId, 'engagement_items', requestId);
    expect(`${item!.status}|${item!.closed_at !== null}`).toBe('closed|true');
  });

  // The PostgreSQL `append_only_guard` on engagement_events has no Firestore counterpart to test:
  // no function offers to change or delete an event (FIRESTORE_DATA_MODEL.md §4), and the browser
  // cannot reach Firestore at all.
});

describe('a deliverable', () => {
  it('may only be created by the team, and the client is told', async () => {
    await expect(createEngagementItem(client(), { kind: 'deliverable', title: 'Q3 pack', detail: null, dueDate: null }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const id = await createEngagementItem(admin(), { kind: 'deliverable', title: 'Q3 management pack', detail: null, dueDate: '2026-10-15' });
    expect(await inbox(client())).toContain('engagement_created:New deliverable: Q3 management pack');
    await commentEngagementItem(client(), id, 'Thanks — can it include cash?');
    expect(await inbox(admin())).toContain('engagement_comment:New comment on "Q3 management pack"');
  });
});

describe('comments on an action', () => {
  it('reach the action\'s owner and earlier commenters, never the author', async () => {
    const actionId = newId();
    const now = nowIso();
    await orgRow(fs(), orgId, 'actions', actionId).set({
      id: actionId, organization_id: orgId, title: 'Chase late payers', description: null, source_type: 'user',
      source_id: null, priority: 'medium', status: 'open', owner_user_id: adminId, created_by: ownerId, due_date: null,
      completed_at: null, evidence_bundle_id: null, created_at: now, updated_at: now,
    });
    await addActionComment(client(), actionId, 'Two have now paid.');
    expect(await inbox(admin())).toContain('action_comment:New comment on "Chase late payers"');
    expect(await inbox(owner())).toContain('action_comment:New comment on "Chase late payers"');
    expect((await inbox(client())).filter((t) => t.startsWith('action_comment'))).toEqual([]);
  });
});

describe('notifications about the client\'s data and reports', () => {
  it('tell the client new data was added, linking to Home; the importer is not told', async () => {
    const doc = await seedDocument(orgId, { filename: 'gl.csv', kind: 'general_ledger' });
    const batch = await seedBatch(orgId, {
      documentId: doc, importType: 'general_ledger', targetTable: 'ledger_entries', status: 'committed',
      periodStart: '2026-09-01', periodEnd: '2026-09-30', reviewedBy: ownerId,
    });
    // The commit's `notify_data_added` (Team I's commit writes it in the commit transaction).
    const server = serviceClientScoped(orgId);
    await runTx(server, async (tx) => {
      const notices = await prepareDataAdded(server, tx, (await rowOf(orgId, 'import_batches', batch))!);
      notices.write(tx);
    });
    const clientNote = (await listNotifications(client())).find((n) => n.kind === 'data_added')!;
    expect(clientNote).toMatchObject({ title: 'New data added: general ledger' });
    expect(clientNote.href).toMatch(/\/home$/);
    // An admin reviews imports, so goes to the import itself.
    expect((await listNotifications(admin())).find((n) => n.kind === 'data_added')?.href).toMatch(new RegExp(`/data/imports/${batch}$`));
    expect((await inbox(owner())).filter((t) => t.startsWith('data_added'))).toEqual([]);
  });

  it('tell everyone who may read reports that a weekly report is ready', async () => {
    const recorded = await rpc(serviceClientScoped(orgId), 'record_report', {
      p_org: orgId, p_actor: null, p_kind: 'weekly_intelligence', p_origin: 'scheduled', p_period: null, p_job: null,
      p_content: {}, p_content_version: 'brief.v1', p_window_start: '2026-09-07', p_window_end: '2026-09-13',
    }, { server: true });
    expect(recorded.error).toBeNull();
    for (const ctx of [owner(), admin(), client()]) expect(await inbox(ctx)).toContain('report_ready:Your weekly report is ready');
  });
});

describe('the inbox', () => {
  it('counts unread, and marks them read', async () => {
    expect(await unreadCount(client())).toBeGreaterThan(0);
    await markNotificationsRead(client(), null);
    expect(await unreadCount(client())).toBe(0);
  });

  it('is each person\'s own: nobody reads another\'s, and a stranger sees nothing of this organisation', async () => {
    const theirs = (await rowsOf(orgId, 'notifications')).filter((n) => n.user_id !== clientId);
    expect(theirs.length).toBeGreaterThan(0);
    const data = await orgRows(client().db, orgId, 'notifications', (q) => q.where('user_id', '!=', clientId));
    expect(data).toEqual([]);
    expect(await listNotifications(ctxFor(strangerId, 'owner', otherOrgId))).toEqual([]);
  });
});
