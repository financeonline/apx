import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createUserClient } from '@/core/db';
import { MotionError, NotFound, ValidationError, toMotionError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { canManageTargets, getMonthlyTargets, saveMonthlyTargets, type MonthlyTargetsRecord } from '@/modules/targets';
import { getAccessContext } from '@/modules/tenancy';

/**
 * `GET|POST /api/dashboard/targets?org=slug` — the department dashboard's monthly targets
 * (docs/DEPARTMENT_DASHBOARD_PLAN.md; the prototype's `/api/targets`).
 *
 *   GET  ?org=slug&month=YYYY-MM          → 200 MonthlyTargetsResponse (the defaults, revision 0,
 *                                          when nothing was saved for the month)
 *   POST ?org=slug {month, targets, expectedRevision} → 200 MonthlyTargetsResponse (the saved record);
 *                                          409 when `expectedRevision` is stale (`error.context.revision`
 *                                          is the current one), 422 for a field out of bounds
 *                                          (`error.issues[].path` names it), 403 without the right
 *
 * The organisation is addressed by slug and resolved server-side against the caller's own access
 * (ADR-014); NotFound for "no access" as for "no such organisation". The permissions are checked in
 * the service and again by the `api.*` function. Errors are `{ error: SerialisedError }`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What both methods answer: the record and whether this person may save. */
export interface MonthlyTargetsResponse extends MonthlyTargetsRecord {
  readonly canManage: boolean;
}

const BodySchema = z.object({
  month: z.string(),
  targets: z.record(z.string(), z.unknown()),
  expectedRevision: z.number(),
  orgSlug: z.string().min(1).optional(),
});

const NO_STORE = { 'cache-control': 'no-store' };

async function signedIn(requestId: string, headers: Record<string, string>): Promise<NextResponse | null> {
  // ROUTE_ARCHITECTURE.md §237: an API route answers 401, not a redirect, to a caller with no session.
  const session = await createUserClient();
  if (session.actor.kind === 'user') return null;
  return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Sign in to continue.', requestId } }, { status: 401, headers });
}

function failure(cause: unknown, requestId: string, headers: Record<string, string>, what: string): NextResponse {
  const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
  if (error.status >= 500) log.error(what, { requestId, error: error.message });
  return NextResponse.json({ error: error.toJSON() }, { status: error.status, headers });
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  const headers = { 'x-request-id': requestId, ...NO_STORE };
  try {
    const refused = await signedIn(requestId, headers);
    if (refused) return refused;
    const orgSlug = request.nextUrl.searchParams.get('org');
    if (!orgSlug) throw new ValidationError('The organization is missing from the request.');
    const month = request.nextUrl.searchParams.get('month') ?? '';

    const ctx = await getAccessContext(orgSlug);
    if (!ctx.orgId) throw new NotFound();
    const record = await getMonthlyTargets(ctx, month);
    const body: MonthlyTargetsResponse = { ...record, canManage: canManageTargets(ctx) };
    return NextResponse.json(body, { status: 200, headers });
  } catch (cause) {
    return failure(cause, requestId, headers, 'monthly targets could not be read');
  }
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  const headers = { 'x-request-id': requestId, ...NO_STORE };
  try {
    const refused = await signedIn(requestId, headers);
    if (refused) return refused;
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError('Those targets could not be read.', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const body = parsed.data;
    const orgSlug = body.orgSlug ?? request.nextUrl.searchParams.get('org');
    if (!orgSlug) throw new ValidationError('The organization is missing from the request.');

    const ctx = await getAccessContext(orgSlug);
    if (!ctx.orgId) throw new NotFound();
    const record = await saveMonthlyTargets(ctx, body.month, body.targets, body.expectedRevision);
    const out: MonthlyTargetsResponse = { ...record, canManage: canManageTargets(ctx) };
    return NextResponse.json(out, { status: 200, headers });
  } catch (cause) {
    return failure(cause, requestId, headers, 'monthly targets could not be saved');
  }
}
