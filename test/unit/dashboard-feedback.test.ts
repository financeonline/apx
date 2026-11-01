import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/core/errors';
import {
  FEEDBACK_DEPARTMENT_LABELS, FEEDBACK_SECTIONS, FEEDBACK_SECTION_LABELS, feedbackDepartmentLabel, feedbackSectionLabel,
  parseDashboardFeedback,
} from '@/modules/feedback';

/** "Give feedback" on the department dashboard (docs/DEPARTMENT_DASHBOARD_PLAN.md). */

const pathsOf = (input: unknown): string[] => {
  try {
    parseDashboardFeedback(input);
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).issues.map((i) => i.path);
  }
  throw new Error('expected a ValidationError');
};

/** Reads a `const NAME = [ 'a', 'b', … ] as const` list out of the database function's source. */
function listInSource(file: string, name: string): string[] {
  const source = readFileSync(file, 'utf8');
  const m = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(source);
  if (!m) throw new Error(`${name} not found in ${file}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('the feedback sections', () => {
  it('are the prototype’s 17 sections, in its order, with its labels', () => {
    expect(FEEDBACK_SECTIONS).toEqual([
      'branding', 'departments', 'metrics', 'performance', 'composition', 'perspective', 'priorities',
      'workspace', 'report-summary', 'growth', 'clients', 'industry', 'systems', 'apax', 'targets',
      'marketing', 'templates',
    ]);
    expect(FEEDBACK_SECTION_LABELS.metrics).toBe('03 · Financial metrics');
    expect(FEEDBACK_SECTION_LABELS.templates).toBe('17 · Reports & Pitch Decks');
    FEEDBACK_SECTIONS.forEach((key, i) => {
      expect(FEEDBACK_SECTION_LABELS[key].startsWith(String(i + 1).padStart(2, '0'))).toBe(true);
    });
  });

  it('are exactly the keys the database function accepts, and so are the departments', () => {
    expect(listInSource('src/db/api/dashboard.ts', 'FEEDBACK_SECTIONS')).toEqual(FEEDBACK_SECTIONS);
    expect(listInSource('src/db/api/dashboard.ts', 'FEEDBACK_DEPARTMENTS')).toEqual(Object.keys(FEEDBACK_DEPARTMENT_LABELS));
  });

  it('label an unknown key as itself and a missing department as a dash', () => {
    expect(feedbackSectionLabel('growth')).toBe('10 · How can I Grow');
    expect(feedbackSectionLabel('gone')).toBe('gone');
    expect(feedbackDepartmentLabel('capture')).toBe('Data Capture');
    expect(feedbackDepartmentLabel(null)).toBe('—');
  });
});

describe('a feedback note', () => {
  const valid = { section: 'metrics', department: 'analysis', notes: '  Make the operating profit larger.  ', context: { period: 'Apr – Sep 2026', view: 'current' } };

  it('is accepted and trimmed', () => {
    expect(parseDashboardFeedback(valid)).toEqual({
      section: 'metrics', department: 'analysis', notes: 'Make the operating profit larger.',
      context: { period: 'Apr – Sep 2026', view: 'current' },
    });
  });

  it('may leave out the department and the context', () => {
    expect(parseDashboardFeedback({ section: 'branding', notes: 'Bigger logo' })).toEqual({
      section: 'branding', department: null, notes: 'Bigger logo', context: {},
    });
  });

  it('needs a known section and department', () => {
    expect(pathsOf({ ...valid, section: 'footer' })).toEqual(['section']);
    expect(pathsOf({ ...valid, department: 'tax' })).toEqual(['department']);
  });

  it('needs notes, at most 4,000 characters', () => {
    expect(pathsOf({ ...valid, notes: '   ' })).toEqual(['notes']);
    expect(pathsOf({ ...valid, notes: 'x'.repeat(4001) })).toEqual(['notes']);
    expect(parseDashboardFeedback({ ...valid, notes: 'x'.repeat(4000) }).notes).toHaveLength(4000);
  });

  it('keeps the context to short known strings', () => {
    expect(pathsOf({ ...valid, context: { period: 'x'.repeat(201) } })).toEqual(['context.period']);
    expect(pathsOf({ ...valid, context: { secret: 'x' } })).toEqual(['context']);
    expect(pathsOf({ ...valid, context: { view: 3 } })).toEqual(['context.view']);
  });
});
