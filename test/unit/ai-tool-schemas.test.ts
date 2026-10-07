import { describe, expect, it } from 'vitest';
import { TOOLS, submitAnswerTool, toSdkTool } from '@/modules/ai';

/**
 * The model API refuses a tool whose input schema is not an object at the top level ("tools.N …
 * type: Field required"). One union-input tool made every analyst call fail until 2026-10-07; this
 * keeps every tool the analyst offers an object schema.
 */
describe('every analyst tool schema is an object at the top level', () => {
  const tools = [...Object.values(TOOLS).map((t) => toSdkTool(t as Parameters<typeof toSdkTool>[0])), submitAnswerTool()];

  it.each(tools.map((t) => [t.name, t] as const))('%s', (_name, tool) => {
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema).not.toHaveProperty('anyOf');
  });

  it('a union tool offers every variant\'s fields, requiring only the shared ones', () => {
    const evidence = tools.find((t) => t.name === 'get_transactions_for_evidence')!;
    const props = Object.keys((evidence.input_schema.properties ?? {}) as object);
    expect(props).toContain('metric_snapshot_id');
    expect(props.length).toBeGreaterThan(1);
  });
});
