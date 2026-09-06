import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { recordAccessEvent } from '@/core/db';
import { adminSql, clientFor, createAuthUser, serviceStorage } from './setup';

/**
 * Level 4 of the evidence drawer: the source document, and who may reach it
 * (EVIDENCE_MODEL.md §10; TEST_STRATEGY.md §4 cases 4 and 5; ADR-043.5).
 *
 * ADR-043.5's design is that the audit row is the INPUT the signer needs — `signDownloadUrl`
 * re-reads the row and refuses unless it names this actor, this target, and was written in the last
 * thirty seconds. A download that was not recorded therefore cannot happen, and the whole property
 * rests on `record_access_event` refusing to write a row it should not. That is what this suite is
 * about; it is the verification `IMPLEMENTATION_PLAN.md` Phase 10 slice 2 asks for and that the
 * phase shipped without.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `d${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.documents.itest`;

let ownerA: string;
let clientA: string;
let ownerB: string;
let orgA: string;
let orgB: string;
let documentA: string;
let documentB: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function seedDocument(orgId: string, name: string): string {
  return one(`
    insert into public.source_documents
           (organization_id, storage_path, original_filename, mime_type, byte_size, sha256,
            status, document_kind)
    values ('${orgId}', '${orgId}/${name}/f.csv', '${name}.csv', 'text/csv', 12,
            decode(md5('${orgId}${name}'), 'hex'), 'ready', 'general_ledger')
    returning id`);
}

function auditRowsFor(orgId: string, documentId: string): number {
  return Number(one(`
    select count(*) from public.audit_events
     where organization_id = '${orgId}' and action = 'document.downloaded'
       and target_id = '${documentId}'`));
}

beforeAll(async () => {
  ownerA = createAuthUser(`owner-a@${DOMAIN}`);
  clientA = createAuthUser(`client-a@${DOMAIN}`);
  ownerB = createAuthUser(`owner-b@${DOMAIN}`);

  const a = await clientFor(ownerA).schema('api').rpc('create_organization', { p_name: `ITest Docs A ${RUN}` });
  if (a.error) throw new Error(`fixture org A failed: ${a.error.message}`);
  orgA = a.data as unknown as string;

  const b = await clientFor(ownerB).schema('api').rpc('create_organization', { p_name: `ITest Docs B ${RUN}` });
  if (b.error) throw new Error(`fixture org B failed: ${b.error.message}`);
  orgB = b.data as unknown as string;

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgA}', '${clientA}', 'client', 'active')`);

  documentA = seedDocument(orgA, 'a');
  documentB = seedDocument(orgB, 'b');
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Docs%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Docs %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.documents.itest' and created_at < now() - interval '1 hour';`);
});

describe('case 4 — a signed URL for another organisation’s document', () => {
  it('is refused as NOT FOUND, and writes no audit row', async () => {
    const before = auditRowsFor(orgA, documentB);

    /*
     * The attack this models: owner A, who legitimately holds `documents.view` in A, asks for a
     * download of a document belonging to B. The permission check alone would pass — they really do
     * have the permission, in the organisation they named. Only the target check refuses it.
     */
    await expect(recordAccessEvent(
      { userId: ownerA, requestId: `itest-${RUN}` },
      {
        organizationId: orgA,
        action: 'document.downloaded',
        targetTable: 'source_documents',
        targetId: documentB,
      },
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // No row means the signer has nothing to verify, so no URL can be minted (ADR-043.5).
    expect(auditRowsFor(orgA, documentB), 'a refused download leaves no trace of having happened')
      .toBe(before);
    expect(Number(one(`
      select count(*) from public.audit_events
       where action = 'document.downloaded' and target_id = '${documentB}'`)),
    'and no row anywhere, under any organisation').toBe(0);
  });

  it('is refused for a client, who has no documents.view at all (§10, CD-17)', async () => {
    await expect(recordAccessEvent(
      { userId: clientA, requestId: `itest-${RUN}` },
      {
        organizationId: orgA,
        action: 'document.downloaded',
        targetTable: 'source_documents',
        targetId: documentA,
      },
    )).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    expect(auditRowsFor(orgA, documentA)).toBe(0);
  });

  it('and an invented document id is refused the same way as somebody else’s', async () => {
    const invented = '00000000-0000-4000-8000-000000000000';
    const foreign = await recordAccessEvent(
      { userId: ownerA, requestId: `itest-${RUN}` },
      { organizationId: orgA, action: 'document.downloaded', targetTable: 'source_documents', targetId: documentB },
    ).catch((error: { code?: string }) => error.code);
    const fake = await recordAccessEvent(
      { userId: ownerA, requestId: `itest-${RUN}` },
      { organizationId: orgA, action: 'document.downloaded', targetTable: 'source_documents', targetId: invented },
    ).catch((error: { code?: string }) => error.code);

    expect(fake, 'a stranger learns nothing from the difference').toBe(foreign);
  });
});

describe('a download that is allowed is recorded, and the owner can see it', () => {
  it('writes exactly one document.downloaded row, attributed to the person', async () => {
    const auditId = await recordAccessEvent(
      { userId: ownerA, requestId: `itest-${RUN}` },
      {
        organizationId: orgA,
        action: 'document.downloaded',
        targetTable: 'source_documents',
        targetId: documentA,
        metadata: { surface: 'evidence' },
      },
    );
    expect(auditId).toBeGreaterThan(0);
    expect(auditRowsFor(orgA, documentA)).toBe(1);

    const row = one(`
      select actor_user_id::text || '|' || actor_type::text || '|' || (metadata->>'surface')
        from public.audit_events where id = ${auditId}`);
    expect(row).toBe(`${ownerA}|user|evidence`);
  });

  it('and the owner reads it in their own audit log', async () => {
    const { data, error } = await clientFor(ownerA)
      .from('audit_events')
      .select('action, target_id')
      .eq('organization_id', orgA)
      .eq('action', 'document.downloaded');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => (r as { target_id: string }).target_id)).toContain(documentA);
  });
});

describe('case 5 — a signed URL does not outlive its window', () => {
  /*
   * The signer mints for 60 seconds (asserted in `storage-signer.test.ts`). Waiting a minute in a
   * test would buy nothing but a slow suite, so what is tested here is the property the 60 seconds
   * RESTS on: that Storage itself refuses a URL whose window has passed. If it did not, the TTL
   * would be a comment rather than a control.
   */
  it('Storage refuses a URL whose window has closed', async () => {
    const storage = serviceStorage();
    const path = `${orgA}/expiry-${RUN}/probe.txt`;
    const upload = await storage.storage
      .from('source-documents')
      .upload(path, new Blob(['probe'], { type: 'text/plain' }), { upsert: true });
    expect(upload.error, 'the fixture object must exist for the expiry to mean anything').toBeNull();

    const fresh = await storage.storage.from('source-documents').createSignedUrl(path, 60);
    expect(fresh.error).toBeNull();
    const live = await fetch(fresh.data!.signedUrl);
    expect(live.status, 'a URL inside its window works').toBe(200);

    const brief = await storage.storage.from('source-documents').createSignedUrl(path, 1);
    expect(brief.error).toBeNull();
    await new Promise((resolve) => { setTimeout(resolve, 2_000); });

    const replayed = await fetch(brief.data!.signedUrl);
    expect([400, 401, 403], `expired URL returned ${replayed.status}`).toContain(replayed.status);

    await storage.storage.from('source-documents').remove([path]);
  });
});
