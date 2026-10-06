import { Decimal, ROUND_HALF_UP, formatMoney, formatPercent, toRatioString } from '@/core/money';
import { observationOf, usableValue, type MetricObservation } from '@/modules/alerts';
import { bandOf, coefficientOfVariation, type BandedRule } from '@/modules/health';
import {
  CASH_FAMILY, FACTOR_BASELINE, FACTOR_KEYS, FACTOR_NAMES, FACTOR_WEIGHTS, FUNDING_DISCLAIMER, FUNDING_RULES_VERSION,
  GATE_MIN_FACTORS, GATE_MIN_WEIGHT, MIN_COMPLETENESS, PROXY_CAP, RULES, SUBSTANTIVE, SUBSTANTIVE_WEIGHT_TOTAL,
  W7_WARNINGS, readinessBand, type FactorKey,
} from './config';
import type {
  ActionPriority, FactorResult, FactorSentence, FundingAssessment, FundingInput, ImprovementAction, MetricUse,
  MissingLine, RuleResult,
} from './types';

/**
 * The Funding Readiness assessment (PHASE_16_IMPLEMENTATION.md §4–§7). Pure and deterministic: the
 * same snapshots give the same assessment byte for byte. No model is involved anywhere (D-15).
 *
 * The contract, in the design's words:
 *   - each factor starts at 50, EVERY applicable rule adds its points, and the total is clamped to
 *     [0, 100] once (§4.2);
 *   - an unavailable input is not a value: the rule is skipped with its reason and adds nothing (§4.4);
 *     a genuine zero or negative IS a value (§4.5);
 *   - a factor is unavailable when a required input is missing, its completeness is below 0.6, or no
 *     rule could run (§4.6), and an unavailable factor is excluded, never scored 0;
 *   - estimated, proxy or AI-read required inputs cap the factor at 70 (§4.7; D-2), except F3 and F7;
 *   - one missing piece of data lowers at most one rule (§4.11, §5.9; A-1…A-5).
 */

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

interface Reader {
  readonly input: FundingInput;
  value(key: string, periodId?: string): Decimal | null;
  obs(key: string, periodId?: string): MetricObservation | undefined;
  use(key: string, periodId?: string): MetricUse;
  periodOffset(offset: number): string | null;
}

function reader(input: FundingInput): Reader {
  const index = input.periodIds.indexOf(input.periodId);
  return {
    input,
    obs: (key, periodId = input.periodId) => observationOf(input.snapshots, periodId, key),
    value: (key, periodId = input.periodId) => usableValue(observationOf(input.snapshots, periodId, key)),
    use: (key, periodId = input.periodId) => {
      const o = observationOf(input.snapshots, periodId, key);
      return { key, periodId, value: o?.value ?? null, snapshotId: o?.snapshotId ?? null };
    },
    // A month before the organisation's first period does not exist and has no data (§4.1).
    periodOffset: (offset) => (index - offset >= 0 ? input.periodIds[index - offset] ?? null : null),
  };
}

const banded = (key: keyof typeof RULES, value: Decimal | null, unavailableReason = 'value_unavailable'): RuleResult => {
  if (value === null) return { rule: key, value: null, band: null, points: 0, unavailable: unavailableReason };
  const band = bandOf(RULES[key] as BandedRule, value);
  return { rule: key, value: toRatioString(value), band: band.result, points: band.points, unavailable: null };
};
const flat = (rule: string, band: string, points: number, value: string | null = null): RuleResult =>
  ({ rule, value, band, points, unavailable: null });
const skipped = (rule: string, reason: string): RuleResult =>
  ({ rule, value: null, band: null, points: 0, unavailable: reason });

/** A period is P&L-complete (§4.10, A-3): revenue and operating profit usable, basis ≠ none, not partial. */
function pnlComplete(r: Reader, periodId: string): boolean {
  for (const key of ['revenue', 'operating_profit']) {
    const o = r.obs(key, periodId);
    if (o === undefined || usableValue(o) === null) return false;
    if (o.basis === 'none' || o.dataQuality.warnings.includes('partial_month')) return false;
  }
  return true;
}

const weakAssurance = (o: MetricObservation | undefined): 'proxy' | 'inferred' | null => {
  if (o === undefined) return null;
  if (o.assurance === 'inferred') return 'inferred';
  if (o.dataQuality.proxy || o.assurance === 'estimated') return 'proxy';
  return null;
};

// ---------------------------------------------------------------------------------------------
// Sentences, missing lines and actions (§4.8, §4.9, §7)
// ---------------------------------------------------------------------------------------------

interface Draft {
  readonly key: FactorKey;
  readonly required: readonly string[];
  /** Factor-level unavailability decided before the rules (§4.6 (a), (d)). */
  readonly unavailable?: { readonly reason: string; readonly codes: readonly string[]; readonly text?: string };
  readonly rules: readonly RuleResult[];
  readonly metrics: readonly MetricUse[];
  readonly noCap?: boolean;
  readonly extraMissing?: readonly MissingLine[];
}

const pct = (value: string) => formatPercent(value);

function sentenceFor(rule: RuleResult, currency: string, r: Reader): FactorSentence | null {
  if (rule.points === 0 || rule.unavailable !== null) return null;
  const v = rule.value ?? '';
  const pin = (...keys: string[]) => keys.map((k) => r.obs(k)?.snapshotId).filter((id): id is string => id !== null && id !== undefined);
  const money = (key: string) => (r.obs(key)?.value == null ? '' : formatMoney(r.obs(key)!.value!, { currency }));
  const make = (template: string, text: string, values: Record<string, string>, ids: string[]): FactorSentence =>
    ({ rule: rule.rule, template, text, values, snapshotIds: ids });
  switch (rule.rule) {
    case 'F1.1':
      return rule.band === 'no_revenue'
        ? make('no_revenue', 'No revenue in the month', {}, pin('revenue'))
        : rule.points < 0
          ? make('loss', `A loss of ${money('net_profit')}`, { net_profit: r.obs('net_profit')?.value ?? '' }, pin('net_profit'))
          : make('net_margin', `Net margin of ${pct(v)}`, { net_margin: v }, pin('net_margin'));
    case 'F1.2':
      return make('revenue_growth', `Revenue ${rule.points > 0 ? 'up' : 'down'} ${pct(new Decimal(v).abs().toString())}`, { growth: v },
        pin(r.value('revenue_growth_yoy') !== null ? 'revenue_growth_yoy' : 'revenue_growth_mom'));
    case 'F1.3': return make('gross_margin', `Gross margin of ${pct(v)}`, { gross_margin: v }, pin('gross_margin'));
    case 'F2.1': return make('closing_cash', `Cash at the month end of ${money('closing_cash')}`, { closing_cash: r.obs('closing_cash')?.value ?? '' }, pin('closing_cash'));
    case 'F2.2': return rule.band === 'cash generative'
      ? make('cash_generative', 'More cash came in than went out, so cash is not running down', {}, pin('cash_runway_months'))
      : make('runway', `Cash would last about ${new Decimal(v).toDecimalPlaces(1).toString()} months`, { runway: v }, pin('cash_runway_months'));
    case 'F2.3': return make('cash_trend', rule.points > 0 ? 'More cash came in than went out in most of the last three months' : 'More cash went out than came in in each of the last three months', {}, []);
    case 'F2.4': return make('cash_cover', `Cash covers ${new Decimal(v).toDecimalPlaces(1).toString()} months of spending`, { cover: v }, pin('closing_cash', 'cash_outflows'));
    case 'F3.1': return make('in_out', `Money in was ${new Decimal(v).toDecimalPlaces(2).toString()} times money out`, { ratio: v }, pin('cash_inflows', 'cash_outflows'));
    case 'F3.2': return make('anomalies', rule.points > 0 ? 'No unusual bank activity was found' : `${v} unusual bank pattern${v === '1' ? '' : 's'} found`, { count: v }, []);
    case 'F3.3': return make('coverage', rule.points > 0 ? 'Bank statements cover the whole month' : 'Bank statements cover only part of the month', { coverage: v }, []);
    case 'F3.4': return make('reconciliation', rule.points > 0 ? 'Every statement reconciles to its balances' : 'A bank statement does not reconcile to its balances', {}, []);
    case 'F3.5': return make('statement_history', `${v} of the previous five months fully covered by statements`, { months: v }, []);
    case 'F4.1': return rule.band === 'no_debt'
      ? make('no_debt', 'No borrowing on the balance sheet', {}, pin('debt_balance'))
      : rule.band === 'no_operating_profit'
        ? make('no_operating_profit', 'Borrowing with no operating profit over twelve months to service it', {}, pin('debt_balance'))
        : make('debt_ratio', `Debt is ${new Decimal(v).toDecimalPlaces(1).toString()} times twelve months of operating profit`, { ratio: v }, pin('debt_balance'));
    case 'F4.2': return rule.band === 'new_debt'
      ? make('new_debt', 'New borrowing in the last three months', {}, pin('debt_balance'))
      : make('debt_trend', `Debt ${rule.points > 0 ? 'down' : 'up'} ${pct(new Decimal(v).abs().toString())} over three months`, { change: v }, pin('debt_balance'));
    case 'F5.1': return make('days_to_get_paid', `Customers take about ${new Decimal(v).toDecimalPlaces(0).toString()} days to pay`, { days: v }, pin('receivables_days'));
    case 'F5.2': return rule.band === 'nothing_outstanding'
      ? make('nothing_overdue', 'No customer invoice is outstanding', {}, pin('receivables'))
      : make('receivables_overdue', `${pct(v)} of what customers owe is overdue`, { share: v }, pin('receivables', 'receivables_overdue'));
    case 'F5.3': return rule.band === 'nothing_outstanding'
      ? make('nothing_owed', 'No supplier bill is outstanding', {}, pin('payables'))
      : make('payables_overdue', `${pct(v)} of what you owe suppliers is overdue`, { share: v }, pin('payables', 'payables_overdue'));
    case 'F6.1': return make('continuity', `${v} of the last six months have complete figures`, { months: v }, []);
    case 'F6.2': return make('volatility', rule.points > 0 ? 'Revenue has been steady over six months' : 'Revenue has been volatile over six months', { cv: v }, []);
    case 'F6.3': return make('profitable_months', `${v} of the last six months were profitable`, { months: v }, []);
    case 'F7.1': return make('completeness', rule.points > 0 ? 'The scored figures are substantially complete' : 'Some scored figures rest on incomplete data', { completeness: v }, []);
    case 'F7.2': return make('pnl_basis', rule.points > 0 ? 'Profit comes from your accounts' : 'Profit is estimated from bank activity, not your accounts', { basis: v }, pin('revenue'));
    case 'F7.3': return make('warnings', `${v} data-quality warning${v === '1' ? '' : 's'} on the scored figures`, { warnings: v }, []);
    default: return null;
  }
}

const MISSING_TEXT: Readonly<Record<string, string>> = {
  required_input_missing: 'The figures this needs are not available yet.',
  insufficient_completeness: 'Too little of the month is visible to judge this.',
  no_applicable_rule: 'None of the checks for this could run on the data available.',
  no_bank_coverage: 'No bank statement covers the month.',
  no_balance_sheet: 'Debt could not be established from the available balance-sheet data.',
  no_revenue: 'No margin or growth is calculated for a month without revenue.',
  no_comparable_period: 'There is no earlier month to compare revenue with.',
  no_cost_of_sales_accounts: 'No direct-cost accounts, so there is no gross margin.',
  runway_unavailable: 'How long cash would last could not be worked out.',
  insufficient_history: 'Not enough complete months yet.',
  capacity_unavailable: 'Twelve months of complete operating profit are needed to judge debt against it.',
  no_statement_for_month: 'No account has a statement for the month to reconcile.',
  no_outflows_to_compare: 'No money went out, so money in cannot be compared with it.',
  aging_unavailable: 'Overdue amounts are not known for this source.',
  revenue_not_positive: 'Revenue was not positive over the period, so its steadiness cannot be measured.',
  no_prior_debt: 'Debt three months earlier is not known.',
  no_scored_factor: 'No other factor could be scored, so data quality has nothing to describe.',
  no_non_cash_input: 'Every scored figure is a cash figure, already judged by bank coverage.',
  value_unavailable: 'A figure this check needs is not available.',
};

const ACTION_TEXT: Readonly<Record<string, string>> = {
  'F2.2': 'Review near-term cash commitments: cash would last about {runway} months.',
  'F5.1': 'Review overdue customer balances: customers take about {days} days to pay.',
  'F4.1': 'Review debt exposure against operating profit.',
  'F3.3': 'Upload the missing bank statements.',
  'F3.5': 'Upload the missing bank statements.',
  'F4:no_balance_sheet': 'Import a trial balance or balance sheet so debt can be established.',
};

function priorityFor(points: number | null): ActionPriority {
  if (points === null) return 'medium';
  if (points <= -30) return 'high';
  if (points <= -10) return 'medium';
  return 'low';
}

function finalise(draft: Draft, r: Reader): FactorResult {
  const { key } = draft;
  const name = FACTOR_NAMES[key];
  const weight = FACTOR_WEIGHTS[key];
  const missing: MissingLine[] = [...(draft.extraMissing ?? [])];
  const actions: ImprovementAction[] = [];

  const unavailable = (reason: string, codes: readonly string[], text?: string): FactorResult => {
    missing.unshift({ factor: key, rule: null, reason, text: text ?? MISSING_TEXT[reason] ?? MISSING_TEXT.required_input_missing! });
    const actionText = ACTION_TEXT[`${key}:${reason}`] ?? `Add the data ${name.toLowerCase()} needs: ${(text ?? MISSING_TEXT[reason] ?? '').replace(/\.$/, '').toLowerCase()}.`;
    actions.push({ factor: key, rule: null, reason, text: actionText, priority: key === 'F7' ? 'low' : 'medium', evidence: codes.length > 0 ? codes : [reason] });
    return {
      key, name, weight, appliedWeight: 0, status: 'missing', score: null, reason, missingCodes: codes, capped: false, capReason: null,
      completeness: null, rules: draft.rules, metrics: draft.metrics, positives: [], negatives: [], missing, actions,
    };
  };

  if (draft.unavailable) return unavailable(draft.unavailable.reason, draft.unavailable.codes, draft.unavailable.text);

  // §4.6 (b): thin required inputs exclude the factor.
  const required = draft.required.map((k) => r.obs(k));
  const completenessValues = required.filter((o): o is MetricObservation => o !== undefined).map((o) => o.dataQuality.completeness);
  const completeness = completenessValues.length === 0 ? null : Math.min(...completenessValues);
  if (completeness !== null && completeness < MIN_COMPLETENESS) return unavailable('insufficient_completeness', []);

  // §4.6 (c)
  if (draft.rules.every((rule) => rule.unavailable !== null)) return unavailable('no_applicable_rule', []);

  const total = draft.rules.reduce((sum, rule) => sum + rule.points, FACTOR_BASELINE);
  let score = Math.min(100, Math.max(0, total));
  const weak = draft.noCap ? [] : required.map(weakAssurance).filter((w): w is 'proxy' | 'inferred' => w !== null);
  const capped = weak.length > 0 && score > PROXY_CAP;
  if (weak.length > 0) score = Math.min(score, PROXY_CAP);
  const capReason = weak.length === 0 ? null : weak.includes('inferred') ? 'includes figures read from a PDF by AI' : 'based on bank data only';

  const positives: FactorSentence[] = [];
  const negatives: FactorSentence[] = [];
  for (const rule of draft.rules) {
    if (rule.unavailable !== null) {
      missing.push({ factor: key, rule: rule.rule, reason: rule.unavailable, text: MISSING_TEXT[rule.unavailable] ?? MISSING_TEXT.value_unavailable! });
      continue;
    }
    const sentence = sentenceFor(rule, r.input.currency, r);
    if (sentence === null) continue;
    (rule.points > 0 ? positives : negatives).push(sentence);
    if (rule.points < 0) {
      const values = sentence.values;
      const template = ACTION_TEXT[rule.rule];
      const text = template !== undefined
        ? template.replace('{runway}', values.runway ? new Decimal(values.runway).toDecimalPlaces(1).toString() : '')
          .replace('{days}', values.days ? new Decimal(values.days).toDecimalPlaces(0).toString() : '')
        : `Review ${RULES[rule.rule as keyof typeof RULES]?.description.toLowerCase() ?? name.toLowerCase()}: ${sentence.text.charAt(0).toLowerCase()}${sentence.text.slice(1)}.`;
      actions.push({ factor: key, rule: rule.rule, reason: rule.band ?? 'negative', text, priority: priorityFor(rule.points), evidence: sentence.snapshotIds });
    }
  }

  return {
    key, name, weight, appliedWeight: 0, status: 'scored', score, reason: null, missingCodes: [], capped, capReason,
    completeness, rules: draft.rules, metrics: draft.metrics, positives, negatives, missing, actions,
  };
}

/** The required inputs that are missing, with the engine's own `missing` codes (§4.6 (a)). */
function requiredMissing(r: Reader, keys: readonly string[]): { reason: string; codes: string[] } | null {
  const absent = keys.filter((k) => r.value(k) === null);
  if (absent.length === 0) return null;
  const codes = [...new Set(absent.flatMap((k): readonly string[] => r.obs(k)?.dataQuality.missing ?? ['no_figure']))];
  return { reason: 'required_input_missing', codes };
}

// ---------------------------------------------------------------------------------------------
// The factors (§5)
// ---------------------------------------------------------------------------------------------

function f1(r: Reader): Draft {
  const required = ['revenue', 'net_profit'];
  const metrics = ['revenue', 'net_profit', 'net_margin', 'gross_margin', 'revenue_growth_yoy', 'revenue_growth_mom'].map((k) => r.use(k));
  const gap = requiredMissing(r, required);
  if (gap) return { key: 'F1', required, unavailable: { reason: gap.reason, codes: gap.codes }, rules: [], metrics };
  const revenue = r.value('revenue')!;
  // A-4: revenue ≤ 0 → −30, and no margin or growth is calculated.
  if (!revenue.greaterThan(0)) {
    return { key: 'F1', required, metrics, rules: [
      flat('F1.1', 'no_revenue', -30, toRatioString(revenue)), skipped('F1.2', 'no_revenue'), skipped('F1.3', 'no_revenue'),
    ] };
  }
  const growth = r.value('revenue_growth_yoy') ?? r.value('revenue_growth_mom');
  const grossObs = r.obs('gross_margin');
  const grossReason = grossObs?.dataQuality.missing.includes('no_cost_of_sales_accounts') ? 'no_cost_of_sales_accounts' : 'value_unavailable';
  return { key: 'F1', required, metrics, rules: [
    banded('F1.1', r.value('net_margin')),
    banded('F1.2', growth, 'no_comparable_period'),
    banded('F1.3', r.value('gross_margin'), grossReason),
  ] };
}

function f2(r: Reader): Draft {
  const required = ['closing_cash', 'net_cash_movement'];
  const metrics = ['closing_cash', 'net_cash_movement', 'cash_runway_months', 'cash_outflows'].map((k) => r.use(k));
  const gap = requiredMissing(r, required);
  if (gap) return { key: 'F2', required, unavailable: { reason: gap.reason, codes: gap.codes }, rules: [], metrics };

  const cash = r.value('closing_cash')!;
  const f21 = cash.greaterThan(0) ? flat('F2.1', '> 0', 10, toRatioString(cash)) : flat('F2.1', '<= 0', -40, toRatioString(cash));

  const runway = r.value('cash_runway_months');
  const runwayObs = r.obs('cash_runway_months');
  const f22 = runway !== null ? banded('F2.2', runway)
    : runwayObs?.dataQuality.warnings.includes('cash_positive') ? flat('F2.2', 'cash generative', 20)
      : skipped('F2.2', 'runway_unavailable');

  // A-5: a month whose bank evidence is not full counts as unavailable, never as a fall.
  const months = [2, 1, 0].map((o) => r.periodOffset(o));
  const usable = months.map((p) => {
    if (p === null) return null;
    if (r.input.bankEvidence.get(p) !== 1) return null;
    return r.value('net_cash_movement', p);
  });
  const f23 = usable.some((v) => v === null)
    ? skipped('F2.3', 'insufficient_history')
    : usable.filter((v) => v!.greaterThan(0)).length >= 2 ? flat('F2.3', 'positive in 2+ of 3', 15)
      : usable.every((v) => !v!.greaterThan(0)) ? flat('F2.3', 'not positive in all 3', -20)
        : flat('F2.3', 'mixed', 0);

  const outflows = r.value('cash_outflows');
  const f24 = outflows === null || outflows.isZero() ? skipped('F2.4', 'no_outflows_to_compare') : banded('F2.4', cash.dividedBy(outflows.abs()));
  return { key: 'F2', required, metrics, rules: [f21, f22, f23, f24] };
}

function f3(r: Reader): Draft {
  const metrics = ['cash_inflows', 'cash_outflows'].map((k) => r.use(k));
  const coverage = r.input.bankEvidence.get(r.input.periodId) ?? null;
  // H-1: NULL (no cash-like account) and 0 are both "no bank coverage" — never "full".
  if (coverage === null || coverage <= 0) {
    return { key: 'F3', required: [], noCap: true, unavailable: { reason: 'no_bank_coverage', codes: ['no_bank_coverage'] }, rules: [], metrics };
  }
  const inflows = r.value('cash_inflows');
  const outflows = r.value('cash_outflows');
  const f31 = inflows === null || outflows === null || outflows.isZero()
    ? skipped('F3.1', 'no_outflows_to_compare') : banded('F3.1', inflows.abs().dividedBy(outflows.abs()));

  const a = r.input.anomalies;
  const f32 = a.suppressed ? skipped('F3.2', a.reason ?? 'anomaly_rules_suppressed')
    : a.count === 0 ? flat('F3.2', '0', 10, '0') : a.count <= 2 ? flat('F3.2', '1-2', -5, String(a.count)) : flat('F3.2', '3+', -15, String(a.count));

  const f33 = coverage >= 1 ? flat('F3.3', 'full', 10, String(coverage)) : flat('F3.3', 'partial', -5, String(coverage));

  const accounts = r.input.reconciliation;
  const f34 = accounts.length === 0 ? skipped('F3.4', 'no_statement_for_month')
    : accounts.some((x) => x.status === 'unreconciled') ? flat('F3.4', 'unreconciled', -10)
      : accounts.every((x) => x.status === 'reconciled') ? flat('F3.4', 'reconciled', 10) : flat('F3.4', 'balances missing', 0);

  // A-1: the five periods before P; a period that does not exist counts as not covered.
  const covered = [5, 4, 3, 2, 1].map((o) => r.periodOffset(o))
    .filter((p) => p !== null && r.input.bankEvidence.get(p) === 1).length;
  const f35 = covered === 5 ? flat('F3.5', '5', 10, '5') : covered >= 3 ? flat('F3.5', '3-4', 0, String(covered)) : flat('F3.5', '0-2', -10, String(covered));

  return { key: 'F3', required: [], noCap: true, metrics, rules: [f31, f32, f33, f34, f35] };
}

function f4(r: Reader): Draft {
  const required = ['debt_balance'];
  const metrics: MetricUse[] = [r.use('debt_balance')];
  const debt = r.value('debt_balance');
  if (debt === null) {
    const hints: MissingLine[] = r.input.loanBankAccountNames.map((n) => ({
      factor: 'F4', rule: null, reason: 'loan_account_hint',
      text: `"${n}" is a loan-type bank account, but a bank account never establishes what is owed; a trial balance or balance sheet does.`,
    }));
    return { key: 'F4', required, metrics, rules: [], extraMissing: hints,
      unavailable: { reason: 'no_balance_sheet', codes: r.obs('debt_balance')?.dataQuality.missing ?? ['no_balance_sheet'] } };
  }

  // T12M operating profit: defined only when all twelve periods are P&L-complete (§4.10).
  const window = Array.from({ length: 12 }, (_, i) => r.periodOffset(11 - i));
  let t12m: Decimal | null = null;
  if (window.every((p) => p !== null && pnlComplete(r, p))) {
    t12m = window.reduce((s, p) => s.plus(r.value('operating_profit', p!)!), new Decimal(0));
    for (const p of window) metrics.push(r.use('operating_profit', p!));
  }

  let f41: RuleResult;
  if (!debt.greaterThan(0)) f41 = flat('F4.1', 'no_debt', 25, toRatioString(debt));
  else if (t12m === null) f41 = skipped('F4.1', 'capacity_unavailable');
  else if (!t12m.greaterThan(0)) f41 = flat('F4.1', 'no_operating_profit', -30);
  else f41 = banded('F4.1', debt.dividedBy(t12m));

  const priorPeriod = r.periodOffset(3);
  const prior = priorPeriod === null ? null : r.value('debt_balance', priorPeriod);
  let f42: RuleResult;
  if (prior === null) f42 = skipped('F4.2', 'no_prior_debt');
  else if (!prior.greaterThan(0)) f42 = debt.greaterThan(0) ? flat('F4.2', 'new_debt', -10) : flat('F4.2', 'none either side', 0);
  else f42 = banded('F4.2', debt.minus(prior).dividedBy(prior));
  if (priorPeriod !== null) metrics.push(r.use('debt_balance', priorPeriod));

  return { key: 'F4', required, metrics, rules: [f41, f42] };
}

/** F5.2/F5.3's population: gross open invoices and their overdue part, credits apart (ADR-124 D-5, ADR-140). */
function grossShare(r: Reader, side: 'sales' | 'purchase', asOf: string): { open: Decimal; overdue: Decimal } {
  let open = new Decimal(0);
  let overdue = new Decimal(0);
  for (const i of r.input.openInvoices) {
    if (i.invoiceType !== side || i.issueDate > asOf) continue;
    const outstanding = new Decimal(i.outstanding);
    if (!outstanding.greaterThan(0)) continue;
    open = open.plus(outstanding);
    if (i.dueDate !== null && i.dueDate < asOf) overdue = overdue.plus(outstanding);
  }
  return { open, overdue };
}

function shareRule(r: Reader, rule: 'F5.2' | 'F5.3', side: 'sales' | 'purchase', totalKey: string, overdueKey: string): RuleResult {
  if (r.value(totalKey) === null) return skipped(rule, 'value_unavailable');
  const overdueObs = r.obs(overdueKey);
  if (usableValue(overdueObs) === null) return skipped(rule, 'aging_unavailable');
  const asOf = typeof overdueObs?.components.as_of === 'string' ? overdueObs.components.as_of : r.input.periodEnd;
  const pop = grossShare(r, side, asOf);
  if (!pop.open.greaterThan(0)) return flat(rule, 'nothing_outstanding', 10, '0');
  return banded(rule, Decimal.min(pop.overdue.dividedBy(pop.open), new Decimal(1)));
}

function f5(r: Reader): Draft {
  const metrics = ['receivables', 'receivables_overdue', 'receivables_days', 'payables', 'payables_overdue'].map((k) => r.use(k));
  // Required: receivables OR payables. Both missing is unavailable, never "nothing outstanding".
  if (r.value('receivables') === null && r.value('payables') === null) {
    const codes = [...new Set(['receivables', 'payables'].flatMap((k): readonly string[] => r.obs(k)?.dataQuality.missing ?? ['no_figure']))];
    return { key: 'F5', required: [], unavailable: { reason: 'required_input_missing', codes }, rules: [], metrics };
  }
  const required = ['receivables', 'payables'].filter((k) => r.value(k) !== null);
  return { key: 'F5', required, metrics, rules: [
    banded('F5.1', r.value('receivables_days')),
    shareRule(r, 'F5.2', 'sales', 'receivables', 'receivables_overdue'),
    shareRule(r, 'F5.3', 'purchase', 'payables', 'payables_overdue'),
  ] };
}

function f6(r: Reader): Draft {
  const required = ['revenue', 'operating_profit'];
  const window = Array.from({ length: 6 }, (_, i) => r.periodOffset(5 - i));
  const metrics = window.flatMap((p) => (p === null ? [] : [r.use('revenue', p), r.use('operating_profit', p)]));
  if (!pnlComplete(r, r.input.periodId)) {
    const gap = requiredMissing(r, required);
    return { key: 'F6', required, metrics, rules: [],
      unavailable: { reason: 'required_input_missing', codes: gap?.codes ?? ['partial_month'] } };
  }
  const complete = window.map((p) => p !== null && pnlComplete(r, p));
  const count = complete.filter(Boolean).length;
  const f61 = count === 6 ? flat('F6.1', '6', 10, '6') : count >= 4 ? flat('F6.1', '4-5', 0, String(count)) : flat('F6.1', '1-3', -10, String(count));
  // A missing month is never loss-making: F6.2 and F6.3 need all six complete.
  if (count < 6) return { key: 'F6', required, metrics, rules: [f61, skipped('F6.2', 'insufficient_history'), skipped('F6.3', 'insufficient_history')] };

  const revenues = window.map((p) => r.value('revenue', p!)!);
  const cv = coefficientOfVariation(revenues);
  const f62 = cv === null ? skipped('F6.2', 'revenue_not_positive') : banded('F6.2', cv);
  const profitable = window.filter((p) => r.value('operating_profit', p!)!.greaterThan(0)).length;
  const f63 = profitable === 6 ? flat('F6.3', '6', 15, '6') : profitable >= 4 ? flat('F6.3', '4-5', 5, String(profitable))
    : profitable >= 2 ? flat('F6.3', '2-3', -5, String(profitable)) : flat('F6.3', '0-1', -15, String(profitable));
  return { key: 'F6', required, metrics, rules: [f61, f62, f63] };
}

function f7(r: Reader, scored: readonly FactorResult[]): Draft {
  const substantive = scored.filter((f) => f.status === 'scored' && f.key !== 'F7');
  if (substantive.length === 0) {
    return { key: 'F7', required: [], noCap: true, unavailable: { reason: 'no_scored_factor', codes: [] }, rules: [], metrics: [] };
  }
  const inputs = substantive.flatMap((f) => f.metrics.filter((m) => m.periodId === r.input.periodId).map((m) => r.obs(m.key)))
    .filter((o): o is MetricObservation => o !== undefined && o.value !== null);
  const nonCash = inputs.filter((o) => !CASH_FAMILY.has(o.metricKey));
  const f71 = nonCash.length === 0 ? skipped('F7.1', 'no_non_cash_input')
    : banded('F7.1', new Decimal(Math.min(...nonCash.map((o) => o.dataQuality.completeness))));
  const basis = r.obs('revenue')?.basis ?? null;
  const f72 = basis === null || basis === 'none' ? skipped('F7.2', 'value_unavailable')
    : basis === 'period_balances' || basis === 'ledger' ? flat('F7.2', basis, 15, basis)
      : basis === 'invoices' ? flat('F7.2', basis, 5, basis) : flat('F7.2', basis, -15, basis);
  const warnings = new Set(inputs.flatMap((o) => o.dataQuality.warnings.filter((w) => W7_WARNINGS.has(w))));
  const f73 = warnings.size === 0 ? flat('F7.3', '0', 10, '0') : warnings.size <= 2 ? flat('F7.3', '1-2', 0, String(warnings.size))
    : flat('F7.3', '3+', -10, String(warnings.size));
  return { key: 'F7', required: [], noCap: true, metrics: [], rules: [f71, f72, f73] };
}

// ---------------------------------------------------------------------------------------------
// The assessment (§6)
// ---------------------------------------------------------------------------------------------

const PRIORITY_ORDER: Readonly<Record<ActionPriority, number>> = { high: 0, medium: 1, low: 2 };

export function assessFundingReadiness(input: FundingInput): FundingAssessment {
  const r = reader(input);
  const substantive = [f1(r), f2(r), f3(r), f4(r), f5(r), f6(r)].map((d) => finalise(d, r));
  const all = [...substantive, finalise(f7(r, substantive), r)];

  // §6.1 the gate: F1 and F2, and at least three of F3–F6. F7 never counts.
  const scoredKeys = new Set(all.filter((f) => f.status === 'scored').map((f) => f.key));
  const substantiveScored = SUBSTANTIVE.filter((k) => scoredKeys.has(k));
  const substantiveWeight = substantiveScored.reduce((t, k) => t + FACTOR_WEIGHTS[k], 0);
  const gate = scoredKeys.has('F1') && scoredKeys.has('F2')
    && substantiveScored.length >= GATE_MIN_FACTORS && substantiveWeight >= GATE_MIN_WEIGHT;

  // §6.2: renormalised applied weights (1 dp), then the weighted mean (0 dp), half up — Health's rounding.
  const scored = all.filter((f) => f.status === 'scored');
  const totalWeight = scored.reduce((t, f) => t + f.weight, 0);
  const applied = new Map<FactorKey, Decimal>(scored.map((f) => [f.key,
    totalWeight === 0 ? new Decimal(0) : new Decimal(f.weight).dividedBy(totalWeight).times(100).toDecimalPlaces(1, ROUND_HALF_UP)]));
  const appliedTotal = [...applied.values()].reduce((t, w) => t.plus(w), new Decimal(0));
  const score = !gate || appliedTotal.isZero() ? null
    : scored.reduce((t, f) => t.plus(new Decimal(f.score!).times(applied.get(f.key)!)), new Decimal(0))
      .dividedBy(appliedTotal).toDecimalPlaces(0, ROUND_HALF_UP).toNumber();

  const factors = all.map((f) => ({ ...f, appliedWeight: (applied.get(f.key) ?? new Decimal(0)).toNumber() }));

  // §7 order: priority, then factor weight, then factor order, then rule order.
  const actions = factors.flatMap((f) => f.actions).sort((a, b) =>
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    || FACTOR_WEIGHTS[b.factor] - FACTOR_WEIGHTS[a.factor]
    || FACTOR_KEYS.indexOf(a.factor) - FACTOR_KEYS.indexOf(b.factor)
    || (a.rule ?? '').localeCompare(b.rule ?? ''));

  return {
    rulesVersion: FUNDING_RULES_VERSION,
    periodId: input.periodId,
    status: score === null ? 'insufficient_data' : 'scored',
    score,
    band: readinessBand(score),
    factorsUsed: scored.length,
    factorsTotal: 7,
    substantiveWeightScored: substantiveWeight,
    dataCoveragePercent: new Decimal(substantiveWeight).times(100).dividedBy(SUBSTANTIVE_WEIGHT_TOTAL).toDecimalPlaces(0, ROUND_HALF_UP).toNumber(),
    factors,
    actions,
    disclaimer: FUNDING_DISCLAIMER,
  };
}
