import 'server-only';
import { toMotionError } from '@/core/errors';
import { log } from '@/core/logging';
import type { ActionResult } from '@/components/action-result';

/**
 * The failure half of every server action (ROUTE_ARCHITECTURE.md §7).
 *
 * Nothing is ever swallowed: whatever was thrown is normalised to a MotionError, written to the
 * operational log with its requestId, and returned to the form in plain words. A PermissionDenied
 * from `assertCan` and a 42501 raised inside the `api.*` function surface identically, which is the
 * point of the shared error model (SERVICE_ARCHITECTURE.md §6).
 */
export function fail(error: unknown, context: { requestId?: string; action: string }): ActionResult {
  const motionError = toMotionError(error, context.requestId);
  log.error('server action failed', {
    requestId: motionError.requestId,
    service: context.action,
    errorCode: motionError.code,
    // An unexpected failure keeps its original message in the log (never in the reply), so staff
    // can see what broke instead of only "INTERNAL" (2026-11-03).
    ...(motionError.code === 'INTERNAL' && error instanceof Error ? { detail: error.message } : {}),
  });
  return { ok: false, error: motionError.toJSON() };
}

export function done(message?: string): ActionResult {
  return message ? { ok: true, message } : { ok: true };
}

/** Read a required text field from a form. Empty strings are treated as absent. */
export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export function optionalText(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value.length > 0 ? value : undefined;
}

export function integer(form: FormData, name: string, fallback: number): number {
  const value = Number.parseInt(text(form, name), 10);
  return Number.isFinite(value) ? value : fallback;
}
