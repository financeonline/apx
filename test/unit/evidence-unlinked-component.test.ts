import { describe, expect, it } from 'vitest';
import { EvidenceQuerySchema } from '@/modules/evidence';

/**
 * A derived figure may name a component the engine could not link (`snapshot_id: null` — a
 * balance-sheet term such as inventory, or a per-customer breakdown). The evidence reader must accept
 * it: refusing the whole figure is what made "Why?" on Cash fail (2026-11-01).
 */
describe('derived evidence with an unlinked component', () => {
  const id = '00000000-0000-4000-8000-000000000001';

  it('is accepted, keeping the null', () => {
    const parsed = EvidenceQuerySchema.parse({
      kind: 'derived',
      components: [{ name: 'closing_cash', snapshot_id: id }, { name: 'inventory', snapshot_id: null }],
    });
    expect(parsed.kind === 'derived' && parsed.components.map((c) => c.snapshot_id)).toEqual([id, null]);
  });

  it('still refuses a malformed id or an empty component list', () => {
    expect(EvidenceQuerySchema.safeParse({ kind: 'derived', components: [{ name: 'x', snapshot_id: 'not-a-uuid' }] }).success).toBe(false);
    expect(EvidenceQuerySchema.safeParse({ kind: 'derived', components: [] }).success).toBe(false);
  });
});
