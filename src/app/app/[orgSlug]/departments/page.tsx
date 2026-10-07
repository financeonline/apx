import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Building2, CalendarDays, ChartColumn, ClipboardCheck, FileText, FileUp, HandCoins, Landmark, ListChecks,
  Plus, ShieldCheck, Sparkles, TrendingUp, Upload, Users, UsersRound,
} from 'lucide-react';
import { loadDepartments, type DepartmentTile, type TileTone } from '@/modules/departments';
import { getAccessContext } from '@/modules/tenancy';
import { fundingEnabled } from '@/modules/funding';
import { can } from '@/core/permissions';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/surfaces';
import {
  DepartmentCard, QuickLink, ShortcutLink, IconTile, type CardTint,
} from '@/components/dashboard/department-card';
import { SectionTabs } from '@/components/dashboard/section-tabs';
import { requirePermission } from '@/app/_lib/authz';

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
    pills: [{ label: 'Profit & loss', path: 'money/profit-and-loss' }, { label: 'Cash', path: 'money/cash' }, { label: 'Budget', path: 'money/budget' }],
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

/** Order as the reference: the money departments first, then risk, actions and the rest. */
const ORDER = ['finance', 'banking', 'planning', 'analyst', 'alerts', 'actions', 'customers', 'reports'];

export default async function DepartmentsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  // Not `dashboard.view` alone: a suspended member sees only the frozen Home (ADR-044.4).
  requirePermission(ctx, 'financials.view');
  const view = await loadDepartments(ctx);
  const showFunding = can(ctx, 'reports.view') && await fundingEnabled(ctx);
  const base = `/app/${orgSlug}`;

  const byKey = new Map(view.tiles.map((t) => [t.key, t]));
  const ordered = [
    ...ORDER.flatMap((k) => byKey.get(k) ?? []),
    ...view.tiles.filter((t) => !ORDER.includes(t.key)),
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
          pills={(p?.pills ?? []).map((pill) => ({ label: pill.label, href: `${base}/${pill.path}` }))}
          status={{ tone: tile.tone, label: STATUS[tile.tone] }}
        />
      </li>
    );
  };

  const canImport = can(ctx, 'imports.review');
  const canReports = can(ctx, 'reports.view');

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-4xl md:text-5xl">Your departments</h1>
          <p className="mt-2 text-lg text-ink-muted md:text-xl">One workspace. Every part of your business.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {canImport ? (
            <ButtonLink href={`${base}/data/imports/new`} tone="secondary" className="h-14 rounded-2xl bg-surface/80 px-7 text-lg shadow-[0_8px_24px_-14px_rgb(106_69_229/0.45)] [&_svg]:size-5">
              <Upload aria-hidden="true" /> Add data
            </ButtonLink>
          ) : null}
          {canReports && can(ctx, 'ai.use') ? (
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

          {view.system.team !== null ? (
            <li>
              <DepartmentCard
                title="Team & Clients" href={`${base}/settings/team`} icon={<UsersRound />} tint="violet"
                description={['Team', 'Requests & deliverables']}
                headline={view.system.team}
                pills={can(ctx, 'actions.view') ? [{ label: 'Requests', href: `${base}/engagement` }] : []}
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
                  <p className="text-sm text-ink-muted">Get your data into MOTION.</p>
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
              {can(ctx, 'ai.use') ? <li><ShortcutLink href={`${base}/reports/custom/new`} label="Custom" icon={<Sparkles />} /></li> : null}
              {showFunding ? <li><ShortcutLink href={`${base}/funding`} label="Funding" icon={<HandCoins />} /></li> : null}
              {can(ctx, 'assignments.view') ? <li><ShortcutLink href="/portfolio/report" label="Portfolio" icon={<Building2 />} /></li> : null}
            </ul>
          </section>
        ) : null}
      </div>

      <Card className="mt-4" id="system">
        <CardBody>
          <h2 className="text-lg text-ink">How MOTION is running</h2>
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
