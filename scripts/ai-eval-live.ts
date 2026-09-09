import { execFileSync } from 'node:child_process';

/**
 * `npm run ai:eval:live -- <org-slug> <requester-email>` — the nightly live run (AI_ARCHITECTURE.md
 * §12; TEST_STRATEGY.md §10.3 `ai:eval:live`).
 *
 * Enqueues one `ai.eval` job for the organisation, acting as the requester, drains the queue through
 * the same route the cron uses, and prints the job's result. Needs a running app (`E2E_BASE_URL`,
 * default http://127.0.0.1:3100), `CRON_SECRET`, `ANTHROPIC_API_KEY` on the app, and the local
 * database container. Exits non-zero when the run is below the §10.3 targets — the job says so.
 */

const [slug, email] = process.argv.slice(2);
if (!slug || !email) {
  console.error('usage: ai-eval-live <org-slug> <requester-email>');
  process.exit(2);
}

const container = process.env.MOTION_DB_CONTAINER ?? 'supabase_db_MOTION';
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('CRON_SECRET is required to drain the queue');
  process.exit(2);
}

const sql = (statement: string): string =>
  execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-c', statement], { encoding: 'utf8' }).trim();

const jobId = sql(`
  insert into public.jobs (organization_id, job_type, payload, requested_by, max_attempts)
  select o.id, 'ai.eval', '{}'::jsonb, u.id, 1
    from public.organizations o, auth.users u
   where o.slug = '${slug.replace(/'/g, "''")}' and u.email = '${email.replace(/'/g, "''")}'
  returning id`);
if (!jobId) {
  console.error('no organisation with that slug, or no user with that email');
  process.exit(2);
}
console.log(`enqueued ai.eval ${jobId}`);

const deadline = Date.now() + 10 * 60 * 1000;
let status = 'queued';
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/jobs/run`, { headers: { authorization: `Bearer ${secret}` } });
  if (!response.ok) {
    console.error(`the worker route answered ${response.status}`);
    process.exit(1);
  }
  status = sql(`select status from public.jobs where id = '${jobId}'`);
  if (status !== 'queued' && status !== 'running') break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

const result = sql(`select coalesce(result::text, '{}') from public.jobs where id = '${jobId}'`);
console.log(JSON.stringify({ jobId, status, result: JSON.parse(result) as unknown }, null, 2));
process.exit(status === 'succeeded' ? 0 : 1);
