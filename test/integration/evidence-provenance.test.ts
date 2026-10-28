import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { getDocumentEvidence, getRecordProvenance } from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, fs } from './setup';
import { createOrgFixture } from './r-fixtures';
import {
  anyAccount, deleteAuthUsers, periodFor, seedBatch, seedDocument, seedImportRow, seedLedgerEntry,
} from './evidence-fixtures';

/**
 * The two ends of the evidence chain (EVIDENCE_MODEL.md §1, §5.1; ADR-096).
 *
 * The drawer walks a figure down to its rows and a row down to its file. These are the same chain
 * asked about from the other end — one record's own history, and one file's reach — and the
 * properties that matter are the ones a wrong answer would hide rather than announce:
 *
 *   * a record that no longer counts says so, and says why;
 *   * a record with no file behind it says that, instead of inventing one;
 *   * a rolled-back import stops counting towards the file it came from;
 *   * neither service reaches across an organisation, and neither hands a client a filename.
 *
 * Run-unique fixtures (ADR-052.12), written straight into Firestore (`evidence-fixtures.ts`); the
 * suite removes exactly what it created.
 */

const RUN = `p${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.provenance.itest.motion`;

let ownerA: string;
let clientA: string;
let ownerB: string;
let orgA: string;
let orgB: string;
let periodA: string;
let accountA: string;
let documentA: string;
let documentB: string;
let batchA: string;
let rolledBackBatch: string;
let entryCounted: string;
let entrySuperseded: string;
let entryReplacement: string;
let entryRejected: string;
let entryNoDocument: string;
let entryB: string;

function contextFor(userId: string, role: 'owner' | 'client', org: string = orgA): AccessContext {
  return {
    userId,
    orgId: org,
    orgSlug: null,
    effectiveRole: role,
    permissions: permissionsFor(role),
    actorType: 'user',
    db: clientFor(userId, { email: `${role}-${userId.slice(0, 4)}@${DOMAIN}` }),
    requestId: `itest-${RUN}`,
    now: () => new Date('2026-06-15T00:00:00Z'),
    organizationStatus: 'active',
  };
}

/** A May ledger line, with whatever provenance the case needs. */
function seedEntry(org: string, opts: {
  description: string;
  account: string;
  document?: string | null;
  batch?: string | null;
  importRow?: string | null;
  status?: string;
  rejectedReason?: string | null;
  sourceRef?: string | null;
}): Promise<string> {
  return seedLedgerEntry(org, {
    date: '2026-05-12', accountId: opts.account, direction: 'credit', amount: '1000', description: opts.description,
    documentId: opts.document ?? null, batchId: opts.batch ?? null, importRowId: opts.importRow ?? null,
    sourceRef: opts.sourceRef ?? null, status: opts.status ?? 'accepted', rejectedReason: opts.rejectedReason ?? null,
  });
}

const seedFile = (org: string, name: string) => seedDocument(org, { name: `${name}.csv` });

function seedLedgerBatch(org: string, document: string, opts: {
  status: string;
  committed?: number;
  rolledBack?: boolean;
  from?: string;
  to?: string;
}): Promise<string> {
  return seedBatch(org, {
    documentId: document, importType: 'general_ledger', targetTable: 'ledger_entries', status: opts.status,
    rowCounts: { committed: opts.committed ?? 0, superseded: 0, total: opts.committed ?? 0 },
    periodStart: opts.from ?? '2026-05-01', periodEnd: opts.to ?? '2026-05-31',
    committedAt: opts.status === 'committed' ? new Date().toISOString() : null,
    rolledBackAt: opts.rolledBack ? new Date().toISOString() : null, createdBy: ownerA,
  });
}

beforeAll(async () => {
  ownerA = await createAuthUser(`owner-a@${DOMAIN}`);
  clientA = await createAuthUser(`client-a@${DOMAIN}`);
  ownerB = await createAuthUser(`owner-b@${DOMAIN}`);

  orgA = (await createOrgFixture({ name: `ITest Prov A ${RUN}`, ownerId: ownerA, members: [{ userId: clientA, role: 'client' }] })).id;
  orgB = (await createOrgFixture({ name: `ITest Prov B ${RUN}`, ownerId: ownerB })).id;

  periodA = await periodFor(orgA, '2026-05-01');
  accountA = await anyAccount(orgA);
  const accountB = await anyAccount(orgB);

  documentA = await seedFile(orgA, 'a');
  documentB = await seedFile(orgB, 'b');
  batchA = await seedLedgerBatch(orgA, documentA, { status: 'committed', committed: 3 });
  rolledBackBatch = await seedLedgerBatch(orgA, documentA, { status: 'rolled_back', committed: 9, rolledBack: true, from: '2026-04-01', to: '2026-04-30' });

  const importRow = await seedImportRow(orgA, { batchId: batchA, rowNumber: 7, sourceRef: 'csv:row:7' });

  entryCounted = await seedEntry(orgA, { description: 'May sales', account: accountA, document: documentA, batch: batchA, importRow, sourceRef: 'csv:row:7' });
  entryReplacement = await seedEntry(orgA, { description: 'May sales, corrected', account: accountA, document: documentA, batch: batchA });
  entrySuperseded = await seedEntry(orgA, { description: 'May sales, first try', account: accountA, document: documentA, batch: batchA });
  await orgRow(fs(), orgA, 'ledger_entries', entrySuperseded).update({ superseded_by: entryReplacement, superseded_at: new Date().toISOString() });
  entryRejected = await seedEntry(orgA, { description: 'A duplicate', account: accountA, document: documentA, batch: batchA, status: 'rejected', rejectedReason: 'Already in the ledger' });
  entryNoDocument = await seedEntry(orgA, { description: 'Typed in by hand', account: accountA });
  entryB = await seedEntry(orgB, { description: 'B sales', account: accountB, document: documentB });
});

afterAll(async () => {
  await deleteOrg(orgA);
  await deleteOrg(orgB);
  await deleteAuthUsers(DOMAIN);
});

// -----------------------------------------------------------------------------------------------
// One record's own history
// -----------------------------------------------------------------------------------------------

describe('a record says where it came from (§5.1)', () => {
  it('walks a counted row to its import and the line of the file it came from', async () => {
    const view = await getRecordProvenance(contextFor(ownerA, 'owner'), 'ledger', entryCounted);

    expect(view.kindLabel).toBe('Ledger entry');
    expect(view.description).toBe('May sales');
    expect(view.periodId).toBe(periodA);
    expect(view.periodLabel, 'the month in the reader’s words, not an id').toBe('May 2026');
    expect(view.standing.countsTowardsFigures).toBe(true);
    expect(view.standing.assurance).toBe('verified');

    expect(view.importedBy?.batchId).toBe(batchA);
    expect(view.importedBy?.periodStart).toBe('2026-05-01');

    // The chain's last link: the file, and the line within it.
    expect(view.document?.documentId).toBe(documentA);
    expect(view.document?.filename).toBe('a.csv');
    expect(view.document?.row, 'the line comes from the import row, which is the parser’s own record').toBe(7);
    expect(view.document?.locked).toBe(false);
  });

  it('says a superseded row is no longer counted, and names what replaced it', async () => {
    const view = await getRecordProvenance(contextFor(ownerA, 'owner'), 'ledger', entrySuperseded);
    expect(view.standing.countsTowardsFigures).toBe(false);
    expect(view.standing.superseded).toBe(true);
    expect(view.standing.supersededById).toBe(entryReplacement);
  });

  it('says a rejected row is not in any figure, and gives the reviewer’s reason', async () => {
    const view = await getRecordProvenance(contextFor(ownerA, 'owner'), 'ledger', entryRejected);
    expect(view.standing.countsTowardsFigures).toBe(false);
    expect(view.standing.status).toBe('rejected');
    expect(view.standing.rejectedReason).toBe('Already in the ledger');
  });

  it('says there is no file behind a hand-entered row rather than inventing one (§8.6)', async () => {
    const view = await getRecordProvenance(contextFor(ownerA, 'owner'), 'ledger', entryNoDocument);
    expect(view.document, 'no document is a real state, not an error').toBeNull();
    expect(view.importedBy).toBeNull();
    expect(view.standing.countsTowardsFigures).toBe(true);
  });

  it('answers NOT FOUND for an id that does not exist', async () => {
    await expect(getRecordProvenance(
      contextFor(ownerA, 'owner'), 'ledger', '00000000-0000-4000-8000-000000000000',
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// -----------------------------------------------------------------------------------------------
// Tenancy and role
// -----------------------------------------------------------------------------------------------

describe('a record belongs to exactly one organisation (§8.4)', () => {
  it('refuses organisation B’s record to organisation A’s owner, as NOT FOUND', async () => {
    await expect(getRecordProvenance(contextFor(ownerA, 'owner'), 'ledger', entryB))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses A’s record to B’s owner, whose own permission is not the question', async () => {
    await expect(getRecordProvenance(contextFor(ownerB, 'owner', orgB), 'ledger', entryCounted))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses B’s document to A’s owner', async () => {
    await expect(getDocumentEvidence(contextFor(ownerA, 'owner'), documentB))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a client sees the record but not the file (§10, CD-17)', () => {
  it('gives a client the row and the line reference, and withholds the filename', async () => {
    const view = await getRecordProvenance(contextFor(clientA, 'client'), 'ledger', entryCounted);

    expect(view.description, 'the record itself is theirs to see').toBe('May sales');
    expect(view.standing.countsTowardsFigures).toBe(true);

    expect(view.document?.locked, 'the document level is where a client stops').toBe(true);
    expect(view.document?.documentId).toBeNull();
    expect(view.document?.filename, 'naming the file would reach past the boundary to render a caption').toBeNull();
    expect(view.document?.row, 'the line stays: it is what lets them ask an admin for the right thing').toBe(7);
  });

  it('refuses a client the document evidence outright: they have no documents.view', async () => {
    await expect(getDocumentEvidence(contextFor(clientA, 'client'), documentA))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

// -----------------------------------------------------------------------------------------------
// One file's reach
// -----------------------------------------------------------------------------------------------

describe('a file says what rests on it (§1)', () => {
  it('counts only the imports that are still in the figures', async () => {
    const view = await getDocumentEvidence(contextFor(ownerA, 'owner'), documentA);

    expect(view.filename).toBe('a.csv');
    expect(view.imports, 'both imports are listed — the rolled-back one is history, not a secret').toHaveLength(2);

    /*
     * The rolled-back batch declares nine committed rows and April. Neither may be counted: its rows
     * were taken back out, and saying this file is behind April's figures would be false.
     */
    expect(view.recordsCommitted).toBe(3);
    expect(view.periods.map((p) => p.label)).toEqual(['May 2026']);
    expect(view.imports.find((i) => i.batchId === rolledBackBatch)?.rolledBackAt).not.toBeNull();
  });

  it('names the kind of record in the product’s words, never a table', () => {
    return getDocumentEvidence(contextFor(ownerA, 'owner'), documentA).then((view) => {
      expect(view.imports[0]?.kindLabel).toBe('Ledger entry');
      expect(JSON.stringify(view), 'no table name travels to the reader').not.toMatch(/ledger_entries/);
    });
  });

  it('says a file nothing rests on yet has nothing resting on it', async () => {
    const fresh = await seedFile(orgA, `fresh${RUN}`);
    const view = await getDocumentEvidence(contextFor(ownerA, 'owner'), fresh);
    expect(view.recordsCommitted).toBe(0);
    expect(view.imports).toHaveLength(0);
    expect(view.periods).toEqual([]);
  });

  it('answers NOT FOUND for a document id that does not exist', async () => {
    await expect(getDocumentEvidence(
      contextFor(ownerA, 'owner'), '00000000-0000-4000-8000-000000000000',
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
