import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMetricBundle } from '@/core/db';
import { NotFound, toMotionError, ValidationError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { minAssurance, isAssuranceLevel, type AssuranceLevel } from '../domain/assurance';
import { descriptorHash } from '../domain/canonical';
import { EvidenceQuerySchema, type EvidenceQuery, type QueryDescriptorV1 } from '../domain/descriptor';
import { accountLabel, calculationRunLabel, counterpartyLabel, metricSnapshotLabel, queryLabel } from '../domain/labels';
import { compileDescriptor } from '../data/descriptor-compiler';
import { fetchCalculationRun, fetchMetricSnapshot } from '../data/bundles';
import type { Row } from '../data/rows';
import { requireOrgId, resolveCompiled } from './resolve';

/**
 * `buildBundleForMetric` (EVIDENCE_MODEL.md §5, §9).
 *
 * A metric snapshot IS its own evidence root — `metric_snapshots.evidence_query` is either a `leaf`
 * descriptor or a `derived` list of component snapshot ids (ADR-034) — so nothing is written when a
 * run finishes. This materialises the bundle the first time somebody clicks "Why?" on that figure,
 * and `api_server.build_metric_bundle_as` returns the same bundle for every later click: bundles are
 * immutable (§8.1), and a second bundle for one snapshot would be a second answer to a question with
 * one — which is an index, not a comment (ADR-066).
 *
 * A derived metric is walked all the way down. §5: "one `metric_snapshot` item per component,
 * recursively expanded to leaves so the drawer can reconcile each" — which is what makes level 3's
 * per-component reconciliation blocks possible without the drawer discovering the shape of the
 * calculation one round trip at a time.
 */

interface DraftItem {
  readonly item_type: 'metric_snapshot' | 'calculation_run' | 'query' | 'counterparty' | 'account';
  readonly ref_id?: string;
  readonly query_descriptor?: QueryDescriptorV1;
  readonly descriptor_hash?: string;
  readonly label: string;
  readonly assurance_level: AssuranceLevel;
}

function str(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function assuranceOf(row: Row, what: string): AssuranceLevel {
  const value = row.assurance_level;
  if (!isAssuranceLevel(value)) {
    throw new ValidationError(`${what} carries an unrecognised assurance level.`, [
      { path: 'assurance_level', message: String(value) },
    ]);
  }
  return value;
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

async function periodLabel(db: SupabaseClient, orgId: string, periodId: string): Promise<string | null> {
  const { data, error } = await db
    .from('fiscal_periods')
    .select('label')
    .eq('organization_id', orgId)
    .eq('id', periodId)
    .maybeSingle();
  if (error) throw toMotionError(error);
  return (data as { label?: string } | null)?.label ?? null;
}

/** The counterparty or account a dimensioned snapshot is about (§5, "Dimension metrics add …"). */
async function dimensionItem(
  db: SupabaseClient,
  orgId: string,
  snapshot: Row,
): Promise<{ item: DraftItem; label: string } | null> {
  const type = str(snapshot, 'dimension_type');
  const id = str(snapshot, 'dimension_id');
  if (id === null || type === null || type === 'none') return null;

  if (type === 'counterparty') {
    const { data, error } = await db
      .from('counterparties').select('name').eq('organization_id', orgId).eq('id', id).maybeSingle();
    if (error) throw toMotionError(error);
    const name = (data as { name?: string } | null)?.name;
    if (name === undefined) return null;
    const label = counterpartyLabel({ name });
    return { item: { item_type: 'counterparty', ref_id: id, label, assurance_level: 'verified' }, label };
  }

  if (type === 'account' || type === 'category') {
    const { data, error } = await db
      .from('accounts').select('code, name').eq('organization_id', orgId).eq('id', id).maybeSingle();
    if (error) throw toMotionError(error);
    const row = data as { code?: string | null; name?: string } | null;
    if (row?.name === undefined) return null;
    const label = accountLabel({ code: row.code ?? null, name: row.name });
    return { item: { item_type: 'account', ref_id: id, label, assurance_level: 'verified' }, label };
  }

  return null;
}

/**
 * §7: a descriptor item's assurance is "the *minimum* assurance over the resolved set, computed at
 * build time and stored". That means resolving the selection once here — the alternative is storing
 * the snapshot's own assurance, which would let a metric calculated from one AI-read PDF row show as
 * `verified` because the arithmetic was exact.
 */
async function queryItemAssurance(
  ctx: AccessContext,
  descriptor: QueryDescriptorV1,
  fallback: AssuranceLevel,
): Promise<AssuranceLevel> {
  const selection = await resolveCompiled(ctx, compileDescriptor(descriptor));
  const levels: AssuranceLevel[] = [];
  for (const row of selection.rows) {
    if (isAssuranceLevel(row.assuranceLevel)) levels.push(row.assuranceLevel);
  }
  return minAssurance(levels) ?? fallback;
}

interface WalkState {
  readonly ctx: AccessContext;
  readonly orgId: string;
  readonly items: DraftItem[];
  /** A derived tree can reach one snapshot by two routes; it is cited once. */
  readonly seen: Set<string>;
}

/**
 * One node of the `evidence_query` tree: the snapshot's own item, then either its leaf descriptor or
 * its components, depth-first, so the drawer reads top-down in the order the calculation composes.
 */
async function walk(state: WalkState, snapshot: Row): Promise<void> {
  const id = String(snapshot.id);
  if (state.seen.has(id)) return;
  state.seen.add(id);

  const { ctx, orgId } = state;
  const metricKey = String(snapshot.metric_key);
  const assurance = assuranceOf(snapshot, 'A metric snapshot');
  const label = metricSnapshotLabel({
    metricKey,
    periodLabel: await periodLabel(ctx.db, orgId, String(snapshot.period_id)),
    basis: String(snapshot.basis),
    dimensionLabel: (await dimensionItem(ctx.db, orgId, snapshot))?.label ?? null,
  });

  state.items.push({ item_type: 'metric_snapshot', ref_id: id, label, assurance_level: assurance });

  const evidenceQuery = parseEvidenceQuery(snapshot.evidence_query);
  if (evidenceQuery === null) {
    /*
     * A snapshot with no `evidence_query` is one the engine wrote before it could say where the
     * figure came from. It is still cited — the number is real — but there is nothing to descend
     * into, and inventing a descriptor for it would be inventing the answer.
     */
    return;
  }

  if (evidenceQuery.kind === 'leaf') {
    const descriptor = evidenceQuery.descriptor;
    state.items.push({
      item_type: 'query',
      query_descriptor: descriptor,
      descriptor_hash: descriptorHash(descriptor),
      label: queryLabel({ table: descriptor.table, ofMetricLabel: label }),
      assurance_level: await queryItemAssurance(ctx, descriptor, assurance),
    });
    return;
  }

  if (evidenceQuery.kind === 'difference') {
    /*
     * Step 0E: a cumulative report's month = year to date (P) − year to date (P−1). Each readable
     * term is its own record selection, labelled with its period and its role in the subtraction; an
     * unreadable term has no records to cite (the drawer states why, from the snapshot).
     */
    for (const term of evidenceQuery.terms) {
      if (term.descriptor === null) continue;
      const termPeriod = term.period_id === null ? null : await periodLabel(ctx.db, orgId, term.period_id);
      const role = term.sign === 1 ? 'year to date' : 'less: year to date';
      state.items.push({
        item_type: 'query',
        query_descriptor: term.descriptor,
        descriptor_hash: descriptorHash(term.descriptor),
        label: `${queryLabel({ table: term.descriptor.table, ofMetricLabel: label })} — ${role}${termPeriod ? ` to ${termPeriod}` : ''}`,
        assurance_level: await queryItemAssurance(ctx, term.descriptor, assurance),
      });
    }
    return;
  }

  for (const component of evidenceQuery.components) {
    const row = await fetchMetricSnapshot(ctx.db, orgId, component.snapshot_id);
    // §8.2: a snapshot an evidence item references is never archived, so a missing component is an
    // integrity failure, not an empty branch to render as zero.
    if (row === null) throw new NotFound();
    await walk(state, row);
  }

}

/**
 * §9: `buildBundleForMetric(ctx, snapshotId) → BundleId`, cached by snapshot.
 *
 * The cache is the server function's, not this one's: it returns the existing bundle for the
 * snapshot before inserting anything, under a per-snapshot lock, so two readers opening the same
 * figure at the same instant both get the same id.
 */
export async function buildBundleForMetric(
  ctx: AccessContext,
  snapshotId: string,
): Promise<string> {
  assertCan(ctx, 'financials.view');
  const orgId = requireOrgId(ctx);

  const snapshot = await fetchMetricSnapshot(ctx.db, orgId, snapshotId);
  if (snapshot === null) throw new NotFound();

  const items: DraftItem[] = [];

  const runId = str(snapshot, 'calculation_run_id');
  if (runId !== null) {
    const run = await fetchCalculationRun(ctx.db, orgId, runId);
    if (run !== null) {
      items.push({
        item_type: 'calculation_run',
        ref_id: runId,
        label: calculationRunLabel({
          engineVersion: String(run.engine_version),
          finishedAt: str(run, 'finished_at'),
        }),
        // A run is not a claim about data quality; it is the "as of" context (§2.2).
        assurance_level: 'verified',
      });
    }
  }

  const state: WalkState = { ctx, orgId, items: [], seen: new Set() };
  await walk(state, snapshot);

  // §5 order: the snapshot, its calculation_run, then the descriptor or the components.
  const root = state.items.shift();
  if (root === undefined) throw new NotFound();
  const dimension = await dimensionItem(ctx.db, orgId, snapshot);
  const ordered = [
    root,
    ...items,
    ...(dimension === null ? [] : [dimension.item]),
    ...state.items,
  ];

  /*
   * Written through `api_server`, never `api` (ADR-066). The walk above ran under the caller's own
   * client, so every snapshot it cited is one the caller may read; the function re-derives the tree
   * in SQL and refuses any item outside it, so even this server-side list cannot carry anything the
   * snapshot does not itself say. There is no bundle-writing function a browser token can call.
   */
  return buildMetricBundle(
    { userId: ctx.userId, requestId: ctx.requestId },
    {
      snapshotId,
      items: ordered.map((item) => ({
        item_type: item.item_type,
        ref_id: item.ref_id ?? null,
        query_descriptor: item.query_descriptor ?? null,
        descriptor_hash: item.descriptor_hash ?? null,
        label: item.label,
        assurance_level: item.assurance_level,
      })),
    },
  );
}
