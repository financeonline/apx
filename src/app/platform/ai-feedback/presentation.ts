import type { BadgeTone } from '@/components/ui/surfaces';
import type { FeedbackStatus } from '@/modules/ai';

/** Plain words for the queue (UX_ARCHITECTURE.md §8.1: enum values are never rendered). */
export const FEEDBACK_TYPE_LABELS: Readonly<Record<string, string>> = {
  incorrect: 'A figure or claim is incorrect',
  unhelpful: 'Did not answer the question',
  unsafe: 'Said something it should not have',
  helpful: 'Helpful',
};

export const STATUS_LABELS: Readonly<Record<FeedbackStatus, string>> = {
  open: 'Open', reviewed: 'Reviewed', actioned: 'Actioned', dismissed: 'Dismissed',
};

export const STATUS_TONES: Readonly<Record<FeedbackStatus, BadgeTone>> = {
  open: 'warn', reviewed: 'accent', actioned: 'accent', dismissed: 'neutral',
};
