/**
 * `modules/feedback` — "Give feedback" on the department dashboard: a member's note to APX staff,
 * stored platform-wide and read in the Platform area. Not `modules/engagement`, which is the work
 * between a company and its advisers inside that company (requests, deliverables, comments); this is
 * feedback about APX itself, which no other member of the company sees.
 */
export {
  DashboardFeedbackInput,
  FEEDBACK_DEPARTMENT_LABELS,
  FEEDBACK_NOTES_MAX,
  FEEDBACK_SECTIONS,
  FEEDBACK_SECTION_LABELS,
  feedbackDepartmentLabel,
  feedbackSectionLabel,
  parseDashboardFeedback,
  type FeedbackDepartment,
  type FeedbackSection,
} from './domain/feedback';
export {
  listDashboardFeedback,
  submitDashboardFeedback,
  type DashboardFeedbackItem,
  type SubmittedFeedback,
} from './services';
