import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createUserClient } from '@/core/db';
import { MotionError, NotFound, PermissionDenied, ValidationError, toMotionError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { can } from '@/core/permissions';
import { answer, createConversation, FALLBACK_MESSAGE, type AnswerOutput } from '@/modules/ai';
import { getAccessContext, moduleOn, resolveAccessFresh } from '@/modules/tenancy';

/**
 * `POST /api/ai/chat` — the analyst turn, streamed (AI_ARCHITECTURE.md §2; ROUTE_ARCHITECTURE.md §165).
 *
 * The browser sends `{conversationId?, message, orgSlug}` and receives Server-Sent Events: `status`
 * events while tools run (a tool name and a human label, never a payload) and exactly ONE `answer`
 * event carrying the validated, grounded JSON. Nothing the model wrote outside `submit_answer`
 * reaches this channel (F-C-08).
 *
 * The status code is decided before the first byte. Everything that can refuse the turn — no
 * session, no access, no permission, the conversation not the caller's, the quota — happens inside
 * `answer()` BEFORE the model is called and before any status event, so the route waits for either
 * the first status event or the turn's end and only then chooses: a JSON error with its status, or
 * a 200 stream. A 429 with `resetAt` therefore arrives as a 429, not as an event inside a 200.
 *
 * The organisation is addressed by slug and resolved server-side against the caller's own access;
 * the slug is an address, never an authority (ADR-014). The tool loop re-resolves that access
 * uncached before every tool (§4, F-C-17), which is why `resolveAccessFresh` and not the
 * per-request memo is handed down.
 *
 * Node runtime: the turn holds a connection open for up to 120 s (the turn budget; ADR-157).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 150;

/** §9: the question is wrapped before the model sees it; here it is only bounded. */
export const MAX_MESSAGE_CHARS = 2_000;

const BodySchema = z.object({
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1, 'Ask a question.').max(MAX_MESSAGE_CHARS, `Keep a question under ${MAX_MESSAGE_CHARS} characters.`),
  orgSlug: z.string().min(1).optional(),
});

type ChatEvent =
  | { readonly event: 'status'; readonly data: { readonly tool: string; readonly label: string } }
  | { readonly event: 'answer'; readonly data: ClientAnswer }
  | { readonly event: 'error'; readonly data: { readonly code: string; readonly message: string } };

/** What the browser receives: the server's verdict and the answer, with the ids it needs to link. */
export interface ClientAnswer {
  readonly conversationId: string;
  readonly messageId: string;
  readonly evidenceBundleId: string | null;
  readonly groundingStatus: AnswerOutput['groundingStatus'];
  readonly answer: AnswerOutput['answer'];
  readonly toolCalls: number;
  /** The fallback the client shows when `answer` is null (§10). */
  readonly fallback: string;
}

const encoder = new TextEncoder();

function frame(e: ChatEvent): Uint8Array {
  return encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  const headers = { 'x-request-id': requestId };

  try {
    // ROUTE_ARCHITECTURE.md §237: an API route answers 401, not a redirect, to a caller with no session.
    // The handle's actor is `user` only for a verified, unrevoked Firebase session cookie.
    const session = await createUserClient();
    if (session.actor.kind !== 'user') {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Sign in to continue.', requestId } }, { status: 401, headers });
    }

    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError('That question could not be read.', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const body = parsed.data;
    const orgSlug = body.orgSlug ?? request.nextUrl.searchParams.get('org');
    if (!orgSlug) throw new ValidationError('The organization is missing from the request.');

    // NotFound for "no access" as for "no such organisation" (SECURITY_MODEL.md §14).
    const ctx = await getAccessContext(orgSlug);
    if (!ctx.orgId) throw new NotFound();
    if (!can(ctx, 'ai.use')) throw new PermissionDenied('ai.use');
    // ADR-158: the AI Analyst is a system the super admin may switch off for this organisation.
    if (!moduleOn(ctx, 'analyst')) throw new NotFound();

    const conversationId = body.conversationId ?? (await createConversation(ctx));

    /*
     * The turn starts now, but the response does not: events are buffered until the first status
     * event or the end of the turn tells us whether this is a stream or a refusal.
     */
    const buffered: ChatEvent[] = [];
    let sink: ((e: ChatEvent) => void) | null = null;
    const emit = (e: ChatEvent): void => { if (sink) sink(e); else buffered.push(e); };

    let opened!: () => void;
    const firstStatus = new Promise<void>((resolve) => { opened = resolve; });

    const turn = answer({
      ctx, conversationId, message: body.message,
      resolveAccess: () => resolveAccessFresh(orgSlug),
      onStatus: (e) => { emit({ event: 'status', data: e }); opened(); },
    }).then(
      (out): MotionError | null => {
        emit({ event: 'answer', data: {
          conversationId, messageId: out.messageId, evidenceBundleId: out.evidenceBundleId,
          groundingStatus: out.groundingStatus, answer: out.answer, toolCalls: out.toolCalls, fallback: FALLBACK_MESSAGE,
        } });
        return null;
      },
      (cause: unknown): MotionError => {
        const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
        // After the stream is open a status line is spent; the client gets the fallback as an event.
        emit({ event: 'error', data: { code: error.code, message: error.status >= 500 ? FALLBACK_MESSAGE : error.message } });
        return error;
      },
    );

    const refused = await Promise.race([firstStatus.then(() => null), turn]);
    if (refused) throw refused;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of buffered) controller.enqueue(frame(e));
        buffered.length = 0;
        sink = (e) => controller.enqueue(frame(e));
        void turn.then(() => controller.close());
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    });
  } catch (cause) {
    const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
    if (error.status >= 500) {
      log.error('an analyst turn could not be started', { requestId, error: error.message });
    }
    return NextResponse.json({ error: error.toJSON() }, { status: error.status, headers });
  }
}
