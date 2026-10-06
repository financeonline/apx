import type { z } from 'zod';
import type { Permission } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import type { PeriodContext, PeriodRef } from '../periods';

/**
 * The tool contract (AI_ARCHITECTURE.md §3, §4).
 *
 * A tool is a typed TypeScript function that calls a module service with the asking user's
 * `AccessContext` (ADR-010, ADR-014). The registry is CLOSED: adding a tool means adding a
 * definition here with a permission, a Zod input, a branded numeric output and a test (§3).
 *
 * Three things are structural rather than remembered:
 *   * the model never sees `ctx` — it is injected by the loop, refreshed before every call (§4);
 *   * the organisation comes from `ctx.orgId`, never from an argument — the input schemas carry no
 *     `organization_id`, and Zod STRIPS any unknown property the model adds (§4). Tool inputs are
 *     therefore `z.object`, never `z.strictObject`: a strict schema would REFUSE the call, which
 *     teaches the model to retry, whereas stripping makes a foreign `organization_id` inert. (The
 *     response contract in `contract.ts` is strict for the opposite reason — there, an unknown
 *     field is the model asserting something the server owns, R2-C-08.)
 *   * a period label the model passes must be one the turn already knows (`period_context` or an
 *     earlier `meta.periods`), or the tool answers `PERIOD_NOT_FOUND` — never the nearest period.
 */

export type ToolErrorCode =
  | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'PERIOD_NOT_FOUND' | 'NO_DATA'
  | 'INSUFFICIENT_DATA' | 'TIMEOUT' | 'INTERNAL';

export interface ToolError {
  readonly code: ToolErrorCode;
  /** Relayed verbatim by the model. Never carries a figure the model could quote (§7.1). */
  readonly message: string;
  readonly hint?: string;
}

export interface ToolMeta {
  readonly periods: readonly PeriodRef[];
  readonly basis?: string;
  readonly assurance_level?: string;
  readonly calculation_run_id: string | null;
  readonly computed_at: string;
}

export type ToolOutcome<T> =
  | { readonly ok: true; readonly data: T; readonly meta: ToolMeta }
  | { readonly ok: false; readonly error: ToolError };

/** What the loop hands a tool beyond its validated input. */
export interface ToolCallContext {
  readonly ctx: AccessContext;
  readonly periodContext: PeriodContext;
  /** `meta.periods` of every earlier tool result this turn (§3 "Period inputs"). */
  readonly knownPeriods: readonly PeriodRef[];
  /** ISO instant the turn started; every tool's `computed_at` and "today" derive from it. */
  readonly now: Date;
  /**
   * This turn's question as the person typed it. Only `check_affordability` reads it, to prove an
   * amount came from the person and not the model (ADR-146). Absent outside a live turn.
   */
  readonly question?: string;
}

export interface ToolDefinition<I, O> {
  readonly name: string;
  /** Shown to the model. States when to use it and that `period` comes from `period_context`. */
  readonly description: string;
  readonly permission: Permission;
  readonly input: z.ZodType<I>;
  readonly run: (input: I, call: ToolCallContext) => Promise<ToolOutcome<O>>;
}

/** Every evidence id and descriptor hash a result carried — what the bundle may cite (§14.2). */
export interface ReturnedRefs {
  readonly ids: readonly string[];
  readonly hashes: readonly string[];
}
