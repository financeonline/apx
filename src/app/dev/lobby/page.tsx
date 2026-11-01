import { notFound } from 'next/navigation';
import {
  Bell, ChartColumn, ClipboardCheck, FileText, HeartPulse, Landmark, ListChecks, MessageCircleQuestion, Sparkles, TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import type { AlertView } from '@/modules/dashboard';
import type { HealthCardView } from '@/modules/health';
import type { Action } from '@/modules/actions';
import { AppShell } from '@/components/dashboard/app-shell';
import { TrendChart } from '@/components/dashboard';
import { ButtonLink } from '@/components/ui/button';
import {
  ActionQueue, ArrowLink, BandHeading, Chip, DepartmentStrip, HealthRing, LobbyCanvas, LobbyFigure, LobbyFooter,
  LobbyHero, LobbyPanel, NextMovePanel, RiskPoints, type LobbyDepartment, type NextMove,
} from '@/components/dashboard/lobby';
import { CARDS, TREND_ARIA_SUMMARY, TREND_SERIES } from '../components/fixtures';

/**
 * The lobby fixture page (ADR-179): the company masthead and Home's arrangement from fixed data, so
 * the look can be checked against the owner's reference without a database. Every link points at a
 * real route shape; nothing here reads or writes data.
 *
 * NOT A PRODUCTION ROUTE. It refuses to exist outside development, as `/dev/components` does.
 */
export const dynamic = 'force-dynamic';

const BASE = '/app/sample';

const RISKS: AlertView[] = [
  {
    id: 'r1', ruleKey: 'sales_drop', family: 'Sales', severity: 'high', status: 'open', statusReasonCode: 'new',
    title: 'Sales fell 11% on last month', whatHappened: 'Sales were £118,400 in September against £133,100 in August. Most of the fall came from two customers.',
    whyItMatters: null, whatYouCanDo: 'Strengthen sales outside the peak quarter.', thresholdNote: 'A fall of 10% or more',
    periodLabel: 'Sep 2026', firstSeenLabel: 'Sep 2026', recurring: false, evidenceHref: `${BASE}/evidence/x`, actionId: null, detailHref: `${BASE}/insights/r1`,
  },
  {
    id: 'r2', ruleKey: 'margin', family: 'Profit', severity: 'medium', status: 'open', statusReasonCode: 'new',
    title: 'Gross margin down 7.6 points', whatHappened: 'Direct costs rose faster than sales, narrowing the margin to 40.5%.',
    whyItMatters: null, whatYouCanDo: 'Review product margins, pricing and freight costs.', thresholdNote: null,
    periodLabel: 'Sep 2026', firstSeenLabel: 'Aug 2026', recurring: true, evidenceHref: null, actionId: null, detailHref: `${BASE}/insights/r2`,
  },
  {
    id: 'r3', ruleKey: 'costs', family: 'Costs', severity: 'low', status: 'open', statusReasonCode: 'new',
    title: 'Software costs repeat across two suppliers', whatHappened: 'Two monthly subscriptions look like the same service, at £640 together.',
    whyItMatters: 'Small overlaps add up over a year.', whatYouCanDo: null, thresholdNote: null,
    periodLabel: 'Sep 2026', firstSeenLabel: 'Sep 2026', recurring: false, evidenceHref: null, actionId: null, detailHref: `${BASE}/insights/r3`,
  },
];

const HEALTH: HealthCardView = {
  periodId: 'p9', score: 68, band: 'stable', changeVsPrevious: -3, dimensionsUsed: 5, dimensionsTotal: 6, capped: false,
  configVersion: 'v1', breakdown: [], updatedAt: '2026-10-02T09:00:00Z', evidenceBundleId: null,
};

const action = (id: string, title: string, priority: Action['priority'], status: Action['status'], dueDate: string | null): Action => ({
  id, title, issue: null, recommendation: null, priority, ownerUserId: null, ownerName: 'Carl', dueDate, status,
  sourceType: 'alert', sourceId: null, evidenceBundleId: null, outcomeNotes: null, outcomeValue: null, outcomeCurrency: null,
  completedAt: null, dismissedReason: null, createdAt: '2026-10-01T09:00:00Z',
});
const ACTIONS: Action[] = [
  action('a1', 'Review project margin movement', 'high', 'open', '2026-10-20'),
  action('a2', 'Investigate recurring software costs', 'medium', 'in_progress', '2026-11-20'),
  action('a3', 'September management pack ready', 'low', 'open', null),
];

export default function DevLobbyPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  const departments: LobbyDepartment[] = [
    { key: 'analysis', title: 'Financial Analysis', line: 'Understand performance', href: `${BASE}/home`, icon: <ChartColumn /> },
    { key: 'banking', title: 'Banking', line: 'Control cash & funding', href: `${BASE}/money/banking`, icon: <Landmark /> },
    { key: 'data', title: 'Data Capture', line: 'Build reliable foundations', href: `${BASE}/data/imports`, icon: <FileText /> },
    { key: 'actions', title: 'Manage Workflow', line: 'Assign, track & review', href: `${BASE}/actions`, icon: <ListChecks /> },
  ];
  const moves: NextMove[] = [
    { key: 'workflow', eyebrow: 'Improve the way you work', title: 'Manage Systems and Workflow.', line: 'Assign, track and review what needs doing, with the evidence behind each step.', href: `${BASE}/actions`, cta: 'Open the Action Centre', icon: <ListChecks /> },
    { key: 'insights', eyebrow: 'An APX perspective', title: 'AI Insights.', line: 'What moved this month and why, read from the figures APX calculated.', href: `${BASE}/insights`, cta: 'Open Insights', icon: <Sparkles /> },
    { key: 'notifications', eyebrow: 'Set · Track · Improve', title: 'Monthly Notifications.', line: 'Your inbox: alerts, answers to your requests and updates from your adviser.', href: `${BASE}/notifications`, cta: 'Open notifications', icon: <Bell /> },
    { key: 'reports', eyebrow: 'Reports & packs', title: 'Analyse your Reports.', line: 'Monthly management reports, ready to read on screen or download.', href: `${BASE}/reports`, cta: 'Open Reports', icon: <FileText /> },
  ];
  const seriesFor = new Map(TREND_SERIES.map((one) => [one.key, one]));
  return (
    <AppShell
      homeHref={`${BASE}/home`}
      groups={[{ label: 'Sections', links: [{ label: 'Home', href: `${BASE}/home`, icon: 'home' }] }]}
      user={{ name: 'Carl Sample', role: 'Owner', href: '/account' }}
      look="light"
      headerActions={<Link href={`${BASE}/notifications`} aria-label="Notifications" className="flex size-[2.0625rem] items-center justify-center rounded-full text-ink-muted hover:bg-accent-soft hover:text-accent"><Bell aria-hidden="true" className="size-[1.1875rem]" strokeWidth={1.6} /></Link>}
    >
      <LobbyCanvas>
        <DepartmentStrip departments={departments} currentKey="analysis" showMore />
        <LobbyHero section="Financial Analysis" greeting="Welcome back, Carl. Your business, in perspective." orgName="Sample Catering" orgLine="Sep 2026 · GBP" />
        <section aria-labelledby="lobby-performance" className="mt-6">
          <BandHeading id="lobby-performance" number="01" eyebrow="Understand your performance" title="Financial Analysis"
            end={<><Chip>Sep 2026</Chip><ArrowLink href={`${BASE}/money`}>All figures</ArrowLink><ArrowLink href={`${BASE}/reports`}>Reports</ArrowLink></>} />
          <p className="mt-3 text-[0.6875rem] text-ink-muted">Figures to 30 Sep 2026 · calculated 2 Oct 2026</p>
          <ul className="mt-5 grid gap-[1.125rem] md:grid-cols-3">
            {CARDS.slice(0, 3).map((card) => (
              <li key={card.metricKey} className="min-w-0"><LobbyFigure card={card} trend={seriesFor.get(card.metricKey) ?? TREND_SERIES[0] ?? null} showWhy /></li>
            ))}
          </ul>
          <div className="mt-5"><RiskPoints risks={RISKS} allHref={`${BASE}/insights`} periodLabel="Sep 2026" /></div>
        </section>
        <section aria-label="Performance over time" className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1.8fr)_minmax(19.375rem,1fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <LobbyPanel id="lobby-trend" eyebrow="Performance over time" title="Sales, profit & cash" end={<span className="text-[0.6875rem] text-ink-muted">Oct 2025 – Sep 2026</span>}>
              <TrendChart series={TREND_SERIES} ariaSummary={TREND_ARIA_SUMMARY} tableFallbackId="dev-lobby-trend" />
            </LobbyPanel>
            <LobbyPanel id="lobby-perspective" tone="tinted" serif eyebrow="APX perspective" title="Sep 2026, in a sentence." end={<Sparkles aria-hidden="true" className="size-[1.0625rem] text-accent" />}>
              <p className="text-[0.75rem] leading-[1.8] text-ink-muted">Sales fell in September while costs held, so profit narrowed; cash is still up on the year.</p>
              <ArrowLink href={`${BASE}/insights`} className="mt-3">Explore the insights</ArrowLink>
            </LobbyPanel>
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <LobbyPanel id="lobby-health" eyebrow="The bigger picture" title="Business health" end={<HeartPulse aria-hidden="true" className="size-[1.0625rem] text-[#aa92a2]" />}>
              <HealthRing view={HEALTH} comparisonLabel="Aug 2026" explainHref={`${BASE}/home/health`} />
            </LobbyPanel>
            <LobbyPanel id="lobby-scenario" tone="growth" serif eyebrow="Turn insight into opportunity" title={<>How could things change<span className="text-accent">?</span></>} end={<TrendingUp aria-hidden="true" className="size-[1.0625rem] text-accent" />}>
              <p className="text-[0.75rem] leading-[1.8] text-ink-muted">Change sales, costs or hiring and see how the outlook moves — your recorded figures stay as they are.</p>
              <ButtonLink href={`${BASE}/what-if`} className="mt-4 w-full justify-center">Open What if</ButtonLink>
              <ArrowLink href={`${BASE}/forecast`} className="mt-3">See the forecast</ArrowLink>
            </LobbyPanel>
          </div>
        </section>
        <section aria-label="Priorities and workspace" className="mt-5 grid items-stretch gap-5 md:grid-cols-2 xl:grid-cols-[1fr_1.12fr_1.06fr]">
          <LobbyPanel id="lobby-actions" serif eyebrow="Your next moves" title="Priorities & observations." end={<ArrowLink href={`${BASE}/actions`}>Open all</ArrowLink>}>
            <p className="text-[0.75rem] text-ink">3 outstanding<span className="text-danger">, 1 overdue</span></p>
            <div className="mt-1"><ActionQueue actions={ACTIONS} today="2026-11-01" actionHref={(id) => `${BASE}/actions/${id}`} icon={<ClipboardCheck />} /></div>
          </LobbyPanel>
          <LobbyPanel id="lobby-ws" eyebrow="Completeness & connections" serif title="Compliance view.">
            <p className="text-[0.75rem] text-ink-muted">The real card is `WorkspaceStatus` in the home page.</p>
          </LobbyPanel>
          <LobbyPanel id="lobby-analyst" tone="blush" serif eyebrow="Ask APX" title="Ask about your figures." end={<MessageCircleQuestion aria-hidden="true" className="size-[1.0625rem] text-accent" />}>
            <p className="text-[0.75rem] leading-[1.8] text-ink-muted">The AI Financial Analyst answers from your calculated figures only, with the evidence behind each answer.</p>
            <ButtonLink href={`${BASE}/analyst`} className="mt-4">Ask the analyst</ButtonLink>
          </LobbyPanel>
        </section>
        <div className="mt-6"><NextMovePanel moves={moves} /></div>
        <LobbyFooter line="Figures to 30 Sep 2026" />
      </LobbyCanvas>
    </AppShell>
  );
}
