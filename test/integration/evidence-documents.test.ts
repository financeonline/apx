import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { recordAccessEvent } from '@/core/db';
import { putObject, redeemDownloadGrant, removeObjectsForOrganization, signDownloadUrl } from '@/core/storage/signer';
import { createAuthUser, clientFor, deleteOrg, fs, rpc } from './setup';
import { addMember, makeOrg } from './f-fixtures';
import { seedDocument as seedDocumentRow } from './i-fixtures';

/**
 * Level 4 of the evidence drawer: the source document, and who may reach it
 * (EVIDENCE_MODEL.md §10; TEST_STRATEGY.md §4 cases 4 and 5; ADR-043.5).
 *
 * ADR-043.5's design is that the audit row is the INPUT the signer needs — `signDownloadUrl`
 * re-reads the row and refuses unless it names this actor, this target, and was written in the last
 * thirty seconds. A download that was not recorded therefore cannot happen, and the whole property
 * rests on `record_access_event` refusing to write a row it should not. That is what this suite is
 * about.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `d${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.documents.itest.motion`;

let ownerA: string;
let clientA: string;
let ownerB: string;
let orgA: string;
let orgB: string;
let documentA: string;
let documentB: string;

function seedDocument(orgId: string, name: string): Promise<string> {
  return seedDocumentRow(orgId, { filename: `${name}.csv`, kind: 'general_ledger', byteSize: 12 });
}

async function downloadsOf(documentId: string, orgId?: string) {
  let q = fs().collection('audit_events').where('action', '==', 'document.downloaded').where('target_id', '==', documentId);
  if (orgId) q = q.where('organization_id', '==', orgId);
  return (await q.get()).docs.map((d) => d.data());
}

async function auditRowsFor(orgId: string, documentId: string): Promise<number> {
  return (await downloadsOf(documentId, orgId)).length;
}

beforeAll(async () => {
  ownerA = await createAuthUser(`owner-a@${DOMAIN}`);
  clientA = await createAuthUser(`client-a@${DOMAIN}`);
  ownerB = await createAuthUser(`owner-b@${DOMAIN}`);
  orgA = await makeOrg(ownerA, `ITest Docs A ${RUN}`);
  orgB = await makeOrg(ownerB, `ITest Docs B ${RUN}`);
  await addMember(orgA, clientA, 'client');
  documentA = await seedDocument(orgA, 'a');
  documentB = await seedDocument(orgB, 'b');
});

afterAll(async () => {
  await deleteOrg(orgA);
  await deleteOrg(orgB);
});

describe('case 4 — a signed URL for another organisation’s document', () => {
  it('is refused as NOT FOUND, and writes no audit row', async () => {
    const before = await auditRowsFor(orgA, documentB);

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
    expect(await auditRowsFor(orgA, documentB), 'a refused download leaves no trace of having happened')
      .toBe(before);
    expect(await downloadsOf(documentB), 'and no row anywhere, under any organisation').toHaveLength(0);
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

    expect(await auditRowsFor(orgA, documentA)).toBe(0);
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
    // The id is a uuid now (it was a bigint identity); the signer reads the event back by it.
    expect(String(auditId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await auditRowsFor(orgA, documentA)).toBe(1);

    const row = (await fs().collection('audit_events').doc(String(auditId)).get()).data()!;
    expect(`${row.actor_user_id}|${row.actor_type}|${(row.metadata as Record<string, unknown>).surface}`).toBe(`${ownerA}|user|evidence`);
  });

  it('and the owner reads it in their own audit log', async () => {
    const { data, error } = await rpc<Array<{ action: string; target_id: string }>>(clientFor(ownerA), 'org_audit_events', { p_org: orgA });
    expect(error).toBeNull();
    expect((data ?? []).filter((r) => r.action === 'document.downloaded').map((r) => r.target_id)).toContain(documentA);
  });
});

describe('case 5 — a download link does not outlive its window', () => {
  /*
   * Downloads are served through the APX server now (`/api/storage/download`): `signDownloadUrl`
   * mints a link carrying a grant signed by the server, good for 60 seconds, and redeeming it reads
   * the object only after re-checking the audit event (ADR-043.5). The 60 seconds is therefore the
   * server's own control rather than the bucket's, and what is tested is that a grant whose window
   * has passed is refused — with the clock moved past it rather than a minute's wait.
   */
  it('a link inside its window serves the bytes; one past it is refused', async () => {
    const key = `${orgA}/expiry-${RUN}/probe.txt`;
    await putObject({ orgId: orgA, userId: ownerA }, 'source-documents', key, new TextEncoder().encode('probe'), 'text/plain');
    try {
      const auditId = await recordAccessEvent(
        { userId: ownerA, requestId: `itest-${RUN}` },
        { organizationId: orgA, action: 'document.downloaded', targetTable: 'source_documents', targetId: documentA },
      );
      const ctx = { orgId: orgA, userId: ownerA };
      const req = { bucket: 'source-documents', key, auditEventId: auditId, targetTable: 'source_documents', targetId: documentA, downloadAs: 'probe.txt' };

      const fresh = await signDownloadUrl(ctx, req);
      const grant = decodeURIComponent(new URL(fresh.url, 'http://apx.local').searchParams.get('grant')!);
      const live = await redeemDownloadGrant(grant, ownerA);
      expect(new TextDecoder().decode(live.bytes), 'a link inside its window works').toBe('probe');
      // Somebody else's session cannot redeem it.
      await expect(redeemDownloadGrant(grant, ownerB)).rejects.toMatchObject({ code: 'NOT_FOUND' });

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + (fresh.expiresInSeconds + 2) * 1000);
      try {
        await expect(redeemDownloadGrant(grant, ownerA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await removeObjectsForOrganization(orgA, 'source-documents', [key]);
    }
  });
});
