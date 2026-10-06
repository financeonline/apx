import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import {
  addActionComment, commentEngagementItem, createEngagementItem, getEngagementItem, listNotifications,
  markNotificationsRead, unreadCount, updateEngagementStatus,
} from '@/modules/engagement';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * Team/Client Management, in-app (ADR-144): requests, deliverables, comments and the inbox — who
 * may do what, who is told, and that nobody is told about their own doing or about something they
 * may not open. Run-unique fixtures (ADR-052.12).
 */

const RUN = `e${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.engagement.itest`;
let ownerId: string;
let adminId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let otherOrgId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const ctxFor = (userId: string, role: EffectiveRole, org = orgId): AccessContext => ({
  userId, orgId: org, orgSlug: 'eng', effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}-${userId.slice(0, 4)}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
});
const owner = () => ctxFor(ownerId, 'owner');
const admin = () => ctxFor(adminId, 'admin');
const client = () => ctxFor(clientId, 'client');
const inbox = async (ctx: AccessContext) => (await listNotifications(ctx)).map((n) => n.kind + ':' + n.title);

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  adminId = createAuthUser(`admin@${DOMAIN}`);
  clientId = createAuthUser(`client@${DOMAIN}`);
  strangerId = createAuthUser(`stranger@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Engagement ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  orgId = created.data as unknown as string;
  const other = await clientFor(strangerId).schema('api').rpc('create_organization', { p_name: `ITest Engagement Other ${RUN}` });
  otherOrgId = other.data as unknown as string;
  adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status)
            values ('${orgId}', '${adminId}', 'admin', 'active'), ('${orgId}', '${clientId}', 'client', 'active')`);
});

afterAll(() => {
  adminSql(`
    select set_config('app.purge', 'on', false);
    delete from public.notifications where organization_id in (select id from public.organizations where name like 'ITest Engagement%${RUN}');
    delete from public.engagement_events where organization_id in (select id from public.organizations where name like 'ITest Engagement%${RUN}');
    delete from public.engagement_items where organization_id in (select id from public.organizations where name like 'ITest Engagement%${RUN}');
    delete from public.action_comments where organization_id in (select id from public.organizations where name like 'ITest Engagement%${RUN}');
    delete from public.organizations where name like 'ITest Engagement%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

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
    expect(one(`select status || '|' || (closed_at is not null) from public.engagement_items where id = '${requestId}'`)).toBe('closed|true');
  });

  it('keeps its history: events cannot be edited or deleted', () => {
    expect(() => adminSql(`update public.engagement_events set note = 'x' where item_id = '${requestId}'`)).toThrow(/IMMUTABLE/);
  });
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
    const actionId = one(`insert into public.actions (organization_id, title, source_type, owner_user_id, created_by)
                          values ('${orgId}', 'Chase late payers', 'user', '${adminId}', '${ownerId}') returning id`);
    await addActionComment(client(), actionId, 'Two have now paid.');
    expect(await inbox(admin())).toContain('action_comment:New comment on "Chase late payers"');
    expect(await inbox(owner())).toContain('action_comment:New comment on "Chase late payers"');
    expect((await inbox(client())).filter((t) => t.startsWith('action_comment'))).toEqual([]);
    expect(() => adminSql(`delete from public.action_comments where action_id = '${actionId}'`)).toThrow(/IMMUTABLE/);
  });
});

describe('notifications about the client\'s data and reports', () => {
  it('tell the client new data was added, linking to Home; the importer is not told', async () => {
    const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
                     values ('${orgId}', '${orgId}/e/gl.csv', 'gl.csv', 'text/csv', 10, decode('e5','hex'), 'ready', 'general_ledger') returning id`);
    const batch = one(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end)
                       values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committing', 'csv', '2026-09-01', '2026-09-30') returning id`);
    adminSql(`update public.import_batches set status = 'committed', committed_at = now(), reviewed_by = '${ownerId}' where id = '${batch}'`);
    const clientNote = (await listNotifications(client())).find((n) => n.kind === 'data_added')!;
    expect(clientNote).toMatchObject({ title: 'New data added: general ledger' });
    expect(clientNote.href).toMatch(/\/home$/);
    // An admin reviews imports, so goes to the import itself.
    expect((await listNotifications(admin())).find((n) => n.kind === 'data_added')?.href).toMatch(new RegExp(`/data/imports/${batch}$`));
    expect((await inbox(owner())).filter((t) => t.startsWith('data_added'))).toEqual([]);
  });

  it('tell everyone who may read reports that a weekly report is ready', async () => {
    adminSql(`insert into public.reports (organization_id, report_kind, window_start, window_end, origin, content, content_version)
              values ('${orgId}', 'weekly_intelligence', '2026-09-07', '2026-09-13', 'scheduled', '{}'::jsonb, 'brief.v1')`);
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
    const theirs = one(`select count(*) from public.notifications where organization_id = '${orgId}' and user_id <> '${clientId}'`);
    expect(Number(theirs)).toBeGreaterThan(0);
    const { data } = await client().db.from('notifications').select('id').eq('organization_id', orgId).neq('user_id', clientId);
    expect(data ?? []).toEqual([]);
    expect(await listNotifications(ctxFor(strangerId, 'owner', otherOrgId))).toEqual([]);
  });
});
