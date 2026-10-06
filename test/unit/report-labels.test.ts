import { describe, expect, it } from 'vitest';
import { DIMENSION_LABELS, EXCLUSION_TEXT } from '@/components/dashboard/health-presentation';
import { REPORT_DIMENSION_LABELS, REPORT_EXCLUSION_TEXT, windowLabel } from '@/modules/reporting';

/** Phase 17: the composed reports and the Health panel must name things the same way. */
describe('report labels', () => {
  it('names every health dimension exactly as the Health panel does', () => {
    expect(REPORT_DIMENSION_LABELS).toEqual(DIMENSION_LABELS);
  });

  it('gives every exclusion reason exactly the Health panel\'s words', () => {
    expect(REPORT_EXCLUSION_TEXT).toEqual(EXCLUSION_TEXT);
  });

  it('writes a day and a week the way a reader expects', () => {
    expect(windowLabel('2026-09-07', '2026-09-07')).toBe('Monday 7 September 2026');
    expect(windowLabel('2026-09-07', '2026-09-13')).toBe('7–13 September 2026');
    expect(windowLabel('2026-09-28', '2026-10-04')).toBe('28 September – 4 October 2026');
  });
});

describe('the Custom AI Report speaks as the analyst does', async () => {
  const analyst = await import('@/components/dashboard/analyst-presentation');
  const labels = await import('@/modules/reporting');

  it('uses the analyst\'s statement kinds, section titles, notes and reasons', () => {
    expect(labels.STATEMENT_KIND_LABELS).toEqual(analyst.KIND_LABELS);
    expect(labels.ANSWER_SECTION_TITLES).toEqual(analyst.SECTION_TITLES);
    expect(labels.NOTE_TEXT).toEqual(analyst.DATA_QUALITY_NOTE_TEXT);
    expect(labels.UNSUPPORTED_TEXT).toEqual(analyst.UNSUPPORTED_REASON_TEXT);
    expect(labels.DEGRADED_TEXT).toBe(analyst.DEGRADED_BANNER);
    expect(labels.REPORT_PRIORITY_LABELS).toEqual(analyst.PRIORITY_LABELS);
  });
});
