import 'server-only';
import type { Transaction } from 'firebase-admin/firestore';
import { ConflictError, MotionError, ValidationError } from '@/core/errors';
import { MissingArgument } from './registry';
import type { Db } from './types';

/**
 * A Firestore transaction with the database's error contract (FIRESTORE_DATA_MODEL.md §7).
 *
 * Firestore retries a transaction that lost a race; one that keeps losing becomes CONFLICT, as a
 * serialization failure (40001) did. Two rules carry over from PL/pgSQL and are easy to forget:
 *
 *  1. every READ must happen before the first WRITE — gather, decide, then write;
 *  2. the function may run more than once, so it must not have side effects outside `tx`
 *     (no audit written with `audit()`, no job enqueued, no file touched — use the `prepare*`
 *     helpers and write through `tx`).
 */
export async function runTx<T>(db: Db, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    return await db.fs.runTransaction(fn, { maxAttempts: 5 });
  } catch (error) {
    if (error instanceof MotionError) throw error;
    if (error instanceof MissingArgument) throw new ValidationError(error.message);
    const code = (error as { code?: unknown }).code;
    // gRPC ABORTED (10): contention that outlasted the retries.
    if (code === 10 || code === 'aborted') {
      throw new ConflictError('That changed while you were saving it. Please try again.');
    }
    throw error;
  }
}
