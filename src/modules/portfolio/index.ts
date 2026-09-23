export {
  ADVISER_ROLES,
  type AdviserRole,
  type AttentionEntry,
  type AttentionReason,
  type AttentionReasonKind,
  type ClientRow,
  type PortfolioAction,
  type PortfolioAlert,
  type PortfolioCounts,
  type PortfolioHealth,
  type PortfolioOrganisation,
  type PortfolioView,
  type RecentChange,
} from './domain/types';

export {
  REASON_WEIGHTS,
  SCORE_FALL_POINTS,
  attentionEntry,
  attentionReasons,
  bandFell,
  compareAttention,
  scoreFell,
  trendOf,
} from './domain/attention';

export {
  PRIORITY_LABELS,
  SEVERITY_LABELS,
  TREND_LABELS,
  ageLabel,
  dueLabel,
  priorityTone,
  reasonTone,
  severityTone,
  type Tone,
} from './domain/presentation';

export {
  adviserOrganisations,
  getPortfolioContext,
  isAdviserRole,
  resolvePortfolioContext,
  type PortfolioContext,
} from './services/access';

export { ATTENTION_CAP, RECENT_DAYS, hrefs, loadPortfolio, sortAlerts } from './services/portfolio';

export {
  BRIEFING_PROMPT_VERSION,
  BRIEFING_TOOL,
  BriefingSchema,
  MAX_QUESTION_CHARS,
  buildDigest,
  digestNumbers,
  digestRefs,
  groundBriefing,
  type Briefing,
  type Digest,
  type DigestClient,
  type GroundedBriefing,
} from './domain/briefing';

export {
  askAdviser,
  listAdviserTurns,
  type AdviserAnswer,
  type AdviserStatus,
  type AdviserTurn,
  type AskOptions,
  type PersistedAnswer,
} from './services/adviser';
