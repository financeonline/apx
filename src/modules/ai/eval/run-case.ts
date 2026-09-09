import { statementsOf, type ResponseMode, type SubmitAnswer } from '../domain/contract';
import { ground, type GroundingStatus, type Mismatch } from '../domain/grounding';
import { resolvePeriodContext } from '../domain/periods';
import { applyKinds, buildGroundingContext, DEGRADED_DIRECT_ANSWER, degrade } from '../domain/turn-context';
import { judge, validate } from '../domain/verdict';
import type { CaseResult, EvalCase } from './types';

/**
 * Runs one recorded case through the server's own judgement, in the order the loop takes
 * (`services/answer.ts`, AI_ARCHITECTURE.md §2 steps 8–9): validate, judge; on refusal, the
 * recorded regeneration (or the same submission again); then the final ground → kinds → degrade.
 * The functions are the loop's — `validate`, `judge`, `ground`, `degrade` — never re-implemented.
 */
export function runRecordedCase(evalCase: EvalCase): CaseResult {
  const periodContext = resolvePeriodContext({
    question: evalCase.question, periods: evalCase.periods, fiscalYearStartMonth: evalCase.fiscalYearStartMonth,
  });
  const results = evalCase.toolCalls.map((call) => call.result);
  const context = buildGroundingContext({ periodContext, results });

  let candidate = validate(evalCase.submission);
  let verdict = candidate.ok ? judge(candidate.answer, context) : candidate;
  const firstPassOk = verdict.ok;
  const firstPassReasons = verdict.ok ? [] : verdict.reasons;

  let outcome: GroundingStatus;
  let final: SubmitAnswer | null = null;
  let removed: readonly Mismatch[] = [];

  if (!verdict.ok) {
    candidate = validate(evalCase.regenerated ?? evalCase.submission);
    verdict = candidate.ok ? judge(candidate.answer, context) : candidate;
  }

  if (!candidate.ok || (!verdict.ok && verdict.kind !== 'grounding')) {
    outcome = 'failed';
  } else if (candidate.answer.mode !== 'answer') {
    outcome = 'not_applicable';
    final = applyKinds(candidate.answer, {});
  } else {
    const result = ground(candidate.answer, context);
    final = applyKinds(candidate.answer, result.kinds);
    outcome = result.status;
    if (result.status !== 'passed') {
      const degraded = degrade(final, result, context);
      final = degraded.answer;
      removed = degraded.removed;
      outcome = 'degraded';
    }
  }

  // The server's own replacement sentence (§7.8) is not a claim the model made: it is neither a
  // statement to cover nor a citation to count.
  const statements = (final ? statementsOf(final) : []).filter((s) => s.statement.statement !== DEGRADED_DIRECT_ANSWER);
  const cited = statements.filter((s) => s.statement.evidence_refs.length > 0).length;
  const mode: ResponseMode | null = final?.mode ?? null;
  const resolvedPeriod = periodContext.resolved[0]?.label ?? periodContext.default?.label ?? null;
  const text = final ? JSON.stringify(final) : '';

  const failures: string[] = [];
  const expect = evalCase.expect;
  if (outcome !== expect.outcome) failures.push(`outcome ${outcome}, expected ${expect.outcome}`);
  if (expect.mode !== undefined && mode !== expect.mode) failures.push(`mode ${mode}, expected ${expect.mode}`);
  if (expect.firstPass !== undefined && firstPassOk !== expect.firstPass) {
    failures.push(expect.firstPass
      ? `first pass refused: ${firstPassReasons.join('; ')}`
      : 'first pass accepted a submission that must fail (R2-C)');
  }
  if (expect.metricKeys) {
    const called = new Set(evalCase.toolCalls.map((c) => (c.input as { metric_key?: string })?.metric_key).filter(Boolean));
    for (const key of expect.metricKeys) if (!called.has(key)) failures.push(`metric ${key} was not called`);
  }
  if (expect.resolvedPeriod !== undefined && resolvedPeriod !== expect.resolvedPeriod) {
    failures.push(`period resolved to ${resolvedPeriod}, expected ${expect.resolvedPeriod}`);
  }
  for (const n of expect.numbers ?? []) if (!text.includes(n)) failures.push(`${n} is missing from the final answer`);
  for (const a of expect.absent ?? []) if (text.includes(a)) failures.push(`"${a}" survived into the final answer`);
  if (expect.refusalOpening !== undefined && !(final?.direct_answer.statement ?? '').startsWith(expect.refusalOpening)) {
    failures.push('the refusal does not open with the fixed template');
  }
  if (expect.reason !== undefined && !firstPassReasons.some((r) => r.includes(expect.reason!))) {
    failures.push(`no first-pass reason mentions "${expect.reason}" (got: ${firstPassReasons.join('; ') || 'none'})`);
  }
  // §12 golden rule: every statement of an ANSWER cites evidence; §7.8: removed text never survives.
  // A refusal or clarification carries no facts to cite (§7.7).
  if (final && final.mode === 'answer' && expect.outcome !== 'failed') {
    for (const s of statements) {
      if (s.statement.evidence_refs.length === 0) failures.push(`${s.path} has no evidence ref`);
    }
    for (const m of removed) if (text.includes(m.statement)) failures.push(`removed text reappeared: ${m.statement}`);
  }

  return {
    id: evalCase.id, set: evalCase.set, category: evalCase.category,
    ok: failures.length === 0, failures, outcome, mode, firstPassOk, firstPassReasons,
    statements: statements.length, cited, toolCalls: evalCase.toolCalls.length, resolvedPeriod,
  };
}
