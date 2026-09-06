import 'server-only';
import { callApi } from '@/core/db';
import { assertCan, can } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { byUrgency, canTransition, isOpen, isOverdue, type Action, type ActionPriority, type ActionStatus } from '../domain/types';
import * as repo from '../data/repository';
import { ValidationError } from '@/core/errors';

/**
 * The Action Centre's services (SERVICE_ARCHITECTURE.md §4.13; SOW §17).
 *
 * Every write goes through an `api.*` function, and the permission is asserted here AND in SQL
 * (`RBAC_MATRIX.md §4`, defence in depth). The interesting split is between the two update paths:
 * `updateAction` asks "may you edit actions in this organisation at all", `setStatus` asks "is this
 * one yours" — and a client only ever satisfies the second, on the two columns §17 lets them move.
 * Collapsing them into one function with a role branch is exactly how a client ends up able to
 * change a due date (ADR-003: code asks for a permission, never for a role name).
 */

export interface CreateActionInput {
  readonly title: string;
  readonly issue?: string | null;
  readonly recommendation?: string | null;
  readonly priority?: ActionPriority;
  readonly ownerUserId?: string | null;
  readonly dueDate?: string | null;
}

function orgOf(ctx: AccessContext): string {
  if (!ctx.orgId) throw new ValidationError('No organisation is in context.');
  return ctx.orgId;
}

export async function createAction(ctx: AccessContext, input: CreateActionInput): Promise<string> {
  assertCan(ctx, 'actions.create');
  return callApi<string>(ctx.db, 'create_action', {
    p_org: orgOf(ctx),
    p_input: {
      title: input.title,
      issue: input.issue ?? null,
      recommendation: input.recommendation ?? null,
      priority: input.priority ?? 'medium',
      owner_user_id: input.ownerUserId ?? null,
      due_date: input.dueDate ?? null,
    },
    p_source: { type: 'user' },
  }, ctx.requestId);
}

/**
 * §4.13: from an alert, pinning the revision that prompted it.
 *
 * An alert is re-evaluated whenever the figures change (ADR-034). The action keeps saying what the
 * alert said when somebody decided to act on it — otherwise "why did we do this?" is unanswerable a
 * month later, which is the question an action list exists to answer.
 */
export async function createFromAlert(
  ctx: AccessContext, alertId: string, input: Partial<CreateActionInput> = {},
): Promise<string> {
  assertCan(ctx, 'actions.create');
  return callApi<string>(ctx.db, 'create_action_from_alert', {
    p_alert: alertId,
    p_input: {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.ownerUserId == null ? {} : { owner_user_id: input.ownerUserId }),
      ...(input.dueDate == null ? {} : { due_date: input.dueDate }),
    },
  }, ctx.requestId);
}

/**
 * §4.13, ADR-032.5: from an AI recommendation — **refused unless the answer passed grounding**.
 *
 * A degraded answer has had its unverifiable sentences removed (§7.8) and a failed one was never
 * shown as fact. Turning either into a task would launder it into something that looks
 * authoritative precisely because it now has an owner and a due date. The SQL function refuses too;
 * this is the first of the two gates, not the only one.
 */
export async function createFromRecommendation(
  ctx: AccessContext, messageId: string, index: number, input: Partial<CreateActionInput> = {},
): Promise<string> {
  assertCan(ctx, 'actions.create');
  return callApi<string>(ctx.db, 'create_action_from_recommendation', {
    p_message: messageId,
    p_index: index,
    p_input: {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.ownerUserId == null ? {} : { owner_user_id: input.ownerUserId }),
      ...(input.dueDate == null ? {} : { due_date: input.dueDate }),
    },
  }, ctx.requestId);
}

export async function assignAction(
  ctx: AccessContext, actionId: string, ownerUserId: string | null,
): Promise<string> {
  assertCan(ctx, 'actions.assign');
  return callApi<string>(ctx.db, 'assign_action', {
    p_action: actionId, p_owner: ownerUserId,
  }, ctx.requestId);
}

export async function updateAction(
  ctx: AccessContext, actionId: string, patch: Partial<CreateActionInput>,
): Promise<string> {
  assertCan(ctx, 'actions.create');
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.issue !== undefined) body.issue = patch.issue;
  if (patch.recommendation !== undefined) body.recommendation = patch.recommendation;
  if (patch.priority !== undefined) body.priority = patch.priority;
  if (patch.dueDate !== undefined) body.due_date = patch.dueDate;
  return callApi<string>(ctx.db, 'update_action', {
    p_action: actionId, p_patch: body,
  }, ctx.requestId);
}

export interface OutcomeInput {
  readonly outcomeNotes?: string | null;
  readonly outcomeValue?: string | null;
  readonly dismissedReason?: string | null;
}

/**
 * Moves an action along, with its outcome.
 *
 * The transition is checked here as well as the permission, because §17's statuses are an account
 * of what happened: a completed action that becomes dismissed without first being re-opened leaves
 * two contradictory records of the same work, and the audit trail cannot say which is true.
 */
export async function setStatus(
  ctx: AccessContext,
  actionId: string,
  status: ActionStatus,
  outcome: OutcomeInput = {},
): Promise<string> {
  assertCan(ctx, 'actions.update_own');

  const current = await repo.getAction(ctx.db, orgOf(ctx), actionId);
  if (current === null) throw new ValidationError('That action could not be found.');
  if (!canTransition(current.status, status)) {
    throw new ValidationError(
      `An action that is ${current.status} has to be re-opened before it can be ${status}.`,
    );
  }

  return callApi<string>(ctx.db, 'set_action_status', {
    p_action: actionId,
    p_status: status,
    p_outcome: {
      ...(outcome.outcomeNotes === undefined ? {} : { outcome_notes: outcome.outcomeNotes }),
      ...(outcome.outcomeValue === undefined ? {} : { outcome_value: outcome.outcomeValue }),
      ...(outcome.dismissedReason === undefined ? {} : { dismissed_reason: outcome.dismissedReason }),
    },
  }, ctx.requestId);
}

export async function listActions(
  ctx: AccessContext, filter: repo.ActionFilter = {},
): Promise<Action[]> {
  assertCan(ctx, 'actions.view');
  const actions = await repo.listActions(ctx.db, orgOf(ctx), filter, can(ctx, 'users.view'));
  return [...actions].sort(byUrgency);
}

export async function getAction(ctx: AccessContext, actionId: string): Promise<Action | null> {
  assertCan(ctx, 'actions.view');
  return repo.getAction(ctx.db, orgOf(ctx), actionId, can(ctx, 'users.view'));
}

export async function assignableOwners(
  ctx: AccessContext,
): Promise<Array<{ userId: string; name: string }>> {
  assertCan(ctx, 'actions.assign');
  return repo.assignableOwners(ctx.db, orgOf(ctx));
}

export interface ActionsSummary {
  readonly open: number;
  readonly overdue: number;
  readonly mine: number;
  /** The few a person would look at first, for Home's widget. */
  readonly top: readonly Action[];
}

/** §4.13: the Home widget's figures. */
export async function getActionsSummary(
  ctx: AccessContext, today: string, limit = 3,
): Promise<ActionsSummary> {
  const actions = await listActions(ctx, { status: ['open', 'in_progress'] });
  return {
    open: actions.length,
    overdue: actions.filter((action) => isOverdue(action, today)).length,
    mine: actions.filter((action) => action.ownerUserId === ctx.userId).length,
    top: actions.slice(0, limit),
  };
}

/**
 * Whether this caller may move THIS action.
 *
 * A client may move only their own (`RBAC_MATRIX.md`), which is a fact about the row as well as
 * about the role — so the answer needs the action, not just the context.
 */
export function canManage(ctx: AccessContext, action: Action): boolean {
  if (can(ctx, 'actions.create')) return true;
  return can(ctx, 'actions.update_own') && action.ownerUserId === ctx.userId;
}

export { isOpen, isOverdue, byUrgency, canTransition };
export type { ActionFilter } from '../data/repository';

/**
 * Who a reader is told owns an action.
 *
 * Their own name is always "you"; a colleague's is a name only when the reader may see the team
 * (`users.view`). A client sees "someone here", which says everything the list needs to and nothing
 * the tenancy model does not allow.
 */
export function ownerLabel(action: Action, viewerUserId: string): string {
  if (action.ownerUserId === null) return 'Nobody yet';
  if (action.ownerUserId === viewerUserId) return 'You';
  return action.ownerName ?? 'Someone here';
}
