import { Decimal } from '@/core/money';
import { METRIC_LABELS } from '@/modules/financials';
import { entryAt, type AllowedEntry } from './allowed-set';
import { extractClaims, normalise, type Claim, type ClaimContext } from './claims';
import {
  kindForAssurance, statementsOf, weakestKind,
  type EvidenceRef, type NumberRef, type Statement, type StatementKind, type SubmitAnswer,
} from './contract';

/**
 * Grounding v3 (AI_ARCHITECTURE.md §7; ADR-032 + ADR-045).
 *
 * Pure and deterministic: the same `submit_answer` object and the same recorded tool results always
 * produce the same verdict. That is what lets the eval harness run on fixtures and what lets a
 * disputed answer be re-examined months later.
 *
 * Two earlier designs were withdrawn, and the reasons are the specification:
 *
 *   * v1 matched a claimed number against a flat bag of every number in every tool output. It
 *     passed "Beta Ltd is 41% of revenue" when 41% was Acme's share, because 41 was *somewhere*
 *     (F-C-01).
 *   * v2 bound each number to a path but not to the noun, the period word, the entity or the
 *     direction. It passed "Net profit was £120,000" citing the revenue path, and "Revenue rose to
 *     £120,000" on a level that had not moved (R2-C-01, R2-C-03, R2-C-07).
 *
 * v3 binds all five. A number is grounded when the value at its path matches the text, AND the
 * metric noun beside it is that metric, AND the period agrees, AND the entity beside it is the
 * entity the row is about, AND the direction word is anchored to something that actually changed.
 */

export type GroundingStatus = 'passed' | 'degraded' | 'failed' | 'not_applicable';

export interface Mismatch {
  /** Where in the answer, e.g. `key_findings[1]`. */
  readonly path: string;
  /** The sentence, stored for review only — never rendered, never replayed (§7.8, R2-C-04). */
  readonly statement: string;
  readonly reason: string;
}

export interface GroundingContext {
  readonly entries: readonly AllowedEntry[];
  /** Canonical labels of this turn: `period_context.resolved ∪ default ∪ meta.periods`. */
  readonly periodLabels: readonly string[];
  /** Period id by canonical label, for §7.4's "the entry must belong to that period". */
  readonly periodIdByLabel: Readonly<Record<string, string>>;
  /** Every entity name a tool returned this turn, by id. */
  readonly entityNamesById: Readonly<Record<string, string>>;
  /** Every reference string a tool returned this turn (invoice numbers, source refs). */
  readonly references: readonly string[];
  /** Descriptor hashes returned this turn — the only `query` refs §7.6 accepts. */
  readonly descriptorHashes: readonly string[];
  /** Assurance of each evidence id a tool returned, for recomputing kind (§6.2). */
  readonly assuranceById: Readonly<Record<string, string>>;
  /** Comparison-period labels reachable from this turn's entries (§7.4). */
  readonly comparisonLabels: readonly string[];
  /** True when §8 flagged the question ambiguous, which is what admits `clarification` (§7.7). */
  readonly periodAmbiguous: boolean;
  /** True when every tool call returned NO_DATA / INSUFFICIENT_DATA (§7.7). */
  readonly allToolsNoData: boolean;
  readonly toolCallCount: number;
}

export interface GroundingResult {
  readonly status: GroundingStatus;
  readonly mismatches: readonly Mismatch[];
  /** The kind the server computed for each statement path, which overrides the model's (§6.2). */
  readonly kinds: Readonly<Record<string, StatementKind>>;
  /** Evidence refs derived from `NumberRef`s, per statement path (§7.6). */
  readonly derivedRefs: Readonly<Record<string, readonly EvidenceRef[]>>;
}

// -----------------------------------------------------------------------------------------------
// Tokens and proximity (§7.4 "within six tokens", §7.5 "nearest named span")
// -----------------------------------------------------------------------------------------------

const PROXIMITY_TOKENS = 6;

interface Token { readonly text: string; readonly start: number; readonly end: number }

function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/[^\s]+/g)) {
    tokens.push({ text: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return tokens;
}

function tokenIndexAt(tokens: readonly Token[], offset: number): number {
  for (let i = 0; i < tokens.length; i += 1) {
    if (offset >= tokens[i]!.start && offset < tokens[i]!.end) return i;
    if (offset < tokens[i]!.start) return i;
  }
  return tokens.length - 1;
}

/** §7.5: a span may not be bound across `;` `.` `and` `vs` `versus` `while` `but`. */
const CLAUSE_BREAK = /^(?:and|vs|versus|while|but)$/i;

function crossesClause(tokens: readonly Token[], from: number, to: number): boolean {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (CLAUSE_BREAK.test(token.text.replace(/[^a-z]/gi, ''))) return true;
    if (i !== hi && /[;.]$/.test(token.text)) return true;
  }
  return false;
}

/**
 * Case-folded comparison that ignores the punctuation a token happens to end a sentence with.
 *
 * Only the EDGES are trimmed. "revenue." must equal "revenue" and "Ltd," must equal "Ltd", or the
 * metric noun at the end of a sentence never matches and every honest answer that finishes with
 * its subject degrades — the false-positive failure Spike S3 exists to rule out. Interior
 * characters stay: "£52,000" keeps its symbol and its separator, and "41%" keeps the mark that
 * makes it a ratio rather than a count.
 */
function fold(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[("'\u2018\u201c]+/u, '')
    .replace(/[^\p{L}\p{N}%]+$/u, '');
}

// -----------------------------------------------------------------------------------------------
// §7.3 path–value comparison
// -----------------------------------------------------------------------------------------------

/**
 * Whether the claimed figure is the figure at the path, within the tolerance the display commits to.
 *
 * Tolerance comes from what was DISPLAYED, not from the underlying precision: "£12,900" commits to
 * whole pounds and accepts 12,900.00–12,900.49; "8.3%" commits to one decimal and accepts
 * 0.0825–0.0835. An abbreviation carries its own precision, which is why "£12.9k" is accepted for
 * £12,900 and "£0.1m" is not accepted for £120,000 — 0.1m rounds to 100,000.
 */
function valueMatches(claim: Claim, entry: AllowedEntry): boolean {
  const isPercentForm = claim.kind === 'percentage' || claim.kind === 'points';
  // "A percentage form is accepted only when `unit = 'ratio'`" (§7.3).
  if (isPercentForm && entry.unit !== 'ratio') return false;
  if (!isPercentForm && entry.unit === 'ratio' && claim.kind !== 'plain') return false;

  // A ratio quoted as a percentage is compared as value × 100 (§7.9).
  const actual = isPercentForm ? entry.value.times(100) : entry.value;

  const precision = claim.abbreviation === null
    ? (isPercentForm ? Math.max(entry.displayPrecision - 2, claim.writtenDecimals) : entry.displayPrecision)
    : claim.writtenDecimals;

  /*
   * A change is compared on MAGNITUDE and takes its sign from the direction word (§7.5); a level
   * must match literally. Comparing a change on its literal sign would reject "profit fell £3,000"
   * — the honest way to say it — while accepting "profit fell -£3,000", which reads as a rise.
   */
  const claimed = entry.fieldKind === 'change' ? claim.value.abs() : claim.value;
  const target = entry.fieldKind === 'change' ? actual.abs() : actual;

  const step = claim.abbreviation === null && precision === 0 && !isPercentForm
    ? new Decimal(1)
    : new Decimal(10).pow(-precision);
  const scale = claim.abbreviation === null
    ? new Decimal(1)
    : new Decimal(claim.abbreviation === 'k' ? 1_000 : claim.abbreviation === 'm' ? 1_000_000 : 1_000_000_000);

  // The claim names a bucket; the actual value must fall inside it.
  const tolerance = step.times(scale).dividedBy(2);
  return target.minus(claimed).abs().lessThan(tolerance.plus('0.0000001'));
}

// -----------------------------------------------------------------------------------------------
// §7.4 metric and period binding
// -----------------------------------------------------------------------------------------------

/** The words a reader would use for a metric — both registers (§8.1, ADR-037). */
function labelsFor(metricKey: string): string[] {
  const labels = METRIC_LABELS[metricKey];
  const base = metricKey.replace(/_/g, ' ');
  return [...new Set([base, labels?.plain ?? base, labels?.technical ?? base].map((l) => l.toLowerCase()))];
}

function metricNounNear(tokens: readonly Token[], claimIndex: number, metricKey: string): boolean {
  const wanted = labelsFor(metricKey).map((label) => label.split(/\s+/).map(fold));
  const lo = Math.max(0, claimIndex - PROXIMITY_TOKENS);
  const hi = Math.min(tokens.length - 1, claimIndex + PROXIMITY_TOKENS);
  for (const phrase of wanted) {
    for (let i = lo; i + phrase.length - 1 <= hi; i += 1) {
      if (phrase.every((word, k) => fold(tokens[i + k]?.text ?? '') === word)) return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------------------------
// §7.5 direction words
// -----------------------------------------------------------------------------------------------

const DIRECTION_UP = ['rose', 'up', 'increased', 'higher', 'grew', 'improved'];
const DIRECTION_DOWN = ['fell', 'down', 'decreased', 'lower', 'shrank', 'worsened'];
const DIRECTION_WORDS = new Set([...DIRECTION_UP, ...DIRECTION_DOWN]);

function directionNear(
  tokens: readonly Token[], claimIndex: number,
): { word: string; sign: 1 | -1; index: number } | null {
  const lo = Math.max(0, claimIndex - PROXIMITY_TOKENS);
  const hi = Math.min(tokens.length - 1, claimIndex + PROXIMITY_TOKENS);
  for (let i = lo; i <= hi; i += 1) {
    const word = fold(tokens[i]?.text ?? '');
    if (!DIRECTION_WORDS.has(word)) continue;
    if (crossesClause(tokens, i, claimIndex)) continue;
    return { word, sign: DIRECTION_UP.includes(word) ? 1 : -1, index: i };
  }
  return null;
}

// -----------------------------------------------------------------------------------------------
// The check
// -----------------------------------------------------------------------------------------------

function claimContextOf(context: GroundingContext): ClaimContext {
  return {
    periodLabels: [...context.periodLabels, ...context.comparisonLabels],
    entityNames: Object.values(context.entityNamesById),
    references: context.references,
  };
}

/** §7.6: the evidence ref a `NumberRef`'s row implies. */
function derivedRefOf(entry: AllowedEntry): EvidenceRef | null {
  if (entry.derivedEvidenceId === null || entry.derivedEvidenceType === null) return null;
  const type = entry.derivedEvidenceType as EvidenceRef['type'];
  return entry.derivedRevisionNo === null
    ? { type, id: entry.derivedEvidenceId }
    : { type, id: entry.derivedEvidenceId, revision_no: entry.derivedRevisionNo };
}

function refsInclude(refs: readonly EvidenceRef[], wanted: EvidenceRef): boolean {
  return refs.some((ref) => ref.type === wanted.type
    && ref.id === wanted.id
    && (wanted.revision_no === undefined || ref.revision_no === wanted.revision_no));
}

/** One statement, against the turn's facts. Returns the reason it failed, or null. */
function checkStatement(
  statement: Statement,
  context: GroundingContext,
): { reason: string | null; kind: StatementKind; derived: EvidenceRef[] } {
  const text = normalise(statement.statement);
  const tokens = tokenise(text);
  const extraction = extractClaims(statement.statement, claimContextOf(context));
  const derived: EvidenceRef[] = [];
  let kind: StatementKind = statement.kind;

  // §7.5: every tool-returned name in the sentence must appear in entity_refs with this turn's id.
  for (const span of extraction.entitySpans) {
    const named = statement.entity_refs.some(
      (ref) => fold(ref.name) === fold(span.name) && context.entityNamesById[ref.id] !== undefined,
    );
    if (!named) {
      return { reason: `names "${span.name}" without an entity_ref carrying this turn's id`, kind, derived };
    }
  }

  // §7.4: every period token in the prose must be the statement's period or a comparison label.
  for (const span of extraction.periodSpans) {
    const allowed = fold(span.label) === fold(statement.period ?? '')
      || context.comparisonLabels.some((label) => fold(label) === fold(span.label));
    if (!allowed) {
      return { reason: `mentions the period "${span.label}", which is not this statement's period`, kind, derived };
    }
  }

  if (extraction.claims.length === 0) {
    // §6.3: every kind requires evidence, including an inference and a recommendation.
    if (statement.evidence_refs.length === 0) {
      return { reason: 'has no evidence, and every kind requires evidence (§6.3)', kind, derived };
    }
    return { reason: null, kind, derived };
  }

  // A statement carrying a number must name its period (§7.4).
  if (statement.period === null) {
    return { reason: 'contains a number but names no period', kind, derived };
  }
  const statementPeriodId = context.periodIdByLabel[statement.period];
  if (statementPeriodId === undefined) {
    return { reason: `names the period "${statement.period}", which this turn does not know`, kind, derived };
  }

  const used = new Set<NumberRef>();
  for (const claim of extraction.claims) {
    const claimIndex = tokenIndexAt(tokens, claim.start);

    // §7.2: every claim needs a NumberRef, matched by the text the model quoted.
    const ref = statement.numbers.find(
      (candidate) => !used.has(candidate) && fold(candidate.text) === fold(claim.text),
    ) ?? statement.numbers.find((candidate) => !used.has(candidate));
    if (ref === undefined) {
      return { reason: `states "${claim.text}" with no NumberRef`, kind, derived };
    }
    used.add(ref);

    const entry = entryAt(context.entries, ref.tool_call_seq, ref.path);
    if (entry === null) {
      return { reason: `cites ${ref.path} of call ${ref.tool_call_seq}, which returned no such number`, kind, derived };
    }

    // §7.3
    if (!valueMatches(claim, entry)) {
      return { reason: `states "${claim.text}" but ${ref.path} is ${entry.display}`, kind, derived };
    }

    // §7.4 metric binding, server-compared
    if (ref.metric_key !== entry.metricKey) {
      return {
        reason: `attributes "${claim.text}" to ${ref.metric_key ?? 'no metric'}, but ${ref.path} is ${entry.metricKey ?? 'not a metric'}`,
        kind, derived,
      };
    }
    if (entry.metricKey !== null && !metricNounNear(tokens, claimIndex, entry.metricKey)) {
      return { reason: `states "${claim.text}" without naming ${entry.metricKey} beside it`, kind, derived };
    }

    // §7.4 period binding
    if (entry.periodIds.length > 0 && !entry.periodIds.includes(statementPeriodId)) {
      const comparison = entry.fieldKind === 'change';
      if (!comparison) {
        return { reason: `states "${claim.text}" for ${statement.period}, but ${ref.path} belongs to another period`, kind, derived };
      }
    }

    // §7.5 entity binding
    if (entry.rowEntityIds.length > 0) {
      if (ref.entity_id === null && extraction.entitySpans.length > 0) {
        return { reason: `names an entity beside "${claim.text}" without binding it`, kind, derived };
      }
      if (ref.entity_id !== null) {
        if (!entry.rowEntityIds.includes(ref.entity_id)) {
          return { reason: `attributes "${claim.text}" to an entity the row at ${ref.path} is not about`, kind, derived };
        }
        const nearest = [...extraction.entitySpans]
          .map((span) => ({ span, index: tokenIndexAt(tokens, span.start) }))
          .filter(({ index }) => Math.abs(index - claimIndex) <= PROXIMITY_TOKENS
            && !crossesClause(tokens, index, claimIndex))
          .sort((a, b) => Math.abs(a.index - claimIndex) - Math.abs(b.index - claimIndex))[0];
        if (nearest !== undefined
          && fold(nearest.span.name) !== fold(context.entityNamesById[ref.entity_id] ?? '')) {
          return { reason: `states "${claim.text}" beside ${nearest.span.name}, but cites another entity's row`, kind, derived };
        }
      }
    }

    // §7.5 direction binding
    const direction = directionNear(tokens, claimIndex);
    if (entry.fieldKind === 'change') {
      const signed = claim.value.isNegative() ? -1 : 1;
      if (direction === null && !claim.value.isNegative()) {
        return { reason: `states the change "${claim.text}" without saying which way it went`, kind, derived };
      }
      const claimedSign = direction === null ? signed : direction.sign;
      const actualSign = entry.value.isNegative() ? -1 : 1;
      if (claimedSign !== actualSign) {
        return { reason: `says ${direction?.word ?? 'negative'} for "${claim.text}", but ${ref.path} moved the other way`, kind, derived };
      }
    } else if (direction !== null) {
      /*
       * "Revenue rose to £120,000" on a LEVEL is unmatched unless the statement also cites a change
       * for the same metric — the sentence asserts a movement the cited number cannot support.
       */
      const carriesChange = statement.numbers.some((candidate) => {
        const other = entryAt(context.entries, candidate.tool_call_seq, candidate.path);
        return other !== null && other.fieldKind === 'change' && other.metricKey === entry.metricKey;
      });
      if (!carriesChange) {
        return { reason: `says "${direction.word}" beside a level value that cannot show a movement`, kind, derived };
      }
    }

    // §7.6 evidence derived from the number
    const derivedRef = derivedRefOf(entry);
    if (derivedRef !== null) {
      derived.push(derivedRef);
      if (!refsInclude(statement.evidence_refs, derivedRef)) {
        return { reason: `cites ${ref.path} without listing the ${derivedRef.type} it came from`, kind, derived };
      }
      const assurance = context.assuranceById[derivedRef.id ?? ''];
      if (assurance !== undefined) kind = weakestKind(kind, kindForAssurance(assurance));
    }
  }

  return { reason: null, kind, derived };
}

/**
 * §7.7 mode admissibility: the VALIDATOR decides which modes the turn's facts allow, not the model.
 *
 * Without this a model can answer a question it has no data for by calling it a refusal, or refuse
 * a question it could answer by calling it `no_data` — in both cases producing a response the
 * product renders as a considered decision.
 */
export function modeAdmissible(answer: SubmitAnswer, context: GroundingContext): string | null {
  const digits = /\d/;
  const statements = statementsOf(answer);

  if (answer.mode === 'clarification') {
    if (!context.periodAmbiguous) return 'clarification is only admissible when the period is ambiguous';
    if (context.toolCallCount > 0) return 'a clarification runs no tools';
    if (statements.some((s) => digits.test(s.statement.statement))) return 'a clarification carries no numbers';
    if (statements.some((s) => s.statement.entity_refs.length > 0)) return 'a clarification names no entities';
    if (!answer.direct_answer.statement.trimEnd().endsWith('?')) return 'a clarification is a single question';
    return null;
  }

  if (answer.mode === 'no_data') {
    if (!context.allToolsNoData) return 'no_data is only admissible when every tool returned no data';
    if (statements.some((s) => digits.test(s.statement.statement))) return 'a no_data answer is digit-free';
    if (statements.some((s) => s.statement.entity_refs.length > 0)) return 'a no_data answer names no entities';
    if (answer.direct_answer.evidence_refs.length === 0) return 'a no_data answer cites what it looked at';
    return null;
  }

  if (answer.mode === 'refusal') {
    if (answer.direct_answer.entity_refs.length > 0) return 'a refusal names no entities';
    if (digits.test(answer.direct_answer.statement)) return 'a refusal carries no numbers';
    return null;
  }

  // `answer` requires at least one statement the facts can carry.
  if (context.allToolsNoData && context.toolCallCount > 0) {
    return 'every tool returned no data, so an answer is not admissible';
  }
  return null;
}

/**
 * §7.2 and §5: `unsupported[].topic` is rejected if it contains any digit.
 *
 * The topics are server-generated on degradation (§7.8) precisely so a removed fabricated sentence
 * cannot reappear as a "Not covered" line carrying its figure (R2-C-04). A model-written topic is
 * held to the same rule.
 */
export function unsupportedTopicsClean(answer: SubmitAnswer): string | null {
  const offender = answer.unsupported.find((entry) => /\d/.test(entry.topic));
  return offender === undefined ? null : `"${offender.topic}" contains a digit`;
}

/** §7: the whole check. */
export function ground(answer: SubmitAnswer, context: GroundingContext): GroundingResult {
  const mismatches: Mismatch[] = [];
  const kinds: Record<string, StatementKind> = {};
  const derivedRefs: Record<string, readonly EvidenceRef[]> = {};

  for (const { path, statement } of statementsOf(answer)) {
    const { reason, kind, derived } = checkStatement(statement, context);
    kinds[path] = kind;
    derivedRefs[path] = derived;
    if (reason !== null) {
      mismatches.push({ path, statement: statement.statement, reason });
    }
  }

  return {
    status: mismatches.length === 0 ? 'passed' : 'degraded',
    mismatches,
    kinds,
    derivedRefs,
  };
}
