import { NextResponse, type NextRequest } from 'next/server';
import { enqueueScheduledRecalculation } from '@/core/db';
import { log } from '@/core/logging';
import { cronAuthorised } from '../_lib/cron-auth';

/**
 * The daily recalculation's enqueue, run HOURLY (FU-6, ADR-131, ADR-135).
 *
 * "Daily" is per organisation, in its own timezone. A single 02:00 UTC tick left an organisation in
 * Los Angeles on yesterday's date (19:00 local) and one in Kiritimati sixteen hours into its day. Each
 * hourly tick queues only organisations whose latest succeeded run is dated before their local today,
 * and the database refuses a second scheduled job for the same organisation and date — so the hour
 * after local midnight queues it, and the other twenty-three queue nothing. The cost is one indexed
 * query an hour.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!cronAuthorised(request)) return new NextResponse(null, { status: 404 });
  try {
    const scheduled = await enqueueScheduledRecalculation();
    if (scheduled > 0) log.info('organisations queued for the daily recalculation', { count: scheduled });
    return NextResponse.json({ scheduled });
  } catch (cause) {
    log.error('the daily recalculation could not be queued', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ error: 'The daily recalculation could not be queued.' }, { status: 500 });
  }
}
