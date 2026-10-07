import type { SubmitAnswer } from '@/modules/ai';
import type { CustomSection } from './custom-sections';

/**
 * The Custom AI Report (Phase 17; Agreement §22 "user-selected period, questions and analytical
 * dimensions"; R17-4).
 *
 * Each chosen question is put to the AI Analyst exactly as a person would ask it — the same route,
 * the same grounding, refusal and evidence rules, the same quota — and the report is those answers
 * in order. The AI writes nothing here that it did not write, and was not checked, in the analyst;
 * figures come only from the calculation tools the analyst calls. A question the analyst could not
 * ground stays in the report as it came back — refused, no data, or degraded — rather than being
 * dropped, so the report never looks more certain than its answers were.
 */

export const CUSTOM_CONTENT_VERSION = 'custom.v1';

/** At most this many questions in one report: each is a full analyst turn against the quota. */
export const MAX_CUSTOM_QUESTIONS = 5;
export const MAX_CUSTOM_QUESTION_CHARS = 500;

/** The question categories the agreement lists for the analyst (§12), offered as a starting point. */
export const SUPPORTED_QUESTIONS: readonly string[] = [
  'Why did profit increase or decrease?',
  'Why is cash falling?',
  'Which expenses increased the most?',
  'Which customers are most profitable?',
  'Where is the business losing money?',
  'Which products or services have the strongest contribution?',
  'What changed this month?',
  'What risks require attention?',
  'What should management focus on?',
];

/** The analytical dimensions a person may point the questions at. */
export const CUSTOM_DIMENSIONS = {
  profitability: 'Profitability',
  cash: 'Cash',
  revenue: 'Sales',
  costs: 'Costs',
  receivables_payables: 'What customers owe and what is owed to suppliers',
  customers: 'Customers',
  banking: 'Banking',
  // ADR-156: these four also carry a fixed figures table MOTION computes itself (custom-sections.ts).
  loans: 'Loans',
  assets: 'Assets',
  vat: 'VAT',
  corporation_tax: 'Corporation Tax',
} as const;

export type CustomDimension = keyof typeof CUSTOM_DIMENSIONS;

export function isCustomDimension(value: string): value is CustomDimension {
  return Object.prototype.hasOwnProperty.call(CUSTOM_DIMENSIONS, value);
}

/** An area's name inside a sentence: lower case, except an abbreviation ("VAT") stays as it is. */
export function focusWord(label: string): string {
  return label === label.toUpperCase() ? label : label.toLowerCase();
}

/**
 * The message actually sent to the analyst for one question. The period and dimensions are part
 * of the question, in words, so the analyst's own period resolution reads them — and so the report
 * shows exactly what was asked.
 */
export function customQuestionMessage(periodLabel: string, dimensions: readonly CustomDimension[], question: string): string {
  const focus = dimensions.length === 0
    ? ''
    : `, looking at ${dimensions.map((d) => focusWord(CUSTOM_DIMENSIONS[d])).join(', ')}`;
  return `For ${periodLabel}${focus}: ${question.trim()}`;
}

export interface CustomAnswerEntry {
  /** What was sent to the analyst, as stored with the user's turn. */
  readonly asked: string;
  readonly messageId: string;
  readonly groundingStatus: string | null;
  readonly evidenceBundleId: string | null;
  /** The analyst's validated answer; NULL when the turn failed. */
  readonly answer: SubmitAnswer | null;
}

export interface CustomReportContent {
  readonly version: typeof CUSTOM_CONTENT_VERSION;
  readonly organisationName: string;
  readonly period: { readonly id: string; readonly label: string; readonly start: string; readonly end: string };
  readonly dimensions: readonly CustomDimension[];
  /** NULL when no question was put to the analyst (a report of fixed sections only, ADR-156). */
  readonly conversationId: string | null;
  readonly entries: readonly CustomAnswerEntry[];
  /**
   * ADR-156: the fixed figures tables for the chosen Loans / Assets / VAT / Corporation Tax areas,
   * computed by MOTION, not the AI. Absent from reports recorded before them — optional, so
   * `custom.v1` content stays readable either way.
   */
  readonly sections?: readonly CustomSection[];
  readonly composedAt: string;
}

export interface ConversationMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string | null;
  readonly structured: SubmitAnswer | null;
  readonly groundingStatus: string | null;
  readonly evidenceBundleId: string | null;
}

/**
 * The entries, from the conversation as STORED — never from what a browser says the answers were.
 * Each named assistant message must be in the conversation, and the question is the user message
 * immediately before it. Returns NULL if any id is not an assistant turn of this conversation.
 */
export function entriesFromConversation(
  messages: readonly ConversationMessage[], assistantIds: readonly string[],
): CustomAnswerEntry[] | null {
  const entries: CustomAnswerEntry[] = [];
  const seen = new Set<string>();
  for (const id of assistantIds) {
    if (seen.has(id)) return null;
    seen.add(id);
    const index = messages.findIndex((message) => message.id === id);
    const message = messages[index];
    if (index < 1 || message === undefined || message.role !== 'assistant') return null;
    const question = messages[index - 1];
    if (question === undefined || question.role !== 'user') return null;
    entries.push({
      asked: question.content ?? '',
      messageId: message.id,
      groundingStatus: message.groundingStatus,
      evidenceBundleId: message.evidenceBundleId,
      answer: message.structured,
    });
  }
  return entries;
}
