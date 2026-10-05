import 'server-only';
import { NotFound, toMotionError } from '@/core/errors';
import { formatMoney, parseDecimalOrNull } from '@/core/money';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { metricDefinition, isMetricKey, type MetricUnit } from '@/modules/financial-engine';
import type { AssuranceLevel } from '../domain/assurance';
import { parseQueryDescriptor } from '../domain/descriptor';
import { compileDescriptor } from '../data/descriptor-compiler';
import { fetchMetricSnapshot } from '../data/bundles';
import type { Row } from '../data/rows';
import { getBundle, type EvidenceBundleView } from './bundle';
import { itemCanReachDocument } from './document';
import { requireOrgId, resolveCompiled, type Cursor, type ResolvedSelection } from './resolve';

/**
 * The Evidence Drawer's five levels, assembled in one read (EVIDENCE_MODEL.md §6).
 *
 * §6 is explicit that the levels are "levels the user can descend, never all at once" — that is a
 * rendering rule, not a fetching one. Assembling them together is what makes the reconciliation at
 * level 3 possible: "500 of 1,238 rows shown; all rows total £120,000.00 = metric" is a statement
 * about the metric AND the selection, and a drawer that fetched them separately could show a total
 * next to a value from a different run without ever noticing.
 *
 * Level 4 is deliberately not here. A document reference is per-record and is fetched when a reader
 * picks a row (`getDocumentReference`), because level 3 can be a thousand rows from a dozen files.
 */

export interface DrawerComponent {
  readonly name: string;
  /** The component's own label, from the canonical §8.1 table. */
  readonly label: string;
  readonly snapshotId: string | null;
  /** NUMERIC as a string, never a number (ADR-006). `null` means "not computable", not zero. */
  readonly value: string | null;
  readonly unit: MetricUnit | null;
  readonly currency: string | null;
  readonly leaf: boolean;
}

export interface DrawerRecords {
  /** The `evidence_items.id` of the `query` item this block resolves. */
  readonly itemId: string;
  readonly label: string;
  /** The snapshot this selection is the evidence for — a derived metric has one block per leaf. */
  readonly forSnapshotId: string | null;
  readonly forLabel: string | null;
  readonly forValue: string | null;
  readonly selection: ResolvedSelection;
  /**
   * §6: "the block totals must reproduce the derived value". `null` when there is nothing to
   * compare — a ratio, a count, or a snapshot whose value was not computable.
   */
  readonly reconciles: boolean | null;
  /**
   * The reconciliation sentence §6 requires, written here rather than in the page.
   *
   * "500 of 1,238 rows shown; all rows total £120,000.00, which is the figure." The count and the
   * total are over the WHOLE selection, not the page, which is what lets a truncated list still
   * reconcile (§3). It is composed in the service because it is a statement ABOUT money and the
   * components do not do money (SERVICE_ARCHITECTURE.md §8).
   */
  readonly reconciliation: string;
  /** The row this page of the block starts at, so "back" is expressible as well as "next". */
  readonly offset: number;
}

/**
 * A record, entity or alert the bundle PINS (§4, §8.3).
 *
 * "The reader must see *that* row even if data later changes" — a duplicate pair, an unusual
 * payment, the overdue invoice a rule fired on, the alert revision an answer rests on. A pinned item
 * is deliberately NOT filtered by status: a superseded or rejected row is still fetched and shown
 * with its badge, because hiding it would erase the reason the claim was made.
 */
export interface DrawerPinned {
  readonly itemId: string;
  readonly itemType: string;
  readonly label: string;
  /** The sentence this item supports, when the producer recorded one (§2.2). */
  readonly claim: string | null;
  readonly table: string | null;
  readonly recordId: string | null;
  readonly superseded: boolean;
  readonly rejected: boolean;
  /** §2.2: an `alert` item pins the revision that was cited, not the alert's current text. */
  readonly revisionNo: number | null;
  /** Only the four record tables have a source document behind them (§5.1). */
  readonly canReachDocument: boolean;
}

export interface DrawerMetric {
  readonly snapshotId: string;
  readonly metricKey: string;
  readonly label: string;
  readonly description: string | null;
  readonly value: string | null;
  readonly unit: MetricUnit;
  readonly currency: string | null;
  readonly basis: string;
  readonly periodId: string;
  readonly periodLabel: string | null;
  readonly assurance: AssuranceLevel;
  readonly dataQuality: Record<string, unknown>;
  /** §8.2: false when a later run has replaced this figure. */
  readonly isCurrent: boolean;
  /** The value the current snapshot holds, when this one is no longer it (§8.2). */
  readonly currentValue: string | null;
  /**
   * Step 0D: the statements weaker than verified that a cash balance rests on — an AI-read or
   * unreconciled month it was carried through (`components.rests_on_statements`). Empty otherwise.
   */
  readonly restsOn: readonly RestsOnStatement[];
  /**
   * Step 0E: a figure that is the DIFFERENCE of two periods' records (a cumulative report's month):
   * the formula and each term — its period, the total of its records, or why it cannot be read.
   * NULL for every other figure.
   */
  readonly difference: DrawerDifference | null;
}

export interface DrawerDifference {
  readonly formula: string;
  readonly terms: ReadonlyArray<{
    readonly name: 'year_to_date' | 'prior_year_to_date';
    readonly sign: 1 | -1;
    readonly periodLabel: string | null;
    /** Σ of the term's records in reporting sign; NULL when the term is unavailable. */
    readonly total: string | null;
    readonly rowCount: number | null;
    /** The engine's reason the term cannot be read (e.g. `no_prior_trial_balance`). */
    readonly unavailable: string | null;
  }>;
}

/** Resolves each term of a `difference` evidence query (Step 0E), so the drawer can show the sum. */
async function differenceOf(ctx: AccessContext, orgId: string, snapshot: Row): Promise<DrawerDifference | null> {
  const query = snapshot.evidence_query as {
    kind?: string;
    formula?: string;
    terms?: Array<{ name: 'year_to_date' | 'prior_year_to_date'; sign: 1 | -1; period_id: string | null; descriptor: unknown; unavailable: string | null }>;
  } | null;
  if (query?.kind !== 'difference' || !Array.isArray(query.terms)) return null;
  const terms = [];
  for (const term of query.terms) {
    const periodLabel = term.period_id === null ? null : await periodLabelOf(ctx, orgId, term.period_id);
    if (term.descriptor === null || term.descriptor === undefined) {
      terms.push({ name: term.name, sign: term.sign, periodLabel, total: null, rowCount: null, unavailable: term.unavailable ?? 'unavailable' });
      continue;
    }
    const selection = await resolveCompiled(ctx, compileDescriptor(parseQueryDescriptor(term.descriptor)));
    terms.push({ name: term.name, sign: term.sign, periodLabel, total: selection.total, rowCount: selection.count, unavailable: null });
  }
  return { formula: query.formula ?? 'year_to_date - prior_year_to_date', terms };
}

export interface RestsOnStatement {
  readonly batchId: string;
  readonly fileName: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** `pdf_claude` (read by AI) or `pdf_text` (a text PDF that did not reconcile). */
  readonly extractionMethod: string | null;
}

/** The statements a cash snapshot says it rests on, read under the caller's own access. */
async function restsOnStatements(ctx: AccessContext, orgId: string, snapshot: Row): Promise<RestsOnStatement[]> {
  const ids = ((snapshot.components ?? {}) as { rests_on_statements?: unknown }).rests_on_statements;
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { data, error } = await ctx.db
    .from('import_batches')
    .select('id, period_start, period_end, extraction_method, source_documents(original_filename)')
    .eq('organization_id', orgId)
    .in('id', ids.map(String));
  if (error) throw toMotionError(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((b) => ({
    batchId: String(b.id),
    fileName: ((b.source_documents ?? null) as { original_filename?: string } | null)?.original_filename ?? null,
    periodStart: b.period_start === null ? null : String(b.period_start),
    periodEnd: b.period_end === null ? null : String(b.period_end),
    extractionMethod: b.extraction_method === null ? null : String(b.extraction_method),
  })).sort((a, b) => (a.periodStart ?? '').localeCompare(b.periodStart ?? ''));
}

export interface EvidenceDrawerView {
  readonly bundle: EvidenceBundleView;
  /** Level 1. `null` for a bundle with no metric in it — an alert pinning only records, say. */
  readonly metric: DrawerMetric | null;
  /** Level 2. Empty for a leaf metric, which descends straight to records. */
  readonly components: readonly DrawerComponent[];
  /**
   * Figures the bundle cites that are NOT parts of the calculation.
   *
   * An alert pins the figure it fired on and the one it compared against; the comparison is not a
   * component of anything, and rendering it under "how it was worked out" would tell a reader that
   * last month's revenue is part of this month's arithmetic.
   */
  readonly relatedFigures: readonly DrawerComponent[];
  /** Level 3, one block per `query` item. */
  readonly records: readonly DrawerRecords[];
  /** The specific rows and entities the bundle pins (§4), shown alongside the selections. */
  readonly pinned: readonly DrawerPinned[];
}

function str(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function metricLabelOf(metricKey: string): { label: string; description: string | null } {
  if (!isMetricKey(metricKey)) {
    // A variance key ("revenue.variance.prev_period") is composed, not declared. Naming it by its
    // key is honest; throwing would take down a drawer over a caption.
    return { label: metricKey, description: null };
  }
  const definition = metricDefinition(metricKey);
  return { label: definition.label, description: definition.description };
}

async function periodLabelOf(ctx: AccessContext, orgId: string, periodId: string): Promise<string | null> {
  const { data, error } = await ctx.db
    .from('fiscal_periods').select('label').eq('organization_id', orgId).eq('id', periodId).maybeSingle();
  if (error) throw toMotionError(error);
  return (data as { label?: string } | null)?.label ?? null;
}

/**
 * §8.2: "The drawer shows 'This figure has since been recalculated — current value £X' when the
 * referenced snapshot is not current."
 *
 * The comparison is against `metric_current`, which recalculation repoints; the old snapshot is
 * never rewritten, so an old bundle keeps resolving to the exact numbers that were shown.
 */
async function currency(
  ctx: AccessContext, orgId: string, snapshot: Row,
): Promise<{ isCurrent: boolean; currentValue: string | null }> {
  let q = ctx.db
    .from('metric_current')
    .select('snapshot_id')
    .eq('organization_id', orgId)
    .eq('period_id', String(snapshot.period_id))
    .eq('metric_key', String(snapshot.metric_key))
    .eq('dimension_type', String(snapshot.dimension_type));

  const dimensionId = str(snapshot, 'dimension_id');
  q = dimensionId === null ? q.is('dimension_id', null) : q.eq('dimension_id', dimensionId);

  const { data, error } = await q.maybeSingle();
  if (error) throw toMotionError(error);

  const currentId = (data as { snapshot_id?: string } | null)?.snapshot_id ?? null;
  if (currentId === null || currentId === String(snapshot.id)) {
    return { isCurrent: true, currentValue: null };
  }
  const current = await fetchMetricSnapshot(ctx.db, orgId, currentId);
  return { isCurrent: false, currentValue: current === null ? null : str(current, 'value') };
}

/**
 * Whether the selection's total is the figure, to the cent (§9: "the totals equal the snapshot value
 * it supports").
 *
 * Compared as decimals, never as floats or as raw strings: "120000.00" and "120000.000000" are the
 * same money and different text, and the snapshot column is NUMERIC(20,6) while the total is a
 * two-decimal money string (ADR-006).
 */
function sameMoney(a: string | null, b: string | null): boolean | null {
  const left = parseDecimalOrNull(a);
  const right = parseDecimalOrNull(b);
  if (left === null || right === null) return null;
  return left.minus(right).abs().lessThan('0.005');
}

/**
 * §6's reconciliation line, in the reader's own words.
 *
 * A mismatch is stated, never hidden. A reconciliation that quietly fails is worse than none at
 * all: it looks like a reconciliation.
 */
function reconciliationSentence(input: {
  readonly shown: number;
  readonly count: number;
  readonly total: string | null;
  readonly figure: string | null;
  readonly reconciles: boolean | null;
  readonly currency: string | null;
}): string {
  const rows = input.shown < input.count
    ? `${input.shown} of ${input.count} rows shown`
    : `${input.count} ${input.count === 1 ? 'row' : 'rows'}`;
  if (input.total === null) return `${rows}.`;

  const money = (value: string | null): string => (
    value === null
      ? '—'
      : formatMoney(value, { currency: input.currency ?? 'GBP', showMinorUnits: true })
  );

  if (input.reconciles === true) {
    return `${rows}; they total ${money(input.total)}, which is the figure.`;
  }
  if (input.reconciles === false) {
    return `${rows}; they total ${money(input.total)}, which does not match the figure of `
      + `${money(input.figure)}. Please tell us — a figure that does not reconcile is a fault.`;
  }
  return `${rows}; they total ${money(input.total)}.`;
}

/**
 * §9 / §6: everything the drawer renders for one bundle.
 *
 * `page` names the block it belongs to. A derived metric has one selection per leaf, and a reader
 * paging through one component's rows is not also paging through another's — a single cursor
 * applied to every block would silently skip rows in the ones it was not meant for.
 */
export async function loadEvidenceDrawer(
  ctx: AccessContext,
  bundleId: string,
  page?: { readonly itemId: string; readonly cursor: Cursor },
): Promise<EvidenceDrawerView> {
  assertCan(ctx, 'financials.view');
  const orgId = requireOrgId(ctx);

  const bundle = await getBundle(ctx, bundleId);

  const snapshotItems = bundle.items.filter((item) => item.itemType === 'metric_snapshot');
  const rootItem = snapshotItems[0] ?? null;

  let metric: DrawerMetric | null = null;
  let rootSnapshot: Row | null = null;
  if (rootItem?.ref !== undefined) {
    rootSnapshot = await fetchMetricSnapshot(ctx.db, orgId, rootItem.ref.id);
    if (rootSnapshot === null) throw new NotFound();
    const metricKey = String(rootSnapshot.metric_key);
    const naming = metricLabelOf(metricKey);
    const state = await currency(ctx, orgId, rootSnapshot);
    metric = {
      snapshotId: String(rootSnapshot.id),
      metricKey,
      label: naming.label,
      description: naming.description,
      value: str(rootSnapshot, 'value'),
      unit: String(rootSnapshot.unit) as MetricUnit,
      currency: str(rootSnapshot, 'currency'),
      basis: String(rootSnapshot.basis),
      periodId: String(rootSnapshot.period_id),
      periodLabel: await periodLabelOf(ctx, orgId, String(rootSnapshot.period_id)),
      assurance: rootItem.assurance,
      dataQuality: (rootSnapshot.data_quality ?? {}) as Record<string, unknown>,
      ...state,
      restsOn: await restsOnStatements(ctx, orgId, rootSnapshot),
      difference: await differenceOf(ctx, orgId, rootSnapshot),
    };
  }

  /*
   * Level 2 is the root's DECLARED components, and nothing else.
   *
   * Taking "every other `metric_snapshot` item in the bundle" is wrong the moment the bundle was not
   * built by `buildBundleForMetric`: an alert pins the figure it fired on AND the one it compared
   * against, and the comparison is not part of any arithmetic. `evidence_query.components` is the
   * only thing that knows which snapshots a figure was worked out from (ADR-034), so it decides —
   * and everything else the bundle cites is a related figure, named as such.
   */
  const declared = new Set<string>();
  if (rootSnapshot !== null) {
    const rootQuery = rootSnapshot.evidence_query as
      { kind?: string; components?: { snapshot_id?: string }[] } | null;
    if (rootQuery?.kind === 'derived') {
      for (const component of rootQuery.components ?? []) {
        if (component.snapshot_id) declared.add(component.snapshot_id);
      }
    }
  }

  const components: DrawerComponent[] = [];
  const relatedFigures: DrawerComponent[] = [];
  const snapshotById = new Map<string, Row>();
  for (const item of snapshotItems.slice(1)) {
    if (item.ref === undefined) continue;
    const row = await fetchMetricSnapshot(ctx.db, orgId, item.ref.id);
    if (row === null) throw new NotFound();
    snapshotById.set(String(row.id), row);
    const key = String(row.metric_key);
    const view: DrawerComponent = {
      name: key,
      label: metricLabelOf(key).label,
      snapshotId: String(row.id),
      value: str(row, 'value'),
      unit: str(row, 'unit') as MetricUnit | null,
      currency: str(row, 'currency'),
      leaf: (row.evidence_query as { kind?: string } | null)?.kind === 'leaf',
    };
    (declared.has(String(row.id)) ? components : relatedFigures).push(view);
  }
  if (rootSnapshot !== null) snapshotById.set(String(rootSnapshot.id), rootSnapshot);

  /*
   * Level 3. The builder writes each `query` item immediately after the snapshot it belongs to, so
   * walking the bundle in order and remembering the last snapshot pairs a selection with the figure
   * it has to reconcile against — which is the whole content of the block (§6).
   */
  const records: DrawerRecords[] = [];
  let lastSnapshotId: string | null = null;
  for (const item of bundle.items) {
    if (item.itemType === 'metric_snapshot' && item.ref !== undefined) {
      lastSnapshotId = item.ref.id;
      continue;
    }
    if (item.itemType !== 'query' || item.query === undefined) continue;

    const descriptor = parseQueryDescriptor(item.query);
    const selection = await resolveCompiled(
      ctx,
      compileDescriptor(descriptor),
      page?.itemId === item.id ? page.cursor : undefined,
    );
    const forSnapshot = lastSnapshotId === null ? null : snapshotById.get(lastSnapshotId) ?? null;
    const forValue = forSnapshot === null ? null : str(forSnapshot, 'value');
    const forUnit = forSnapshot === null ? null : String(forSnapshot.unit);

    records.push({
      itemId: item.id,
      label: item.label,
      forSnapshotId: lastSnapshotId,
      forLabel: forSnapshot === null ? null : metricLabelOf(String(forSnapshot.metric_key)).label,
      forValue,
      selection,
      offset: page?.itemId === item.id ? page.cursor.offset : 0,
      // Only money reconciles by addition. A ratio, a count or a number of days is not the sum of
      // the rows behind it, and printing "does not reconcile" against one would be a false alarm.
      reconciles: forUnit === 'money' ? sameMoney(selection.total, forValue) : null,
      reconciliation: reconciliationSentence({
        shown: selection.rows.length,
        count: selection.count,
        total: selection.total,
        figure: forValue,
        reconciles: forUnit === 'money' ? sameMoney(selection.total, forValue) : null,
        currency: forSnapshot === null ? null : str(forSnapshot, 'currency'),
      }),
    });
  }

  const pinned: DrawerPinned[] = bundle.items
    .filter((item) => item.itemType !== 'query'
      && item.itemType !== 'metric_snapshot'
      && item.itemType !== 'calculation_run')
    .map((item) => ({
      itemId: item.id,
      itemType: item.itemType,
      label: item.label,
      claim: item.claim,
      table: item.ref?.table ?? null,
      recordId: item.ref?.id ?? null,
      superseded: item.ref?.superseded === true,
      rejected: item.ref?.recordStatus === 'rejected',
      revisionNo: item.ref?.revisionNo ?? null,
      canReachDocument: itemCanReachDocument(item.itemType),
    }));

  return { bundle, metric, components, relatedFigures, records, pinned };
}

/**
 * The snapshot a "Why?" link means (`UX_ARCHITECTURE.md` §4).
 *
 * Every figure on every screen links with the metric key and the period it was shown for, not with
 * a snapshot id — because the card was rendered from `metric_current`, and pinning the id into a
 * href would hand out a link that goes stale the next time the figures are recalculated. The
 * indirection is deliberate: the link means "the evidence for this figure, this month", and it is
 * resolved against the current pointer at the moment it is followed.
 */
export async function currentSnapshotId(
  ctx: AccessContext,
  input: {
    readonly metricKey: string;
    readonly periodId: string;
    readonly dimensionType?: string;
    readonly dimensionId?: string | null;
  },
): Promise<string | null> {
  const orgId = requireOrgId(ctx);
  let q = ctx.db
    .from('metric_current')
    .select('snapshot_id')
    .eq('organization_id', orgId)
    .eq('period_id', input.periodId)
    .eq('metric_key', input.metricKey)
    .eq('dimension_type', input.dimensionType ?? 'none');
  q = input.dimensionId ? q.eq('dimension_id', input.dimensionId) : q.is('dimension_id', null);

  const { data, error } = await q.maybeSingle();
  if (error) throw toMotionError(error);
  return (data as { snapshot_id?: string } | null)?.snapshot_id ?? null;
}
