import type { BadgeTone } from '@/components/ui/surfaces';

/**
 * The words and the small pure rules of the analyst page (UX_ARCHITECTURE.md §5 `AnalystChat`,
 * §6, §7.1–7.2, §8.1; AI_ARCHITECTURE.md §2 step 13, §7.8, §13).
 *
 * Nothing here touches the network or the model. The component that does is thin, and the rules a
 * test can pin — which badge a kind wears, how a stream is cut into events, what the quota notice
 * says — live here.
 */

// -----------------------------------------------------------------------------------------------
// §8.1: exactly one kind badge per statement, from the canonical table
// -----------------------------------------------------------------------------------------------

export type StatementKind = 'verified_fact' | 'deterministic_calculation' | 'estimate' | 'inference' | 'recommendation';

export const KIND_LABELS: Readonly<Record<StatementKind, string>> = {
  verified_fact: 'Fact',
  deterministic_calculation: 'Calculated',
  estimate: 'Estimate',
  inference: 'Analysis',
  recommendation: 'Recommendation',
};

export const KIND_TONES: Readonly<Record<StatementKind, BadgeTone>> = {
  verified_fact: 'neutral',
  deterministic_calculation: 'neutral',
  estimate: 'warn',
  inference: 'accent',
  recommendation: 'accent',
};

/** §5: sections in contract order, after the direct answer. */
export const SECTION_ORDER = ['key_findings', 'causes', 'risks', 'opportunities', 'recommended_actions'] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];

export const SECTION_TITLES: Readonly<Record<SectionKey, string>> = {
  key_findings: 'Key findings',
  causes: 'What is behind it',
  risks: 'Risks',
  opportunities: 'Opportunities',
  recommended_actions: 'Recommended actions',
};

export const PRIORITY_LABELS: Readonly<Record<'critical' | 'high' | 'medium' | 'low', string>> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
};

// -----------------------------------------------------------------------------------------------
// §7.8: "Not covered" renders server-generated topics only, in plain words
// -----------------------------------------------------------------------------------------------

export const UNSUPPORTED_REASON_TEXT: Readonly<Record<string, string>> = {
  no_data: 'no figures for that',
  not_in_scope: 'outside what the analyst covers',
  unverified: 'figure could not be verified',
  ambiguous_period: 'which period was meant is unclear',
  permission: 'not available to your role',
};

export function notCoveredLine(item: { readonly topic: string; readonly reason: string }): string {
  const reason = UNSUPPORTED_REASON_TEXT[item.reason] ?? 'could not be included';
  return `Not covered: ${item.topic} — ${reason}`;
}

/** The R2-C-08 rule: the note carries a code, and the server chooses the prose. */
export const DATA_QUALITY_NOTE_TEXT: Readonly<Record<string, string>> = {
  cash_basis_proxy: 'figures are estimated from bank activity, not from your accounts',
  vat_inclusive: 'bank figures may include VAT',
  uncategorised_amounts: 'some amounts are not yet categorised',
  bank_coverage_partial: 'bank statements do not cover the whole period',
  partial_month: 'the month is not complete',
  no_cost_of_sales: 'no direct-cost accounts, so no margin after direct costs',
  no_source_covers_period: 'no data covers that period',
  comparison_period_missing: 'nothing to compare with yet',
  insufficient_history: 'not enough history yet',
  no_counterparty_data: 'no customer or supplier detail in the data',
  stale_invoice_data: 'invoice data is out of date',
  basis_differs: 'the two periods come from different sources',
};

export function dataQualityNoteLine(note: { readonly code: string; readonly period: string | null }): string {
  const text = DATA_QUALITY_NOTE_TEXT[note.code] ?? note.code.replace(/_/g, ' ');
  return note.period ? `${capitalise(text)} (${note.period}).` : `${capitalise(text)}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// -----------------------------------------------------------------------------------------------
// Grounding verdict → what the reader is told (§7.2)
// -----------------------------------------------------------------------------------------------

export type GroundingStatus = 'passed' | 'degraded' | 'failed' | 'not_applicable';

export const DEGRADED_BANNER = "Some of this answer couldn't be verified against your data, so we've left it out.";
export const CREATE_ACTION_WITHHELD = 'Actions can be created only from an answer every figure of which was verified.';
export const UNDER_REVIEW_LABEL = 'Under review';

/** "Create action" appears on a recommendation only when the whole answer passed (ADR-032.5). */
export function canCreateActionFrom(groundingStatus: string | null, canCreate: boolean): boolean {
  return canCreate && groundingStatus === 'passed';
}

// -----------------------------------------------------------------------------------------------
// §7.1: the status line while tools run — plain words, never JSON
// -----------------------------------------------------------------------------------------------

export function statusLine(label: string): string {
  const trimmed = label.trim();
  if (trimmed === '') return 'Working on it…';
  return `${capitalise(trimmed)}…`;
}

// -----------------------------------------------------------------------------------------------
// Quota (ROUTE_ARCHITECTURE.md §121): the notice with its reset time
// -----------------------------------------------------------------------------------------------

export function quotaNotice(
  exhausted: 'daily' | 'monthly' | null,
  quota: { readonly dailyLimit: number | null; readonly resetsAt: string },
): string | null {
  if (exhausted === 'monthly') {
    return 'This organisation has reached its monthly analyst allowance. Ask again next month.';
  }
  if (exhausted === 'daily') {
    const reset = new Date(quota.resetsAt);
    const when = Number.isNaN(reset.getTime())
      ? 'tomorrow'
      : `at ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(reset)} UTC`;
    const limit = quota.dailyLimit === null ? "today's" : `today's ${quota.dailyLimit}`;
    return `You've used ${limit} questions. You can ask more ${when}.`;
  }
  return null;
}

/** The small line under the question box. */
export function remainingLine(remainingToday: number | null): string | null {
  if (remainingToday === null) return null;
  if (remainingToday === 1) return '1 question left today';
  return `${remainingToday} questions left today`;
}

// -----------------------------------------------------------------------------------------------
// The stream: SSE frames → events (§2 step 13)
// -----------------------------------------------------------------------------------------------

export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

/**
 * Cuts complete `event:`/`data:` frames off the front of a buffer and returns what is left. A frame
 * ends at a blank line; anything after the last blank line is a partial frame and stays.
 */
export function drainSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf('\n\n');
    if (end === -1) break;
    const frame = rest.slice(0, end);
    rest = rest.slice(end + 2);
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      // A frame the server did not write as JSON is not an event the page acts on.
      continue;
    }
    events.push({ event, data });
  }
  return { events, rest };
}

/** The reveal order after the single validated event (ADR-032.4): each step is one more section. */
export function revealSteps(answer: {
  readonly key_findings: readonly unknown[];
  readonly causes: readonly unknown[];
  readonly risks: readonly unknown[];
  readonly opportunities: readonly unknown[];
  readonly recommended_actions: readonly unknown[];
  readonly unsupported: readonly unknown[];
}): number {
  // The direct answer, every non-empty section, then confidence/not-covered/evidence as one step.
  return 1 + SECTION_ORDER.filter((key) => answer[key].length > 0).length + 1;
}

export function conversationLabel(ref: { readonly title: string | null }): string {
  return ref.title?.trim() || 'New conversation';
}
