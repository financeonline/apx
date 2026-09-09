/**
 * `modules/ai` — the Claude financial analyst (AI_ARCHITECTURE.md).
 *
 * The module's first principle is the one every other file here serves: **Claude interprets; the
 * engine calculates** (§1.1, ADR-010). Every figure the analyst states comes from a
 * `metric_snapshots` row or a committed record returned by a tool in the same turn, and the
 * grounding check is what makes that a property of the system rather than a hope about the model.
 *
 * Built: `untrusted()` (§9), the claim grammar (§7.9), the response contract (§5), the allowed
 * set and grounding v3 (§7), period resolution (§8), the Claude client (§1.2, ADR-023), and the
 * conversation service bound to (org, user) (§2 step 3, ADR-076).
 *
 * Slice 2 adds the closed tool registry (§3) and `runTool`, the per-call authorisation wrapper (§4).
 *
 * Still to come: the tool loop (§2), the chat UI, the eval harness (§12) and the feedback queue (§13).
 *
 * The Anthropic SDK will be imported in exactly one file, `data/claude-client.ts` (§1.2, ADR-023).
 * No key, prompt or tool definition ever reaches the browser.
 */

export {
  UNTRUSTED_MAX_LENGTH,
  documentText,
  escapeUntrusted,
  untrusted,
  untrustedJson,
  userQuestion,
} from './domain/untrusted';

export {
  extractClaims,
  normalise,
  type Abbreviation,
  type Claim,
  type ClaimContext,
  type ClaimKind,
  type ExtractionResult,
} from './domain/claims';

export {
  NUMERIC_UNITS,
  NullableNumericSchema,
  NumericValueSchema,
  displayPrecision,
  isNumericValue,
  numeric,
  toDecimal,
  type NumericUnit,
  type NumericValue,
} from './domain/values';

export {
  allowedSet,
  entryAt,
  type AllowedEntry,
  type FieldKind,
  type ToolResult,
} from './domain/allowed-set';

export {
  ENTITY_REF_TYPES,
  EVIDENCE_REF_TYPES,
  EntityRefSchema,
  EvidenceRefSchema,
  NumberRefSchema,
  RESPONSE_MODES,
  RecommendedActionSchema,
  STATEMENT_KINDS,
  StatementSchema,
  SubmitAnswerSchema,
  UNSUPPORTED_REASONS,
  kindForAssurance,
  statementsOf,
  weakestKind,
  type EntityRef,
  type EvidenceRef,
  type NumberRef,
  type ResponseMode,
  type Statement,
  type StatementKind,
  type SubmitAnswer,
  type UnsupportedReason,
} from './domain/contract';

export {
  ground,
  modeAdmissible,
  unsupportedTopicsClean,
  type GroundingContext,
  type GroundingResult,
  type GroundingStatus,
  type Mismatch,
} from './domain/grounding';

export {
  acceptableLabels,
  resolvePeriodContext,
  type PeriodContext,
  type PeriodRef,
  type PeriodRow,
  type ResolveInput,
} from './domain/periods';

export {
  createConversation,
  findConversation,
  listConversations,
  loadHistory,
  loadMessages,
  HISTORY_TURNS,
  type ConversationRef,
  type HistoryTurn,
  type StoredMessage,
} from './services/conversations';

export {
  callModel,
  liveTransport,
  ANALYST_MAX_TOKENS,
  DEFAULT_ANALYST_MODEL,
  PROMPT_VERSION,
  type ModelCall,
  type ModelResponse,
  type ModelTransport,
} from './data/claude-client';

export {
  TOOLS,
  TOOL_NAMES,
  MAX_TOOL_CALLS,
  REGENERATION_EXTRA_CALLS,
  TOOL_TIMEOUT_MS,
  toolNamed,
  type AnyTool,
} from './domain/tools/registry';

export type {
  ToolCallContext,
  ToolDefinition,
  ToolError,
  ToolErrorCode,
  ToolMeta,
  ToolOutcome,
  ReturnedRefs,
} from './domain/tools/types';

export {
  runTool,
  snapshotAccess,
  ContextChanged,
  type RunToolInput,
  type RunToolOutput,
  type TurnAccess,
} from './services/run-tool';
