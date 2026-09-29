/**
 * The adviser analyst's contract (ADR-113, ADR-116). Pure.
 *
 * The model never sees a database, a data tool, or an organisation the caller may not advise. It sees
 * a DIGEST built from the Command Centre's authorised view: each client, alert and action has a short
 * reference, and every figure MOTION holds about them is a FACT — a typed, authoritative value with
 * its subject, metric, period, direction and the canonical sentence that states it.
 *
 * The model does not write figures (ADR-116). It answers through one forced tool with a list of
 * statements per block, and each statement is EITHER prose it wrote OR a list of fact ids. The
 * server renders a fact statement from the facts themselves — value, noun, subject, period and
 * direction all come from the fact — and no model text is placed beside it, so nothing the model
 * writes can re-qualify a figure ("8 open actions" cannot become "8 overdue actions"). Prose is
 * untrusted: prose that carries anything quantitative (`free-text.ts`) is removed. So a figure in a
 * stored answer is, by construction, a figure the server wrote from a fact in the caller's digest.
 */

import { z } from 'zod';
import { bandLabel } from '@/modules/health';
import { quantitativeContent } from './free-text';
import { PRIORITY_LABELS, SEVERITY_LABELS, TREND_LABELS, dueLabel } from './presentation';
import type { PortfolioAction, PortfolioAlert, PortfolioView } from './types';

export const BRIEFING_TOOL = 'submit_briefing';
export const BRIEFING_PROMPT_VERSION = 'adviser-v3.0';
export const MAX_QUESTION_CHARS = 1_000;

// ---------------------------------------------------------------------------------------------
// Facts and the digest
// ---------------------------------------------------------------------------------------------

/**
 * What kind of claim a fact makes. The Phase 15 digest emits `count`, `score` and `score_change`;
 * the others are the contract for any fact a later digest adds, each rendered in its own unit.
 */
export type ClaimType = 'count' | 'score' | 'score_change' | 'percent_change' | 'amount' | 'duration' | 'multiplier';

export interface Fact {
  readonly id: string;
  /** `portfolio`, or a client ref (`client:N`). */
  readonly subject: string;
  /** The organisation the fact is about; null for a portfolio fact. */
  readonly organizationId: string | null;
  readonly metric: string;
  readonly type: ClaimType;
  /** The period label the fact is for, or null when it has none (what stands today). */
  readonly period: string | null;
  /** Exact decimal string. Never a float. */
  readonly value: string;
  /** Which way a change went, for a change; null otherwise. */
  readonly direction: 'increase' | 'decrease' | null;
  /** Where the value comes from, for the record (`api.portfolio_summary`, `health_scores`). */
  readonly source: string;
  /** The canonical sentence stating this fact, without the full stop. The only way it is shown. */
  readonly statement: string;
  /** For a client count, the noun phrase alone ("3 open actions"), so counts can share one sentence. */
  readonly phrase?: string;
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

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Each count the digest states: its noun for a client, and its sentence for the portfolio. */
const COUNT_WORDING: Record<string, { client?: (n: number) => string; portfolio: (n: number) => string }> = {
  clients: { portfolio: (n) => `The portfolio has ${n} ${plural(n, 'client', 'clients')}` },
  needing_attention: { portfolio: (n) => `${n} ${plural(n, 'client needs', 'clients need')} attention` },
  healthy: { portfolio: (n) => `${n} ${plural(n, 'client was', 'clients were')} scored Stable or Strong in their latest complete month` },
  unscored: { portfolio: (n) => `${n} ${plural(n, 'client has', 'clients have')} no complete month scored yet` },
  standing_alerts: {
    client: (n) => `${n} standing ${plural(n, 'alert', 'alerts')}`,
    portfolio: (n) => `${n} ${plural(n, 'alert stands', 'alerts stand')} across the portfolio`,
  },
  critical_alerts: {
    client: (n) => `${n} standing critical ${plural(n, 'alert', 'alerts')}`,
    portfolio: (n) => `${n} critical ${plural(n, 'alert stands', 'alerts stand')} across the portfolio`,
  },
  high_alerts: {
    client: (n) => `${n} standing high-severity ${plural(n, 'alert', 'alerts')}`,
    portfolio: (n) => `${n} high-severity ${plural(n, 'alert stands', 'alerts stand')} across the portfolio`,
  },
  open_actions: {
    client: (n) => `${n} open ${plural(n, 'action', 'actions')}`,
    portfolio: (n) => `${n} ${plural(n, 'action is', 'actions are')} open across the portfolio`,
  },
  overdue_actions: {
    client: (n) => `${n} overdue ${plural(n, 'action', 'actions')}`,
    portfolio: (n) => `${n} open ${plural(n, 'action is', 'actions are')} overdue across the portfolio`,
  },
};

/**
 * The view, with references and facts. Everything the model may cite is here and nothing else
 * exists. `alerts` and `actions` are the portfolio's capped detail lists (worst first); the counts
 * the model may state come from the view's authoritative aggregates, as facts.
 */
export function buildDigest(view: PortfolioView, alerts: readonly PortfolioAlert[], actions: readonly PortfolioAction[]): Digest {
  const facts: Fact[] = [];
  const count = (subject: string, organizationId: string | null, name: string | null, metric: string, value: number) => {
    const wording = COUNT_WORDING[metric]!;
    const phrase = name !== null && wording.client ? wording.client(value) : undefined;
    facts.push({
      id: `${subject}/${metric}`, subject, organizationId, metric, type: 'count', period: null, value: String(value),
      direction: null, source: 'api.portfolio_summary',
      statement: phrase !== undefined ? `${name} has ${phrase}` : wording.portfolio(value),
      ...(phrase !== undefined ? { phrase } : {}),
    });
  };
  const c = view.counts;
  count('portfolio', null, null, 'clients', c.clients);
  count('portfolio', null, null, 'needing_attention', c.needingAttention);
  count('portfolio', null, null, 'healthy', c.healthy);
  count('portfolio', null, null, 'unscored', c.unscored);
  count('portfolio', null, null, 'standing_alerts', c.alertsStanding);
  count('portfolio', null, null, 'critical_alerts', c.criticalAlerts);
  count('portfolio', null, null, 'high_alerts', c.highAlerts);
  count('portfolio', null, null, 'open_actions', c.openActions);
  count('portfolio', null, null, 'overdue_actions', c.overdueActions);

  let alertN = 0;
  let actionN = 0;
  const clients = view.clients.map((row, i): DigestClient => {
    const ref = `client:${i + 1}`;
    const org = row.organisation;
    const h = row.health;
    const k = row.counts;
    count(ref, org.id, org.name, 'standing_alerts', k.alertsStanding);
    count(ref, org.id, org.name, 'critical_alerts', k.alertsCritical);
    count(ref, org.id, org.name, 'high_alerts', k.alertsHigh);
    count(ref, org.id, org.name, 'open_actions', k.actionsOpen);
    count(ref, org.id, org.name, 'overdue_actions', k.actionsOverdue);
    if (h !== null && h.score !== null) {
      const band = bandLabel(h.band);
      facts.push({
        id: `${ref}/health_score`, subject: ref, organizationId: org.id, metric: 'health_score', type: 'score',
        period: h.periodLabel, value: String(h.score), direction: null, source: 'health_scores',
        statement: `${org.name}'s health score for ${h.periodLabel} is ${h.score}${band ? ` (${band})` : ''}`,
      });
      const prev = h.previous;
      if (prev !== null && prev.score !== null) {
        facts.push({
          id: `${ref}/previous_health_score`, subject: ref, organizationId: org.id, metric: 'previous_health_score', type: 'score',
          period: prev.periodLabel, value: String(prev.score), direction: null, source: 'health_scores',
          statement: `${org.name}'s health score for ${prev.periodLabel} was ${prev.score}`,
        });
        const delta = h.score - prev.score;
        const size = Math.abs(delta);
        facts.push({
          id: `${ref}/health_score_change`, subject: ref, organizationId: org.id, metric: 'health_score_change', type: 'score_change',
          period: h.periodLabel, value: String(size), direction: delta < 0 ? 'decrease' : delta > 0 ? 'increase' : null, source: 'health_scores',
          statement: delta === 0
            ? `${org.name}'s health score was unchanged at ${h.score} from ${prev.periodLabel} to ${h.periodLabel}`
            : `${org.name}'s health score ${delta < 0 ? 'fell' : 'rose'} ${size} ${plural(size, 'point', 'points')}, from ${prev.score} in ${prev.periodLabel} to ${h.score} in ${h.periodLabel}`,
        });
      }
    }
    return {
      ref,
      id: org.id,
      name: org.name,
      status: org.status,
      health: h === null ? null : {
        band: bandLabel(h.band), month: h.periodLabel, trend: row.trend === null ? null : TREND_LABELS[row.trend],
        previous_month: h.previous?.periodLabel ?? null,
      },
      attention: row.attention?.reasons.map((r) => r.label) ?? [],
      alerts: alerts.filter((a) => a.organizationId === org.id).slice(0, DIGEST_DETAIL_PER_CLIENT).map((a) => ({
        ref: `alert:${++alertN}`, id: a.id, severity: SEVERITY_LABELS[a.severity], status: a.status, title: a.title,
        standing_since: a.firstSeenAt.slice(0, 10),
      })),
      actions: actions.filter((a) => a.organizationId === org.id).slice(0, DIGEST_DETAIL_PER_CLIENT).map((a) => ({
        ref: `action:${++actionN}`, id: a.id, priority: PRIORITY_LABELS[a.priority], title: a.title, due: dueLabel(a.dueDate, view.today),
      })),
    };
  });
  return { today: view.today, clients, facts };
}

/** What the model is shown of a fact: the id to cite and the sentence the server will write. */
export function factForModel(f: Fact): { id: string; type: ClaimType; period: string | null; says: string } {
  return { id: f.id, type: f.type, period: f.period, says: `${f.statement}.` };
}

// ---------------------------------------------------------------------------------------------
// What the model submits (the forced tool's input)
// ---------------------------------------------------------------------------------------------

/**
 * A statement is prose OR facts, never both. A `facts` statement's text, if the model sends any,
 * is never shown: the sentence is the server's.
 */
const StatementSchema = z.object({
  kind: z.enum(['text', 'facts']),
  text: z.string().max(400).optional(),
  facts: z.array(z.string()).max(6).optional(),
});
const Statements = (max: number) => z.array(StatementSchema).max(max);

export const SubmissionSchema = z.object({
  mode: z.enum(['answer', 'refusal']),
  headline: Statements(3),
  clients: z.array(z.object({
    ref: z.string(),
    statements: Statements(8),
    /** alert:N / action:N refs the summary rests on. */
    because: z.array(z.string()).max(12),
  })).max(25),
  notes: z.array(z.object({ statements: Statements(4) })).max(6),
  limitations: z.array(z.string().max(300)).max(6),
});
export type Submission = z.infer<typeof SubmissionSchema>;
export type SubmittedStatement = z.infer<typeof StatementSchema>;

// ---------------------------------------------------------------------------------------------
// What the server keeps and shows (persisted; rendered by /portfolio/analyst)
// ---------------------------------------------------------------------------------------------

export const BriefingSchema = z.object({
  mode: z.enum(['answer', 'refusal']),
  /** `facts` lists the fact ids whose server-rendered sentences the text contains. */
  headline: z.object({ text: z.string(), facts: z.array(z.string()) }),
  clients: z.array(z.object({ ref: z.string(), summary: z.string(), facts: z.array(z.string()), because: z.array(z.string()) })),
  notes: z.array(z.object({ text: z.string(), facts: z.array(z.string()) })),
  limitations: z.array(z.string()),
});
export type Briefing = z.infer<typeof BriefingSchema>;

export interface GroundedBriefing {
  readonly briefing: Briefing;
  readonly status: 'passed' | 'degraded' | 'not_applicable';
  /** What was dropped, for the record — never rendered. */
  readonly removed: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Rendering and validation (ADR-116)
// ---------------------------------------------------------------------------------------------

const capitalise = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

function listOf(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The server's sentence for a set of facts. Counts about one client share a sentence ("Alpha Ltd
 * has 3 standing critical alerts and 8 open actions."); anything else is each fact's own sentence.
 * Every word of it comes from the facts.
 */
export function renderFacts(facts: readonly Fact[], names: ReadonlyMap<string, string>): string {
  const first = facts[0];
  if (first === undefined) return '';
  const sharable = facts.length > 1 && facts.every((f) => f.phrase !== undefined && f.subject === first.subject);
  if (sharable) return `${names.get(first.subject) ?? first.subject} has ${listOf(facts.map((f) => f.phrase!))}.`;
  return facts.map((f) => `${capitalise(f.statement)}.`).join(' ');
}

interface Block {
  readonly text: string;
  readonly facts: readonly string[];
}

/**
 * Hold the submission to the digest (ADR-113, ADR-116).
 *
 *  - a client ref the digest did not issue is dropped whole: the model cannot introduce a client;
 *  - a `because` ref that is not that client's own alert or action is dropped;
 *  - a `facts` statement is rendered by the server from the facts it names. A fact id the digest did
 *    not issue, or — in a client's summary — a fact about another client, is dropped; the rest of
 *    the statement is still rendered, because each fact renders on its own and cannot lend its
 *    value to another;
 *  - a `text` statement is kept only if it carries nothing quantitative (`free-text.ts`); a text
 *    statement that also names facts is refused;
 *  - anything dropped makes the turn `degraded`. A summary left empty becomes the server's own
 *    sentence from the attention reasons; an empty headline becomes the server's count sentence;
 *  - a limitation is prose, under the same rule;
 *  - a refusal carries no clients, no notes and no facts, and is `not_applicable`.
 */
export function groundBriefing(submission: Submission, digest: Digest): GroundedBriefing {
  const removed: string[] = [];
  let degraded = false;
  const drop = (reason: string) => { removed.push(reason); degraded = true; };
  const factById = new Map(digest.facts.map((f) => [f.id, f]));
  const clientByRef = new Map(digest.clients.map((c) => [c.ref, c]));
  const names = digest.clients.map((c) => c.name);
  const nameOf = new Map(digest.clients.map((c) => [c.ref, c.name]));
  const everySubject = ['portfolio', ...digest.clients.map((c) => c.ref)];

  const prose = (text: string, where: string): string | null => {
    const found = quantitativeContent(text, names);
    if (found.length > 0) { drop(`${where}: prose states ${found[0]}`); return null; }
    return text.trim();
  };

  const render = (statements: readonly SubmittedStatement[], subjects: readonly string[], where: string, allowFacts: boolean): Block => {
    const parts: string[] = [];
    const used: string[] = [];
    statements.forEach((s, i) => {
      const at = `${where} statement ${i}`;
      const text = s.text?.trim() ?? '';
      const ids = [...new Set(s.facts ?? [])];
      if (s.kind === 'text') {
        if (ids.length > 0) { drop(`${at}: prose may not carry facts`); return; }
        if (text.length === 0) return;
        const kept = prose(text, at);
        if (kept !== null) parts.push(/[.!?]$/.test(kept) ? kept : `${kept}.`);
        return;
      }
      if (!allowFacts) { drop(`${at}: a refusal states no facts`); return; }
      if (text.length > 0) removed.push(`${at}: text beside facts is never shown`);
      const facts = ids.flatMap((id) => {
        const f = factById.get(id);
        if (f === undefined) { drop(`${at}: cites ${id}, not a fact the digest issued`); return []; }
        if (!subjects.includes(f.subject)) { drop(`${at}: cites ${id}, a fact about ${f.subject}`); return []; }
        return [f];
      });
      if (facts.length === 0) { if (ids.length === 0) drop(`${at}: a facts statement with no facts`); return; }
      parts.push(renderFacts(facts, nameOf));
      used.push(...facts.map((f) => f.id));
    });
    return { text: parts.join(' '), facts: [...new Set(used)] };
  };

  if (submission.mode === 'refusal') {
    const headline = render(submission.headline, [], 'headline', false).text || 'That is outside what the Command Centre can answer.';
    if (submission.clients.length > 0 || submission.notes.length > 0) removed.push('refusal: clients and notes are not kept');
    return { briefing: { mode: 'refusal', headline: { text: headline, facts: [] }, clients: [], notes: [], limitations: [] }, status: 'not_applicable', removed };
  }

  const clients: Briefing['clients'] = [];
  for (const client of submission.clients) {
    const digestClient = clientByRef.get(client.ref);
    if (digestClient === undefined) { drop(`client ${client.ref}: not in the portfolio`); continue; }
    const because = client.because.filter((ref) => {
      const ok = digestClient.alerts.some((a) => a.ref === ref) || digestClient.actions.some((a) => a.ref === ref);
      if (!ok) drop(`${client.ref} because ${ref}: not that client's`);
      return ok;
    });
    const block = render(client.statements, [client.ref, 'portfolio'], client.ref, true);
    const summary = block.text.length > 0
      ? block.text
      : digestClient.attention.length > 0
        ? `${digestClient.name}: ${digestClient.attention.join('; ')}.`
        : `${digestClient.name}: nothing needs attention.`;
    clients.push({ ref: client.ref, summary, facts: [...block.facts], because });
  }

  const notes: Briefing['notes'] = [];
  submission.notes.forEach((note, i) => {
    const block = render(note.statements, everySubject, `note ${i}`, true);
    if (block.text.length > 0) notes.push({ text: block.text, facts: [...block.facts] });
  });

  let headline: Block = render(submission.headline, everySubject, 'headline', true);
  if (headline.text.length === 0) {
    const fallback = ['portfolio/needing_attention', 'portfolio/clients'].flatMap((id) => factById.get(id) ?? []);
    headline = { text: fallback.map((f) => `${capitalise(f.statement)}.`).join(' '), facts: fallback.map((f) => f.id) };
  }

  const limitations = submission.limitations.flatMap((text, i) => {
    const kept = prose(text, `limitation ${i}`);
    return kept === null || kept.length === 0 ? [] : [kept];
  });

  return {
    briefing: { mode: 'answer', headline: { text: headline.text, facts: [...headline.facts] }, clients, notes, limitations },
    status: degraded ? 'degraded' : 'passed',
    removed,
  };
}
