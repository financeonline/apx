import { z } from 'zod';
import { loadAlerts, type AlertListRow } from '@/modules/alerts';
import { loadHealthCard } from '@/modules/health';
import { loadPeriods } from '@/modules/dashboard';
import { isMetricKey, metricDefinition } from '@/modules/financial-engine';
import {
  getBundle, getDocumentReference, resolveItem, type EvidenceItemView,
} from '@/modules/evidence';
import { NotFound, PermissionDenied } from '@/core/errors';
import { can } from '@/core/permissions';
import type { PeriodRef } from '../periods';
import { untrusted } from '../untrusted';
import type { NumericValue } from '../values';
import { count, days, fail, money, noData, ok, ratio, resolvePeriodArg, subject } from './envelope';
import type { ToolCallContext, ToolDefinition } from './types';

/**
 * Tools 9–13 (AI_ARCHITECTURE.md §3): alerts, the health score, and the evidence surface.
 *
 * The three evidence tools are where the ownership rule bites (§4, F-C-11, R2-C-12): an
 * `ai_response` bundle — or an `action` bundle cloned from one — is reachable only by the person
 * whose message produced it or by the organisation's owner/admin; anyone else gets `NOT_FOUND`.
 * Tool 13 accepts ids ONLY: the server derives the descriptor from the snapshot, the alert or the
 * item, and the model never supplies one (ADR-032.6, F-C-02). The `client` role is stripped of
 * document references and `source_ref` on the way out (§4).
 */

const uuid = z.string().uuid();

/**
 * A structured number from an alert's `threshold_summary` or a health factor's `values`.
 *
 * Those maps are MIXED: `amount` and `threshold` are money, `share` and `multiple` are ratios, and
 * `signature`, `description`, `customer` and `account` are imported TEXT. Nothing in the value says
 * which. The unit therefore comes from the KEY — the metric registry when the key is a metric, a
 * short field-name table when it is a threshold field — and anything else is text: wrapped
 * `untrusted`, and not a number the model may quote (§7.1, F-C-09). A description that happened to
 * be all digits would still be text here, because its key says so.
 */
const RATIO_FIELDS = new Set(['share', 'multiple', 'threshold_multiple', 'share_of_outflows', 'pct_change', 'ratio']);
const MONEY_FIELDS = new Set(['amount', 'threshold', 'threshold_floor', 'median_outflow', 'account_median', 'mad', 'monthly_outflows', 'revenue', 'balance', 'value', 'overdue', 'total']);
const COUNT_FIELDS = new Set(['count', 'n', 'days_late', 'months', 'invoices']);

function unitOfKey(key: string): NumericValue['unit'] | null {
  if (isMetricKey(key)) return metricDefinition(key).unit;
  if (RATIO_FIELDS.has(key)) return 'ratio';
  if (MONEY_FIELDS.has(key)) return 'money';
  if (COUNT_FIELDS.has(key)) return 'count';
  return null;
}

function typedValue(key: string, raw: string | null): NumericValue | string | null {
  if (raw === null) return null;
  const unit = unitOfKey(key);
  if (unit === null || !/^-?\d+(\.\d+)?$/.test(raw)) return untrusted(key.replace(/[^a-z0-9_]/gi, '_'), raw);
  switch (unit) {
    case 'ratio': return ratio(raw);
    case 'count': return count(raw, 0);
    case 'days': return days(raw);
    default: return money(raw, null);
  }
}

function typedRecord(values: Readonly<Record<string, string | null>>): Record<string, NumericValue | string | null> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typedValue(k, v)]));
}

// -----------------------------------------------------------------------------------------------
// 9. get_alerts
// -----------------------------------------------------------------------------------------------

export const getAlerts: ToolDefinition<{ period?: string; severity?: readonly string[]; status?: readonly string[]; limit?: number }, unknown> = {
  name: 'get_alerts',
  description: 'Open or acknowledged alerts, optionally for one month or filtered by severity. Each carries its explanation, its numbers as structured fields, and its evidence bundle.',
  permission: 'dashboard.view',
  input: z.object({
    period: z.string().optional(),
    severity: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
    status: z.array(z.enum(['open', 'acknowledged'])).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async run(input, call) {
    const { ctx } = call;
    let periodId: string | undefined;
    if (input.period !== undefined) {
      const r = resolvePeriodArg(input.period, call); if (!r.ok) return fail(r.error);
      periodId = r.period.id;
    }
    const [rows, periods] = await Promise.all([
      loadAlerts(ctx.db, ctx.orgId!, {
        ...(periodId ? { periodId } : {}),
        statuses: (input.status ?? ['open', 'acknowledged']) as AlertListRow['status'][],
        ...(input.severity ? { severities: input.severity as AlertListRow['severity'][] } : {}),
        limit: input.limit ?? 10,
      }, ctx.requestId),
      loadPeriods(ctx.db, ctx.orgId!, ctx.requestId),
    ]);
    if (rows.length === 0) return noData('open alert');
    const periodOf = (id: string): PeriodRef | null => { const p = periods.find((x) => x.id === id); return p ? { id: p.id, label: p.label } : null; };
    const alerts = rows.map((a) => ({
      id: a.id,
      // The revision the figure was read at (§2.2): the list row carries the CURRENT revision's
      // bundle; the revision number is what the bundle item pins.
      revision_no: 0,
      rule_key: a.ruleKey,
      severity: a.severity,
      status: a.status,
      title: untrusted('title', a.title),
      explanation: untrusted('explanation', a.explanation),
      threshold_summary: typedRecord(a.thresholdSummary),
      metric_key: a.metricKey,
      period: periodOf(a.periodId),
      recommended_next_step: untrusted('next_step', a.recommendedNextStep),
      evidence_bundle_id: a.evidenceBundleId,
      subject: a.subjectId && (a.subjectType === 'account' || a.subjectType === 'counterparty')
        ? subject(a.subjectType, a.subjectId, null) : null,
    }));
    const touched = [...new Set(rows.map((a) => a.periodId))].map(periodOf).filter((p): p is PeriodRef => p !== null);
    return ok({ alerts }, { periods: touched, calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 10. get_health_score
// -----------------------------------------------------------------------------------------------

export const getHealthScore: ToolDefinition<{ period?: string }, unknown> = {
  name: 'get_health_score',
  description: 'The health score for a month with its dimension breakdown: each dimension’s score, weight, what helped, what hurt, and the metrics it rested on. `period` must be a label from period_context.',
  permission: 'dashboard.view',
  input: z.object({ period: z.string().optional() }),
  async run(input, call) {
    const r = resolvePeriodArg(input.period, call); if (!r.ok) return fail(r.error);
    const { ctx } = call;
    const periods = await loadPeriods(ctx.db, ctx.orgId!, ctx.requestId);
    const here = periods.find((p) => p.id === r.period.id);
    const previous = here ? periods.filter((p) => p.periodStart < here.periodStart).sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0] : undefined;
    const card = await loadHealthCard(ctx.db, ctx.orgId!, r.period.id, previous?.id ?? null, ctx.requestId);
    if (!card) return noData('health score');
    return ok({
      period: r.period,
      score: count(card.score, 0),
      band: card.band,
      change_vs_previous: card.changeVsPrevious === null ? null : count(card.changeVsPrevious, 0),
      dimensions_used: count(card.dimensionsUsed)!,
      dimensions_total: count(card.dimensionsTotal)!,
      breakdown: card.breakdown.map((d) => ({
        key: d.key,
        score: count(d.score, 0),
        weight_applied: ratio(String(d.weight_applied / 100)),
        included: d.included,
        exclusion_reason: d.exclusion_reason,
        positives: d.positives_structured.map((f) => ({ text: untrusted('factor', f.text), values: typedRecord(f.values), snapshot_ids: f.snapshot_ids })),
        negatives: d.negatives_structured.map((f) => ({ text: untrusted('factor', f.text), values: typedRecord(f.values), snapshot_ids: f.snapshot_ids })),
        metrics: d.metrics.map((m) => ({ metric_key: m.metric_key, value: m.value === null ? null : money(m.value, null), snapshot_id: m.snapshot_id })),
      })),
      evidence_bundle_id: card.evidenceBundleId,
    }, { periods: [r.period], calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 11. get_evidence
// -----------------------------------------------------------------------------------------------

/** §4: a client never sees a document item or a `source_ref`. */
function stripForRole(items: readonly EvidenceItemView[], call: ToolCallContext) {
  const docs = can(call.ctx, 'documents.view');
  return items
    .filter((i) => docs || i.itemType !== 'source_document')
    .map((i) => ({
      id: i.id,
      item_type: i.itemType,
      label: untrusted('label', i.label),
      claim: i.claim === null ? null : untrusted('claim', i.claim),
      assurance_level: i.assurance,
      ref: i.ref ? { table: i.ref.table, id: i.ref.id, revision_no: i.ref.revisionNo, superseded: i.ref.superseded } : null,
      // A query item is referenced by its hash alone; the descriptor never reaches the model (§3).
      descriptor_hash: i.descriptorHash ?? null,
    }));
}

const asToolError = (e: unknown) =>
  e instanceof PermissionDenied ? fail({ code: 'PERMISSION_DENIED' as const, message: e.message })
  : e instanceof NotFound ? fail({ code: 'NOT_FOUND' as const, message: 'That is not something this conversation can open.' })
  : null;

export const getEvidence: ToolDefinition<{ evidence_bundle_id: string }, unknown> = {
  name: 'get_evidence',
  description: 'The items of an existing evidence bundle — behind an alert, a health score, or an earlier answer.',
  permission: 'financials.view',
  input: z.object({ evidence_bundle_id: uuid }),
  async run(input, call) {
    try {
      const bundle = await getBundle(call.ctx, input.evidence_bundle_id);
      return ok({
        bundle_id: bundle.id, kind: bundle.kind, assurance_level: bundle.assurance,
        items: stripForRole(bundle.items, call),
      }, { periods: [], calculation_run_id: bundle.asOf?.calculationRunId ?? null }, call);
    } catch (e) { const mapped = asToolError(e); if (mapped) return mapped; throw e; }
  },
};

// -----------------------------------------------------------------------------------------------
// 12. get_source_document_reference
// -----------------------------------------------------------------------------------------------

const RECORD_TABLE: Readonly<Record<string, string>> = {
  ledger_entry: 'ledger_entries', bank_transaction: 'bank_transactions', invoice: 'invoices', period_balance: 'period_balances',
};

export const getSourceDocumentReference: ToolDefinition<{ record_type: string; record_id: string }, unknown> = {
  name: 'get_source_document_reference',
  description: 'Which uploaded file, page or line a record came from. A reference only — never the file’s contents. Not available to every role.',
  permission: 'documents.view',
  input: z.object({
    record_type: z.enum(['ledger_entry', 'bank_transaction', 'invoice', 'period_balance']), record_id: uuid,
  }),
  async run(input, call) {
    try {
      const ref = await getDocumentReference(call.ctx, { table: RECORD_TABLE[input.record_type]!, id: input.record_id });
      if (ref.locked || ref.documentId === null) {
        return fail({ code: 'PERMISSION_DENIED', message: 'Source documents are not available to your role.' });
      }
      return ok({
        document_id: ref.documentId,
        original_filename: untrusted('filename', ref.filename),
        page: ref.page === null ? null : count(ref.page, 0), sheet: ref.sheet, row: ref.row === null ? null : count(ref.row, 0),
        source_ref: untrusted('source_ref', ref.sourceRef),
      }, { periods: [], calculation_run_id: null }, call);
    } catch (e) { const mapped = asToolError(e); if (mapped) return mapped; throw e; }
  },
};

// -----------------------------------------------------------------------------------------------
// 13. get_transactions_for_evidence — ids only, never a descriptor (F-C-02)
// -----------------------------------------------------------------------------------------------

const TransactionsInput = z.union([
  z.object({ metric_snapshot_id: uuid }),
  z.object({ alert_id: uuid }),
  z.object({ evidence_item_id: uuid }),
]);

export const getTransactionsForEvidence: ToolDefinition<z.infer<typeof TransactionsInput>, unknown> = {
  name: 'get_transactions_for_evidence',
  description: 'The records behind a figure, an alert, or an evidence item, largest first (at most 50). Give exactly one id; the server decides which records those are.',
  permission: 'financials.view',
  input: TransactionsInput,
  async run(input, call) {
    const { ctx } = call;
    try {
      let selection;
      let descriptorHash: string | null = null;
      if ('evidence_item_id' in input) {
        const resolved = await resolveItem(ctx, input.evidence_item_id);
        if (resolved.kind !== 'query') {
          return fail({ code: 'NO_DATA', message: 'That evidence item pins one record rather than a set of them; open it with get_evidence.' });
        }
        selection = resolved.selection;
        descriptorHash = resolved.item.descriptorHash ?? null;
      } else {
        // A snapshot's descriptor, or an alert's current-revision bundle, is read by the server —
        // the model gave an id and gets the rows the engine's own descriptor selects.
        const bundleId = 'alert_id' in input ? await bundleOfAlert(call, input.alert_id) : null;
        const item = 'metric_snapshot_id' in input
          ? await queryItemOfSnapshot(call, input.metric_snapshot_id)
          : bundleId ? await firstQueryItem(call, bundleId) : null;
        if (!item) return noData('record set behind that');
        const resolved = await resolveItem(ctx, item.id);
        if (resolved.kind !== 'query') return noData('record set behind that');
        selection = resolved.selection;
        descriptorHash = resolved.item.descriptorHash ?? null;
      }
      const docs = can(ctx, 'documents.view');
      const records = selection.rows.slice(0, 50).map((r) => ({
        type: TYPE_OF[r.table] ?? r.table, id: r.id, date: r.date,
        description: untrusted('description', r.description),
        amount: money(r.amount, r.currency), direction: r.direction,
        account: r.accountId ? { id: r.accountId, name: untrusted('name', r.standardCategory) } : null,
        counterparty: r.counterpartyId ? { id: r.counterpartyId } : null,
        assurance_level: r.assuranceLevel,
        ...(docs ? { source_ref: untrusted('source_ref', r.reference) } : {}),
      }));
      return ok({
        records, total_count: count(selection.count)!, sum: money(selection.total, records[0]?.amount ? null : null),
        descriptor_hash: descriptorHash,
      }, { periods: [], calculation_run_id: null }, call);
    } catch (e) { const mapped = asToolError(e); if (mapped) return mapped; throw e; }
  },
};

const TYPE_OF: Readonly<Record<string, string>> = {
  ledger_entries: 'ledger_entry', bank_transactions: 'bank_transaction', invoices: 'invoice', period_balances: 'period_balance',
};

async function bundleOfAlert(call: ToolCallContext, alertId: string): Promise<string | null> {
  const { ctx } = call;
  const rows = await loadAlerts(ctx.db, ctx.orgId!, { limit: 200 }, ctx.requestId);
  return rows.find((a) => a.id === alertId)?.evidenceBundleId ?? null;
}

async function firstQueryItem(call: ToolCallContext, bundleId: string): Promise<EvidenceItemView | null> {
  const bundle = await getBundle(call.ctx, bundleId);
  return bundle.items.find((i) => i.itemType === 'query') ?? null;
}

/** The leaf descriptor behind a snapshot, reached through the metric bundle that materialises it. */
async function queryItemOfSnapshot(call: ToolCallContext, snapshotId: string): Promise<EvidenceItemView | null> {
  const { buildBundleForMetric } = await import('@/modules/evidence');
  const bundleId = await buildBundleForMetric(call.ctx, snapshotId);
  return firstQueryItem(call, bundleId);
}

