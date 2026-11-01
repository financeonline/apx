import 'server-only';
import { NotFound } from '@/core/errors';
import { can } from '@/core/permissions';
import { fixedClock, todayInTimeZone } from '@/core/periods';
import { isOpen, isOverdue, listActions, type Action } from '@/modules/actions';
import type { AccessContext } from '@/modules/tenancy';
import * as repo from '../../data/repository';
import {
  WORKSTREAM_LABELS, countBaseline, countByMonth, countChart, countSpark, dayLabel, departmentHeading,
  formatCount, groupCounts, monthEndOf, monthKey, openAt, plural, rate, rateLabel, shareSlices, workstream,
} from '../../domain/dashboard-ops';
import {
  DEPARTMENT_META, type DepartmentView, type MonthWindow, type PriorityIcon, type PriorityItem,
} from '../../domain/dashboard';
import { engagementItemsFor, reviewRequestTitle, titleSet } from './review-requests';

/**
 * Manage Workflow (the prototype's `workflow` department): the Action Centre's tasks. Created =
 * `created_at`, completed = `completed_at`; "open" = open or in progress. One read of the actions
 * (the Action Centre's own query, every status) and the engagement items for the request flags.
 */

const OPEN_SHOWN = 6;
const COMPLETED_SHOWN = 3;
const FOOTNOTE = 'Open a task to see its evidence, owner and due date. Completing a task here changes it in the Action Centre.';
const QUEUE = { kicker: 'OWNERS · DEADLINES · REVIEW', title: 'Tasks & approvals', footnote: FOOTNOTE, reviewedWord: 'Completed' } as const;

const SOURCE_ICON: Readonly<Record<string, PriorityIcon>> = {
  alert: 'shield', health_score: 'chart', ai: 'search', report: 'file', user: 'workflow',
};

export async function loadWorkflowView(ctx: AccessContext, window: MonthWindow): Promise<DepartmentView> {
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const heading = departmentHeading('workflow', window);
  const lastEnd = window.months.length === 0 ? null : monthEndOf(window.months.at(-1)!.periodStart);

  if (!can(ctx, 'actions.view')) {
    return emptyWorkflow(heading, window, lastEnd, 'Tasks are shown to the people who can open the Action Centre.');
  }

  const base = `/app/${ctx.orgSlug ?? ''}`;
  const [actions, basics, engagement] = await Promise.all([
    listActions(ctx),
    repo.organisationBasics(ctx.db, orgId),
    engagementItemsFor(ctx),
  ]);
  const today = todayInTimeZone(fixedClock(ctx.now()), basics.timezone);
  const requestedTitles = titleSet(engagement);

  const keys = window.months.map((m) => m.periodStart.slice(0, 7));
  const inWindow = (date: string | null) => {
    const key = monthKey(date);
    return key !== null && keys.includes(key);
  };
  const createdDates = actions.map((a) => a.createdAt);
  const createdByMonth = countByMonth(createdDates, keys);
  const completedByMonth = countByMonth(actions.filter((a) => a.status === 'completed').map((a) => a.completedAt), keys);
  const baseline = countBaseline(createdDates, window);

  const createdInWindow = actions.filter((a) => inWindow(a.createdAt));
  const created = createdInWindow.length;
  // Of the tasks created in the window, how many are completed (a cohort, so "x of y" holds).
  const completed = createdInWindow.filter((a) => a.status === 'completed').length;
  const completionRate = rate(completed, created);
  const open = actions.filter((a) => isOpen(a.status));
  const openByMonthEnd = window.months.map((m) => openAt(actions, monthEndOf(m.periodStart)));

  const item = (a: Action): PriorityItem => {
    const done = a.status === 'completed';
    const tag = done ? 'Completed' : isOverdue(a, today) ? 'Review required' : a.status === 'in_progress' ? 'In progress' : 'Ready for review';
    return {
      id: `action:${a.id}`, kind: 'action', recordId: a.id,
      title: a.title,
      subtitle: done
        ? `Owner: ${a.ownerName ?? 'Unassigned'} · Completed ${dayLabel(a.completedAt)}`
        : `Owner: ${a.ownerName ?? 'Unassigned'} · ${a.dueDate === null ? 'No date' : `Due ${dayLabel(a.dueDate)}`}`,
      tag, icon: SOURCE_ICON[a.sourceType] ?? 'workflow',
      context: a.issue ?? a.title,
      nextStep: done ? (a.outcomeNotes ?? 'Completed. Reopen it in the Action Centre if more is needed.') : (a.recommendation ?? 'Agree the next step with the owner.'),
      href: `${base}/actions/${a.id}`,
      reviewed: done,
      requested: requestedTitles.has(reviewRequestTitle(a.title)),
    };
  };
  const recentlyCompleted = actions
    .filter((a) => a.status === 'completed')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .slice(0, COMPLETED_SHOWN);

  const figure = rateLabel(completionRate);
  return {
    ...heading,
    metrics: [
      { label: 'Tasks created', value: formatCount(created), change: plural(window.months.length, 'month'), note: 'selected period', spark: countSpark(window, createdByMonth) },
      { label: 'Completion rate', value: figure, change: formatCount(completed), note: 'tasks completed', spark: countSpark(window, completedByMonth) },
      { label: 'Open at month end', value: formatCount(open.length), change: dayLabel(lastEnd), note: 'workload snapshot', spark: countSpark(window, openByMonthEnd) },
    ],
    chart: countChart({
      dept: 'workflow', window, first: createdByMonth, second: completedByMonth, baseline,
      insight: `${formatCount(completed)} of ${formatCount(created)} tasks completed in the selected period.`,
      figure: completionRate === null ? '—' : `${figure} complete`,
    }),
    mix: {
      title: DEPARTMENT_META.workflow.mix,
      total: formatCount(open.length),
      caption: 'open tasks',
      slices: shareSlices(groupCounts(open, WORKSTREAM_LABELS, (a) => workstream(a.sourceType))),
    },
    // `listActions` returns the Action Centre's order (most urgent first).
    queue: { ...QUEUE, items: [...open.slice(0, OPEN_SHOWN), ...recentlyCompleted].map(item) },
    clients: null,
    empty: actions.length === 0 ? 'No tasks yet. Create one in the Action Centre, or from an alert or the AI analyst’s answer.' : null,
  };
}

function emptyWorkflow(
  heading: ReturnType<typeof departmentHeading>, window: MonthWindow, lastEnd: string | null, empty: string,
): DepartmentView {
  const zeros = window.months.map(() => 0);
  return {
    ...heading,
    metrics: [
      { label: 'Tasks created', value: '0', change: plural(window.months.length, 'month'), note: 'selected period', spark: countSpark(window, zeros) },
      { label: 'Completion rate', value: '—', change: '0', note: 'tasks completed', spark: countSpark(window, zeros) },
      { label: 'Open at month end', value: '0', change: dayLabel(lastEnd), note: 'workload snapshot', spark: countSpark(window, zeros) },
    ],
    chart: countChart({ dept: 'workflow', window, first: zeros, second: zeros, baseline: null, insight: '0 of 0 tasks completed in the selected period.', figure: '—' }),
    mix: { title: DEPARTMENT_META.workflow.mix, total: '0', caption: 'open tasks', slices: [] },
    queue: { ...QUEUE, items: [] },
    clients: null,
    empty,
  };
}
