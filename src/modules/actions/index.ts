/**
 * `modules/actions` — the Action Centre (SOW §17, SERVICE_ARCHITECTURE.md §4.13).
 *
 * An action is the one object in MOTION that records a decision rather than a fact. Everything else
 * is the product telling somebody what is true; an action is somebody saying what they will do
 * about it, with their name and a date on it. That is why it carries a COPY of the evidence it was
 * created from (EVIDENCE_MODEL.md §5): the alert behind it will be re-evaluated, and the action has
 * to keep saying what it said when the decision was made.
 *
 * Never deletes. An action that turns out to be wrong is dismissed with a reason, because the list
 * is a record of what a business decided and a deleted row is a decision nobody can account for.
 */

export {
  ACTION_PRIORITIES,
  ACTION_SOURCES,
  ACTION_STATUSES,
  OPEN_STATUSES,
  byUrgency,
  canTransition,
  isOpen,
  isOverdue,
  type Action,
  type ActionPriority,
  type ActionSource,
  type ActionStatus,
} from './domain/types';

export {
  ACTION_VIEWS,
  ACTION_VIEW_LABELS,
  DUE_SOON_DAYS,
  addDays,
  inView,
  isActionView,
  isDueSoon,
  type ActionView,
} from './domain/views';

export {
  assignAction,
  assignableOwners,
  canManage,
  createAction,
  createFromAlert,
  createFromHealthScore,
  createFromRecommendation,
  getAction,
  getActionsSummary,
  loadActionCentre,
  listActions,
  listOpenActionsForJob,
  ownerLabel,
  setStatus,
  updateAction,
  type ActionFilter,
  type ActionCentreView,
  type ActionsSummary,
  type CreateActionInput,
  type OutcomeInput,
} from './services';
