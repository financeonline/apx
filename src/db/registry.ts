import type { Db } from './types';

/**
 * The contract every ported database function keeps (FIRESTORE_DATA_MODEL.md §6).
 *
 * An `api.*` or `api_server.*` SQL function becomes a TypeScript function of the SAME NAME, taking
 * the SAME `p_`-prefixed arguments and returning the SAME shape (a scalar, a row, or an array of
 * rows with snake_case fields) — so `callApi(db, 'create_action', { p_org, p_input, p_source })`
 * and every service built on it are unchanged by the move. What was a SQL `raise` is a thrown
 * MotionError (`src/db/raise.ts`).
 *
 * `api.*` functions run for the caller in `db.actor` (a user); `api_server.*` functions are called
 * only by `core/db/server-rpc.ts` and the job workers, with a service actor.
 */
export type DbFunction = (db: Db, args: Record<string, unknown>) => Promise<unknown>;
export type DbFunctions = Readonly<Record<string, DbFunction>>;

/** Small argument readers, so each function validates its inputs the way the SQL types did. */
export const arg = {
  str(args: Record<string, unknown>, name: string): string | null {
    const v = args[name];
    if (v === undefined || v === null) return null;
    return String(v);
  },
  req(args: Record<string, unknown>, name: string): string {
    const v = args[name];
    if (v === undefined || v === null || v === '') throw new MissingArgument(name);
    return String(v);
  },
  bool(args: Record<string, unknown>, name: string): boolean | null {
    const v = args[name];
    return v === undefined || v === null ? null : Boolean(v);
  },
  num(args: Record<string, unknown>, name: string): number | null {
    const v = args[name];
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  obj(args: Record<string, unknown>, name: string): Record<string, unknown> {
    const v = args[name];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  },
  arr<T = unknown>(args: Record<string, unknown>, name: string): T[] | null {
    const v = args[name];
    return Array.isArray(v) ? (v as T[]) : null;
  },
};

/** A required argument was absent: the SQL function would have failed its NOT NULL / type check. */
export class MissingArgument extends Error {
  constructor(name: string) {
    super(`missing argument ${name}`);
  }
}
