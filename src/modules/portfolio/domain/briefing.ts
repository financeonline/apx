/**
 * The adviser analyst's contract (ADR-113, ADR-114 §5). Pure.
 *
 * The model never sees a database, a data tool, or an organisation the caller may not advise. It sees
 * a DIGEST built from the Command Centre's authorised view: each client, alert and action has a short
 * reference, and every number the digest states is a FACT with an id, a subject, a metric, a period, a
 * unit and a value. The model answers through one forced output tool, citing the fact ids its
 * sentences rest on.
 *
 * Grounding is claim-level and fact-specific (ADR-114 §5, ADR-115). Every quantitative claim a
 * sentence makes — in digits, in words, as a fraction or a multiplier (`quantities.ts`) — must be
 * bound to ONE fact the sentence cites that has its exact value, its unit, its metric (read from the
 * claim's own clause), its subject (the client the sentence names), its period and its direction.
 * "The same number appears somewhere in the digest" proves nothing; neither does a number inside an
 * alert's title. A hedged figure ("about 20%") or a magnitude with no figure ("sharply") has no fact
 * to bind to. A sentence with any claim that fails is removed — the rest of the answer stands.
 */

import { z } from 'zod';
import { parseDecimalOrNull } from '@/core/money';
import { bandLabel } from '@/modules/health';
import { PRIORITY_LABELS, SEVERITY_LABELS, TREND_LABELS, dueLabel } from './presentation';
import { periodOf, readQuantities, type PeriodMention, type Quantity, type QuantityUnit } from './quantities';
import type { PortfolioAction, PortfolioAlert, PortfolioView } from './types';

export const BRIEFING_TOOL = 'submit_briefing';
export const BRIEFING_PROMPT_VERSION = 'adviser-v2.1';
export const MAX_QUESTION_CHARS = 1_000;

// ---------------------------------------------------------------------------------------------
// Facts and the digest
// ---------------------------------------------------------------------------------------------

/**
 * `multiple` is a ratio to a stated comparison ("doubled" is 2, "halved" is 0.5). The digest emits
 * none today; the unit exists so that a multiplier claim can only ever be grounded by a fact that
 * states one — never by a "2" that happens to be a count.
 */
export type FactUnit = 'count' | 'score' | 'percent' | 'months' | 'money' | 'multiple';

export interface Fact {
  readonly id: string;
  /** `portfolio`, or a client ref (`client:N`). */
  readonly subject: string;
  readonly metric: string;
  /** Words one of which the claim's clause must contain (matched at a word start). Lower case. */
  readonly words: readonly string[];
  /** A noun the clause must also contain ("critical" needs "alert"). */
  readonly noun?: string;
  /** Words that name a more specific fact: "3 overdue actions" is not the open-action count. */
  readonly excludes?: readonly string[];
  /** For a change: the way it went. A clause saying the opposite does not state this fact. */
  readonly direction?: 'increase' | 'decrease' | null;
  /** The period label the fact is for, or null when it has none (a count of what stands today). */
  readonly period: string | null;
  readonly value: string;
  readonly unit: FactUnit;
}

export interface DigestAlert { readonly ref: string; readonly id: string; readonly severity: string; readonly status: string; readonly title: string; readonly standing_since: string }
export interface DigestAction { readonly ref: string; readonly id: string; readonly priority: string; readonly title: string; readonly due: string | null }
export interface DigestClient {
  readonly ref: string;
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly health: { readonly band: string | null; readonly month: string; readonly trend: string | null; readonly previous_month: string | null } | null;
  readonly attention: readonly string[];
  /** A capped sample; the complete counts are facts. */
  readonly alerts: readonly DigestAlert[];
  readonly actions: readonly DigestAction[];
}
export interface Digest {
  readonly today: string;
  readonly clients: readonly DigestClient[];
  readonly facts: readonly Fact[];
}

/** Per-client detail given to the model: at most this many alerts and actions each. */
export const DIGEST_DETAIL_PER_CLIENT = 10;

/**
 * The view, with references and facts. Everything the model may cite is here and nothing else
 * exists. `alerts` and `actions` are the portfolio's capped detail lists (worst first); the counts
 * the model may state come from the view's authoritative aggregates, as facts.
 */
export function buildDigest(view: PortfolioView, alerts: readonly PortfolioAlert[], actions: readonly PortfolioAction[]): Digest {
  const facts: Fact[] = [];
  type Shape = Pick<Fact, 'words' | 'noun' | 'excludes' | 'direction'>;
  const fact = (subject: string, metric: string, shape: Shape, value: number | null, unit: FactUnit, period: string | null = null) => {
    if (value === null) return;
    facts.push({ id: `${subject}/${metric}`, subject, metric, ...shape, period, value: String(value), unit });
  };
  // What a clause must say to state each count. The generic counts exclude the qualifiers of the
  // specific ones, so "3 overdue actions" can never be grounded by the open-action count.
  const COUNTS = {
    clients: { words: ['client', 'organisation', 'organization'] },
    needing_attention: { words: ['attention', 'need'] },
    healthy: { words: ['healthy', 'stable', 'strong'] },
    unscored: { words: ['unscored', 'scored', 'score'] },
    standing_alerts: { words: ['alert'], excludes: ['critical', 'high'] },
    critical_alerts: { words: ['critical'], noun: 'alert' },
    high_alerts: { words: ['high'], noun: 'alert' },
    open_actions: { words: ['action'], excludes: ['overdue', 'urgent', 'due'] },
    overdue_actions: { words: ['overdue'], noun: 'action' },
  } satisfies Record<string, Shape>;
  const c = view.counts;
  fact('portfolio', 'clients', COUNTS.clients, c.clients, 'count');
  fact('portfolio', 'needing_attention', COUNTS.needing_attention, c.needingAttention, 'count');
  fact('portfolio', 'healthy', COUNTS.healthy, c.healthy, 'count');
  fact('portfolio', 'unscored', COUNTS.unscored, c.unscored, 'count');
  fact('portfolio', 'standing_alerts', COUNTS.standing_alerts, c.alertsStanding, 'count');
  fact('portfolio', 'critical_alerts', COUNTS.critical_alerts, c.criticalAlerts, 'count');
  fact('portfolio', 'high_alerts', COUNTS.high_alerts, c.highAlerts, 'count');
  fact('portfolio', 'open_actions', COUNTS.open_actions, c.openActions, 'count');
  fact('portfolio', 'overdue_actions', COUNTS.overdue_actions, c.overdueActions, 'count');

  let alertN = 0;
  let actionN = 0;
  const clients = view.clients.map((row, i): DigestClient => {
    const ref = `client:${i + 1}`;
    const h = row.health;
    // "fell", "rose", "from", "was" are not metric words: they no longer let a sentence about
    // anything state a health score. The change carries its direction instead.
    if (h !== null) {
      fact(ref, 'health_score', { words: ['health', 'score'] }, h.score, 'score', h.periodLabel);
      if (h.previous !== null) fact(ref, 'previous_health_score', { words: ['health', 'score'] }, h.previous.score, 'score', h.previous.periodLabel);
    }
    const k = row.counts;
    fact(ref, 'standing_alerts', COUNTS.standing_alerts, k.alertsStanding, 'count');
    fact(ref, 'critical_alerts', COUNTS.critical_alerts, k.alertsCritical, 'count');
    fact(ref, 'high_alerts', COUNTS.high_alerts, k.alertsHigh, 'count');
    fact(ref, 'open_actions', COUNTS.open_actions, k.actionsOpen, 'count');
    fact(ref, 'overdue_actions', COUNTS.overdue_actions, k.actionsOverdue, 'count');
    if (h !== null && h.previous?.score != null && h.score !== null) {
      const delta = h.score - h.previous.score;
      fact(ref, 'health_score_change', {
        words: ['health', 'score'],
        direction: delta < 0 ? 'decrease' : delta > 0 ? 'increase' : null,
      }, Math.abs(delta), 'score', null);
    }
    return {
      ref,
      id: row.organisation.id,
      name: row.organisation.name,
      status: row.organisation.status,
      health: h === null ? null : {
        band: bandLabel(h.band), month: h.periodLabel, trend: row.trend === null ? null : TREND_LABELS[row.trend],
        previous_month: h.previous?.periodLabel ?? null,
      },
      attention: row.attention?.reasons.map((r) => r.label) ?? [],
      alerts: alerts.filter((a) => a.organizationId === row.organisation.id).slice(0, DIGEST_DETAIL_PER_CLIENT).map((a) => ({
        ref: `alert:${++alertN}`, id: a.id, severity: SEVERITY_LABELS[a.severity], status: a.status, title: a.title,
        standing_since: a.firstSeenAt.slice(0, 10),
      })),
      actions: actions.filter((a) => a.organizationId === row.organisation.id).slice(0, DIGEST_DETAIL_PER_CLIENT).map((a) => ({
        ref: `action:${++actionN}`, id: a.id, priority: PRIORITY_LABELS[a.priority], title: a.title, due: dueLabel(a.dueDate, view.today),
      })),
    };
  });
  return { today: view.today, clients, facts };
}

// ---------------------------------------------------------------------------------------------
// What the model submits
// ---------------------------------------------------------------------------------------------

const FactIds = z.array(z.string()).max(40);
export const BriefingSchema = z.object({
  mode: z.enum(['answer', 'refusal']),
  headline: z.object({ text: z.string().min(1).max(300), facts: FactIds }),
  clients: z.array(z.object({
    ref: z.string(),
    summary: z.string().min(1).max(600),
    /** Fact ids the summary's numbers rest on. */
    facts: FactIds,
    /** alert:N / action:N refs the summary rests on. */
    because: z.array(z.string()).max(12),
  })).max(25),
  notes: z.array(z.object({ text: z.string().max(400), facts: FactIds })).max(6),
  limitations: z.array(z.string().max(300)).max(6),
});
export type Briefing = z.infer<typeof BriefingSchema>;

export interface GroundedBriefing {
  readonly briefing: Briefing;
  readonly status: 'passed' | 'degraded' | 'not_applicable';
  /** What was dropped or rewritten, for the record — never rendered. */
  readonly removed: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Grounding (ADR-115)
// ---------------------------------------------------------------------------------------------

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

const DECREASE = /\b(?:fell|fall|falls|fallen|falling|declined?|declines|declining|dropped|drops?|down|decreased?|decreases|lower|lowered|reduced|reduction|shrank|shrunk|lost|worsened|weakened|slipped|slid|contracted|deteriorated)\b/;
const INCREASE = /\b(?:rose|rise|rises|risen|rising|increased?|increases|up|grew|grows?|grown|growth|higher|gained|gains?|improved|improvement|climbed|strengthened|jumped|expanded)\b/;
/** Financial words. A count or a score is never a figure about any of them. */
const FINANCIAL = ['revenue', 'sales', 'turnover', 'income', 'profit', 'margin', 'cash', 'runway', 'cost', 'expense', 'spend', 'payroll', 'wage', 'salar', 'debt', 'burn', 'ebitda', 'receivable', 'debtor', 'payable', 'creditor', 'invoice', 'vat', 'tax', 'balance', 'liquidity', 'loss', 'overhead', 'fee', 'price', 'valuation', 'capital', 'funding', 'loan', 'dividend', 'money'];
/** A portfolio fact belongs to a clause about the portfolio. Naming a client narrows what counts. */
const PORTFOLIO_NARROW = /\b(?:portfolio|clients|organisations|organizations)\b/;
const PORTFOLIO_BROAD = /\b(?:portfolio|clients|organisations|organizations|across|overall|in total|altogether)\b/;
const LEGAL_SUFFIX = /\s+(?:ltd\.?|limited|llc|llp|plc|inc\.?|fze|fzco|fz-llc|co\.?|corp\.?|gmbh|pvt\.?(?:\s+ltd\.?)?)$/i;

const has = (words: string, word: string): boolean => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(words);

function unitMatches(unit: QuantityUnit, factUnit: FactUnit): boolean {
  switch (unit) {
    case 'bare': return factUnit === 'count' || factUnit === 'score';
    case 'points': return factUnit === 'score';
    case 'percent': return factUnit === 'percent';
    case 'months': return factUnit === 'months';
    case 'money': return factUnit === 'money';
    case 'multiple': return factUnit === 'multiple';
    default: return false;
  }
}

/** A named period and a fact's period label agree: the same label, or the same month (and year, if named). */
function periodAgrees(mention: PeriodMention, label: string): boolean {
  if (mention.text.trim().toLowerCase() === label.trim().toLowerCase()) return true;
  const fact = periodOf(label);
  if (mention.month !== null) return fact.month === mention.month && (mention.year === null || fact.year === mention.year);
  // A quarter is not a month: fiscal quarters are the organisation's own, so only its label agrees.
  if (mention.quarter !== null) return false;
  return mention.year !== null && fact.year === mention.year;
}

/** Who and what a sentence may be about: the clients it may name, the titles it may quote. */
export interface SentenceScope {
  /** The client a summary is about, or null for the headline, notes and limitations. */
  readonly own: string | null;
  readonly quoted: readonly string[];
}

/** The headline, the notes and the limitations: about the portfolio, quoting no title. */
const PORTFOLIO_SCOPE: SentenceScope = { own: null, quoted: [] };

interface Grounder {
  readonly periodLabels: readonly string[];
  readonly names: readonly string[];
  readonly refOf: ReadonlyMap<string, string>;
  /** Every word that names a metric: the digest's, and the financial words no fact here may state. */
  readonly vocabulary: readonly string[];
}

function grounderFor(digest: Digest): Grounder {
  const periodLabels = [...new Set(digest.facts.map((f) => f.period).filter((p): p is string => p !== null))];
  // Each client by its full name, and by its name without a legal suffix when that is unambiguous.
  const owners = new Map<string, Set<string>>();
  for (const c of digest.clients) {
    for (const variant of [c.name, c.name.replace(LEGAL_SUFFIX, '')]) {
      const key = variant.trim();
      if (key.length < 3) continue;
      owners.set(key, (owners.get(key) ?? new Set()).add(c.ref));
    }
  }
  const refOf = new Map([...owners].filter(([, refs]) => refs.size === 1).map(([name, refs]) => [name, [...refs][0]!]));
  const vocabulary = [...new Set([...digest.facts.flatMap((f) => [...f.words, ...(f.noun ? [f.noun] : []), ...(f.excludes ?? [])]), ...FINANCIAL])];
  return { periodLabels, names: [...refOf.keys()], refOf, vocabulary };
}

/** Does this fact state this claim, as the sentence frames it? */
function binds(
  f: Fact, q: Quantity, words: string, periods: readonly PeriodMention[],
  named: readonly string[], clauseNamed: readonly string[], scope: SentenceScope,
): boolean {
  const value = parseDecimalOrNull(f.value.replace(/,/g, ''));
  if (q.value === null || value === null || !q.value.equals(value)) return false;
  if (!unitMatches(q.unit, f.unit)) return false;
  // Metric: from the claim's own clause, never from another claim's.
  if (!f.words.some((w) => has(words, w))) return false;
  if (f.noun !== undefined && !has(words, f.noun)) return false;
  if ((f.excludes ?? []).some((w) => has(words, w))) return false;
  const financialFact = f.words.some((w) => FINANCIAL.some((t) => w.startsWith(t)));
  if (!financialFact && FINANCIAL.some((t) => has(words, t))) return false;
  // Period: the clause's, or the sentence's when the clause names none.
  if (f.period !== null && periods.length > 0 && !periods.some((p) => periodAgrees(p, f.period!))) return false;
  // Direction: a change stated the wrong way round is a different claim.
  if (f.direction === 'decrease' && INCREASE.test(words)) return false;
  if (f.direction === 'increase' && DECREASE.test(words)) return false;
  // Subject.
  if (f.subject === 'portfolio') return (clauseNamed.length > 0 ? PORTFOLIO_NARROW : scope.own === null ? PORTFOLIO_BROAD : PORTFOLIO_NARROW).test(words);
  const about = [...new Set(clauseNamed.length > 0 ? clauseNamed : named)];
  if (scope.own !== null) return about.every((ref) => ref === f.subject);
  return about.length === 1 && about[0] === f.subject;
}

/**
 * Check one sentence against the facts it cites. Returns null when every quantitative claim in it is
 * bound to a cited fact, else the reason the first one is not.
 */
function checkSentence(sentence: string, cited: readonly Fact[], scope: SentenceScope, g: Grounder): string | null {
  const reading = readQuantities(sentence, { names: g.names, quoted: scope.quoted, periodLabels: g.periodLabels });
  if (reading.unresolved.length > 0) return reading.unresolved[0]!;
  const refAt = (start: number, end: number) => reading.names
    .filter((n) => n.start >= start && n.start < end)
    .map((n) => g.refOf.get(n.name))
    .filter((r): r is string => r !== undefined);
  const named = refAt(0, reading.text.length);
  // A clause that names no metric at all ("…, from 61 in Jul 2026 to 38 in Aug 2026") is governed by
  // the nearest clause before it that does. A clause that names one reads only its own.
  const clauseWords = reading.clauses.map((c) => reading.words.slice(c.start, c.end).toLowerCase());
  const namesMetric = clauseWords.map((w) => g.vocabulary.some((v) => has(w, v)));
  const governed = clauseWords.map((w, i) => {
    if (namesMetric[i]) return w;
    for (let j = i - 1; j >= 0; j--) if (namesMetric[j]) return `${clauseWords[j]} ${w}`;
    return w;
  });

  for (const q of reading.quantities) {
    if (q.approximate) return `"${q.text}" is approximate, and no fact states a range`;
    if (q.value === null) return `"${q.text}" does not state an exact figure`;
    const index = Math.max(0, reading.clauses.findIndex((c) => q.start >= c.start && q.start < c.end));
    const clause = reading.clauses[index] ?? { start: 0, end: reading.text.length };
    const words = governed[index] ?? '';
    const clausePeriods = reading.periods.filter((p) => p.start >= clause.start && p.start < clause.end);
    const periods = clausePeriods.length > 0 ? clausePeriods : reading.periods;
    const clauseNamed = refAt(clause.start, clause.end);
    if (!cited.some((f) => binds(f, q, words, periods, named, clauseNamed, scope))) {
      return `"${q.text}" is not a cited fact of that value, unit, metric, subject, period and direction`;
    }
  }
  return null;
}

/**
 * Hold the submission to the digest (ADR-113, ADR-114 §5).
 *
 *  - a client ref the digest did not issue is dropped whole: the model cannot introduce a client;
 *  - a `because` ref that is not that client's own alert or action is dropped;
 *  - a cited fact id the digest did not issue, or one about another subject, is ignored — so a
 *    number resting only on it is ungrounded;
 *  - each sentence of the headline, a summary or a note is kept only if every quantitative claim in
 *    it — digits, words, fractions, multipliers — is bound to a cited fact (value, unit, metric,
 *    subject, period, direction; ADR-115); a hedged figure, a magnitude with no figure, or a cited
 *    title used as a figure fails. Otherwise that sentence is removed and the turn is `degraded`.
 *    A summary left empty becomes the server's own sentence built from the attention reasons; an
 *    empty headline becomes the server's count sentence;
 *  - a title is text, never a fact: only a summary may quote one, only the exact title of an alert
 *    or action it cites in `because`, and only in quotation marks;
 *  - a limitation may state no quantity;
 *  - a refusal carries no clients and is `not_applicable`.
 */
export function groundBriefing(submission: Briefing, digest: Digest): GroundedBriefing {
  const removed: string[] = [];
  const factById = new Map(digest.facts.map((f) => [f.id, f]));
  const clientByRef = new Map(digest.clients.map((c) => [c.ref, c]));
  const grounder = grounderFor(digest);
  let degraded = false;

  const citedFor = (ids: readonly string[], subjects: readonly string[], where: string): Fact[] => ids.flatMap((id) => {
    const f = factById.get(id);
    if (f === undefined) { removed.push(`${where}: cites ${id}, not a fact the digest issued`); return []; }
    if (!subjects.includes(f.subject)) { removed.push(`${where}: cites ${id}, a fact about ${f.subject}`); return []; }
    return [f];
  });

  const keepGrounded = (text: string, cited: readonly Fact[], scope: SentenceScope, where: string): string => {
    const kept: string[] = [];
    for (const sentence of sentences(text)) {
      const reason = checkSentence(sentence, cited, scope, grounder);
      if (reason === null) kept.push(sentence);
      else { removed.push(`${where}: ${reason}`); degraded = true; }
    }
    return kept.join(' ');
  };

  if (submission.mode === 'refusal') {
    const headline = keepGrounded(submission.headline.text, [], PORTFOLIO_SCOPE, 'headline') || 'That is outside what the Command Centre can answer.';
    return { briefing: { ...submission, headline: { text: headline, facts: [] }, clients: [], notes: [] }, status: 'not_applicable', removed };
  }

  const clients: Briefing['clients'] = [];
  for (const client of submission.clients) {
    const digestClient = clientByRef.get(client.ref);
    if (digestClient === undefined) { removed.push(`client ${client.ref}: not in the portfolio`); degraded = true; continue; }
    const because = client.because.filter((ref) => {
      const ok = digestClient.alerts.some((a) => a.ref === ref) || digestClient.actions.some((a) => a.ref === ref);
      if (!ok) { removed.push(`${client.ref} because ${ref}: not that client's`); degraded = true; }
      return ok;
    });
    const cited = citedFor(client.facts, [client.ref, 'portfolio'], client.ref);
    const quoted = [...digestClient.alerts, ...digestClient.actions].filter((x) => because.includes(x.ref)).map((x) => x.title);
    let summary = keepGrounded(client.summary, cited, { own: client.ref, quoted }, `${client.ref} summary`);
    if (summary.length === 0) {
      summary = digestClient.attention.length > 0
        ? `${digestClient.name}: ${digestClient.attention.join('; ')}.`
        : `${digestClient.name}: nothing needs attention.`;
    }
    clients.push({ ref: client.ref, summary, facts: cited.map((f) => f.id), because });
  }

  const notes: Briefing['notes'] = [];
  submission.notes.forEach((note, i) => {
    const cited = citedFor(note.facts, ['portfolio', ...digest.clients.map((c) => c.ref)], `note ${i}`);
    const text = keepGrounded(note.text, cited, PORTFOLIO_SCOPE, `note ${i}`);
    if (text.length > 0) notes.push({ text, facts: cited.map((f) => f.id) });
  });

  const headlineCited = citedFor(submission.headline.facts, ['portfolio', ...digest.clients.map((c) => c.ref)], 'headline');
  let headline = keepGrounded(submission.headline.text, headlineCited, PORTFOLIO_SCOPE, 'headline');
  let headlineFacts = headlineCited.map((f) => f.id);
  if (headline.length === 0) {
    const need = factById.get('portfolio/needing_attention');
    const all = factById.get('portfolio/clients');
    headline = `${need?.value ?? '0'} of ${all?.value ?? '0'} clients need attention.`;
    headlineFacts = ['portfolio/needing_attention', 'portfolio/clients'];
  }

  const limitations = submission.limitations.filter((text, i) => {
    const reason = checkSentence(text, [], PORTFOLIO_SCOPE, grounder);
    if (reason !== null) { removed.push(`limitation ${i}: ${reason}`); degraded = true; }
    const ok = reason === null;
    return ok;
  });

  return {
    briefing: { mode: 'answer', headline: { text: headline, facts: headlineFacts }, clients, notes, limitations },
    status: degraded ? 'degraded' : 'passed',
    removed,
  };
}
