/**
 * `modules/ai` — the Claude financial analyst (AI_ARCHITECTURE.md).
 *
 * The module's first principle is the one every other file here serves: **Claude interprets; the
 * engine calculates** (§1.1, ADR-010). Every figure the analyst states comes from a
 * `metric_snapshots` row or a committed record returned by a tool in the same turn, and the
 * grounding check is what makes that a property of the system rather than a hope about the model.
 *
 * Built so far (Phase 11 slice 0, Spike S3):
 *   * `untrusted()` — the wrapper every imported string passes through before it reaches the model;
 *   * the claim grammar (§7.9) — what counts as a numeric claim needing a `NumberRef`.
 *
 * Still to come, in the order the plan builds them: the tool registry (§3), the tool loop and
 * period resolution (§2, §8), the response contract and grounding v3 (§5, §7), the chat UI, the
 * eval harness (§12) and the feedback queue (§13).
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
