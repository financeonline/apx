import { describe, it, expect } from 'vitest';
import {
  NO_ALERTS_BODY, NO_ALERTS_TITLE, REASON_TEXT, SEVERITY_LABELS, SEVERITY_TONES,
  STATUS_ACTION_LABELS, UNDO_WINDOW_MS, allowedStatuses, bySeverity, familyOf, reasonText,
  severityLabel, severityTone, thresholdNoteFor, whyItMattersFor,
} from '@/components/dashboard';
import { ALERT_RULE_KEYS, type AlertSeverity } from '@/modules/alerts';

/** Presenting an alert (UX §8.3, DESIGN.md §11, RBAC §2.1). */

describe('colour means severity, and nothing else', () => {
  it('reserves the danger tone for critical and high', () => {
    expect(SEVERITY_TONES).toEqual({
      critical: 'danger', high: 'danger', medium: 'warn', low: 'neutral', info: 'neutral',
    });
  });

  it('carries a word beside every colour (§11)', () => {
    for (const severity of Object.keys(SEVERITY_TONES) as AlertSeverity[]) {
      expect(severityLabel(severity).length).toBeGreaterThan(2);
      expect(severityTone(severity)).toBeTruthy();
    }
  });

  it('never calls an info alert an alert', () => {
    expect(SEVERITY_LABELS.info).toBe('For information');
  });
});

describe('the list is ordered worst first', () => {
  it('sorts by severity, then by recency', () => {
    const alerts = [
      { id: 'a', severity: 'low' as const, lastEvaluatedAt: '2026-03-05' },
      { id: 'b', severity: 'critical' as const, lastEvaluatedAt: '2026-03-01' },
      { id: 'c', severity: 'medium' as const, lastEvaluatedAt: '2026-03-09' },
      { id: 'd', severity: 'medium' as const, lastEvaluatedAt: '2026-03-02' },
    ];
    expect(bySeverity(alerts).map((a) => a.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('does not mutate the list it was given', () => {
    const alerts = [
      { id: 'a', severity: 'low' as const, lastEvaluatedAt: '2026-03-05' },
      { id: 'b', severity: 'critical' as const, lastEvaluatedAt: '2026-03-01' },
    ];
    bySeverity(alerts);
    expect(alerts.map((a) => a.id)).toEqual(['a', 'b']);
  });
});

describe('who may change a status (RBAC §2.1)', () => {
  it('gives a client acknowledge and nothing else', () => {
    expect(allowedStatuses('client')).toEqual(['acknowledged']);
  });

  it('gives every other role all three', () => {
    for (const role of ['owner', 'admin', 'employee', 'super_admin'] as const) {
      expect(allowedStatuses(role), role).toEqual(['acknowledged', 'resolved', 'dismissed']);
    }
  });

  it('gives a suspended member nothing', () => {
    // The failure mode ADR-003 exists for: a role-name test would have let this through.
    expect(allowedStatuses('suspended_member')).toEqual([]);
  });

  it('labels every action', () => {
    for (const status of ['open', 'acknowledged', 'resolved', 'dismissed'] as const) {
      expect(STATUS_ACTION_LABELS[status].length).toBeGreaterThan(3);
    }
  });

  it('leaves eight seconds to undo (§7.4)', () => {
    expect(UNDO_WINDOW_MS).toBe(8_000);
  });
});

describe('a status the engine changed says so', () => {
  it('explains an automatic resolution in the reader’s words', () => {
    expect(reasonText('condition_cleared')).toBe('Resolved automatically — this is no longer happening.');
    expect(reasonText('condition_returned')).toBe('This came back after being resolved.');
    expect(reasonText('severity_increased')).toBe('Re-opened because it got worse.');
  });

  it('says nothing extra when a person did it', () => {
    expect(reasonText('user')).toBeNull();
  });

  it('explains every reason code the database can hold', () => {
    for (const code of ['user', 'condition_cleared', 'record_removed', 'rule_retired',
      'severity_increased', 'condition_returned']) {
      expect(REASON_TEXT[code], code).toBeDefined();
    }
  });
});

describe('grouping and tooltips', () => {
  it('names the §8.2 family of every rule', () => {
    for (const ruleKey of ALERT_RULE_KEYS) {
      expect(familyOf(ruleKey), ruleKey).not.toBe('Other');
    }
    expect(familyOf('something.invented')).toBe('Other');
  });

  it('renders the threshold note from the stored figures', () => {
    expect(thresholdNoteFor('concentration.customer', {}, 'GBP'))
      .toBe('We flag a single customer at 35% of revenue, and 50% as high.');
    expect(thresholdNoteFor('something.invented', {}, 'GBP')).toBeNull();
  });

  it('re-renders "why it matters" from the stored figures, never from the prose', () => {
    const why = whyItMattersFor('expense.spike_category', { value: '2900' }, 'GBP');
    expect(why).toContain('£2,900');
    expect(whyItMattersFor('something.invented', {}, 'GBP')).toBeNull();
  });
});

describe('an empty list is good news, and reads like it', () => {
  it('does not say "no results"', () => {
    expect(NO_ALERTS_TITLE).toBe('Nothing needs your attention');
    expect(NO_ALERTS_BODY).toContain('seventeen');
  });
});
