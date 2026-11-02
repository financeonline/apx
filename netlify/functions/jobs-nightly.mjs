// 02:00 UTC daily: the nightly sweep (`/api/jobs/nightly`, ADR-074, ADR-183) — it only queues the
// sweep; the job worker runs it.
export default async () => {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) return console.error('jobs-nightly: URL or CRON_SECRET is not set');
  const res = await fetch(`${base}/api/jobs/nightly`, { headers: { authorization: `Bearer ${secret}` } });
  console.log(`jobs-nightly: ${res.status} ${await res.text()}`);
};

export const config = { schedule: '0 2 * * *' };
