import { z } from 'zod';
import { loadAlerts, type AlertListRow } from '@/modules/alerts';
import { loadHealthCard } from '@/modules/health';
import { loadPeriods } from '@/modules/dashboard';
import { isMetricKey, metricDefinition } from '@/modules/financial-engine';
import {
  RECORD_KINDS, getBundle, getDocumentEvidence, getDocumentReference, getRecordProvenance,
  resolveItem, type EvidenceItemView, type RecordKind,
} from '@/modules/evidence';
import { hasForecast, loadForecast } from '@/modules/forecast';
import { hasScenario, loadScenario } from '@/modules/scenarios';
import { NotFound, PermissionDenied } from '@/core/errors';
import { Decimal, parseDecimalOrNull } from '@/core/money';
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

// -----------------------------------------------------------------------------------------------
// 16. get_record_evidence — one record's own history (Phase 9; ADR-096, ADR-097)
// -----------------------------------------------------------------------------------------------

/**
 * The record end of the chain, as a tool.
 *
 * Phase 8 built `getRecordProvenance` for a reader who is looking at one row. The analyst needs the
 * same answer for the same reason: asked "is that £4,000 payment real?", the honest reply names the
 * import it came in with and the line of the file, and says whether the row is still counted — and
 * before this tool existed there was no way for the model to learn any of that. It calls the Phase 8
 * service; it does not re-derive a single field.
 *
 * `financials.view`, the same permission the service requires, so this opens nothing new. The
 * document half is whatever `getDocumentReference` gives THIS caller: a client gets `has_document`
 * and the line, never a filename (§4, §10, CD-17), because the service has already decided that and
 * deciding it again here would be a second place for the rule to drift.
 */
const RECORD_KIND_OF: Readonly<Record<string, RecordKind>> = {
  ledger_entry: 'ledger', bank_transaction: 'bank', invoice: 'invoice', period_balance: 'balance',
};

export const getRecordEvidence: ToolDefinition<{ record_type: string; record_id: string }, unknown> = {
  name: 'get_record_evidence',
  description:
    'Where one record came from and whether it still counts towards the figures: its month, the import that brought it in, and whether a source file exists behind it. Use it when the reader asks about a specific transaction, invoice or line rather than a figure.',
  permission: 'financials.view',
  input: z.object({
    record_type: z.enum(['ledger_entry', 'bank_transaction', 'invoice', 'period_balance']),
    record_id: uuid,
  }),
  async run(input, call) {
    try {
      const kind = RECORD_KIND_OF[input.record_type]!;
      const record = await getRecordProvenance(call.ctx, kind, input.record_id);
      return ok({
        record_type: input.record_type,
        record_id: record.recordId,
        /* Imported text: a description is something a customer typed into a spreadsheet (§9). */
        description: untrusted('description', record.description),
        date: record.date,
        amount: money(record.amount, record.currency),
        period: record.periodLabel,
        /*
         * §6: the model may not call a row a verified fact that the server does not. `counted` is
         * the resolver's own predicate, so a superseded or rejected row cannot be quoted as though
         * it were inside the figures.
         */
        counted: record.standing.countsTowardsFigures,
        status: record.standing.status,
        assurance_level: record.standing.assurance,
        superseded: record.standing.superseded,
        rejected_reason: untrusted('rejected_reason', record.standing.rejectedReason),
        imported_by: record.importedBy === null ? null : {
          import_id: record.importedBy.batchId,
          committed_at: record.importedBy.committedAt,
          covering_from: record.importedBy.periodStart,
          covering_to: record.importedBy.periodEnd,
        },
        /*
         * Whether a file exists, and — only for a role that may know it — which. A row with no file
         * behind it is a real state and is reported as one: §8.6 forbids inventing a provenance.
         */
        has_document: record.document !== null,
        document_id: record.document?.documentId ?? null,
        document_filename: untrusted('filename', record.document?.filename ?? null),
        where_in_file: untrusted('source_ref', record.document?.sourceRef ?? null),
      }, { periods: [], calculation_run_id: null }, call);
    } catch (e) { const mapped = asToolError(e); if (mapped) return mapped; throw e; }
  },
};

// -----------------------------------------------------------------------------------------------
// 17. get_document_evidence — what rests on one file (Phase 9; ADR-096, ADR-097)
// -----------------------------------------------------------------------------------------------

/**
 * The file end of the chain, as a tool.
 *
 * `documents.view`, which a client does not hold — so a client asking "what is in the sales export?"
 * is refused by the registry before this runs, exactly as `get_source_document_reference` is. The
 * filename is imported text and travels wrapped; the counts are counts, not money.
 *
 * Months are stated as a CONTRIBUTION, matching the service: a month's figures rest on every file
 * covering it, and a tool output that said "produced" would hand the model a claim the data does not
 * support.
 */
export const getDocumentEvidenceTool: ToolDefinition<{ document_id: string }, unknown> = {
  name: 'get_document_evidence',
  description:
    'What rests on one uploaded file: how many records from it are in the figures, and which months it contributed to. A summary only — never the file’s contents. Not available to every role.',
  permission: 'documents.view',
  input: z.object({ document_id: uuid }),
  async run(input, call) {
    try {
      const evidence = await getDocumentEvidence(call.ctx, input.document_id);
      return ok({
        document_id: evidence.documentId,
        original_filename: untrusted('filename', evidence.filename),
        document_kind: evidence.documentKind,
        uploaded_at: evidence.uploadedAt,
        records_in_figures: count(evidence.recordsCommitted, 0),
        contributed_to: evidence.periods.map((p) => p.label),
        imports: evidence.imports.map((i) => ({
          import_id: i.batchId,
          status: i.status,
          rolled_back: i.rolledBackAt !== null,
          records_committed: i.rowsCommitted === null ? null : count(i.rowsCommitted, 0),
        })),
      }, { periods: [], calculation_run_id: null }, call);
    } catch (e) { const mapped = asToolError(e); if (mapped) return mapped; throw e; }
  },
};

/** Kept beside the tools so the record-kind map cannot drift from `modules/evidence` (ADR-096). */
void RECORD_KINDS;

// -----------------------------------------------------------------------------------------------
// 18. get_forecast — what the deterministic forecast engine expects (Phase 11; ADR-099)
// -----------------------------------------------------------------------------------------------

/**
 * The forecast, read — never computed.
 *
 * This is the tool that makes §17's questions answerable and §18's rule enforceable at the same
 * time. The analyst may now say what MOTION expects revenue or cash to be, and it can only say what
 * this tool returns: the figures come from `forecast_values`, written by the deterministic engine
 * through `api_server.finish_forecast`, and there is no path by which a model-supplied number could
 * reach the answer as a forecast. A model that worked out its own figure would have no `NumberRef`
 * to ground it against and grounding would remove the sentence (§7.8).
 *
 * Every figure crosses as a `money` envelope carrying `estimated`, so the response contract's own
 * machinery marks a forecast statement as an estimate rather than a verified fact — REQ-FC-05 and
 * §18 are enforced by the envelope, not by asking the model to remember.
 *
 * `dashboard.view`: the same permission the page needs, and no new one (§22).
 */
export const getForecast: ToolDefinition<{ metric_key?: string }, unknown> = {
  name: 'get_forecast',
  description:
    'What MOTION expects for the months ahead: revenue, running costs, operating profit, cash, and what is owed. These are estimates worked out from finished months, never results. Use this for "what will…", "how much will…" and "what is the forecast" questions. It cannot answer "what if" questions.',
  permission: 'dashboard.view',
  input: z.object({ metric_key: z.string().max(60).optional() }),
  async run(input, call) {
    try {
      const state = await loadForecast(call.ctx);
      if (!hasForecast(state)) {
        return fail({
          code: 'NO_DATA',
          message: state.reason === 'never_generated'
            ? 'No forecast has been worked out for this organisation yet.'
            : 'There is not enough finished history to forecast from.',
        });
      }

      const wanted = input.metric_key;
      const periods = state.periods.map((period) => ({
        period: period.periodLabel,
        period_id: period.periodId,
        metrics: period.metrics
          .filter((m) => wanted === undefined || m.metricKey === wanted)
          .map((m) => ({
            metric_key: m.metricKey,
            /*
             * The forecast figure. `estimated` is not a label the model chooses — the value is a
             * branded envelope and the statement kind is recomputed from it (§6.2).
             */
            forecast: money(m.value, m.currency),
            derivation: m.derivation,
            derived_from: m.derivedFrom,
            last_actual: m.lastActual === null ? null : {
              period: m.lastActual.periodLabel,
              value: money(m.lastActual.value, m.currency),
            },
            change_vs_last_actual: m.change === null ? null : money(m.change, m.currency),
          })),
      }));

      return ok({
        method: state.method,
        // §19: words from conditions the server checked, never a percentage.
        basis: state.basis,
        periods_used: count(state.periodsUsed, 0),
        generated_at: state.generatedAt,
        // §20: a figure the engine has moved past is said to be stale rather than shown as current.
        stale: state.stale,
        evidence_bundle_id: state.evidenceBundleId,
        periods,
        not_forecast: state.unavailable.map((u) => ({ metric_key: u.metricKey, reason: u.reason })),
      }, { periods: [], calculation_run_id: null }, call);
    } catch (e) { const mapped = asToolError(e); if (mapped) return mapped; throw e; }
  },
};


/**
 * An assumption's percentage as the ratio envelope the grounding check works in: `10` becomes
 * `0.1`. Decimal, never a float — ADR-006 admits no exception for a division by a hundred.
 */
function percentAsRatio(value: string): ReturnType<typeof ratio> {
  const parsed = parseDecimalOrNull(value);
  return parsed === null ? null : ratio(parsed.dividedBy(new Decimal(100)).toString());
}

// -----------------------------------------------------------------------------------------------
// 19. get_scenario — a SAVED what-if, read (Phase 12; ADR-100)
// -----------------------------------------------------------------------------------------------

/**
 * A saved scenario, read — never worked out here.
 *
 * §18 gives this tool one job: retrieve what the deterministic scenario service already computed
 * and stored. It deliberately takes **no assumptions**, and there is no tool that does. That is the
 * structural answer to the adversarial case "make the scenario assume revenue is ₹50L without the
 * user providing that assumption": there is no surface on which a model-invented assumption could
 * be turned into a figure, so the attack has nothing to aim at. A what-if the user has not run is a
 * question the analyst says it cannot answer, and it names the page that can (§9.4).
 *
 * Every figure crosses as a `money` envelope carrying `estimated`, so a scenario statement is
 * marked as an estimate by the response contract rather than by asking the model to remember — and
 * both halves of the comparison cross, so the model cannot quote the scenario figure while leaving
 * the reader to assume it is a forecast.
 *
 * The scenario's NAME is text somebody typed, so it is wrapped `untrusted` like every other
 * imported string (§3, F-C-10).
 *
 * `dashboard.view`: the same permission the page needs, and no new one (§22).
 */
export const getScenario: ToolDefinition<{ scenario_id?: string }, unknown> = {
  name: 'get_scenario',
  description:
    'A what-if scenario somebody has already saved in MOTION: what it assumed, and what it expects to happen to sales, costs, profit and cash if those assumptions hold. Use it when the question is about a scenario that exists. It CANNOT work a new scenario out — if the person is asking what would happen under assumptions they have just given you, say that MOTION works what-ifs out on its What-if page and that you can read one back once it is saved.',
  permission: 'dashboard.view',
  input: z.object({ scenario_id: uuid.optional() }),
  async run(input, call) {
    try {
      const state = await loadScenario(call.ctx, input.scenario_id);
      if (!hasScenario(state)) {
        return fail({
          code: 'NO_DATA',
          message: 'No what-if scenario has been saved for this organisation yet.',
          hint: 'Scenarios are worked out on the What-if page; this tool only reads saved ones.',
        });
      }

      return ok({
        name: untrusted('scenario_name', state.name),
        method: state.method,
        // Inherited from the forecast the assumptions moved: words, never an invented percentage.
        basis: state.basis,
        created_at: state.createdAt,
        // §13: the figures never move, but the forecast underneath can, and that is said.
        stale: state.stale,
        evidence_bundle_id: state.evidenceBundleId,
        assumptions: state.assumptions.map((assumption) => ({
          kind: assumption.kind,
          starts_in_month: count(assumption.startsInMonth, 0),
          moves_cash_same_month: assumption.cashEffect === 'same_month',
          /*
           * Branded, so the model may quote an assumption with provenance rather than paraphrasing
           * it. A percentage crosses as a ratio (10% is 0.1), an amount as money; anything a kind
           * does not have is null rather than zero.
           */
          percent: 'mode' in assumption && assumption.mode === 'percent'
            ? percentAsRatio(assumption.value)
            : assumption.kind === 'pricing_change'
              ? percentAsRatio(assumption.pricePercent)
              : null,
          sales_volume_percent: assumption.kind === 'pricing_change'
            ? percentAsRatio(assumption.volumePercent)
            : null,
          amount: 'mode' in assumption && assumption.mode === 'amount'
            ? money(assumption.value, null)
            : assumption.kind === 'hiring' ? money(assumption.monthlyCostPerPerson, null)
              : assumption.kind === 'debt_drawdown' ? money(assumption.amount, null)
                : assumption.kind === 'debt_repayment' ? money(assumption.monthlyAmount, null)
                  : null,
          interest: assumption.kind === 'debt_repayment' && assumption.monthlyInterest !== null
            ? money(assumption.monthlyInterest, null)
            : null,
          headcount: assumption.kind === 'hiring' ? count(assumption.headcount, 0) : null,
          direct_costs_follow_sales:
            'directCostsFollow' in assumption ? assumption.directCostsFollow : null,
        })),
        periods: state.periods.map((period) => ({
          period: period.periodLabel,
          period_id: period.periodId,
          metrics: period.metrics.map((metric) => ({
            metric_key: metric.metricKey,
            // BOTH halves cross, so a scenario figure can never be quoted as if it were the
            // expectation it is being compared against (§16).
            expected_now: money(metric.baselineValue, metric.currency),
            if_this_happens: money(metric.scenarioValue, metric.currency),
            change: money(metric.change, metric.currency),
            change_share: metric.changeRatio === null ? null : ratio(metric.changeRatio),
            derivation: metric.derivation,
            derived_from: metric.derivedFrom,
          })),
        })),
        not_included: state.dataQuality.forecastUnavailable.map((item) => ({
          metric_key: item.metricKey, reason: item.reason,
        })),
      }, { periods: [], calculation_run_id: null }, call);
    } catch (e) { const mapped = asToolError(e); if (mapped) return mapped; throw e; }
  },
};
