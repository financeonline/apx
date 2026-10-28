import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type DocumentData, type Firestore, type Query, type WhereFilterOp } from 'firebase-admin/firestore';
import { expect, type Page } from '@playwright/test';

/**
 * What the sample-data runs need from the database, on the LOCAL Firebase emulators only
 * (FIRESTORE_DATA_MODEL.md): reading ids and counts to decide what is already loaded, and the few
 * writes no screen offers.
 *
 * `src/db` cannot be imported here — its files `import 'server-only'`, which throws outside a React
 * Server bundle — so the reads are written against the Admin SDK directly, with the data model's
 * layout: organisation tables at `organizations/{orgId}/{table}/{id}`, organisations found by `slug`.
 * Writes that the app has an `api.*` function for go through that function, as the signed-in owner
 * (`callApiAs`, run by `call-api.ts` in a child process where `server-only` resolves to its server
 * build), so they keep the app's checks, unique keys and audit events.
 */

// The emulators `npm run db:start` serves (scripts/write-local-env.sh). Set before the SDK reads them.
const PROJECT = process.env.FIREBASE_PROJECT_ID ?? 'demo-apx';
if (!process.env.FIRESTORE_EMULATOR_HOST && !PROJECT.startsWith('demo-')) {
  throw new Error(`refusing: ${PROJECT} is not a demo- project and FIRESTORE_EMULATOR_HOST is not set — the sample data is for the local emulators only`);
}
process.env.FIREBASE_PROJECT_ID = PROJECT;
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';

const APP_NAME = 'apx-sample-data';

function app(): App {
  return getApps().find((a) => a.name === APP_NAME) ?? initializeApp({ projectId: PROJECT }, APP_NAME);
}

let firestore: Firestore | null = null;
function fs(): Firestore {
  firestore ??= getFirestore(app());
  return firestore;
}

const nowIso = (): string => new Date().toISOString();

export type Filter = readonly [field: string, op: WhereFilterOp, value: unknown];

/** The organisation a slug names (slugs are stored lower-case), or null. */
export async function orgBySlug(slug: string): Promise<DocumentData | null> {
  const snap = await fs().collection('organizations').where('slug', '==', slug.toLowerCase()).limit(1).get();
  return snap.empty ? null : snap.docs[0]!.data();
}

/** The id of the organisation a slug names; fails the test when there is none. */
export async function orgIdBySlug(slug: string): Promise<string> {
  const org = await orgBySlug(slug);
  expect(org, `no company with slug ${slug}`).not.toBeNull();
  return String(org!.id);
}

/** The rows of one organisation table matching every filter. */
export async function orgRows(orgId: string, table: string, filters: readonly Filter[] = []): Promise<DocumentData[]> {
  let q: Query = fs().collection('organizations').doc(orgId).collection(table);
  for (const [field, op, value] of filters) q = q.where(field, op, value);
  return (await q.get()).docs.map((d) => d.data());
}

/** The `id` of the first matching row, or '' when there is none. */
export async function orgRowId(orgId: string, table: string, filters: readonly Filter[]): Promise<string> {
  const rows = await orgRows(orgId, table, filters);
  return rows.length > 0 ? String(rows[0]!.id) : '';
}

/** How many rows of one organisation table match. */
export async function orgCount(orgId: string, table: string, filters: readonly Filter[] = []): Promise<number> {
  let q: Query = fs().collection('organizations').doc(orgId).collection(table);
  for (const [field, op, value] of filters) q = q.where(field, op, value);
  return (await q.count().get()).data().count;
}

/** The Firebase Auth uid of a local account. */
export async function userIdByEmail(email: string): Promise<string> {
  return (await getAuth(app()).getUserByEmail(email)).uid;
}

/** Every organisation a person has a membership of (memberships are keyed by the user id). */
export async function organizationsOf(userId: string): Promise<DocumentData[]> {
  const memberships = await fs().collectionGroup('organization_memberships').where('user_id', '==', userId).get();
  const ids = [...new Set(memberships.docs.map((d) => String(d.get('organization_id'))))];
  if (ids.length === 0) return [];
  const orgs = await fs().getAll(...ids.map((id) => fs().collection('organizations').doc(id)));
  return orgs.filter((s) => s.exists).map((s) => s.data()!);
}

/** A job row as `prepareEnqueue` (src/db/app/jobs.ts) writes one. */
function jobRow(orgId: string, jobType: string, payload: Record<string, unknown>, idempotencyKey: string | null, maxAttempts: number) {
  const now = nowIso();
  return {
    id: randomUUID(), organization_id: orgId, job_type: jobType, idempotency_key: idempotencyKey, payload,
    requested_by: null, status: 'queued', attempts: 0, max_attempts: maxAttempts, run_after: now,
    locked_at: null, locked_by: null, last_error: null, result: null, finished_at: null,
    created_at: now, updated_at: now,
  };
}

/** Queues a job with no idempotency key (never merged), as a plain `insert into jobs` did. */
export async function enqueueJob(orgId: string, jobType: string, payload: Record<string, unknown>, maxAttempts = 3): Promise<string> {
  const row = jobRow(orgId, jobType, payload, null, maxAttempts);
  await fs().collection('jobs').doc(row.id).set(row);
  return row.id;
}

/** `hashKey` (src/db/schema.ts): the id suffix of a unique-key guard document. */
function hashKey(parts: ReadonlyArray<string | null>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
}

/**
 * Switches organisation features on — a platform admin's switch, which the sample account is not.
 * Switching Funding Readiness on queues its first assessment unless one is already queued, as the
 * `funding_enablement` trigger (now `api.set_org_module`) does.
 */
export async function switchFeaturesOn(orgId: string, keys: readonly string[]): Promise<void> {
  const db = fs();
  await db.runTransaction(async (tx) => {
    const ref = db.collection('organizations').doc(orgId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`no organisation ${orgId}`);
    const before = (snap.get('features') as Record<string, unknown> | undefined) ?? {};
    const features: Record<string, unknown> = { ...before };
    for (const key of keys) features[key] = true;

    const key = `funding.assess:${orgId}`;
    const guardRef = db.collection('_unique').doc(`jobs_idempotency_queued__${hashKey(['funding.assess', key])}`);
    let assessment: ReturnType<typeof jobRow> | null = null;
    if (String(features.funding_readiness ?? '') === 'true' && String(before.funding_readiness ?? '') !== 'true') {
      const guard = await tx.get(guardRef);
      const owner = guard.exists ? (guard.get('owner_id') as string | undefined) ?? null : null;
      const holder = owner ? await tx.get(db.collection('jobs').doc(owner)) : null;
      if (!(holder?.exists && holder.get('status') === 'queued')) {
        assessment = jobRow(orgId, 'funding.assess', { trigger: 'enablement_backfill' }, key, 3);
      }
    }

    tx.update(ref, { features, updated_at: nowIso() });
    if (assessment) {
      tx.set(db.collection('jobs').doc(assessment.id), assessment);
      tx.set(guardRef, { owner_id: assessment.id, constraint: 'jobs_idempotency_queued', created_at: assessment.created_at });
    }
  });
}

/** Jobs of one organisation still waiting or running. */
async function outstandingJobs(orgId: string): Promise<number> {
  const snap = await fs().collection('jobs').where('organization_id', '==', orgId)
    .where('status', 'in', ['queued', 'running']).count().get();
  return snap.data().count;
}

/**
 * Runs the queue the way the cron does, so figures appear without waiting for a tick; with a slug,
 * until that company has nothing queued or running (a calculation queues an alert pass, so it is
 * checked after each round rather than assumed after the first).
 */
export async function drainQueue(page: Page, orgSlug?: string): Promise<void> {
  const secret = process.env.CRON_SECRET;
  expect(secret, 'CRON_SECRET must be set to drain the queue').toBeTruthy();
  const orgId = orgSlug === undefined ? null : await orgIdBySlug(orgSlug);
  for (let round = 0; round < 12; round += 1) {
    const response = await page.request.get('/api/jobs/run', { headers: { authorization: `Bearer ${secret}` } });
    expect(response.status(), 'the drain endpoint must accept the cron secret').toBe(200);
    if (orgId === null) return;
    if ((await outstandingJobs(orgId)) === 0) return;
  }
}

const run = promisify(execFile);
const CALL_API = path.resolve('scripts/sample-data/call-api.ts');

/**
 * Calls one of the app's own `api.*` functions as a signed-in person and returns its result. It
 * runs in a child process (`call-api.ts`) because `src/db` only loads under the `react-server`
 * condition, which this Playwright process does not use.
 */
export async function callApiAs(user: { uid: string; email: string }, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { stdout } = await run(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', CALL_API, user.uid, user.email, fn, JSON.stringify(args)],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const last = stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'null';
  return JSON.parse(last) as unknown;
}
