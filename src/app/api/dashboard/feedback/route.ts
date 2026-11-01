import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@/core/db';
import { MotionError, NotFound, ValidationError, toMotionError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { submitDashboardFeedback, type SubmittedFeedback } from '@/modules/feedback';
import { getAccessContext } from '@/modules/tenancy';

/**
 * `POST /api/dashboard/feedback?org=slug` — "Give feedback" on the department dashboard: the note
 * goes to APX staff inside APX (docs/DEPARTMENT_DASHBOARD_PLAN.md), listed at /platform/feedback.
 *
 *   body {section, department, notes, context}  → 201 SubmittedFeedback `{id, createdAt, status}`
 *   422 for an unknown section / department or notes empty or over 4,000 characters;
 *   429 after twenty notes in an hour (`error.resetAt`); 404 without access to the organisation.
 *
 * `section` is one of the prototype's 17 keys (`FEEDBACK_SECTIONS`), `department` one of
 * analysis | banking | capture | workflow | clients (or null), `context` an object of short strings
 * `{period?, view?, months?, scenario?}`. The organisation may also be sent as `orgSlug` in the body.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  const headers = { 'x-request-id': requestId, 'cache-control': 'no-store' };
  try {
    // ROUTE_ARCHITECTURE.md §237: an API route answers 401, not a redirect, to a caller with no session.
    const session = await createUserClient();
    if (session.actor.kind !== 'user') {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Sign in to continue.', requestId } }, { status: 401, headers });
    }

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('That feedback could not be read.');
    const { orgSlug: bodySlug, ...input } = body as Record<string, unknown>;
    const orgSlug = (typeof bodySlug === 'string' && bodySlug !== '' ? bodySlug : null) ?? request.nextUrl.searchParams.get('org');
    if (!orgSlug) throw new ValidationError('The organization is missing from the request.');

    const ctx = await getAccessContext(orgSlug);
    if (!ctx.orgId) throw new NotFound();
    const saved: SubmittedFeedback = await submitDashboardFeedback(ctx, input);
    return NextResponse.json(saved, { status: 201, headers });
  } catch (cause) {
    const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
    if (error.status >= 500) log.error('dashboard feedback could not be saved', { requestId, error: error.message });
    return NextResponse.json({ error: error.toJSON() }, { status: error.status, headers });
  }
}
