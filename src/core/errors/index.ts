/**
 * The error model (SERVICE_ARCHITECTURE.md §6).
 *
 * Every api.* function raises a typed SQLSTATE; this module maps those 1:1 so a database-enforced
 * rule and an application-enforced rule surface identically to the user. Errors are never
 * swallowed: an unmapped failure becomes InternalError and is logged with its requestId.
 */

export type ErrorCode =
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'QUOTA'
  | 'UPSTREAM'
  | 'INTERNAL';

export interface SerialisedError {
  code: ErrorCode;
  message: string;
  issues?: Array<{ path: string; message: string }>;
  resetAt?: string;
  requestId?: string;
}

export abstract class MotionError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;
  requestId?: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }

  toJSON(): SerialisedError {
    return { code: this.code, message: this.message, requestId: this.requestId };
  }
}

/** Used for "not in your accessible set" as well as "does not exist" — never confirms existence. */
export class NotFound extends MotionError {
  readonly code = 'NOT_FOUND' as const;
  readonly status = 404;
  constructor(message = 'Not found') {
    super(message);
  }
}

export class PermissionDenied extends MotionError {
  readonly code = 'PERMISSION_DENIED' as const;
  readonly status = 403;
  constructor(public readonly permission?: string) {
    super(
      permission
        ? `You do not have permission to do this (${permission}).`
        : 'You do not have permission to do this.',
    );
  }
}

export class ValidationError extends MotionError {
  readonly code = 'VALIDATION' as const;
  readonly status = 422;
  constructor(
    message = 'Some details need fixing.',
    public readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
  override toJSON(): SerialisedError {
    return { ...super.toJSON(), issues: this.issues };
  }
}

export class ConflictError extends MotionError {
  readonly code = 'CONFLICT' as const;
  readonly status = 409;
  constructor(message = 'That change conflicts with the current state.') {
    super(message);
  }
}

export class QuotaExceeded extends MotionError {
  readonly code = 'QUOTA' as const;
  readonly status = 429;
  constructor(
    message = 'You have reached a limit. Please try again later.',
    public readonly resetAt?: Date,
  ) {
    super(message);
  }
  override toJSON(): SerialisedError {
    return { ...super.toJSON(), resetAt: this.resetAt?.toISOString() };
  }
}

export class UpstreamError extends MotionError {
  readonly code = 'UPSTREAM' as const;
  readonly status = 502;
  constructor(
    public readonly provider: string,
    message = 'A service MOTION depends on is unavailable.',
  ) {
    super(message);
  }
}

export class InternalError extends MotionError {
  readonly code = 'INTERNAL' as const;
  readonly status = 500;
  constructor(message = 'Something went wrong.') {
    super(message);
  }
}

/** SQLSTATEs raised by the api.* catalogue (DATABASE_ARCHITECTURE.md §14.1). */
const SQLSTATE_MAP: Record<string, (message: string) => MotionError> = {
  P0002: (m) => new NotFound(m),
  '42501': (m) => new PermissionDenied(m),
  '22023': (m) => new ValidationError(m),
  '23505': (m) => new ConflictError(m),
  '23514': (m) => new ConflictError(m),
  '40001': (m) => new ConflictError(m),
  '53400': (m) => new QuotaExceeded(m),
};

interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * Turn a PostgREST/pg error into a MotionError.
 *
 * The api.* functions raise `'CODE: human sentence'`; the prefix is stripped so the user sees the
 * sentence, and `details`/`hint` are discarded because a direct RPC caller bypasses this mapping
 * and must not receive key values (R2-A-06.4).
 */
export function fromPostgresError(error: PostgrestLikeError, requestId?: string): MotionError {
  const raw = (error.message ?? '').trim();
  const withoutPrefix = raw.replace(
    /^(NOT_FOUND|PERMISSION_DENIED|VALIDATION|CONFLICT|QUOTA|IMMUTABLE)\s*:?\s*/,
    '',
  );
  const message = withoutPrefix.length > 0 ? withoutPrefix : 'Something went wrong.';

  const factory = error.code ? SQLSTATE_MAP[error.code] : undefined;
  const mapped = factory ? factory(message) : new InternalError();
  mapped.requestId = requestId;
  return mapped;
}

export function isMotionError(value: unknown): value is MotionError {
  return value instanceof MotionError;
}

/** Normalise anything thrown into a MotionError so nothing is ever silently swallowed. */
export function toMotionError(value: unknown, requestId?: string): MotionError {
  if (isMotionError(value)) {
    if (requestId && !value.requestId) value.requestId = requestId;
    return value;
  }
  if (value && typeof value === 'object' && 'code' in value && 'message' in value) {
    return fromPostgresError(value as PostgrestLikeError, requestId);
  }
  const err = new InternalError();
  err.requestId = requestId;
  return err;
}
