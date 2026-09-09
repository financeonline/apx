import { SubmitAnswerSchema, type SubmitAnswer } from './contract';
import { ground, modeAdmissible, unsupportedTopicsClean, type GroundingContext } from './grounding';

/**
 * Validation and judgement (AI_ARCHITECTURE.md §5, §7.7), pure and in one place.
 *
 * The loop (`services/answer.ts`) and the evaluation harness (`eval/`) must reach the same verdict
 * on the same submission, or the harness measures something the product does not do. So neither
 * has its own copy: this is the one implementation, and it touches nothing but the submission and
 * this turn's grounding context.
 */

export type Candidate =
  | { readonly ok: true; readonly answer: SubmitAnswer }
  | { readonly ok: false; readonly kind: 'schema'; readonly reasons: readonly string[] };

/** §5: the contract, then the one rule the schema cannot express — a digit-free `unsupported`. */
export function validate(submission: unknown): Candidate {
  const parsed = SubmitAnswerSchema.safeParse(submission);
  if (!parsed.success) {
    return {
      ok: false, kind: 'schema',
      reasons: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`),
    };
  }
  const digits = unsupportedTopicsClean(parsed.data);
  if (digits) return { ok: false, kind: 'schema', reasons: [`unsupported: ${digits}`] };
  return { ok: true, answer: parsed.data };
}

export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'mode' | 'grounding' | 'schema'; readonly reasons: readonly string[] };

/** §7.7 then §7: the server decides the mode, then grounds an `answer`. */
export function judge(candidate: SubmitAnswer, context: GroundingContext): Verdict {
  const inadmissible = modeAdmissible(candidate, context);
  if (inadmissible) return { ok: false, kind: 'mode', reasons: [`mode: ${inadmissible}`] };
  if (candidate.mode !== 'answer') return { ok: true };
  const result = ground(candidate, context);
  if (result.status === 'passed') return { ok: true };
  return { ok: false, kind: 'grounding', reasons: result.mismatches.map((m) => `"${m.statement}": ${m.reason}`) };
}
