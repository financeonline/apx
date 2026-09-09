import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_CASES, PROMPT_VERSION, runRecordedCase, shortfalls, summarise, type EvalReport } from '@/modules/ai';
import { buildCorpus, loadRecording } from '../fixtures/ai/corpus';

/**
 * The recorded evaluation run (AI_ARCHITECTURE.md §12; TEST_STRATEGY.md §10.3, "Recorded AI").
 *
 * Every case runs through the server's own validate → judge → ground → degrade, with no model and
 * no database. The run fails when any case misses its expectation, when a set is smaller than §12
 * requires, when a §10.3 rate is below target, or when the recording was made under a different
 * prompt version — a prompt change invalidates the recording and forces a live run before merge.
 * The report is written to `test-results/ai-eval.json` for the CI artefact.
 */

describe('the recorded eval corpus', () => {
  const recording = loadRecording();
  const cases = buildCorpus(recording);
  const startedAt = Date.now();
  const results = cases.map(runRecordedCase);
  const metrics = summarise(results);
  const counts = { golden: 0, adversarial: 0, trap: 0 };
  for (const c of cases) counts[c.set] += 1;

  const report: EvalReport = {
    promptVersion: PROMPT_VERSION, model: null, mode: 'recorded',
    startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, metrics, results,
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/ai-eval.json', `${JSON.stringify(report, null, 2)}\n`);

  it('was recorded under the current prompt version', () => {
    expect(recording.promptVersion, 'the recording is stale: re-record with RECORD_AI_EVAL=1 after a live run').toBe(PROMPT_VERSION);
  });

  it(`has at least ${MIN_CASES.golden} golden, ${MIN_CASES.adversarial} adversarial and ${MIN_CASES.trap} trap cases`, () => {
    expect(counts.golden).toBeGreaterThanOrEqual(MIN_CASES.golden);
    expect(counts.adversarial).toBeGreaterThanOrEqual(MIN_CASES.adversarial);
    expect(counts.trap).toBeGreaterThanOrEqual(MIN_CASES.trap);
  });

  for (const result of results) {
    it(`${result.id} — ${result.category}`, () => {
      expect(result.failures, result.failures.join(' | ')).toEqual([]);
    });
  }

  it('meets the §10.3 targets', () => {
    expect(shortfalls(metrics, counts)).toEqual([]);
  });
});
