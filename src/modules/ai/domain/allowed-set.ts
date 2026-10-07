import type { Decimal } from '@/core/money';
import { displayPrecision, isNumericValue, toDecimal, type NumericUnit } from './values';

/**
 * The grounding allowed set (AI_ARCHITECTURE.md §7.1).
 *
 * Walks a turn's tool results and collects **only** the branded numeric fields, each with the
 * context the rest of §7 binds against: which metric it is, which period it belongs to, which
 * entity the row is about, and whether it is a level or a change.
 *
 * "Strings are never scanned: a number inside a description, name, note, explanation or `hint` is
 * not groundable (F-C-09)." That is enforced structurally here rather than by a rule somebody has
 * to remember — the walker only ever looks at objects shaped like the numeric envelope, so a
 * supplier who names a payment "REFUND 4,800" has published no number at all as far as grounding is
 * concerned.
 */

export type FieldKind = 'level' | 'change';

export interface AllowedEntry {
  readonly toolCallSeq: number;
  /** Dotted path into the tool's `data`, exactly as a `NumberRef` must name it. */
  readonly path: string;
  readonly value: Decimal;
  readonly unit: NumericUnit;
  readonly display: string;
  readonly displayPrecision: number;
  /** From the enclosing MetricValue or row; `null` for a figure that is about no metric. */
  readonly metricKey: string | null;
  readonly fieldKind: FieldKind;
  /** Period ids of the enclosing row, or of `meta` when the row names none. */
  readonly periodIds: readonly string[];
  /** From the row's `subject` (§3, ADR-045.3) — never empty for an entity row. */
  readonly rowEntityIds: readonly string[];
  /** The evidence id §7.6 derives from this row: a snapshot, a record, or the run. */
  readonly derivedEvidenceId: string | null;
  readonly derivedEvidenceType: string | null;
  /** For an alert row, the revision the figure was read at (§2.2). */
  readonly derivedRevisionNo: number | null;
}

export interface ToolResult {
  readonly seq: number;
  readonly name: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly meta?: {
    readonly periods?: readonly { readonly id: string; readonly label: string }[];
    readonly calculation_run_id?: string | null;
  };
}

/**
 * §7.1: `field_kind = 'change'` for `variance.*.value`, `pct_change`, `change_abs`, `change_ratio`
 * and trend `summary.change_*`; everything else is `level`.
 *
 * The distinction decides how a sign is read (§7.5) — a change takes its sign from the direction
 * word beside it, a level must match literally — so getting it wrong turns "profit fell £3,000"
 * into a claim about a level of −£3,000 that no tool ever returned.
 */
function fieldKindFor(path: string): FieldKind {
  const leaf = path.split('.').pop() ?? '';
  if (/^change_/.test(leaf) || leaf === 'pct_change') return 'change';
  if (/(?:^|\.)variance\.[^.]+\.value$/.test(path)) return 'change';
  if (/(?:^|\.)summary\.change_/.test(path)) return 'change';
  return 'level';
}

interface RowContext {
  readonly metricKey: string | null;
  readonly periodIds: readonly string[];
  readonly entityIds: readonly string[];
  readonly evidenceId: string | null;
  readonly evidenceType: string | null;
  readonly revisionNo: number | null;
}

const RECORD_TYPES: Readonly<Record<string, string>> = {
  ledger_entry: 'ledger_entry',
  bank_transaction: 'bank_transaction',
  invoice: 'invoice',
  period_balance: 'period_balance',
};

/**
 * Refines the row context as the walker descends into an object.
 *
 * Every rule here is §7.6's "derive the evidence id of its row": a MetricValue carries
 * `snapshot_id`, a record row carries `id` and `type`, an alert row carries `(id, revision_no)`.
 * Deriving it from the DATA rather than from what the model claimed is the whole of R2-C-02 — a
 * model cannot cite a verified snapshot to launder an estimated number if the server reads the id
 * out of the row the number actually came from.
 */
function refine(parent: RowContext, node: Record<string, unknown>): RowContext {
  const metricKey = typeof node.metric_key === 'string' ? node.metric_key : parent.metricKey;

  let periodIds = parent.periodIds;
  const period = node.period;
  if (period !== null && typeof period === 'object' && typeof (period as { id?: unknown }).id === 'string') {
    periodIds = [(period as { id: string }).id];
  } else if (typeof node.period_id === 'string') {
    periodIds = [node.period_id];
  }

  let entityIds = parent.entityIds;
  const subject = node.subject;
  if (subject !== null && typeof subject === 'object' && typeof (subject as { id?: unknown }).id === 'string') {
    entityIds = [(subject as { id: string }).id];
  } else {
    // Rows that predate ADR-045.3's `subject` still name their entity in a typed field.
    for (const key of ['counterparty', 'account', 'dimension', 'bank_account'] as const) {
      const value = node[key];
      if (value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
        entityIds = [(value as { id: string }).id];
        break;
      }
    }
  }

  let evidenceId = parent.evidenceId;
  let evidenceType = parent.evidenceType;
  let revisionNo = parent.revisionNo;
  if (typeof node.snapshot_id === 'string') {
    evidenceId = node.snapshot_id;
    evidenceType = 'metric_snapshot';
    revisionNo = null;
  } else if (typeof node.id === 'string' && typeof node.type === 'string' && RECORD_TYPES[node.type]) {
    evidenceId = node.id;
    evidenceType = RECORD_TYPES[node.type]!;
    revisionNo = null;
  } else if (typeof node.id === 'string' && typeof node.revision_no === 'number' && typeof node.rule_key === 'string') {
    evidenceId = node.id;
    evidenceType = 'alert';
    revisionNo = node.revision_no;
  }

  return { metricKey, periodIds, entityIds, evidenceId, evidenceType, revisionNo };
}

/** Collects the branded fields of ONE tool result. */
function walk(
  result: ToolResult,
  node: unknown,
  path: string,
  context: RowContext,
  out: AllowedEntry[],
): void {
  if (node === null || typeof node !== 'object') return;

  if (isNumericValue(node)) {
    out.push({
      toolCallSeq: result.seq,
      path,
      value: toDecimal(node),
      unit: node.unit,
      display: node.display,
      displayPrecision: displayPrecision(node.display),
      metricKey: context.metricKey,
      fieldKind: fieldKindFor(path),
      periodIds: context.periodIds,
      rowEntityIds: context.entityIds,
      derivedEvidenceId: context.evidenceId,
      derivedEvidenceType: context.evidenceType,
      derivedRevisionNo: context.revisionNo,
    });
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((entry, index) => walk(result, entry, `${path}[${index}]`, context, out));
    return;
  }

  const record = node as Record<string, unknown>;
  const refined = refine(context, record);
  for (const [key, value] of Object.entries(record)) {
    walk(result, value, path === '' ? key : `${path}.${key}`, refined, out);
  }
}

/**
 * §7.1: the allowed set for a turn.
 *
 * Failed tool calls contribute nothing. An `{ok:false}` envelope carries an `error.message` and a
 * `hint`, both of them prose the model relays verbatim — and a number inside a hint is exactly the
 * kind of thing v1 matched against and v3 must not.
 */
export function allowedSet(results: readonly ToolResult[]): AllowedEntry[] {
  const entries: AllowedEntry[] = [];
  for (const result of results) {
    if (!result.ok) continue;
    const metaPeriods = (result.meta?.periods ?? []).map((period) => period.id);
    walk(result, result.data, '', {
      metricKey: null,
      periodIds: metaPeriods,
      entityIds: [],
      evidenceId: result.meta?.calculation_run_id ?? null,
      evidenceType: result.meta?.calculation_run_id ? 'calculation_run' : null,
      revisionNo: null,
    }, entries);
  }
  return entries;
}

/** Looks an entry up the way a `NumberRef` names it: by tool call and path. */
export function entryAt(
  entries: readonly AllowedEntry[], toolCallSeq: number, path: string,
): AllowedEntry | null {
  // Paths are relative to the result's `data`; a reference that names `data.` in front points into
  // the same object.
  if (path.startsWith('data.')) path = path.slice('data.'.length);
  // `rows.0.revenue` and `rows[0].revenue` name the same element.
  path = path.replace(/\.(\d+)(?=\.|$)/g, '[$1]');
  const exact = entries.find((e) => e.toolCallSeq === toolCallSeq && e.path === path);
  if (exact) return exact;
  // A figure wrapped with its metric and source (`periods[0].closing_cash` = { metric_key, value, … })
  // carries its number at `.value`; citing the wrapper names that number (2026-10-07).
  const wrapped = entries.find((e) => e.toolCallSeq === toolCallSeq && e.path === `${path}.value`);
  if (wrapped) return wrapped;
  // A numeric node is recorded at its own path (`value`) with its formatted text attached. A
  // reference to that text (`value.display`) names the same number in the same result — current
  // models cite it that way (2026-10-07) — so it resolves to the node. Nothing else does: any other
  // path still has to name a number the tool returned.
  // Likewise its raw `value` field (`data.value.value`): a numeric node is `{ value, display, … }`,
  // and both fields are that one number.
  const field = /\.(display|value)$/.exec(path);
  if (field) {
    const node = path.slice(0, field.index);
    return entries.find((e) => e.toolCallSeq === toolCallSeq && e.path === node) ?? null;
  }
  return null;
}
