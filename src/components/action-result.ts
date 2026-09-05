import type { SerialisedError } from '@/core/errors';

/**
 * What every server action returns (ROUTE_ARCHITECTURE.md §7). Success is a plain flag with an
 * optional sentence to show; failure carries the serialised MotionError, including its requestId,
 * so the user can quote it to support (UX_ARCHITECTURE.md §7.2).
 *
 * Type-only, so a client component can import it without pulling a server module into the browser.
 */
export type ActionResult =
  | { readonly ok: true; readonly message?: string }
  | { readonly ok: false; readonly error: SerialisedError };

export type ActionState = ActionResult | null;
