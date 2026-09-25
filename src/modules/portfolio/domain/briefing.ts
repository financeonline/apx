/**
 * The adviser analyst's contract (ADR-113, ADR-114 §5). Pure.
 *
 * The model never sees a database, a data tool, or an organisation the caller may not advise. It sees
 * a DIGEST built from the Command Centre's authorised view: each client, alert and action has a short
 * reference, and every number the digest states is a FACT with an id, a subject, a metric, a period, a
 * unit and a value. The model answers through one forced output tool, citing the fact ids its
 * sentences rest on.
 *
 * Grounding is fact-specific (ADR-114 §5). A number survives only when a fact the sentence CITES has
 * that exact value, belongs to the subject the sentence is about, is of the unit the sentence uses
 * (a "%" is a percent, "months" is months, "£" is money, a bare number is a count or a score), is the
 * metric the sentence names (one of the fact's words is in the sentence), and is for the period the
 * sentence names, if it names one. "The same number appears somewhere in the digest" proves nothing,
 * and a sentence with any number that fails is removed — the rest of the answer stands.
 */

import { z } from 'zod';
import { parseDecimalOrNull } from '@/core/money';
import { bandLabel } from '@/modules/health';
import { PRIORITY_LABELS, SEVERITY_LABELS, TREND_LABELS, dueLabel } from './presentation';
import type { PortfolioAction, PortfolioAlert, PortfolioView } from './types';

export const BRIEFING_TOOL = 'submit_briefing';
export const BRIEFING_PROMPT_VERSION = 'adviser-v2.0';
export const MAX_QUESTION_CHARS = 1_000;

// ---------------------------------------------------------------------------------------------
// Facts and the digest
// ---------------------------------------------------------------------------------------------

export type FactUnit = 'count' | 'score' | 'percent' | 'months' | 'money';

export interface Fact {
  readonly id: string;
  /** `portfolio`, or a client ref (`client:N`). */
  readonly subject: string;
  readonly metric: string;
  /** Words one of which a sentence stating this fact must contain. Lower case. */
  readonly words: readonly string[];
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
  const fact = (subject: string, metric: string, words: readonly string[], value: number | null, unit: FactUnit, period: string | null = null) => {
    if (value === null) return;
    facts.push({ id: `${subject}/${metric}`, subject, metric, words, period, value: String(value), unit });
  };
  const c = view.counts;
  fact('portfolio', 'clients', ['client', 'organisation'], c.clients, 'count');
  fact('portfolio', 'needing_attention', ['attention', 'need'], c.needingAttention, 'count');
  fact('portfolio', 'healthy', ['healthy', 'stable', 'strong'], c.healthy, 'count');
  fact('portfolio', 'unscored', ['scored', 'score'], c.unscored, 'count');
  fact('portfolio', 'standing_alerts', ['alert'], c.alertsStanding, 'count');
  fact('portfolio', 'critical_alerts', ['critical'], c.criticalAlerts, 'count');
  fact('portfolio', 'high_alerts', ['high'], c.highAlerts, 'count');
  fact('portfolio', 'open_actions', ['action'], c.openActions, 'count');
  fact('portfolio', 'overdue_actions', ['overdue'], c.overdueActions, 'count');

  let alertN = 0;
  let actionN = 0;
  const clients = view.clients.map((row, i): DigestClient => {
    const ref = `client:${i + 1}`;
    const h = row.health;
    if (h !== null) {
      fact(ref, 'health_score', ['health', 'score'], h.score, 'score', h.periodLabel);
      if (h.previous !== null) fact(ref, 'previous_health_score', ['health', 'score', 'previous', 'from', 'was'], h.previous.score, 'score', h.previous.periodLabel);
    }
    const k = row.counts;
    fact(ref, 'standing_alerts', ['alert'], k.alertsStanding, 'count');
    fact(ref, 'critical_alerts', ['critical'], k.alertsCritical, 'count');
    fact(ref, 'high_alerts', ['high'], k.alertsHigh, 'count');
    fact(ref, 'open_actions', ['action'], k.actionsOpen, 'count');
    fact(ref, 'overdue_actions', ['overdue'], k.actionsOverdue, 'count');
    if (h !== null && h.previous?.score != null && h.score !== null) {
      fact(ref, 'health_score_change', ['health', 'score', 'fell', 'rose', 'point'], Math.abs(h.score - h.previous.score), 'score', null);
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
// Grounding
// ---------------------------------------------------------------------------------------------

const NUMBER = /(£|\$|€)?\s?(\d+(?:[.,]\d+)*)\s?(%|per ?cent|months?\b)?/gi;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Exact comparison of two decimal strings: "1,053" = "1053", "14.0" = "14". Never a float. */
function normalise(value: string): string {
  const parsed = parseDecimalOrNull(value.replace(/,/g, ''));
  return parsed === null ? value : parsed.toString();
}

function unitOf(prefix: string | undefined, suffix: string | undefined): FactUnit | 'bare' {
  if (prefix) return 'money';
  if (suffix && (suffix === '%' || /per ?cent/i.test(suffix))) return 'percent';
  if (suffix && /month/i.test(suffix)) return 'months';
  return 'bare';
}

function unitMatches(sentenceUnit: FactUnit | 'bare', factUnit: FactUnit): boolean {
  if (sentenceUnit === 'bare') return factUnit === 'count' || factUnit === 'score';
  return sentenceUnit === factUnit;
}

/**
 * Check one sentence against the facts it may use. Returns null when every number in it is
 * grounded, else the reason it is not.
 */
function checkSentence(
  sentence: string,
  cited: readonly Fact[],
  periodLabels: readonly string[],
  quoted: readonly string[],
): string | null {
  // Text the sentence quotes verbatim from a cited alert or action title carries its own numbers.
  let body = sentence;
  for (const q of quoted) body = body.split(q).join(' ');
  const named = periodLabels.filter((label) => body.includes(label));
  for (const label of periodLabels) body = body.split(label).join(' ');
  body = body.replace(ISO_DATE, ' ');
  const lower = body.toLowerCase();

  for (const match of body.matchAll(NUMBER)) {
    const [, prefix, raw, suffix] = match;
    const value = normalise(raw!);
    const unit = unitOf(prefix, suffix);
    const ok = cited.some((f) =>
      normalise(f.value) === value
      && unitMatches(unit, f.unit)
      && f.words.some((w) => lower.includes(w))
      && (named.length === 0 || f.period === null || named.includes(f.period)));
    if (!ok) return `"${match[0].trim()}" is not a cited fact of that metric, unit, subject and period`;
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
 *  - each sentence of the headline, a summary or a note is kept only if every number in it is
 *    grounded to a cited fact (value, unit, metric, subject, period); otherwise that sentence is
 *    removed and the turn is `degraded`. A summary left empty becomes the server's own sentence built
 *    from the attention reasons; an empty headline becomes the server's count sentence;
 *  - a limitation may state no number;
 *  - a refusal carries no clients and is `not_applicable`.
 */
export function groundBriefing(submission: Briefing, digest: Digest): GroundedBriefing {
  const removed: string[] = [];
  const factById = new Map(digest.facts.map((f) => [f.id, f]));
  const clientByRef = new Map(digest.clients.map((c) => [c.ref, c]));
  const periodLabels = [...new Set(digest.facts.map((f) => f.period).filter((p): p is string => p !== null))]
    .sort((a, b) => b.length - a.length);
  let degraded = false;

  const citedFor = (ids: readonly string[], subjects: readonly string[], where: string): Fact[] => ids.flatMap((id) => {
    const f = factById.get(id);
    if (f === undefined) { removed.push(`${where}: cites ${id}, not a fact the digest issued`); return []; }
    if (!subjects.includes(f.subject)) { removed.push(`${where}: cites ${id}, a fact about ${f.subject}`); return []; }
    return [f];
  });

  const keepGrounded = (text: string, cited: readonly Fact[], quoted: readonly string[], where: string): string => {
    const kept: string[] = [];
    for (const sentence of sentences(text)) {
      const reason = checkSentence(sentence, cited, periodLabels, quoted);
      if (reason === null) kept.push(sentence);
      else { removed.push(`${where}: ${reason}`); degraded = true; }
    }
    return kept.join(' ');
  };

  if (submission.mode === 'refusal') {
    const headline = keepGrounded(submission.headline.text, [], [], 'headline') || 'That is outside what the Command Centre can answer.';
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
    let summary = keepGrounded(client.summary, cited, quoted, `${client.ref} summary`);
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
    const text = keepGrounded(note.text, cited, [], `note ${i}`);
    if (text.length > 0) notes.push({ text, facts: cited.map((f) => f.id) });
  });

  const headlineCited = citedFor(submission.headline.facts, ['portfolio', ...digest.clients.map((c) => c.ref)], 'headline');
  let headline = keepGrounded(submission.headline.text, headlineCited, [], 'headline');
  let headlineFacts = headlineCited.map((f) => f.id);
  if (headline.length === 0) {
    const need = factById.get('portfolio/needing_attention');
    const all = factById.get('portfolio/clients');
    headline = `${need?.value ?? '0'} of ${all?.value ?? '0'} clients need attention.`;
    headlineFacts = ['portfolio/needing_attention', 'portfolio/clients'];
  }

  const limitations = submission.limitations.filter((text, i) => {
    const ok = checkSentence(text, [], periodLabels, []) === null;
    if (!ok) { removed.push(`limitation ${i}: states a number`); degraded = true; }
    return ok;
  });

  return {
    briefing: { mode: 'answer', headline: { text: headline, facts: headlineFacts }, clients, notes, limitations },
    status: degraded ? 'degraded' : 'passed',
    removed,
  };
}
