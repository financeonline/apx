/**
 * The adviser analyst's contract (ADR-113). Pure.
 *
 * The model never sees a database, a tool, or an organisation the caller may not advise. It sees a
 * DIGEST — the Command Centre's own view model, already resolved and already authorised, with every
 * organisation, alert and action given a short reference — and it answers through one structured
 * tool whose every reference is checked against that digest. A reference the digest did not issue
 * is dropped; a number the digest does not contain marks the statement as not grounded and the
 * server replaces it with its own sentence. The authorisation boundary is therefore before the
 * model, and the grounding boundary after it, and neither depends on the prompt being obeyed.
 */

import { z } from 'zod';
import { bandLabel } from '@/modules/health';
import { PRIORITY_LABELS, SEVERITY_LABELS, TREND_LABELS, dueLabel } from './presentation';
import type { PortfolioView } from './types';

export const BRIEFING_TOOL = 'submit_briefing';
export const BRIEFING_PROMPT_VERSION = 'adviser-v1.0';
export const MAX_QUESTION_CHARS = 1_000;

// ---------------------------------------------------------------------------------------------
// The digest the model is given
// ---------------------------------------------------------------------------------------------

export interface DigestAlert { readonly ref: string; readonly id: string; readonly severity: string; readonly status: string; readonly title: string; readonly standing_since: string }
export interface DigestAction { readonly ref: string; readonly id: string; readonly priority: string; readonly title: string; readonly due: string | null; readonly overdue: boolean }
export interface DigestClient {
  readonly ref: string;
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly health: { readonly score: number | null; readonly band: string | null; readonly month: string; readonly trend: string | null; readonly previous_score: number | null; readonly previous_month: string | null } | null;
  readonly attention: readonly string[];
  readonly alerts: readonly DigestAlert[];
  readonly actions: readonly DigestAction[];
}
export interface Digest {
  readonly today: string;
  readonly counts: PortfolioView['counts'];
  readonly clients: readonly DigestClient[];
}

/** The view, with references. Everything the model may cite is here, and nothing else exists. */
export function buildDigest(view: PortfolioView): Digest {
  const alertRefs = new Map<string, string>();
  const actionRefs = new Map<string, string>();
  view.alerts.forEach((a, i) => alertRefs.set(a.id, `alert:${i + 1}`));
  view.actions.forEach((a, i) => actionRefs.set(a.id, `action:${i + 1}`));
  return {
    today: view.today,
    counts: view.counts,
    clients: view.clients.map((row, i) => ({
      ref: `client:${i + 1}`,
      id: row.organisation.id,
      name: row.organisation.name,
      status: row.organisation.status,
      health: row.health === null ? null : {
        score: row.health.score,
        band: bandLabel(row.health.band),
        month: row.health.periodLabel,
        trend: row.trend === null ? null : TREND_LABELS[row.trend],
        previous_score: row.health.previous?.score ?? null,
        previous_month: row.health.previous?.periodLabel ?? null,
      },
      attention: row.attention?.reasons.map((r) => r.label) ?? [],
      alerts: view.alerts.filter((a) => a.organizationId === row.organisation.id).map((a) => ({
        ref: alertRefs.get(a.id)!, id: a.id, severity: SEVERITY_LABELS[a.severity], status: a.status,
        title: a.title, standing_since: a.firstSeenAt.slice(0, 10),
      })),
      actions: view.actions.filter((a) => a.organizationId === row.organisation.id).map((a) => ({
        ref: actionRefs.get(a.id)!, id: a.id, priority: PRIORITY_LABELS[a.priority], title: a.title,
        due: dueLabel(a.dueDate, view.today), overdue: (dueLabel(a.dueDate, view.today) ?? '').startsWith('overdue'),
      })),
    })),
  };
}

/** Every reference the digest issued. */
export function digestRefs(digest: Digest): Set<string> {
  const refs = new Set<string>();
  for (const c of digest.clients) {
    refs.add(c.ref);
    for (const a of c.alerts) refs.add(a.ref);
    for (const a of c.actions) refs.add(a.ref);
  }
  return refs;
}

/** Every number the digest states, as the model would quote it. */
export function digestNumbers(digest: Digest): Set<string> {
  const numbers = new Set<string>();
  const add = (n: number | null | undefined) => { if (n !== null && n !== undefined) numbers.add(String(n)); };
  for (const value of Object.values(digest.counts)) add(value);
  for (const c of digest.clients) {
    add(c.health?.score); add(c.health?.previous_score);
    add(c.alerts.length); add(c.actions.length);
    for (const a of c.actions) if (a.due) for (const m of a.due.match(/\d+/g) ?? []) numbers.add(m);
    for (const label of c.attention) for (const m of label.match(/\d+/g) ?? []) numbers.add(m);
  }
  // Years and month days inside the dates the digest carries.
  for (const c of digest.clients) {
    for (const a of c.alerts) for (const m of a.standing_since.match(/\d+/g) ?? []) numbers.add(m);
    if (c.health) for (const m of `${c.health.month} ${c.health.previous_month ?? ''}`.match(/\d+/g) ?? []) numbers.add(m);
  }
  for (const m of digest.today.match(/\d+/g) ?? []) numbers.add(m);
  return numbers;
}

// ---------------------------------------------------------------------------------------------
// What the model submits
// ---------------------------------------------------------------------------------------------

export const BriefingSchema = z.object({
  mode: z.enum(['answer', 'refusal']),
  headline: z.string().min(1).max(300),
  clients: z.array(z.object({
    ref: z.string(),
    summary: z.string().min(1).max(600),
    /** References (alert:N, action:N) the summary rests on. */
    because: z.array(z.string()).max(12),
  })).max(25),
  notes: z.array(z.string().max(400)).max(6),
  limitations: z.array(z.string().max(300)).max(6),
});
export type Briefing = z.infer<typeof BriefingSchema>;

export interface GroundedBriefing {
  readonly briefing: Briefing;
  readonly status: 'passed' | 'degraded' | 'not_applicable';
  /** What was dropped or rewritten, for the record — never rendered. */
  readonly removed: readonly string[];
}

const NUMBER = /\d+(?:[.,]\d+)*/g;

function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/,/g, ''));
}

/**
 * Hold the submission to the digest (ADR-113 §3).
 *
 *  - a client ref the digest did not issue is dropped whole: the model cannot introduce a client;
 *  - a `because` ref the digest did not issue is dropped; a client left with none keeps its summary
 *    only if the summary states no number;
 *  - a number in any prose that the digest does not state is not grounded: the sentence is replaced
 *    by the server's own — the attention reasons — and the turn is `degraded`;
 *  - a refusal carries no clients and is `not_applicable`.
 */
export function groundBriefing(submission: Briefing, digest: Digest): GroundedBriefing {
  const refs = digestRefs(digest);
  const allowed = digestNumbers(digest);
  const removed: string[] = [];
  const clientByRef = new Map(digest.clients.map((c) => [c.ref, c]));
  const ungrounded = (text: string) => numbersIn(text).some((n) => !allowed.has(n));

  if (submission.mode === 'refusal') {
    const headline = ungrounded(submission.headline) ? 'That is outside what the Command Centre can answer.' : submission.headline;
    return { briefing: { ...submission, headline, clients: [], notes: [] }, status: 'not_applicable', removed };
  }

  let degraded = false;
  const clients: Briefing['clients'] = [];
  for (const client of submission.clients) {
    const digestClient = clientByRef.get(client.ref);
    if (digestClient === undefined) { removed.push(`client ${client.ref}: not in the portfolio`); continue; }
    const because = client.because.filter((ref) => {
      const ok = refs.has(ref) && (digestClient.alerts.some((a) => a.ref === ref) || digestClient.actions.some((a) => a.ref === ref));
      if (!ok) removed.push(`${client.ref} because ${ref}: not that client's`);
      return ok;
    });
    let summary = client.summary;
    if (ungrounded(summary)) {
      removed.push(`${client.ref} summary: states a number the digest does not`);
      summary = digestClient.attention.length > 0
        ? `${digestClient.name}: ${digestClient.attention.join('; ')}.`
        : `${digestClient.name}: nothing needs attention.`;
      degraded = true;
    }
    clients.push({ ref: client.ref, summary, because });
  }

  const notes = submission.notes.filter((note) => {
    if (ungrounded(note)) { removed.push('note: states a number the digest does not'); degraded = true; return false; }
    return true;
  });
  let headline = submission.headline;
  if (ungrounded(headline)) {
    removed.push('headline: states a number the digest does not');
    headline = `${digest.counts.needingAttention} of ${digest.counts.clients} clients need attention.`;
    degraded = true;
  }
  if (removed.some((r) => r.startsWith('client '))) degraded = true;

  return {
    briefing: { ...submission, headline, clients, notes },
    status: degraded ? 'degraded' : 'passed',
    removed,
  };
}
