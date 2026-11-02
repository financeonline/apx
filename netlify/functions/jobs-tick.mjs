// Every five minutes (UTC): start the job worker (ADR-183). A scheduled function may run only 30 s,
// so it only starts the background function `jobs-worker-background`, which has fifteen minutes.
// Vercel's Hobby plan ran the queue once a day; this is the replacement and it is more frequent.
export default async () => {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) return console.error('jobs-tick: URL or CRON_SECRET is not set');
  // A background function answers 202 at once. Redirects are not followed: one to the sign-in page
  // would otherwise read as a 200 "success" while the worker never ran (2026-11-02).
  const res = await fetch(`${base}/.netlify/functions/jobs-worker-background`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}` }, redirect: 'manual',
  });
  if (res.status === 202) console.log('jobs-tick: worker started (202)');
  else console.error(`jobs-tick: the worker was NOT started — HTTP ${res.status}${res.headers.get('location') ? ` to ${res.headers.get('location')}` : ''}`);
};

export const config = { schedule: '*/5 * * * *' };
