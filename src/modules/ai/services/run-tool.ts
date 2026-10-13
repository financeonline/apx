import 'server-only';
import { createHash } from 'node:crypto';
import { PermissionDenied } from '@/core/errors';
import { can, type Permission } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { returnedRefs } from '../domain/tools/envelope';
import { TOOL_TIMEOUT_MS, toolNamed } from '../domain/tools/registry';
import type { ToolCallContext, ToolError, ToolOutcome } from '../domain/tools/types';
import type { ToolResult } from '../domain/allowed-set';
import type { PersistedToolCall } from '@/core/db';
import { moduleOn } from '@/modules/tenancy';
import { toolModule } from '../domain/tool-modules';

/**
 * Running one tool the way §4 requires (AI_ARCHITECTURE.md §2 step 7, §4; ADR-032.8, F-C-17).
 *
 * Before EVERY call the access context is re-resolved. If the effective role or the permission set
 * differs from the one the turn started with, the turn aborts — a demotion or a revocation during a
 * 45 s turn cannot be exploited by a call that was already in flight. Then `assertCan` runs here,
 * before the tool, and the service asserts again inside (defence in depth, RBAC §4).
 *
 * Every invocation — allowed, denied, failed, timed out — produces a `PersistedToolCall` for
 * `api_server.ai_persist_turn`, with `authorized`, the denial reason, an output hash and a summary
 * (never the payload), and the ids/hashes the result returned, which are the only ids the bundle
 * may later cite (§14.2).
 */

export class ContextChanged extends Error {
  constructor() { super('The caller’s access changed during the turn.'); }
}

export interface TurnAccess {
  readonly effectiveRole: string;
  readonly permissions: readonly Permission[];
}

export function snapshotAccess(ctx: AccessContext): TurnAccess {
  return { effectiveRole: ctx.effectiveRole, permissions: [...ctx.permissions].sort() };
}

function sameAccess(a: TurnAccess, b: TurnAccess): boolean {
  return a.effectiveRole === b.effectiveRole
    && a.permissions.length === b.permissions.length
    && a.permissions.every((p, i) => p === b.permissions[i]);
}

export interface RunToolInput {
  readonly seq: number;
  readonly name: string;
  readonly rawInput: unknown;
  /** Re-resolves the access context; the loop supplies the real resolver, tests a fake. */
  readonly resolveAccess: () => Promise<AccessContext>;
  readonly started: TurnAccess;
  readonly call: Omit<ToolCallContext, 'ctx'>;
}

export interface RunToolOutput {
  readonly result: ToolResult;
  readonly persisted: PersistedToolCall;
}

function summarise(outcome: ToolOutcome<unknown>): Record<string, unknown> {
  if (!outcome.ok) return { ok: false, code: outcome.error.code };
  const data = outcome.data as Record<string, unknown> | null;
  const keys = data && typeof data === 'object' ? Object.keys(data) : [];
  const counts: Record<string, number> = {};
  for (const key of keys) {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return { ok: true, keys, counts, periods: outcome.meta.periods.map((p) => p.label) };
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function errorOutcome(code: ToolError['code'], message: string): ToolOutcome<never> {
  return { ok: false, error: { code, message } };
}

export async function runTool(input: RunToolInput): Promise<RunToolOutput> {
  const startedAt = Date.now();
  const tool = toolNamed(input.name);
  const finish = (
    outcome: ToolOutcome<unknown>,
    extra: Partial<Pick<PersistedToolCall, 'authorized' | 'denial_reason' | 'error'>> = {},
  ): RunToolOutput => {
    const refs = outcome.ok ? returnedRefs(outcome.data, outcome.meta.calculation_run_id) : { ids: [], hashes: [] };
    return {
      result: {
        seq: input.seq, name: input.name, ok: outcome.ok,
        data: outcome.ok ? outcome.data : outcome.error,
        ...(outcome.ok ? { meta: { periods: outcome.meta.periods, calculation_run_id: outcome.meta.calculation_run_id } } : {}),
      },
      persisted: {
        sequence: input.seq, tool_name: input.name,
        input: (input.rawInput && typeof input.rawInput === 'object' ? input.rawInput : {}) as Record<string, unknown>,
        authorized: extra.authorized ?? true,
        denial_reason: extra.denial_reason ?? null,
        output_hash: outcome.ok ? hashOf(outcome.data) : null,
        output_summary: summarise(outcome),
        duration_ms: Date.now() - startedAt,
        error: extra.error ?? (outcome.ok ? null : outcome.error.message),
        returned_ids: refs.ids, returned_hashes: refs.hashes,
      },
    };
  };

  if (!tool) {
    return finish(errorOutcome('NOT_FOUND', 'No such tool.'), { authorized: false, denial_reason: 'unknown_tool' });
  }

  // §4: re-resolve before every call; abort the turn on any change.
  const ctx = await input.resolveAccess();
  if (!sameAccess(input.started, snapshotAccess(ctx))) {
    finish(errorOutcome('PERMISSION_DENIED', 'Your access changed during this question.'),
      { authorized: false, denial_reason: 'context_changed' });
    throw new ContextChanged();
  }

  // ADR-158: a tool of a system switched off for this organisation never runs, even if asked for.
  const system = toolModule(tool.name);
  if (system !== null && !moduleOn(ctx, system)) {
    return finish(
      errorOutcome('NOT_FOUND', 'That part of APX is not switched on for this organisation.'),
      { authorized: false, denial_reason: `module_off:${system}` },
    );
  }

  if (!can(ctx, tool.permission)) {
    return finish(
      errorOutcome('PERMISSION_DENIED', deniedMessage(tool.name)),
      { authorized: false, denial_reason: `missing:${tool.permission}` },
    );
  }

  // Zod strips unknown properties, so an `organization_id` the model added never reaches the tool.
  const parsed = tool.input.safeParse(input.rawInput);
  if (!parsed.success) {
    return finish(errorOutcome('NOT_FOUND', 'The request did not match what this tool accepts.'), {
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300),
    });
  }

  try {
    const outcome = await Promise.race<ToolOutcome<unknown>>([
      tool.run(parsed.data, { ...input.call, ctx }),
      new Promise<ToolOutcome<unknown>>((resolve) =>
        setTimeout(() => resolve(errorOutcome('TIMEOUT', 'That took too long to look up.')), TOOL_TIMEOUT_MS)),
    ]);
    return finish(outcome);
  } catch (cause) {
    if (cause instanceof PermissionDenied) {
      return finish(errorOutcome('PERMISSION_DENIED', deniedMessage(tool.name)),
        { authorized: false, denial_reason: 'service_denied' });
    }
    // Logged by the caller with the request id; the model sees only that it failed.
    return finish(errorOutcome('INTERNAL', 'That could not be looked up right now.'),
      { error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause) });
  }
}

function deniedMessage(toolName: string): string {
  return toolName === 'get_source_document_reference'
    ? 'Source documents are not available to your role.'
    : 'That is not available to your role.';
}
