import { formatMoney, formatPercent, parseDecimalOrNull, Decimal } from '@/core/money';
import type { PeriodContext, PeriodRef } from '../periods';
import { untrusted } from '../untrusted';
import { numeric, type NumericValue } from '../values';
import type { ReturnedRefs, ToolCallContext, ToolError, ToolMeta, ToolOutcome } from './types';

/**
 * What every tool shares (AI_ARCHITECTURE.md §3 "All tools share").
 *
 * The numeric envelope is built HERE and nowhere else, with `display` produced by the same
 * formatters the customer's screen uses (`core/money`), so the model quotes a number the product
 * actually shows and §7.3 derives its tolerance from that display. A tool that formatted its own
 * numbers would eventually disagree with the dashboard, and the model would be quoting a figure
 * nobody has seen.
 */

// -----------------------------------------------------------------------------------------------
// Numbers
// -----------------------------------------------------------------------------------------------

export function money(value: string | null, currency: string | null): NumericValue | null {
  if (value === null) return null;
  return numeric(value, formatMoney(value, { currency: currency ?? 'GBP' }), 'money');
}

export function ratio(value: string | null): NumericValue | null {
  if (value === null) return null;
  return numeric(value, formatPercent(value), 'ratio');
}

export function count(value: string | number | null, decimals = 0): NumericValue | null {
  if (value === null) return null;
  const decimal = typeof value === 'number' ? new Decimal(value) : parseDecimalOrNull(value);
  if (decimal === null) return null;
  return numeric(decimal.toString(), decimal.toFixed(decimals), 'count');
}

export function days(value: string | null): NumericValue | null {
  if (value === null) return null;
  const decimal = parseDecimalOrNull(value);
  if (decimal === null) return null;
  return numeric(decimal.toString(), `${decimal.toDecimalPlaces(0).toString()} days`, 'days');
}

/** The envelope for a snapshot row, by its unit — the one place that switch lives. */
export function snapshotNumber(
  row: { readonly value: string | null; readonly unit: string; readonly currency: string | null },
): NumericValue | null {
  switch (row.unit) {
    case 'money': return money(row.value, row.currency);
    case 'ratio': return ratio(row.value);
    case 'days': return days(row.value);
    case 'count': return count(row.value, 1);
    default: return null;
  }
}

// -----------------------------------------------------------------------------------------------
// Subjects and untrusted text (§3 "Subjects", "Untrusted text")
// -----------------------------------------------------------------------------------------------

export type SubjectType = 'counterparty' | 'account' | 'standard_category' | 'bank_account';

export interface Subject {
  readonly type: SubjectType;
  readonly id: string;
  /** Wrapped: a name is imported text. */
  readonly name: string;
}

export function subject(type: SubjectType, id: string, name: string | null): Subject {
  return { type, id, name: untrusted('name', name ?? '') };
}

// -----------------------------------------------------------------------------------------------
// Periods (§3 "Period inputs", §8)
// -----------------------------------------------------------------------------------------------

/** The labels a tool may accept this turn: `period_context.resolved ∪ default ∪ earlier meta.periods`. */
export function acceptable(call: ToolCallContext): Map<string, PeriodRef> {
  const out = new Map<string, PeriodRef>();
  const add = (p: PeriodRef | null) => { if (p) out.set(p.label, p); };
  add(call.periodContext.default);
  for (const p of call.periodContext.resolved) add(p);
  for (const p of call.knownPeriods) add(p);
  return out;
}

/**
 * Resolves the model's `period` argument, or the default when it gave none.
 * Returns an error outcome — never the nearest period — for a label the turn does not know.
 */
export function resolvePeriodArg(
  label: string | undefined,
  call: ToolCallContext,
): { ok: true; period: PeriodRef } | { ok: false; error: ToolError } {
  if (label === undefined) {
    const fallback = call.periodContext.default;
    if (fallback) return { ok: true, period: fallback };
    return { ok: false, error: { code: 'NO_DATA', message: 'There is no complete month to report on yet.' } };
  }
  const known = acceptable(call).get(label);
  if (!known) {
    return {
      ok: false,
      error: {
        code: 'PERIOD_NOT_FOUND',
        message: 'That period is not one this conversation can report on.',
        hint: 'Use a label from period_context or from an earlier tool result.',
      },
    };
  }
  return { ok: true, period: known };
}

// -----------------------------------------------------------------------------------------------
// Outcomes
// -----------------------------------------------------------------------------------------------

export function ok<T>(data: T, meta: Omit<ToolMeta, 'computed_at'>, call: ToolCallContext): ToolOutcome<T> {
  return { ok: true, data, meta: { ...meta, computed_at: call.now.toISOString() } };
}

export function fail<T = never>(error: ToolError): ToolOutcome<T> {
  return { ok: false, error };
}

export function noData<T = never>(what: string): ToolOutcome<T> {
  return fail({ code: 'NO_DATA', message: `There is no ${what} for that period yet.` });
}

// -----------------------------------------------------------------------------------------------
// What a result returned, for the bundle (§14.2)
// -----------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;

/**
 * Walks a tool's data and collects every evidence id and descriptor hash it carried, by the same
 * field names the allowed-set walker keys on: `snapshot_id`, a record's `id` beside a `type`, an
 * alert's `id` beside `revision_no`, and `descriptor_hash`. Entity ids (`subject.id`, `counterparty.id`)
 * are collected too: an entity a tool named is one the bundle may pin (EVIDENCE_MODEL.md §4).
 */
export function returnedRefs(data: unknown, calculationRunId: string | null): ReturnedRefs {
  const ids = new Set<string>();
  const hashes = new Set<string>();
  if (calculationRunId) ids.add(calculationRunId);

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, unknown>;
    for (const key of ['snapshot_id', 'id', 'evidence_bundle_id', 'document_id', 'record_id']) {
      const value = record[key];
      if (typeof value === 'string' && UUID.test(value)) ids.add(value);
    }
    const hash = record.descriptor_hash;
    if (typeof hash === 'string' && HASH.test(hash)) hashes.add(hash.toLowerCase());
    for (const value of Object.values(record)) walk(value);
  };
  walk(data);
  return { ids: [...ids], hashes: [...hashes] };
}

/** Period refs carried by a result's rows, so a later tool may walk them (§3). */
export function periodsIn(refs: readonly (PeriodRef | null | undefined)[]): PeriodRef[] {
  const seen = new Map<string, PeriodRef>();
  for (const ref of refs) if (ref) seen.set(ref.id, ref);
  return [...seen.values()];
}

/** Labels of a `PeriodContext` in one place, for `meta.periods` when a tool spans the context. */
export function contextPeriods(context: PeriodContext): PeriodRef[] {
  return periodsIn([context.default, ...context.resolved]);
}
