import { NextResponse, type NextRequest } from 'next/server';
import { enqueueScheduledRecalculation, enqueueScheduledReports } from '@/core/db';
import { log } from '@/core/logging';
import { cronAuthorised } from '../_lib/cron-auth';

/**
 * The daily recalculation's enqueue, and the scheduled reports', run HOURLY (FU-6, ADR-131,
 * ADR-135; Phase 17, ADR-141).
 *
 * "Daily" is per organisation, in its own timezone. A single 02:00 UTC tick left an organisation in
 * Los Angeles on yesterday's date (19:00 local) and one in Kiritimati sixteen hours into its day. Each
 * hourly tick queues only organisations whose latest succeeded run is dated before their local today,
 * and the database refuses a second scheduled job for the same organisation and date — so the hour
 * after local midnight queues it, and the other twenty-three queue nothing. The cost is one indexed
 * query an hour.
 *
 * Phase 17: the same tick queues yesterday's Daily Executive Brief and, on a local Monday, last
 * week's Weekly Intelligence Report — once per organisation, kind and window. The two are separate:
 * a failure to queue the reports never stops the recalculation, nor the reverse.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!cronAuthorised(request)) return new NextResponse(null, { status: 404 });

  let scheduled: number | null = null;
  let reports: number | null = null;
  try {
    scheduled = await enqueueScheduledRecalculation();
    if (scheduled > 0) log.info('organisations queued for the daily recalculation', { count: scheduled });
  } catch (cause) {
    log.error('the daily recalculation could not be queued', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
  try {
    reports = await enqueueScheduledReports();
    if (reports > 0) log.info('scheduled reports queued', { count: reports });
  } catch (cause) {
    log.error('the scheduled reports could not be queued', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  if (scheduled === null) {
    return NextResponse.json({ error: 'The daily recalculation could not be queued.', reports }, { status: 500 });
  }
  if (reports === null) {
    return NextResponse.json({ error: 'The scheduled reports could not be queued.', scheduled }, { status: 500 });
  }
  return NextResponse.json({ scheduled, reports });
}
