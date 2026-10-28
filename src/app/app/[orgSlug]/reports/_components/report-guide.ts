import type { StoredKind } from '@/modules/reporting';

/**
 * What each report is for, in one plain sentence (client-friendliness pass, 2026-10-28).
 *
 * An owner with no accounting training should see at once which report to read and when one
 * arrives. The same sentence introduces a report on the list and at the top of the report itself,
 * so the two never describe it differently. Presentation only: nothing here decides what a report
 * holds.
 */
export const REPORT_PURPOSE: Readonly<Record<StoredKind | 'monthly', string>> = {
  monthly:
    'How the month went: the headline numbers, your Business Health Score and what needs attention. '
    + 'A new one is ready once each month has ended.',
  daily_brief:
    'A quick look at one day: money invoiced, paid and owed, new warnings and what needs attention. '
    + 'Made automatically shortly after midnight.',
  weekly_intelligence:
    'One Monday-to-Sunday week compared with the week before: what changed, why, and what is still open. '
    + 'Made automatically early each Monday.',
  adviser:
    'A fuller picture to send to your accountant or adviser: the latest month, health area by area, '
    + 'open warnings and actions, and how complete your data is. Made when you ask for one.',
  custom_ai:
    'Pick a month and up to five questions, and the AI Analyst answers each one from your own figures. '
    + 'Only you can see your custom reports.',
  funding_readiness:
    'How ready the business looks to a lender, from the latest month, as it stood when the report was made. '
    + 'A guide only, not a lending decision.',
};

/** "Made automatically" / "Made on request": who started a stored report, in plain words. */
export function originLabel(origin: string): string {
  return origin === 'scheduled' ? 'Made automatically' : 'Made on request';
}
