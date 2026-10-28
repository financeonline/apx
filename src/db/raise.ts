import {
  ConflictError, NotFound, PermissionDenied, QuotaExceeded, ValidationError, type MotionError,
} from '@/core/errors';

/**
 * The SQL functions' `raise exception 'CODE: sentence' using errcode = …` (DATABASE_ARCHITECTURE.md
 * §14.1), as typed errors. Each produces exactly what `fromPostgresError` made of the same SQLSTATE,
 * so a refusal reads the same to the user after the move as before it.
 *
 *   P0002 → notFound   42501 → denied   22023 → invalid   23505/23514/40001 → conflict   53400 → quota
 *
 * `notFound()` takes no message on purpose: "not in your accessible set" and "does not exist" must
 * be indistinguishable (SECURITY_MODEL.md §14).
 */
export interface Raise {
  notFound(): never;
  denied(sentence?: string): never;
  invalid(sentence: string): never;
  conflict(sentence: string, context?: Readonly<Record<string, unknown>>): never;
  quota(sentence: string, resetAt?: Date): never;
}

// Typed explicitly so a call narrows the way a `raise exception` ends the function (TS control flow).
export const raise: Raise = {
  notFound(): never {
    throw new NotFound('Not found');
  },
  denied(sentence?: string): never {
    throw new PermissionDenied(sentence);
  },
  invalid(sentence: string): never {
    throw new ValidationError(sentence);
  },
  conflict(sentence: string, context?: Readonly<Record<string, unknown>>): never {
    throw new ConflictError(sentence, context);
  },
  quota(sentence: string, resetAt?: Date): never {
    throw new QuotaExceeded(sentence, resetAt);
  },
};

export type { MotionError };
