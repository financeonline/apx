/**
 * The adviser analyst's contract (ADR-113, ADR-118). Pure.
 *
 * The model never sees a database, a data tool, or an organisation the caller may not advise. It sees
 * a DIGEST built from the Command Centre's authorised view: each client, alert and action has a short
 * reference, and every figure MOTION holds about them is a FACT — a typed, authoritative value with
 * its subject, metric, period, direction and the canonical sentence that states it.
 *
 * MODEL SELECTS, SERVER WRITES (ADR-118). The model answers through one forced tool with BLOCKS, and
 * every block is a reference to something the server already holds: facts (by id), MOTION's own
 * attention reasons (by id), the caller's alerts and actions (by ref), or a phrase from a small
 * server-owned library (by id) whose condition the server checks against the data. The model writes
 * no text at all. The server renders every word of the briefing from those references, and
 * discards anything else the model sends — a text block, an unknown block, an extra field, a foreign
 * reference, a phrase whose condition does not hold — marking the answer degraded.
 *
 * What this guarantees, precisely: the stored briefing contains only server-rendered facts, attention
 * reasons, source records and approved phrases. It does not make the model's CHOICES right — it can
 * still choose an unhelpful fact — but no sentence in the briefing is the model's.
 */

import { z } from 'zod';
import { bandLabel } from '@/modules/health';
import { PRIORITY_LABELS, SEVERITY_LABELS, TREND_LABELS, dueLabel } from './presentation';
import type { AttentionReasonKind, PortfolioAction, PortfolioAlert, PortfolioView } from './types';

export const BRIEFING_TOOL = 'submit_briefing';
export const BRIEFING_PROMPT_VERSION = 'adviser-v4.1';
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
export interface DigestReason { readonly id: string; readonly kind: AttentionReasonKind; readonly says: string }
export interface DigestClient {
  readonly ref: string;
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly health: { readonly band: string | null; readonly month: string; readonly trend: string | null; readonly previous_month: string | null } | null;
  /** MOTION's own attention reasons for this client, each citable by id; the label is the server's. */
  readonly attention: readonly DigestReason[];
  /** 1 for the client MOTION's attention order puts first; null when the client is not in the queue. */
  readonly attentionRank: number | null;
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

  const rankOf = new Map(view.attention.map((row, i) => [row.organisation.id, i + 1]));
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
      attention: row.attention?.reasons.map((r) => ({ id: `${ref}/attention/${r.kind}`, kind: r.kind, says: r.label })) ?? [],
      attentionRank: rankOf.get(org.id) ?? null,
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
// The phrase library: the only qualitative sentences a briefing can contain (ADR-118)
// ---------------------------------------------------------------------------------------------

/**
 * Each phrase is server-written, states nothing quantitative, and HOLDS only when the data says so:
 * "Look at X first" only for the client MOTION's attention order ranks first; "nothing needs
 * attention" only when nothing does. A phrase whose condition fails is discarded like any other
 * unsupported block, so choosing a phrase is choosing a statement the data already supports.
 */
interface ClientPhrase { readonly scope: 'client'; readonly says: (name: string) => string; readonly holds: (c: DigestClient) => boolean }
interface PortfolioPhrase { readonly scope: 'portfolio'; readonly says: () => string; readonly holds: (d: Digest) => boolean }

export const PHRASES = {
  needs_attention: { scope: 'client', says: (n) => `${n} needs attention.`, holds: (c) => c.attention.length > 0 },
  look_first: { scope: 'client', says: (n) => `Look at ${n} first.`, holds: (c) => c.attentionRank === 1 },
  client_clear: { scope: 'client', says: (n) => `Nothing at ${n} needs attention.`, holds: (c) => c.attention.length === 0 },
  health_unavailable: { scope: 'client', says: (n) => `${n} has not been scored yet, so its health is not available.`, holds: (c) => c.health === null },
  review_evidence: { scope: 'client', says: (n) => `The supporting evidence is on ${n}'s own pages.`, holds: () => true },
  portfolio_clear: { scope: 'portfolio', says: () => 'Nothing in the portfolio needs attention.', holds: (d) => d.clients.every((c) => c.attention.length === 0) },
  figures_elsewhere: { scope: 'portfolio', says: () => "Financial figures beyond counts and health scores are not in this briefing; each client's own pages hold them.", holds: () => true },
  not_in_portfolio: { scope: 'portfolio', says: () => 'The organisation asked about is not in this portfolio.', holds: () => true },
  outside_scope: { scope: 'portfolio', says: () => 'That is outside what the Command Centre can answer.', holds: () => true },
} satisfies Record<string, ClientPhrase | PortfolioPhrase>;
export type PhraseId = keyof typeof PHRASES;

/** The phrase library as the model is shown it: the id, whether it names a client, and its wording. */
export function phrasesForModel(): Array<{ id: PhraseId; names_a_client: boolean; says: string }> {
  return (Object.entries(PHRASES) as Array<[PhraseId, ClientPhrase | PortfolioPhrase]>).map(([id, p]) => ({
    id, names_a_client: p.scope === 'client', says: p.scope === 'client' ? p.says('{client}') : p.says(),
  }));
}

// ---------------------------------------------------------------------------------------------
// What the model submits (the forced tool's input)
// ---------------------------------------------------------------------------------------------

/**
 * A block is a reference, never text. Its fields are read strictly by kind: a block of an unknown
 * kind, or one carrying any field its kind does not have (`text`, `value`, …), is discarded or
 * stripped by the grounder and the answer is degraded. The schema therefore accepts any object and
 * leaves the judgement to `groundBriefing`, so one bad block cannot fail the whole turn.
 */
const BlockSchema = z.object({ kind: z.string() }).catchall(z.unknown());
const Blocks = (max: number) => z.array(BlockSchema).max(max);

export const SubmissionSchema = z.object({
  mode: z.enum(['answer', 'refusal']),
  headline: Blocks(4),
  clients: z.array(z.object({
    ref: z.string(),
    blocks: Blocks(10),
    /** alert:N / action:N refs the summary rests on, shown by the page as links. */
    because: z.array(z.string()).max(12),
  })).max(25),
  notes: z.array(z.object({ blocks: Blocks(6) })).max(6),
  /** Phrase ids (portfolio phrases) for what the briefing cannot answer. */
  limitations: z.array(z.string()).max(6),
});
export type Submission = z.infer<typeof SubmissionSchema>;
export type SubmittedBlock = z.infer<typeof BlockSchema>;

const BLOCK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  facts: ['kind', 'facts'],
  attention: ['kind', 'reasons'],
  source: ['kind', 'ref'],
  phrase: ['kind', 'phrase', 'ref'],
};

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
  /** What was discarded, for the record — never rendered. */
  readonly removed: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Rendering and validation (ADR-118)
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

/**
 * A cited alert or action, as a SOURCE: its kind, its title in quotation marks, and its standing.
 * The title is the tenant's own text; it is shown as a title and never read for a figure.
 */
function renderSource(source: DigestAlert | DigestAction, owner: string): string {
  if ('severity' in source) return `${owner}: alert “${source.title}” (${source.severity.toLowerCase()}, ${source.status}).`;
  return `${owner}: action “${source.title}” (${source.priority.toLowerCase()} priority${source.due ? `, ${source.due}` : ''}).`;
}

interface Rendered {
  readonly text: string;
  readonly facts: readonly string[];
  readonly sources: readonly string[];
}

/**
 * Hold the submission to the digest and render it (ADR-113, ADR-118).
 *
 *  - a client ref the digest did not issue is dropped whole: the model cannot introduce a client;
 *  - a `because` ref that is not that client's own alert or action is dropped;
 *  - each block is rendered by the server from what it references, or discarded:
 *      facts     — fact ids the digest issued; in a client's summary only that client's and the
 *                  portfolio's. Each fact renders on its own, so a bad id cannot lend its place to
 *                  another; the valid ones still render;
 *      attention — ids of MOTION's own attention reasons; in a summary only that client's;
 *      source    — an alert:N / action:N of the digest; in a summary only that client's own;
 *      phrase    — a library phrase whose condition holds for the client (or the portfolio) it names;
 *    anything else — a text block, an unknown kind, a field the kind does not have — is discarded;
 *  - anything discarded makes the turn `degraded`. A summary left empty becomes the server's own
 *    sentence from the attention reasons; an empty headline becomes the server's count sentence;
 *  - limitations are portfolio phrase ids;
 *  - a refusal carries no clients, no notes and no facts, and is `not_applicable`.
 */
export function groundBriefing(submission: Submission, digest: Digest): GroundedBriefing {
  const removed: string[] = [];
  let degraded = false;
  const drop = (reason: string) => { removed.push(reason); degraded = true; };
  const factById = new Map(digest.facts.map((f) => [f.id, f]));
  const clientByRef = new Map(digest.clients.map((c) => [c.ref, c]));
  const nameOf = new Map(digest.clients.map((c) => [c.ref, c.name]));
  const reasonById = new Map(digest.clients.flatMap((c) => c.attention.map((r) => [r.id, { reason: r, client: c }] as const)));
  const sourceByRef = new Map(digest.clients.flatMap((c) => [...c.alerts, ...c.actions].map((s) => [s.ref, { source: s, client: c }] as const)));

  /** `own` is the client a summary is about, or null for the headline and the notes. */
  const renderBlock = (block: SubmittedBlock, own: DigestClient | null, at: string, allow: 'all' | 'portfolio_phrases'): Rendered | null => {
    const fields = BLOCK_FIELDS[block.kind];
    if (fields === undefined) { drop(`${at}: a "${block.kind}" block is not part of the contract`); return null; }
    const extra = Object.keys(block).filter((k) => !fields.includes(k));
    if (extra.length > 0) drop(`${at}: ${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not part of a ${block.kind} block and ${extra.length === 1 ? 'was' : 'were'} discarded`);
    if (allow === 'portfolio_phrases' && block.kind !== 'phrase') { drop(`${at}: only a portfolio phrase is allowed here`); return null; }
    const refs = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : []);

    switch (block.kind) {
      case 'facts': {
        const ids = refs(block.facts);
        const facts = ids.flatMap((id) => {
          const f = factById.get(id);
          if (f === undefined) { drop(`${at}: cites ${id}, not a fact the digest issued`); return []; }
          if (own !== null && f.subject !== own.ref && f.subject !== 'portfolio') { drop(`${at}: cites ${id}, a fact about ${f.subject}`); return []; }
          return [f];
        });
        if (facts.length === 0) { if (ids.length === 0) drop(`${at}: a facts block with no facts`); return null; }
        return { text: renderFacts(facts, nameOf), facts: facts.map((f) => f.id), sources: [] };
      }
      case 'attention': {
        const ids = refs(block.reasons);
        const found = ids.flatMap((id) => {
          const hit = reasonById.get(id);
          if (hit === undefined) { drop(`${at}: cites ${id}, not an attention reason the digest issued`); return []; }
          if (own !== null && hit.client.ref !== own.ref) { drop(`${at}: cites ${id}, a reason about ${hit.client.ref}`); return []; }
          return [hit];
        });
        if (found.length === 0) { if (ids.length === 0) drop(`${at}: an attention block with no reasons`); return null; }
        const byClient = new Map<DigestClient, string[]>();
        for (const { reason, client } of found) byClient.set(client, [...(byClient.get(client) ?? []), reason.says]);
        return { text: [...byClient].map(([client, says]) => `${client.name}: ${says.join('; ')}.`).join(' '), facts: [], sources: [] };
      }
      case 'source': {
        const ref = typeof block.ref === 'string' ? block.ref : '';
        const hit = sourceByRef.get(ref);
        if (hit === undefined) { drop(`${at}: cites ${ref || 'nothing'}, not an alert or action the digest issued`); return null; }
        if (own !== null && hit.client.ref !== own.ref) { drop(`${at}: cites ${ref}, another client's`); return null; }
        return { text: renderSource(hit.source, hit.client.name), facts: [], sources: [ref] };
      }
      case 'phrase': {
        const id = typeof block.phrase === 'string' ? block.phrase : '';
        const phrase = (PHRASES as Record<string, ClientPhrase | PortfolioPhrase>)[id];
        if (phrase === undefined) { drop(`${at}: "${id}" is not a phrase in the library`); return null; }
        if (phrase.scope === 'portfolio') {
          if (!phrase.holds(digest)) { drop(`${at}: "${id}" does not hold for this portfolio`); return null; }
          return { text: phrase.says(), facts: [], sources: [] };
        }
        if (allow === 'portfolio_phrases') { drop(`${at}: "${id}" names a client, not allowed here`); return null; }
        const ref = typeof block.ref === 'string' ? block.ref : own?.ref ?? '';
        const client = clientByRef.get(ref);
        if (client === undefined || (own !== null && client.ref !== own.ref)) { drop(`${at}: "${id}" names ${ref || 'no client'}, not this summary's client`); return null; }
        if (!phrase.holds(client)) { drop(`${at}: "${id}" does not hold for ${client.ref}`); return null; }
        return { text: phrase.says(client.name), facts: [], sources: [] };
      }
      default:
        return null;
    }
  };

  const render = (blocks: readonly SubmittedBlock[], own: DigestClient | null, where: string, allow: 'all' | 'portfolio_phrases' = 'all'): Rendered => {
    const parts = blocks.flatMap((b, i) => renderBlock(b, own, `${where} block ${i}`, allow) ?? []);
    return {
      text: parts.map((p) => p.text).join(' '),
      facts: [...new Set(parts.flatMap((p) => p.facts))],
      sources: [...new Set(parts.flatMap((p) => p.sources))],
    };
  };

  const limitationsOf = (ids: readonly string[]): string[] => ids.flatMap((id, i) => {
    const rendered = renderBlock({ kind: 'phrase', phrase: id }, null, `limitation ${i}`, 'portfolio_phrases');
    return rendered === null ? [] : [rendered.text];
  });

  if (submission.mode === 'refusal') {
    const headline = render(submission.headline, null, 'headline', 'portfolio_phrases').text || PHRASES.outside_scope.says();
    if (submission.clients.length > 0 || submission.notes.length > 0) removed.push('refusal: clients and notes are not kept');
    return { briefing: { mode: 'refusal', headline: { text: headline, facts: [] }, clients: [], notes: [], limitations: [] }, status: 'not_applicable', removed };
  }

  const clients: Briefing['clients'] = [];
  for (const client of submission.clients) {
    const digestClient = clientByRef.get(client.ref);
    if (digestClient === undefined) { drop(`client ${client.ref}: not in the portfolio`); continue; }
    const own = new Set([...digestClient.alerts, ...digestClient.actions].map((s) => s.ref));
    const because = client.because.filter((ref) => {
      if (!own.has(ref)) drop(`${client.ref} because ${ref}: not that client's`);
      return own.has(ref);
    });
    const block = render(client.blocks, digestClient, client.ref);
    const summary = block.text.length > 0
      ? block.text
      : digestClient.attention.length > 0
        ? `${digestClient.name}: ${digestClient.attention.map((r) => r.says).join('; ')}.`
        : PHRASES.client_clear.says(digestClient.name);
    clients.push({ ref: client.ref, summary, facts: [...block.facts], because: [...new Set([...because, ...block.sources])] });
  }

  const notes: Briefing['notes'] = [];
  submission.notes.forEach((note, i) => {
    const block = render(note.blocks, null, `note ${i}`);
    if (block.text.length > 0) notes.push({ text: block.text, facts: [...block.facts] });
  });

  let headline: Rendered = render(submission.headline, null, 'headline');
  if (headline.text.length === 0) {
    const fallback = ['portfolio/needing_attention', 'portfolio/clients'].flatMap((id) => factById.get(id) ?? []);
    headline = { text: fallback.map((f) => `${capitalise(f.statement)}.`).join(' '), facts: fallback.map((f) => f.id), sources: [] };
  }

  return {
    briefing: { mode: 'answer', headline: { text: headline.text, facts: [...headline.facts] }, clients, notes, limitations: limitationsOf(submission.limitations) },
    status: degraded ? 'degraded' : 'passed',
    removed,
  };
}
