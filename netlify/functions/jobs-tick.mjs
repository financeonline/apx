// Every five minutes (UTC): start the job worker (ADR-183). A scheduled function may run only 30 s,
// so it only starts the background function `jobs-worker-background`, which has fifteen minutes.
// Vercel's Hobby plan ran the queue once a day; this is the replacement and it is more frequent.
export default async () => {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) return console.error('jobs-tick: URL or CRON_SECRET is not set');
  const res = await fetch(`${base}/.netlify/functions/jobs-worker-background`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}` },
  });
  console.log(`jobs-tick: worker started (${res.status})`);
};

export const config = { schedule: '*/5 * * * *' };
