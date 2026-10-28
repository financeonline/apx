import { randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * `npm run ai:eval:live -- <org-slug> <requester-email>` — the nightly live run (AI_ARCHITECTURE.md
 * §12; TEST_STRATEGY.md §10.3 `ai:eval:live`).
 *
 * Enqueues one `ai.eval` job for the organisation, acting as the requester, drains the queue through
 * the same route the cron uses, and prints the job's result. Needs a running app (`E2E_BASE_URL`,
 * default http://127.0.0.1:3100), `CRON_SECRET`, `ANTHROPIC_API_KEY` on the app, and the same
 * Firebase project the app uses (`FIREBASE_PROJECT_ID`, default `demo-apx`; the emulators when
 * `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` are set). Exits non-zero when the run
 * is below the §10.3 targets — the job says so.
 *
 * The job document is written in exactly the shape `src/db/app/jobs.ts` `prepareEnqueue` writes
 * (no idempotency key: every live run is its own job). A script cannot import `src/db` (it is
 * `server-only`), so the shape is repeated here.
 */

const [slug, email] = process.argv.slice(2);
if (!slug || !email) {
  console.error('usage: ai-eval-live <org-slug> <requester-email>');
  process.exit(2);
}

const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('CRON_SECRET is required to drain the queue');
  process.exit(2);
}

const app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? 'demo-apx' }, 'ai-eval-live');
const fs = getFirestore(app);

const org = (await fs.collection('organizations').where('slug', '==', slug).limit(1).get()).docs[0];
const user = await getAuth(app).getUserByEmail(email).catch(() => null);
if (!org || !user) {
  console.error('no organisation with that slug, or no user with that email');
  process.exit(2);
}

const jobId = randomUUID();
const now = new Date().toISOString();
await fs.collection('jobs').doc(jobId).set({
  id: jobId, organization_id: org.id, job_type: 'ai.eval', idempotency_key: null, payload: {},
  requested_by: user.uid, status: 'queued', attempts: 0, max_attempts: 1, run_after: now,
  locked_at: null, locked_by: null, last_error: null, result: null, finished_at: null,
  created_at: now, updated_at: now,
});
console.log(`enqueued ai.eval ${jobId}`);

const job = async () => (await fs.collection('jobs').doc(jobId).get()).data() ?? {};

const deadline = Date.now() + 10 * 60 * 1000;
let status = 'queued';
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/jobs/run`, { headers: { authorization: `Bearer ${secret}` } });
  if (!response.ok) {
    console.error(`the worker route answered ${response.status}`);
    process.exit(1);
  }
  status = String((await job()).status ?? '');
  if (status !== 'queued' && status !== 'running') break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

const result = ((await job()).result as unknown) ?? {};
console.log(JSON.stringify({ jobId, status, result }, null, 2));
process.exit(status === 'succeeded' ? 0 : 1);
