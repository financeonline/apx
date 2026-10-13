import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Building2, CalendarDays, ChartColumn, ClipboardCheck, FileText, FileUp, HandCoins, Landmark, ListChecks,
  Megaphone, PiggyBank, Plus, Receipt, ShieldCheck, Sparkles, TrendingUp, Upload, Users, UsersRound,
} from 'lucide-react';
import { loadDepartments, type DepartmentTile, type TileTone } from '@/modules/departments';
import { getAccessContext, moduleOn, type AccessContext, type ModuleKey } from '@/modules/tenancy';
import { fundingEnabled } from '@/modules/funding';
import { getMarketingView, marketingEnabled, summariseMarketing, type MarketingSummary } from '@/modules/marketing';
import { getInvestmentView, investmentEnabled, summariseInvestment, type InvestmentSummary } from '@/modules/investment';
import { can } from '@/core/permissions';
import { isMotionError } from '@/core/errors';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/surfaces';
import {
  DepartmentCard, QuickLink, ShortcutLink, IconTile, type CardTint,
} from '@/components/dashboard/department-card';
import { SectionTabs } from '@/components/dashboard/section-tabs';
import { requirePermission } from '@/app/_lib/authz';
import { CompetitiveReadinessCard } from '../marketing/_components/competitive-readiness-card';

export const dynamic = 'force-dynamic';

/**
 * The Departmental Dashboard (Agreement §4; ADR-143), in the owner's reference design (ADR-155):
 * every department of the business as MOTION sees it, and how the system itself is running. A
 * department the viewer may not open is absent.
 *
 * Each card's status, headline and lines are the department tile's own (`modules/departments`) —
 * the figure its section shows. The copy beside them only says what the department covers.
 */

const STATUS: Readonly<Record<TileTone, string>> = {
  good: 'In order',
  attention: 'Needs attention',
  quiet: 'Nothing yet',
};

interface Presentation {
  readonly title: string;
  readonly icon: ReactNode;
  readonly tint: CardTint;
  readonly description: readonly string[];
  readonly pills: readonly { label: string; path: string }[];
  readonly featured?: boolean;
}

/** How each department is presented. Pills link only within the department's own section. */
const PRESENTATION: Readonly<Record<string, Presentation>> = {
  finance: {
    title: 'Financial Intelligence', icon: <ChartColumn />, tint: 'violet',
    description: ['KPIs & trends', 'Profit, cash and what you owe'],
    pills: [{ label: 'Profit & loss', path: 'money/profit-and-loss' }, { label: 'Cash', path: 'money/cash' }, { label: 'Balance sheet', path: 'money/balance-sheet' }, { label: 'Budget', path: 'money/budget' }],
  },
  banking: {
    title: 'Banking', icon: <Landmark />, tint: 'pink',
    description: ['Accounts & cash movements', 'Reconciliation'],
    pills: [{ label: 'Transactions', path: 'money/banking/transactions' }],
  },
  planning: {
    title: 'Planning', icon: <TrendingUp />, tint: 'violet',
    description: ['Forecasts', 'What-if scenarios'],
    pills: [{ label: 'Forecast', path: 'forecast' }, { label: 'What if', path: 'what-if' }],
  },
  analyst: {
    title: 'AI Financial Analyst', icon: <Sparkles />, tint: 'pink', featured: true,
    description: ['Financial questions & explanations', 'Answers with sources'],
    pills: [],
  },
  alerts: {
    title: 'Risk & Health', icon: <ShieldCheck />, tint: 'violet',
    description: ['Business Health Score', 'Alerts & anomaly review'],
    pills: [{ label: 'Health score', path: 'home/health' }, { label: 'Alerts', path: 'insights/alerts' }],
  },
  actions: {
    title: 'Action Centre', icon: <ClipboardCheck />, tint: 'pink',
    description: ['Owners', 'Due dates', 'Outcomes'],
    pills: [],
  },
  customers: {
    title: 'Customers', icon: <Users />, tint: 'violet',
    description: ['Revenue by customer', 'Sales & marketing'],
    pills: [{ label: 'Sales', path: 'customers/sales' }, { label: 'Products', path: 'customers/products' }, { label: 'Marketing', path: 'customers/marketing' }],
  },
  reports: {
    title: 'Reports', icon: <FileText />, tint: 'pink',
    description: ['Daily, weekly and monthly', 'Adviser and custom reports'],
    pills: [],
  },
};

/**
 * Marketing's line (ADR-170), or null when the viewer may not see it or the system is switched off for
 * the company (ADR-158). The status is the report's real state, never a placeholder.
 */
async function marketingSummary(ctx: AccessContext): Promise<MarketingSummary | null> {
  if (!can(ctx, 'reports.view') || !marketingEnabled(ctx)) return null;
  try {
    return summariseMarketing(await getMarketingView(ctx));
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/**
 * Investment's line (ADR-171), as Marketing's: null when the viewer may not see it or the system is
 * switched off for the company (ADR-158). The status is the pack's real state — "Pack ready", "No
 * figures yet" — never a placeholder.
 */
async function investmentSummary(ctx: AccessContext): Promise<InvestmentSummary | null> {
  if (!can(ctx, 'reports.view') || !investmentEnabled(ctx)) return null;
  try {
    return summariseInvestment(await getInvestmentView(ctx));
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/** Order as the reference: the money departments first, then risk, actions and the rest. */
const ORDER = ['finance', 'banking', 'planning', 'analyst', 'alerts', 'actions', 'customers', 'reports'];

export default async function DepartmentsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  // Not `dashboard.view` alone: a suspended member sees only the frozen Home (ADR-044.4).
  requirePermission(ctx, 'financials.view');
  const view = await loadDepartments(ctx);
  const showFunding = can(ctx, 'reports.view') && await fundingEnabled(ctx);
  const [marketing, investment] = await Promise.all([marketingSummary(ctx), investmentSummary(ctx)]);
  const base = `/app/${orgSlug}`;

  // ADR-158: a department of a system the super admin switched off is absent.
  const TILE_MODULES: Readonly<Record<string, ModuleKey>> = {
    banking: 'banking', customers: 'customers', actions: 'actions', reports: 'reports', analyst: 'analyst', planning: 'planning',
  };
  const PILL_MODULES: Readonly<Record<string, ModuleKey>> = {
    'money/budget': 'planning', 'money/balance-sheet': 'tax', 'money/banking/transactions': 'banking',
    forecast: 'planning', 'what-if': 'planning',
  };
  const on = (key: ModuleKey | undefined) => key === undefined || moduleOn(ctx, key);
  const byKey = new Map(view.tiles.filter((t) => on(TILE_MODULES[t.key])).map((t) => [t.key, t]));
  const ordered = [
    ...ORDER.flatMap((k) => byKey.get(k) ?? []),
    ...view.tiles.filter((t) => !ORDER.includes(t.key) && on(TILE_MODULES[t.key])),
  ];

  const tileCard = (tile: DepartmentTile) => {
    const p = PRESENTATION[tile.key];
    return (
      <li key={tile.key}>
        <DepartmentCard
          title={p?.title ?? tile.title}
          href={tile.href}
          icon={p?.icon ?? <ChartColumn />}
          tint={p?.tint ?? 'violet'}
          featured={p?.featured ?? false}
          description={p?.description ?? []}
          headline={tile.headline}
          lines={tile.lines}
          pills={(p?.pills ?? []).filter((pill) => on(PILL_MODULES[pill.path])).map((pill) => ({ label: pill.label, href: `${base}/${pill.path}` }))}
          status={{ tone: tile.tone, label: STATUS[tile.tone] }}
        />
      </li>
    );
  };

  const canImport = can(ctx, 'imports.review');
  const canReports = can(ctx, 'reports.view') && moduleOn(ctx, 'reports');

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-4xl md:text-5xl">Your departments</h1>
          <p className="mt-2 text-lg text-ink-muted md:text-xl">One workspace. Every part of your business.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {canImport ? (
            <ButtonLink href={`${base}/data/imports/new`} tone="secondary" className="h-14 rounded-2xl bg-surface/80 px-7 text-lg shadow-[0_8px_24px_-14px_rgb(255_45_85/0.45)] [&_svg]:size-5">
              <Upload aria-hidden="true" /> Add data
            </ButtonLink>
          ) : null}
          {canReports && can(ctx, 'ai.use') && moduleOn(ctx, 'analyst') ? (
            <ButtonLink href={`${base}/reports/custom/new`} className="h-14 rounded-2xl px-7 text-lg [&_svg]:size-5">
              <Plus aria-hidden="true" /> New report
            </ButtonLink>
          ) : null}
        </div>
      </header>

      <SectionTabs
        label="Departments views"
        tabs={[
          { label: 'Departments', href: `${base}/departments` },
          { label: 'Activity', href: `${base}/notifications` },
          ...(can(ctx, 'users.view') ? [{ label: 'Team', href: `${base}/settings/team` }] : []),
        ]}
      />

      <section aria-labelledby="departments-heading">
        <h2 id="departments-heading" className="sr-only">Business departments</h2>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 min-[1440px]:grid-cols-3 min-[2200px]:grid-cols-4">
          {ordered.map(tileCard)}

          {/* ADR-156: VAT and Corporation Tax, and assets and loans. */}
          {moduleOn(ctx, 'tax') ? <li>
            <DepartmentCard
              title="Tax & VAT" href={`${base}/money/tax`} icon={<Receipt />} tint="pink"
              description={['VAT return', 'Corporation Tax estimate', 'UK and UAE rules']}
              pills={[{ label: 'VAT', href: `${base}/money/tax` }, { label: 'Assets & loans', href: `${base}/money/balance-sheet` }]}
              status={null}
            />
          </li> : null}

          {can(ctx, 'assignments.view') ? (
            <li>
              <DepartmentCard
                title="Accountant / CFO" href="/portfolio" icon={<Building2 />} tint="violet"
                description={['Client portfolio', 'Health, analysis & reports']}
                pills={[{ label: 'Alerts', href: '/portfolio/alerts' }, { label: 'Report', href: '/portfolio/report' }]}
                status={null}
              />
            </li>
          ) : null}

          {showFunding ? (
            <li>
              <DepartmentCard
                title="Funding Readiness" href={`${base}/funding`} icon={<HandCoins />} tint="pink"
                description={['Indicative assessment', 'Factors, evidence & improvements']}
                status={{ tone: 'good', label: 'Switched on' }}
              />
            </li>
          ) : null}

          {marketing === null ? null : (
            <>
              <li>
                <DepartmentCard
                  title="Marketing" href={`${base}/marketing`} icon={<Megaphone />} tint="violet"
                  description={['Marketing strategy report', 'Competitors, campaigns & figures']}
                  headline={marketing.headline ?? undefined}
                  status={{ tone: marketing.tone, label: marketing.label }}
                />
              </li>
              <li><CompetitiveReadinessCard href={`${base}/marketing#section-01`} summary={marketing} /></li>
            </>
          )}

          {investment === null ? null : (
            <li>
              <DepartmentCard
                title="Investment" href={`${base}/investment`} icon={<PiggyBank />} tint="pink"
                description={['Investment pack', 'Reinvestment & diversified investments']}
                headline={investment.headline ?? undefined}
                status={{ tone: investment.tone, label: investment.label }}
              />
            </li>
          )}

          {view.system.team !== null ? (
            <li>
              <DepartmentCard
                title="Team & Clients" href={`${base}/settings/team`} icon={<UsersRound />} tint="violet"
                description={['Team', 'Requests & deliverables']}
                headline={view.system.team}
                pills={can(ctx, 'actions.view') && moduleOn(ctx, 'actions') ? [{ label: 'Requests', href: `${base}/engagement` }] : []}
                status={{ tone: 'good', label: 'Active' }}
              />
            </li>
          ) : null}
        </ul>
      </section>

      <div className="mt-4 grid grid-cols-1 gap-4 min-[1440px]:grid-cols-[3fr_2fr]">
        {canImport ? (
          <section aria-labelledby="capture-heading" className="panel rounded-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex gap-3">
                <IconTile tint="violet" size="sm"><FileText /></IconTile>
                <div>
                  <h2 id="capture-heading" className="text-lg">Data capture</h2>
                  <p className="text-sm text-ink-muted">Get your data into APX.</p>
                </div>
              </div>
              <Link href={`${base}/data/imports`} className="text-sm font-medium text-accent hover:underline">Imports &amp; evidence →</Link>
            </div>
            <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <li><QuickLink href={`${base}/data/imports/new`} title="Upload a file" line="CSV, XLSX or PDF" icon={<FileUp />} tint="violet" /></li>
              <li><QuickLink href={`${base}/data/documents`} title="Documents" line="Statements, invoices, receipts" icon={<FileText />} tint="pink" /></li>
              <li><QuickLink href={`${base}/data/accounts`} title="Accounts" line="Your chart of accounts" icon={<ListChecks />} tint="pink" /></li>
            </ul>
          </section>
        ) : null}

        {canReports ? (
          <section aria-labelledby="reporting-heading" className="panel rounded-card p-5">
            <div className="flex gap-3">
              <IconTile tint="violet" size="sm"><ChartColumn /></IconTile>
              <div>
                <h2 id="reporting-heading" className="text-lg">Intelligent reporting</h2>
                <p className="text-sm text-ink-muted">Your data as clear, actionable reports.</p>
              </div>
            </div>
            <ul className="mt-4 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3">
              <li><ShortcutLink href={`${base}/reports`} label="All reports" icon={<CalendarDays />} /></li>
              {can(ctx, 'ai.use') && moduleOn(ctx, 'analyst') ? <li><ShortcutLink href={`${base}/reports/custom/new`} label="Custom" icon={<Sparkles />} /></li> : null}
              {showFunding ? <li><ShortcutLink href={`${base}/funding`} label="Funding" icon={<HandCoins />} /></li> : null}
              {marketing === null ? null : <li><ShortcutLink href={`${base}/marketing`} label="Marketing" icon={<Megaphone />} /></li>}
              {investment === null ? null : <li><ShortcutLink href={`${base}/investment`} label="Investment" icon={<PiggyBank />} /></li>}
              {can(ctx, 'assignments.view') ? <li><ShortcutLink href="/portfolio/report" label="Portfolio" icon={<Building2 />} /></li> : null}
            </ul>
          </section>
        ) : null}
      </div>

      <Card className="mt-4" id="system">
        <CardBody>
          <h2 className="text-lg text-ink">How APX is running</h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm text-ink">
            <li>{view.system.dataRefreshed}</li>
            <li>{view.system.lastCalculation}</li>
            {view.system.imports === null ? null : <li>{view.system.imports}</li>}
            {view.system.team === null ? null : <li>{view.system.team}</li>}
          </ul>
          <h3 className="mt-4 text-sm font-semibold text-ink">On a schedule</h3>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
            {view.system.schedule.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <h3 className="mt-4 text-sm font-semibold text-ink">Switched on for this organisation</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {view.system.modules.map((m) => (
              <li key={m.label} className="flex justify-between gap-2">
                <span className="text-ink">{m.label}</span>
                <span className="text-ink-muted">{m.on ? 'On' : 'Off'}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </>
  );
}
