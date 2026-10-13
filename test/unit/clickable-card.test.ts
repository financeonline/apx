import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ABOVE_CARD_LINK, CARD_GLOW, CARD_LINK_STRETCH, CLICKABLE_CARD, CLICKABLE_ROW, CardLink, TOUCH_TARGET,
} from '@/components/ui/clickable-card';
import { DepartmentCard } from '@/components/dashboard/department-card';
import { MetricCard } from '@/components/dashboard/metric-card';
import { AlertCard } from '@/components/dashboard/alert-card';
import { ActionCard } from '@/components/dashboard/action-card';
import { HealthScoreCard } from '@/components/dashboard/health-score-card';
import type { AlertView, MetricCardView } from '@/modules/dashboard';
import type { Action } from '@/modules/actions';
import type { HealthCardView } from '@/modules/health';

/**
 * Whole-card links (owner, 2026-10-14; `components/ui/clickable-card.tsx`).
 *
 * The rules worth protecting are structural, so they are checked on the rendered markup rather than
 * by eye: a clickable card has exactly ONE link stretched over it (assistive technology meets one
 * link per card, named as before), nothing interactive is nested inside that link, and every other
 * link, button or field in the card sits above the stretched layer — otherwise the layer swallows
 * its clicks. No DOM library is installed; the markup is walked as tags, which is all these
 * questions need.
 */

const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'col', 'area', 'wbr']);

interface Found {
  readonly tag: string;
  readonly text: string;
  readonly stretched: boolean;
  readonly raised: boolean;
  readonly insideLink: boolean;
}

/** Every interactive element in the markup, with whether it stretches, is raised, or sits in a link. */
function interactive(html: string): Found[] {
  const found: Array<Found & { index: number }> = [];
  const stack: Array<{ tag: string; raised: boolean; link: boolean }> = [];
  const tags = /<(\/?)([a-z][a-z0-9-]*)([^>]*)>/g;
  for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
    const [, closing, tag, attributes] = match;
    if (closing) {
      while (stack.length > 0 && stack.pop()!.tag !== tag) { /* unwind to the matching open tag */ }
      continue;
    }
    const classes = /class="([^"]*)"/.exec(attributes!)?.[1]?.split(/\s+/) ?? [];
    const raised = classes.includes('z-10') || stack.some((open) => open.raised);
    if (INTERACTIVE.has(tag!)) {
      found.push({
        tag: tag!,
        text: '',
        index: match.index + match[0].length,
        stretched: classes.includes('after:absolute'),
        raised,
        insideLink: stack.some((open) => open.link),
      });
    }
    if (!VOID.has(tag!) && !attributes!.trimEnd().endsWith('/')) {
      stack.push({ tag: tag!, raised: classes.includes('z-10') || stack.some((open) => open.raised), link: tag === 'a' });
    }
  }
  return found.map(({ index, ...rest }) => ({ ...rest, text: html.slice(index, index + 60).replace(/<[^>]*>/g, '') }));
}

function expectOneCardLink(element: ReactElement): Found {
  const html = renderToStaticMarkup(element);
  const all = interactive(html);
  const stretched = all.filter((f) => f.stretched);
  expect(stretched, 'exactly one link stretched over the card').toHaveLength(1);
  expect(stretched[0]!.tag).toBe('a');
  for (const other of all.filter((f) => !f.stretched)) {
    expect(other.raised, `"${other.text}" (${other.tag}) must sit above the card's link`).toBe(true);
  }
  expect(all.some((f) => f.insideLink), 'nothing interactive inside the link').toBe(false);
  // The card itself is the box the layer fills.
  expect(html).toMatch(/class="[^"]*\brelative\b[^"]*"/);
  return stretched[0]!;
}

function expectNoCardLink(element: ReactElement): void {
  const all = interactive(renderToStaticMarkup(element));
  expect(all.filter((f) => f.stretched)).toHaveLength(0);
}

const period = { id: 'p-may', label: 'May 2026', periodStart: '2026-05-01', periodEnd: '2026-05-31', isComplete: true };

const metric: MetricCardView = {
  metricKey: 'revenue', label: 'Sales', technicalLabel: 'Revenue', value: '£45,200', rawValue: '45200.00',
  secondaryLine: null, change: null, basisText: 'From invoices', period,
  status: { kind: 'estimate', label: 'Estimate', tooltip: 'Worked out from part of the month.' },
  whyHref: '/app/o/evidence?metric=revenue&period=p-may',
};

const alert: AlertView = {
  id: 'a1', ruleKey: 'cash_runway', family: 'Cash', severity: 'high', status: 'open', statusReasonCode: 'new',
  title: 'Cash runway is under two months', whatHappened: 'Cash covers seven weeks of spending.',
  whyItMatters: null, whatYouCanDo: null, thresholdNote: 'Fires under two months.', periodLabel: 'May 2026',
  firstSeenLabel: '1 May 2026', recurring: false, evidenceHref: '/app/o/evidence/b1', actionId: null,
  detailHref: '/app/o/insights/alerts/a1',
};

const action: Action = {
  id: 'x1', title: 'Chase the two largest unpaid invoices', issue: 'Two invoices are 60 days late.',
  recommendation: null, priority: 'high', ownerUserId: 'u1', ownerName: 'Sam', dueDate: '2026-06-01',
  status: 'open', sourceType: 'alert', sourceId: 'a1', evidenceBundleId: null, outcomeNotes: null,
  outcomeValue: null, outcomeCurrency: null, completedAt: null, dismissedReason: null, createdAt: '2026-05-20',
};

const health: HealthCardView = {
  periodId: 'p-may', score: 64, band: 'stable', changeVsPrevious: 3, dimensionsUsed: 6, dimensionsTotal: 8,
  capped: false, configVersion: 'v5', breakdown: [], updatedAt: '2026-06-01', evidenceBundleId: null,
};

const button = (label: string) => createElement('button', { type: 'button' }, label);

describe('the shared pieces', () => {
  it('stretches the one link over its card and keeps its words and name', () => {
    const html = renderToStaticMarkup(createElement(CardLink, { href: '/a', 'aria-label': 'Open Banking' }, 'Open'));
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).toMatch(/^<a [^>]*aria-label="Open Banking"[^>]*href="\/a"[^>]*>Open<\/a>$/);
    for (const utility of ['after:absolute', 'after:inset-0', 'after:rounded-card', 'outline-none']) {
      expect(html).toContain(utility);
    }
  });

  it('lets a card with other corners give the layer its own', () => {
    const html = renderToStaticMarkup(createElement(CardLink, { href: '/a', className: 'after:rounded-2xl' }, 'Go'));
    expect(html).toContain('after:rounded-2xl');
    expect(html).not.toContain('after:rounded-card');
  });

  it('makes the card the layer\'s box and raises everything else above it', () => {
    expect(CLICKABLE_CARD.split(' ')).toEqual(expect.arrayContaining(['group', 'relative']));
    expect(CLICKABLE_ROW.split(' ')).toEqual(expect.arrayContaining(['group', 'relative']));
    expect(CARD_LINK_STRETCH.split(' ')).toEqual(expect.arrayContaining(['after:absolute', 'after:inset-0']));
    expect(ABOVE_CARD_LINK).toBe('relative z-10');
  });

  it('shows keyboard focus on the card, since the link draws no outline of its own', () => {
    expect(CARD_LINK_STRETCH).toContain('outline-none');
    expect(CARD_GLOW).toMatch(/focus-within:/);
  });

  it('gives a small pill a 40px target on a touch screen only', () => {
    expect(TOUCH_TARGET).toBe('pointer-coarse:min-h-10');
  });

  it('never hard-codes a hex colour (DESIGN.md)', () => {
    for (const classes of [CARD_GLOW, CLICKABLE_CARD, CLICKABLE_ROW, CARD_LINK_STRETCH, ABOVE_CARD_LINK, TOUCH_TARGET]) {
      expect(classes).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });
});

describe('every card that opens something opens it from anywhere on the card', () => {
  it('a department card: "Open" is its one link; the pills keep their own', () => {
    const link = expectOneCardLink(createElement(DepartmentCard, {
      title: 'Banking', href: '/app/o/money/banking', icon: null, tint: 'pink', description: ['Accounts'],
      pills: [{ label: 'Transactions', href: '/app/o/money/banking/transactions' }],
      status: { tone: 'good', label: 'In order' },
    }));
    expect(link.text).toContain('Open');
  });

  it('a figure: "Why?" is its one link, still named for the figure; the badge keeps its tooltip', () => {
    const html = renderToStaticMarkup(createElement(MetricCard, { card: metric }));
    const link = expectOneCardLink(createElement(MetricCard, { card: metric }));
    expect(link.text).toContain('Why?');
    expect(html).toContain('See the evidence behind Sales for May 2026');
    expect(html).toMatch(/class="relative z-10"><span class="inline-flex[^"]*" title="Worked out from part of the month\."/);
  });

  it('an alert: its own page is the card\'s link; "Why?" and the status controls sit above it', () => {
    const link = expectOneCardLink(createElement(AlertCard, { alert, actions: button('Mark as seen') }));
    expect(link.text).toContain('History');
  });

  it('an alert on its own page is not a link to itself', () => {
    expectNoCardLink(createElement(AlertCard, { alert, linked: false, actions: button('Mark as seen') }));
  });

  it('an action: its title is the card\'s link; the status controls sit above it', () => {
    const link = expectOneCardLink(createElement(ActionCard, {
      action, href: '/app/o/actions/x1', today: '2026-05-25', viewerUserId: 'u1',
    }, button('Mark as done')));
    expect(link.text).toContain('Chase the two largest unpaid invoices');
  });

  it('the health score opens its breakdown when it has one, and is a plain card when not', () => {
    const link = expectOneCardLink(createElement(HealthScoreCard, {
      view: health, periodLabel: 'May 2026', comparisonLabel: 'April 2026', explainHref: '/app/o/home/health',
    }));
    expect(link.text).toContain('What makes up this score?');
    expectNoCardLink(createElement(HealthScoreCard, { view: health, periodLabel: 'May 2026', comparisonLabel: null }));
  });
});
