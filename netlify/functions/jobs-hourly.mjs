// Five past every hour (UTC): queue each organisation's daily recalculation once its local day has
// begun, and the scheduled reports (ADR-135, ADR-141, ADR-183) — `/api/jobs/scheduled`, a short call.
export default async () => {
  const base = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) return console.error('jobs-hourly: URL or CRON_SECRET is not set');
  const res = await fetch(`${base}/api/jobs/scheduled`, { headers: { authorization: `Bearer ${secret}` } });
  console.log(`jobs-hourly: ${res.status} ${await res.text()}`);
};

export const config = { schedule: '5 * * * *' };
