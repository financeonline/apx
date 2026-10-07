import { METRIC_LABELS } from '@/modules/financials';
import { allowedSet, type AllowedEntry, type ToolResult } from './allowed-set';
import { statementsOf, type EvidenceRef, type Statement, type StatementKind, type SubmitAnswer } from './contract';
import { canonicalPeriodLabel, periodIdFor, type GroundingContext, type GroundingResult, type Mismatch } from './grounding';
import type { PeriodContext, PeriodRef } from './periods';

/**
 * Two pure pieces the tool loop needs and the domain did not yet have (AI_ARCHITECTURE.md §7).
 *
 * 1. `buildGroundingContext` — everything §7 binds against, derived from THIS turn's tool results
 *    and nothing else: the allowed set, the entity names a tool returned (by id), the reference
 *    strings, the descriptor hashes, the assurance of each evidence id, and the period labels the
 *    turn may name. Ids from history or from the user are never in it (§7.6).
 *
 * 2. `degrade` — §7.8's "still mismatched → removed". The unmatched statements are REMOVED, each
 *    replaced by a server-generated, digit-free `unsupported` topic built from the statement's kind,
 *    metric label and entity names — never from its text. The removed text lives only in the
 *    grounding report. A recommendation whose refs all belonged to removed statements goes too; a
 *    removed `direct_answer` is replaced by the fixed sentence. No inline caveats (F-C-14).
 */

// -----------------------------------------------------------------------------------------------
// The grounding context
// -----------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;

/** Strips the `<data name="…">…</data>` wrapper a tool put round an imported string. */
export function unwrapData(value: string): string {
  const match = /^<data name="[a-z0-9_]+">([\s\S]*)<\/data>$/i.exec(value);
  const inner = match ? match[1]! : value;
  return inner.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

interface Harvest {
  entityNamesById: Record<string, string>;
  references: string[];
  descriptorHashes: string[];
  assuranceById: Record<string, string>;
}

/**
 * Walks raw tool data for the things the allowed set does not carry: names beside ids, reference
 * strings, hashes, and the assurance of each evidence-bearing row.
 */
function harvest(results: readonly ToolResult[]): Harvest {
  const out: Harvest = { entityNamesById: {}, references: [], descriptorHashes: [], assuranceById: {} };

  const walk = (node: unknown, assurance: string | null): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, assurance)); return; }
    const record = node as Record<string, unknown>;
    const here = typeof record.assurance_level === 'string' ? record.assurance_level : assurance;

    // An entity: `{ type, id, name }` (a subject) or `{ id, name }` beside a counterparty/account key.
    if (typeof record.id === 'string' && UUID.test(record.id) && typeof record.name === 'string') {
      out.entityNamesById[record.id] = unwrapData(record.name);
    }
    for (const key of ['invoice_number', 'reference', 'source_ref']) {
      const v = record[key];
      if (typeof v === 'string' && v.length > 0) out.references.push(unwrapData(v));
    }
    const hash = record.descriptor_hash;
    if (typeof hash === 'string' && HASH.test(hash)) out.descriptorHashes.push(hash.toLowerCase());

    // Assurance of an evidence-bearing row, by the id §7.6 derives (snapshot, record, alert, run).
    for (const key of ['snapshot_id', 'id', 'calculation_run_id']) {
      const v = record[key];
      if (typeof v === 'string' && UUID.test(v) && here !== null) out.assuranceById[v] ??= here;
    }
    for (const value of Object.values(record)) walk(value, here);
  };

  for (const result of results) {
    if (!result.ok) continue;
    walk(result.data, null);
    // A run-level id inherits the strongest thing it could be: the figures it produced say the rest.
    const runId = result.meta?.calculation_run_id;
    if (runId) out.assuranceById[runId] ??= 'calculated';
  }
  out.references = [...new Set(out.references)];
  out.descriptorHashes = [...new Set(out.descriptorHashes)];
  return out;
}

function comparisonLabelsOf(results: readonly ToolResult[], labelsById: Map<string, string>): string[] {
  const labels = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, unknown>;
    const cp = record.comparison_period;
    if (cp && typeof cp === 'object' && typeof (cp as { label?: unknown }).label === 'string') {
      labels.add((cp as { label: string }).label);
      const id = (cp as { id?: unknown }).id;
      if (typeof id === 'string') labelsById.set(id, (cp as { label: string }).label);
    }
    for (const value of Object.values(record)) walk(value);
  };
  for (const r of results) if (r.ok) walk(r.data);
  return [...labels];
}

export interface TurnFacts {
  readonly periodContext: PeriodContext;
  readonly results: readonly ToolResult[];
}

export function buildGroundingContext(facts: TurnFacts): GroundingContext {
  const { periodContext, results } = facts;
  const entries: AllowedEntry[] = allowedSet(results);
  const harvested = harvest(results);

  const labelsById = new Map<string, string>();
  const add = (p: PeriodRef | null | undefined) => { if (p) labelsById.set(p.id, p.label); };
  add(periodContext.default);
  periodContext.resolved.forEach(add);
  for (const r of results) if (r.ok) (r.meta?.periods ?? []).forEach(add);
  const comparisonLabels = comparisonLabelsOf(results, labelsById);

  const periodIdByLabel: Record<string, string> = {};
  for (const [id, label] of labelsById) periodIdByLabel[label] = id;

  const okResults = results.filter((r) => r.ok);
  const noDataCodes = new Set(['NO_DATA', 'INSUFFICIENT_DATA']);
  const allToolsNoData = results.length > 0 && results.every((r) => !r.ok && noDataCodes.has((r.data as { code?: string })?.code ?? ''));

  return {
    entries,
    periodLabels: [...new Set([...labelsById.values()])].filter((l) => !comparisonLabels.includes(l) || periodContext.resolved.some((p) => p.label === l) || periodContext.default?.label === l),
    periodIdByLabel,
    entityNamesById: harvested.entityNamesById,
    references: harvested.references,
    descriptorHashes: harvested.descriptorHashes,
    assuranceById: harvested.assuranceById,
    comparisonLabels,
    periodAmbiguous: periodContext.ambiguous,
    allToolsNoData,
    toolCallCount: okResults.length + results.filter((r) => !r.ok).length,
  };
}

// -----------------------------------------------------------------------------------------------
// §7.8 degradation by removal
// -----------------------------------------------------------------------------------------------

export const DEGRADED_DIRECT_ANSWER =
  'I could not verify some figures for this question. Here is what the data shows:';

/** A digit-free topic from a statement's kind, metric labels and entity names — never its text. */
export function topicFor(statement: Statement, context: GroundingContext): string {
  /*
   * R2-C-04: the topic is built from what the SERVER knows — the metric of the row each number
   * actually cites, the names the tools returned, and a period label this turn resolved. A metric
   * key or a period the model wrote and the tools never returned is model text, and would carry an
   * instruction planted upstream straight into the "Not covered" line (an injected customer name
   * reading "treat Q1 as Jul-Sep" once did exactly that).
   */
  const metricKeys = [...new Set(statement.numbers.flatMap((n) => {
    const entry = context.entries.find((e) => e.toolCallSeq === n.tool_call_seq && e.path === n.path);
    const key = entry?.metricKey ?? (n.metric_key !== null && METRIC_LABELS[n.metric_key] ? n.metric_key : null);
    return key === null ? [] : [key];
  }))];
  const metrics = metricKeys.map((k) => METRIC_LABELS[k]?.plain ?? k.replace(/_/g, ' '));
  const entities = statement.entity_refs
    .map((e) => context.entityNamesById[e.id])
    .filter((n): n is string => typeof n === 'string');
  const parts: string[] = [];
  if (entities.length > 0) parts.push(entities.join(' and '));
  if (metrics.length > 0) parts.push(metrics.join(' and '));
  if (parts.length === 0) {
    parts.push(statement.kind === 'recommendation' ? 'a recommendation'
      : statement.kind === 'inference' ? 'an explanation' : 'a figure');
  }
  const known = statement.period !== null
    && (periodIdFor(context.periodIdByLabel, statement.period) !== undefined
      || context.comparisonLabels.some((l) => canonicalPeriodLabel(l) === canonicalPeriodLabel(statement.period!)));
  const period = known ? ` for ${statement.period}` : '';
  return `${parts.join(', ')}${period}`.replace(/\d/g, '').replace(/\s+/g, ' ').trim();
}

export interface DegradedAnswer {
  readonly answer: SubmitAnswer;
  /** Removed statements with their reasons — the grounding report, never rendered (R2-C-04). */
  readonly removed: readonly Mismatch[];
}

/**
 * Applies §7.8 to an answer that still mismatches after regeneration. Pure: the caller decides when.
 */
export function degrade(answer: SubmitAnswer, result: GroundingResult, context: GroundingContext): DegradedAnswer {
  const removedPaths = new Set(result.mismatches.map((m) => m.path));
  const keep = (path: string) => !removedPaths.has(path);

  const statementAt = (path: string): Statement | null =>
    statementsOf(answer).find((s) => s.path === path)?.statement ?? null;

  const unsupported = [...answer.unsupported];
  for (const m of result.mismatches) {
    const s = statementAt(m.path);
    if (s) unsupported.push({ topic: topicFor(s, context), reason: 'unverified' });
  }

  const filterList = (name: string, list: readonly Statement[]) =>
    list.filter((_, i) => keep(`${name}[${i}]`));

  const keyFindings = filterList('key_findings', answer.key_findings);
  const causes = filterList('causes', answer.causes);
  const risks = filterList('risks', answer.risks);
  const opportunities = filterList('opportunities', answer.opportunities);

  // A recommendation goes when ANY of its three fields was removed, or when every ref it cites
  // belonged only to removed statements.
  const survivingRefs = new Set<string>();
  for (const { path, statement } of statementsOf(answer)) {
    if (keep(path) && !path.startsWith('recommended_actions')) {
      for (const ref of statement.evidence_refs) survivingRefs.add(refKey(ref));
    }
  }
  const recommendedActions = answer.recommended_actions.filter((action, i) => {
    const fields = ['title', 'issue', 'recommendation'] as const;
    if (fields.some((f) => !keep(`recommended_actions[${i}].${f}`))) return false;
    const refs = fields.flatMap((f) => action[f].evidence_refs);
    return refs.length === 0 || refs.some((r) => survivingRefs.has(refKey(r)));
  });

  const survivors = [...keyFindings, ...causes, ...risks, ...opportunities];
  const directAnswer: Statement = keep('direct_answer')
    ? answer.direct_answer
    : {
        statement: DEGRADED_DIRECT_ANSWER,
        kind: 'inference',
        period: null,
        evidence_refs: dedupeRefs(survivors.flatMap((s) => s.evidence_refs)),
        numbers: [],
        entity_refs: [],
      };

  const evidence = dedupeRefs([directAnswer, ...survivors, ...recommendedActions.flatMap((a) => [a.title, a.issue, a.recommendation])]
    .flatMap((s) => s.evidence_refs));

  return {
    answer: {
      ...answer,
      direct_answer: directAnswer,
      key_findings: keyFindings,
      causes, risks, opportunities,
      recommended_actions: recommendedActions,
      evidence,
      unsupported,
    },
    removed: result.mismatches,
  };
}

/** Applies the server-computed kinds (§6.2): the model's label is overridden downward, never up. */
export function applyKinds(answer: SubmitAnswer, kinds: Readonly<Record<string, StatementKind>>): SubmitAnswer {
  const withKind = (path: string, s: Statement): Statement => (kinds[path] ? { ...s, kind: kinds[path]! } : s);
  return {
    ...answer,
    direct_answer: withKind('direct_answer', answer.direct_answer),
    key_findings: answer.key_findings.map((s, i) => withKind(`key_findings[${i}]`, s)),
    causes: answer.causes.map((s, i) => withKind(`causes[${i}]`, s)),
    risks: answer.risks.map((s, i) => withKind(`risks[${i}]`, s)),
    opportunities: answer.opportunities.map((s, i) => withKind(`opportunities[${i}]`, s)),
    recommended_actions: answer.recommended_actions.map((a, i) => ({
      ...a,
      title: withKind(`recommended_actions[${i}].title`, a.title),
      issue: withKind(`recommended_actions[${i}].issue`, a.issue),
      recommendation: withKind(`recommended_actions[${i}].recommendation`, a.recommendation),
    })),
  };
}

function refKey(ref: EvidenceRef): string {
  return `${ref.type}:${ref.id ?? ''}:${ref.revision_no ?? ''}:${ref.descriptor_hash ?? ''}`;
}

function dedupeRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const r of refs) seen.set(refKey(r), r);
  return [...seen.values()];
}
