import { z } from 'zod';
import { ValidationError } from '@/core/errors';

/**
 * "Give feedback" on the department dashboard (docs/DEPARTMENT_DASHBOARD_PLAN.md): a note about one
 * section of the dashboard, sent to APX staff inside APX. Pure: the sections, the departments and the
 * input's shape. The keys and labels are the prototype's `#feedback-section` select, unchanged.
 */

export const FEEDBACK_SECTION_LABELS = {
  branding: '01 · Branding, logo & identity',
  departments: '02 · Department navigation',
  metrics: '03 · Financial metrics',
  performance: '04 · Main performance chart',
  composition: '05 · Composition chart',
  perspective: '06 · Comparative Financials',
  priorities: '07 · Workflow & priorities',
  workspace: '08 · Compliance & connections',
  'report-summary': '09 · Financial report summary',
  growth: '10 · How can I Grow',
  clients: '11 · Client Management',
  industry: '12 · Operations insights',
  systems: '13 · Manage Systems and Workflow',
  apax: '14 · APAX AI Insights',
  targets: '15 · Monthly Notifications',
  marketing: '16 · Marketing vs Revenue',
  templates: '17 · Reports & Pitch Decks',
} as const;

export type FeedbackSection = keyof typeof FEEDBACK_SECTION_LABELS;
export const FEEDBACK_SECTIONS = Object.keys(FEEDBACK_SECTION_LABELS) as FeedbackSection[];

/** The dashboard's five departments (`?dept=`), with the names its tiles show. */
export const FEEDBACK_DEPARTMENT_LABELS = {
  analysis: 'Financial Analysis',
  banking: 'Banking',
  capture: 'Data Capture',
  workflow: 'Manage Workflow',
  clients: 'Client Management',
} as const;

export type FeedbackDepartment = keyof typeof FEEDBACK_DEPARTMENT_LABELS;

export const FEEDBACK_NOTES_MAX = 4000;

export function feedbackSectionLabel(section: string): string {
  return (FEEDBACK_SECTION_LABELS as Record<string, string>)[section] ?? section;
}

export function feedbackDepartmentLabel(department: string | null): string {
  if (department === null) return '—';
  return (FEEDBACK_DEPARTMENT_LABELS as Record<string, string>)[department] ?? department;
}

const ContextText = z.string().max(200, 'Keep this under 200 characters.');

export const DashboardFeedbackInput = z.object({
  section: z.enum(FEEDBACK_SECTIONS as [FeedbackSection, ...FeedbackSection[]], { error: 'Choose the section the feedback is about.' }),
  department: z.enum(Object.keys(FEEDBACK_DEPARTMENT_LABELS) as [FeedbackDepartment, ...FeedbackDepartment[]]).nullable().default(null),
  notes: z.string().trim()
    .min(1, 'Describe the change you would like.')
    .max(FEEDBACK_NOTES_MAX, `Keep the note under ${FEEDBACK_NOTES_MAX} characters.`),
  /** What was on screen: the period caption, Current / Last Completed, the months, the scenario. */
  context: z.strictObject({
    period: ContextText.optional(),
    view: ContextText.optional(),
    months: ContextText.optional(),
    scenario: ContextText.optional(),
  }).default({}),
});
export type DashboardFeedbackInput = z.infer<typeof DashboardFeedbackInput>;

/** Validates a feedback note, or throws ValidationError with one issue per field. */
export function parseDashboardFeedback(input: unknown): DashboardFeedbackInput {
  const result = DashboardFeedbackInput.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'Some details need fixing.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
