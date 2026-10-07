import { describe, expect, it } from 'vitest';
import { MODULES, enabledModules, moduleOn, type AccessContext } from '@/modules/tenancy';
import { TOOLS, TOOL_MODULES } from '@/modules/ai';

/** ADR-158: which systems a company may use, and the AI tools that follow them. */
describe('enabledModules', () => {
  it('a company with no switches has every default-on system, and not the two opt-in ones', () => {
    const on = enabledModules({});
    for (const m of MODULES) expect(on.has(m.key)).toBe(m.defaultOn);
    expect(on.has('funding')).toBe(false);
    expect(on.has('banking')).toBe(true);
  });

  it('reads a system switched off, and an opt-in one switched on', () => {
    const on = enabledModules({ module_banking: false, funding_readiness: true });
    expect(on.has('banking')).toBe(false);
    expect(on.has('funding')).toBe(true);
    expect(on.has('customers')).toBe(true);
  });

  it('moduleOn uses the context\'s systems, and the defaults when a context carries none', () => {
    const base = {} as AccessContext;
    expect(moduleOn(base, 'reports')).toBe(true);
    expect(moduleOn({ ...base, modules: enabledModules({ module_reports: false }) }, 'reports')).toBe(false);
  });
});

describe('AI tools follow their systems', () => {
  it('every mapped tool exists, so a renamed tool cannot silently escape its switch', () => {
    const names = new Set(Object.values(TOOLS).map((t) => (t as { name: string }).name));
    for (const tool of Object.keys(TOOL_MODULES)) expect(names.has(tool), tool).toBe(true);
  });
});
