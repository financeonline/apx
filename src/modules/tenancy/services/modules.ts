import { NotFound } from '@/core/errors';
import type { AccessContext } from '../context';
import { enabledModules, type ModuleKey } from '../domain/modules';

/** ADR-158: whether this organisation may use a system. A context without `modules` has the defaults. */
export function moduleOn(ctx: AccessContext, key: ModuleKey): boolean {
  return (ctx.modules ?? enabledModules(undefined)).has(key);
}

/** A page or action of a switched-off system answers "not found" — the system is absent, not locked. */
export function requireModule(ctx: AccessContext, key: ModuleKey): void {
  if (!moduleOn(ctx, key)) throw new NotFound();
}
