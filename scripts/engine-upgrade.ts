/**
 * Post-deploy: queue the engine-upgrade recalculation now rather than waiting for the nightly cron
 * (ADR-120). Calls the SAME endpoint the cron calls, with the same secret, so there is one path:
 *
 *   APP_URL=https://… CRON_SECRET=… npx tsx scripts/engine-upgrade.ts
 *
 * The endpoint queues, through `api_server.enqueue_engine_upgrade`, every organisation that has
 * figures from a succeeded run and no succeeded run on the deployed engine version. Idempotent: run
 * it as often as you like. Progress and failures are the `calculation.run` jobs in /platform/jobs;
 * an organisation whose run fails is queued again the next night until one succeeds.
 */
const base = process.env.APP_URL;
const secret = process.env.CRON_SECRET;
if (!base || !secret) {
  console.error('APP_URL and CRON_SECRET are required.');
  process.exit(2);
}

const response = await fetch(new URL('/api/jobs/nightly', base), {
  headers: { authorization: `Bearer ${secret}` },
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`The engine upgrade could not be queued (${response.status}).`, body);
  process.exit(1);
}
console.log(`Queued for the engine upgrade: ${(body as { engineUpgrade?: number }).engineUpgrade ?? 0} organisation(s).`);
export {};
