import 'server-only';
import { InternalError, NotFound, ValidationError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { isAssuranceLevel, minAssurance, type AssuranceLevel } from '../domain/assurance';
import { descriptorHash } from '../domain/canonical';
import {
  EvidenceQuerySchema,
  parseQueryDescriptor,
  type EvidenceQuery,
  type QueryDescriptorV1,
} from '../domain/descriptor';
import { compileDescriptor } from '../data/descriptor-compiler';
import {
  fetchBundle,
  fetchBundleItems,
  fetchCalculationRun,
  fetchEvidenceItem,
  fetchMetricSnapshot,
  fetchPinnedLifecycle,
  isPinnedItemType,
  ITEM_TYPE_TABLE,
  type EvidenceItemType,
} from '../data/bundles';
import type { Row } from '../data/rows';
import { assertBundleOrg, requireOrgId, resolveCompiled, type Cursor, type ResolvedSelection } from './resolve';

/**
 * The read side of the §9 service contract that can be built against the schema as it stands.
 *
 * `buildBundleForAlert`, `buildBundleForHealthScore`, `buildBundleForAiResponse`,
 * `buildBundleForMetric` and `cloneBundleForAction` are deliberately **absent**: they are write
 * paths through `api.*` functions that need engines this phase does not have — the alert rules
 * (Phase 9), the health score (Phase 8), the AI grounding check (Phase 11) and the calculation
 * engine that writes `metric_snapshots.evidence_query` in the first place (Phase 6). Nothing here is
 * a stub that looks implemented.
 *
 * `getDocumentReference` is likewise absent: it mints a signed URL through `core/storage/signer.ts`
 * and writes a `document.viewed` audit row (§10, ADR-038.1), which is Phase 10 drawer work.
 */

export interface EvidenceRefView {
  readonly table: string;
  readonly id: string;
  /** `null` for objects with no supersession lifecycle (a run, an account, a period). */
  readonly superseded: boolean | null;
  readonly recordStatus: string | null;
  /** §2.2: an `alert` item pins the exact `alert_revisions.revision_no` that was cited. */
  readonly revisionNo: number | null;
}

export interface EvidenceItemView {
  readonly id: string;
  readonly itemType: EvidenceItemType;
  /** Always server-generated from the referenced object; the AI contract carries no label (R2-C-08). */
  readonly label: string;
  readonly claim: string | null;
  readonly assurance: AssuranceLevel;
  readonly ref?: EvidenceRefView;
  readonly query?: QueryDescriptorV1;
  /** Lower-case hex, as exposed in tool outputs and the AI contract (§3). */
  readonly descriptorHash?: string;
}

export interface EvidenceBundleView {
  readonly id: string;
  readonly kind: string;
  readonly origin: { readonly table: string; readonly id: string | null };
  readonly asOf: {
    readonly calculationRunId: string;
    readonly engineVersion: string;
    readonly finishedAt: string | null;
  } | null;
  readonly items: EvidenceItemView[];
  /** §7: the minimum over items. `null` only for an empty bundle, which §8.6 forbids producing. */
  readonly assurance: AssuranceLevel | null;
}

export type ResolvedItem =
  | { readonly kind: 'record'; readonly item: EvidenceItemView; readonly ref: EvidenceRefView }
  | { readonly kind: 'query'; readonly item: EvidenceItemView; readonly selection: ResolvedSelection };

export interface DerivedComponentView {
  readonly name: string;
  readonly snapshotId: string;
  /** NUMERIC(20,6) as a string; `null` means "not computable", which is not zero. */
  readonly value: string | null;
  /** True when the component is itself a leaf, i.e. it descends straight to records. */
  readonly leaf: boolean;
}

function str(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function assuranceOf(row: Row): AssuranceLevel {
  const value = row.assurance_level;
  if (!isAssuranceLevel(value)) {
    throw new ValidationError('An evidence item carries an unrecognised assurance level.', [
      { path: 'assurance_level', message: String(value) },
    ]);
  }
  return value;
}

/**
 * `descriptor_hash` comes back from PostgREST as a `bytea` hex literal (`\x…`). The contract form
 * is lower-case hex without the prefix (§3), so the prefix is stripped rather than re-derived —
 * re-hashing here would hide a descriptor whose stored hash had drifted from its stored JSON.
 */
function hashHex(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return (value.startsWith('\\x') ? value.slice(2) : value).toLowerCase();
}

async function toItemView(ctx: AccessContext, orgId: string, row: Row): Promise<EvidenceItemView> {
  const itemTypeRaw = String(row.item_type);
  const label = String(row.label);
  const claim = str(row, 'claim');
  const assurance = assuranceOf(row);
  const id = String(row.id);

  if (itemTypeRaw === 'query') {
    const descriptor = parseQueryDescriptor(row.query_descriptor);
    const hash = hashHex(row.descriptor_hash);
    /*
     * The stored hash is COMPARED, never replaced (ADR-046.2, ADR-066). A descriptor whose JSON
     * and hash disagree is an item somebody or something altered after it was written — the one
     * thing an append-only evidence table exists to make impossible — and it is refused loudly
     * rather than resolved as though it were the engine's.
     */
    if (hash !== undefined && descriptorHash(descriptor) !== hash) {
      throw new InternalError('An evidence item’s descriptor does not match its recorded hash.');
    }
    return {
      id,
      itemType: 'query',
      label,
      claim,
      assurance,
      query: descriptor,
      ...(hash === undefined ? {} : { descriptorHash: hash }),
    };
  }

  if (!isPinnedItemType(itemTypeRaw)) {
    throw new ValidationError('An evidence item carries an unrecognised item type.', [
      { path: 'item_type', message: itemTypeRaw },
    ]);
  }

  const refId = str(row, 'ref_id');
  if (refId === null) {
    // `evidence_item_xor` guarantees exactly one of ref_id / query_descriptor, so this is a schema
    // violation rather than a caller error, and it is surfaced instead of rendered as an empty item.
    throw new ValidationError('An evidence item has neither a reference nor a descriptor.', [
      { path: 'ref_id', message: id },
    ]);
  }

  const table = ITEM_TYPE_TABLE[itemTypeRaw];
  const lifecycle = await fetchPinnedLifecycle(ctx.db, orgId, table, refId);
  const revision = row.ref_revision_no;

  return {
    id,
    itemType: itemTypeRaw,
    label,
    claim,
    assurance,
    ref: {
      table,
      id: refId,
      superseded: lifecycle.superseded,
      recordStatus: lifecycle.recordStatus,
      revisionNo: revision === null || revision === undefined ? null : Number(revision),
    },
  };
}

/** §9: the bundle with its items unresolved, plus the propagated assurance. */
export async function getBundle(ctx: AccessContext, bundleId: string): Promise<EvidenceBundleView> {
  assertCan(ctx, 'financials.view');
  const orgId = requireOrgId(ctx);

  // RLS already applies §8.9 (an ai_response bundle is readable only by the asker or by
  // owner/admin), so a bundle the caller may not see simply is not returned.
  const bundle = await fetchBundle(ctx.db, orgId, bundleId);
  if (bundle === null) throw new NotFound();
  assertBundleOrg(ctx, str(bundle, 'organization_id'));

  // Phase 16 (§10, U-5): a Funding Readiness bundle is NOT FOUND while the feature is off.
  if (String(bundle.kind) === 'funding_assessment') {
    const { data: org } = await ctx.db.from('organizations').select('features').eq('id', orgId).maybeSingle();
    if ((org as { features?: Record<string, unknown> } | null)?.features?.funding_readiness !== true) throw new NotFound();
  }

  const itemRows = await fetchBundleItems(ctx.db, orgId, bundleId);
  const items: EvidenceItemView[] = [];
  for (const row of itemRows) items.push(await toItemView(ctx, orgId, row));

  const runId = str(bundle, 'calculation_run_id');
  let asOf: EvidenceBundleView['asOf'] = null;
  if (runId !== null) {
    const run = await fetchCalculationRun(ctx.db, orgId, runId);
    if (run !== null) {
      asOf = {
        calculationRunId: runId,
        engineVersion: String(run.engine_version),
        finishedAt: str(run, 'finished_at'),
      };
    }
  }

  return {
    id: String(bundle.id),
    kind: String(bundle.kind),
    origin: { table: String(bundle.origin_table), id: str(bundle, 'origin_id') },
    asOf,
    items,
    assurance: minAssurance(items.map((item) => item.assurance)),
  };
}

/**
 * §9: a pinned item resolves to its record view; a `query` item resolves through the descriptor
 * resolver. A pinned item is **not** filtered by status (§8.3).
 */
export async function resolveItem(
  ctx: AccessContext,
  itemId: string,
  page?: Cursor,
): Promise<ResolvedItem> {
  assertCan(ctx, 'financials.view');
  const orgId = requireOrgId(ctx);

  const itemRow = await fetchEvidenceItem(ctx.db, orgId, itemId);
  if (itemRow === null) throw new NotFound();

  // The item's own RLS policy defers to its bundle's, so reading the bundle is what enforces the
  // ai_response ownership rule for tool 13's {evidence_item_id} input (§8.9, R2-C-12).
  const bundle = await fetchBundle(ctx.db, orgId, String(itemRow.bundle_id));
  if (bundle === null) throw new NotFound();
  assertBundleOrg(ctx, str(bundle, 'organization_id'));

  const item = await toItemView(ctx, orgId, itemRow);
  if (item.query !== undefined) {
    return { kind: 'query', item, selection: await resolveCompiled(ctx, compileDescriptor(item.query), page) };
  }
  if (item.ref === undefined) throw new NotFound();
  return { kind: 'record', item, ref: item.ref };
}

function parseEvidenceQuery(value: unknown): EvidenceQuery | null {
  if (value === null || value === undefined) return null;
  const result = EvidenceQuerySchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError('A metric snapshot carries an invalid evidence query.', [
      { path: 'evidence_query', message: result.error.issues[0]?.message ?? 'invalid' },
    ]);
  }
  return result.data;
}

/**
 * §9 / ADR-034: walk `evidence_query.kind = 'derived'` one level, so the drawer can show one
 * reconciliation block per component and descend into each.
 *
 * A leaf snapshot returns an empty component list rather than an error: "this figure comes straight
 * from records" is a real answer, and level 3 renders its descriptor instead.
 */
export async function resolveDerived(
  ctx: AccessContext,
  snapshotId: string,
): Promise<{ components: DerivedComponentView[] }> {
  assertCan(ctx, 'financials.view');
  const orgId = requireOrgId(ctx);

  const snapshot = await fetchMetricSnapshot(ctx.db, orgId, snapshotId);
  if (snapshot === null) throw new NotFound();

  const evidenceQuery = parseEvidenceQuery(snapshot.evidence_query);
  if (evidenceQuery === null || evidenceQuery.kind !== 'derived') return { components: [] };

  const components: DerivedComponentView[] = [];
  for (const component of evidenceQuery.components) {
    const row = await fetchMetricSnapshot(ctx.db, orgId, component.snapshot_id);
    if (row === null) {
      // §8.2: snapshots referenced by evidence are never archived, so a missing one is a real
      // integrity failure and must not be papered over with a zero.
      throw new NotFound();
    }
    const childQuery = parseEvidenceQuery(row.evidence_query);
    components.push({
      name: component.name,
      snapshotId: component.snapshot_id,
      value: str(row, 'value'),
      leaf: childQuery !== null && childQuery.kind === 'leaf',
    });
  }
  return { components };
}
