import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRight, FileText, HandCoins, KeyRound, ListChecks, Megaphone, PiggyBank, ChartColumn, Landmark } from 'lucide-react';
import {
  DEPARTMENTS_PERMISSION, getAccessContext, listAccessRequests, mayRequestAccess, moduleOn, type AccessContext,
} from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { loadHome, loadOrganizationFacts } from '@/modules/dashboard';
import { DEPARTMENT_META, loadDepartmentDashboard, parseDashboardParams, type DepartmentDashboard } from '@/modules/departments';
import type { Metadata } from 'next';
import { DEFAULT_TARGETS, getMonthlyTargets } from '@/modules/targets';
import { listAvailable } from '@/modules/reporting';
import { fundingEnabled } from '@/modules/funding';
import { marketingEnabled } from '@/modules/marketing';
import { investmentEnabled } from '@/modules/investment';
import { Card, CardBody, IconBadge, type IconTint } from '@/components/ui/surfaces';
import { formatDate } from '@/components/labels';
import { ButtonLink } from '@/components/ui/button';
import { CLICKABLE_CARD, CardLink } from '@/components/ui/clickable-card';
import { dataLinks } from '@/components/dashboard/nav';
import { DepartmentStrip, LobbyFooter, LobbyHero, type LobbyDepartment } from '@/components/dashboard/lobby';
import {
  ClientWorkspace, ComparativeFinancials, ComplianceView, ControlBar, DashFooter, DashProvider, DepartmentNav, GrowthCard,
  IdentityStrip, KeyReportIndicators, MainChart, MarketingVsRevenue, Metrics, OperationsPanel, PrioritiesQueue, RevenueMix,
  SectionHeading, Welcome, type DashActions, type ExportMeta, type FeedbackContext, type TargetsCheckView,
} from '@/components/department-dashboard';
import { requirePermission } from '@/app/_lib/authz';
import {
  assessTargetsAction, projectGrowthAction, recordClientReviewAction, requestReviewAction, setItemReviewedAction,
} from './actions';
import { targetsCheckView } from './targets-view';
import './apx-dashboard.css';

export const dynamic = 'force-dynamic';

/** The prototype's `document.title`: "APX · <department>". */
export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const { dept } = parseDashboardParams(await searchParams);
  return { title: `APX · ${DEPARTMENT_META[dept].name}` };
}

/**
 * Home — the department dashboard (docs/DEPARTMENT_DASHBOARD_PLAN.md): an exact copy of the client's
 * prototype (`~/Downloads/apx-prototype/index.html`), in its order, with the company's own figures.
 *
 * URL state, server-rendered: `?dept=analysis|banking|capture|workflow|clients`, `?months=1|3|6`,
 * `?view=current|last`. Everything else (legend, baseline, filters, growth inputs, dialogs) is
 * client state in the components. Every figure comes formatted from `loadDepartmentDashboard`;
 * nothing here computes a number (`no-arithmetic-in-components`).
 *
 * Kept from the previous Home (ADR-172 follow-up): a company with no figures yet sees the first-run
 * or awaiting-review card; a member who may ask and lacks `financials.view` sees "Request more
 * information" first; a reader without `financials.view` sees their reports listed.
 */

/** The page's server actions, handed to the client components (they never import `src/app`). */
const DASH_ACTIONS: DashActions = {
  requestReview: requestReviewAction,
  setItemReviewed: setItemReviewedAction,
  recordClientReview: recordClientReviewAction,
  projectGrowth: projectGrowthAction,
  assessTargets: assessTargetsAction,
};

/**
 * §6, exact copy. A first-run page says what to do next, not that something is missing.
 *
 * The upload copy is for someone who can upload. A reader who cannot (a client, a 3rd party) is told
 * plainly that the company has not added its figures yet — "upload a bank statement" is not a next
 * step they can take.
 */
function FirstRun({ orgSlug, canImport }: { orgSlug: string; canImport: boolean }) {
  if (!canImport) {
    return (
      <Card>
        <CardBody className="p-6 sm:p-8">
          <h2 className="font-serif text-2xl text-ink">No figures yet.</h2>
          <p className="mt-3 max-w-prose text-ink-muted">
            This company has not added its figures to APX yet. Its health score and headline numbers will
            appear here once it has.
          </p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="p-6 sm:p-8">
        <h2 className="font-serif text-2xl text-ink">Let’s get your first numbers on screen.</h2>
        <p className="mt-3 max-w-prose text-ink-muted">
          APX works from files you already have. Upload a bank statement (CSV or PDF) or an export
          from your accounting software and we’ll show you how the business is doing, what’s changed
          and what needs attention.
        </p>
        <p className="mt-3 max-w-prose text-sm italic text-ink-faint">
          Start with a bank statement to see your cash position. Add a ledger export, trial balance
          or invoice list when you can, and we’ll add profit and customer figures.
        </p>
        {canImport ? (
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <ButtonLink href={`/app/${orgSlug}/data/imports/new`}>Add data</ButtonLink>
            <Link href="/legal/terms" className="text-sm text-accent underline underline-offset-2">
              What files can I upload?
            </Link>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default async function HomePage({
  params, searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  /*
   * Home was the one tenant page with no explicit gate (ADR-094); it states it now rather than
   * relying on every role holding `dashboard.view`.
   */
  requirePermission(ctx, 'dashboard.view');
  const seesDetail = can(ctx, 'financials.view');
  const base = `/app/${orgSlug}`;
  const homePath = `${base}/home`;
  const dashParams = parseDashboardParams(await searchParams);

  const [dashboard, ask, reports, org] = await Promise.all([
    loadDepartmentDashboard(ctx, dashParams),
    // "Request more information" heads Home for a member who may ask and lacks the detail.
    mayRequestAccess(ctx.effectiveRole) && !seesDetail ? waitingRequest(ctx) : Promise.resolve(null),
    // Someone without `financials.view` sees their reports here (Departments carries everyone else's).
    can(ctx, 'reports.view') && !seesDetail ? homeReports(ctx, base) : Promise.resolve(null),
    loadOrganizationFacts(ctx.db, ctx.orgId!),
  ]);
  const currency = org?.baseCurrency ?? 'GBP';

  const askCard = ask === null ? null : <RequestMoreCard href={`${base}/access`} waitingSince={ask.waitingSince} />;
  const reportsBand = reports === null || reports.length === 0 ? null : <YourReports links={reports} allHref={moduleOn(ctx, 'reports') ? `${base}/reports` : null} />;

  if (dashboard === null) {
    return <NoFigures ctx={ctx} orgSlug={orgSlug} orgName={org?.name ?? 'Your company'} currency={currency} askCard={askCard} reportsBand={reportsBand} />;
  }

  const { view, extras } = dashboard;
  const dept = dashParams.dept;
  const workflow = dept === 'workflow';
  const scenario = workflow ? 'Workflow snapshot' : dept === 'clients' ? 'Client portfolio snapshot' : 'Actual figures';
  const meta: ExportMeta = {
    dept, deptName: view.name, role: extras.identity.role, scenario, period: view.periodCaption, months: dashParams.months, currency,
  };
  const feedback: FeedbackContext = {
    orgSlug, department: dept, departmentName: view.name, role: extras.identity.role, period: view.periodCaption,
    months: String(dashParams.months), view: dashParams.view === 'last' ? 'Last Completed' : 'Current', scenario,
  };
  const initialCheck = await initialTargetsCheck(ctx, dashboard, currency);

  return (
    <>
      {askCard || reportsBand ? <div className="mb-6 flex flex-col gap-6">{askCard}{reportsBand}</div> : null}
      <div className="apx-dash">
        <DashProvider feedback={feedback} actions={DASH_ACTIONS}>
          <div id="workspace" tabIndex={-1} className={workflow ? 'workflow-view' : undefined}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 18 }}>
              <IdentityStrip name={extras.identity.name} role={extras.identity.role} isAnalyst={extras.identity.isAnalyst} lastLogin={extras.identity.lastLogin} />
            </div>
            <DepartmentNav departments={dashboard.departments} params={dashParams} homePath={homePath} />
            <Welcome deptName={view.name} greeting={extras.greeting} companyName={extras.companyName} companyLine={extras.companyLine} />
            <div className="dashboard-grid">
              <section className="dashboard-content" aria-labelledby="department-title">
                <SectionHeading kicker={view.kicker} name={view.name} chart={view.chart} meta={meta} />
                <ControlBar
                  params={dashParams}
                  homePath={homePath}
                  periodCaption={view.periodCaption}
                  showReportView={dept === 'analysis'}
                  showScenario={!workflow && dept !== 'clients'}
                  whatIfHref={extras.can.openWhatIf ? extras.links.whatIf : null}
                />
                <p className="reporting-cutoff" id="reporting-cutoff" hidden={dept !== 'analysis'}>{view.reportingCutoff}</p>
                {view.empty ? <div className="dialog-callout" role="status">{view.empty}</div> : null}
                <Metrics metrics={view.metrics} />
                {dept === 'analysis' && extras.keyIndicators ? <KeyReportIndicators panel={extras.keyIndicators} /> : null}
                <div className="visual-grid">
                  <div className="visual-main">
                    <MainChart key={`${dept}-${dashParams.months}-${dashParams.view}`} chart={view.chart} meta={meta} />
                    <MarketingVsRevenue panel={extras.marketing} snapshotLabel={view.snapshotLabel} currency={currency} />
                  </div>
                  <div className="lower-grid">
                    <RevenueMix mix={view.mix} />
                    {dept === 'analysis' || dept === 'banking' ? <GrowthCard orgSlug={orgSlug} baselines={extras.growth} currency={currency} /> : null}
                  </div>
                </div>
                {dept === 'clients' && view.clients ? (
                  <ClientWorkspace orgSlug={orgSlug} clients={view.clients} canRecordReview={extras.can.recordClientReview} />
                ) : null}
              </section>
              <aside className="workspace-context pnl-compliance-row" aria-label="Comparative financials, priorities and compliance" data-section="workspace">
                <ComparativeFinancials panel={extras.comparative} />
                <PrioritiesQueue
                  key={dept}
                  orgSlug={orgSlug}
                  dept={dept}
                  queue={view.queue}
                  isAnalyst={extras.identity.isAnalyst}
                  can={{ requestReview: extras.can.requestReview, markReviewed: extras.can.markReviewed, completeTasks: extras.can.completeTasks }}
                />
                <ComplianceView checks={extras.compliance} />
              </aside>
            </div>
            <OperationsPanel orgSlug={orgSlug} params={dashParams} homePath={homePath} extras={extras} initialCheck={initialCheck} currency={currency} />
            <DashFooter basis={`${extras.companyName} · ${view.reportingCutoff} · figures calculated by APX from the company’s own data`} />
          </div>
        </DashProvider>
      </div>
    </>
  );
}

/** The targets card's first render: the default month's saved targets (or the defaults), checked. */
async function initialTargetsCheck(ctx: AccessContext, dashboard: DepartmentDashboard, currency: string): Promise<TargetsCheckView | null> {
  const { targets } = dashboard.extras;
  try {
    const record = await getMonthlyTargets(ctx, targets.defaultMonth).catch(() => null);
    return targetsCheckView(targets.defaultMonth, record?.targets ?? DEFAULT_TARGETS, targets.history, currency);
  } catch {
    return null;
  }
}

/**
 * No figures yet (the loader returns null): the previous Home's first-run and awaiting-review
 * states, under the lobby's department strip and greeting.
 */
async function NoFigures({ ctx, orgSlug, orgName, currency, askCard, reportsBand }: {
  ctx: AccessContext; orgSlug: string; orgName: string; currency: string; askCard: ReactNode; reportsBand: ReactNode;
}) {
  const base = `/app/${orgSlug}`;
  const canImport = can(ctx, 'imports.create');
  const seesDetail = can(ctx, 'financials.view');
  const showsActions = can(ctx, 'actions.view') && moduleOn(ctx, 'actions');
  const state = await loadHome(ctx.db, ctx.orgId!, orgSlug, ctx.requestId, { suspended: ctx.organizationStatus === 'suspended' });
  const departments: LobbyDepartment[] = [
    { key: 'analysis', title: 'Financial Analysis', line: 'Understand performance', href: `${base}/home`, icon: <ChartColumn /> },
    ...(seesDetail && moduleOn(ctx, 'banking')
      ? [{ key: 'banking', title: 'Banking', line: 'Control cash & funding', href: `${base}/money/banking`, icon: <Landmark /> }] : []),
    ...(dataLinks(ctx).length > 0
      ? [{ key: 'data', title: 'Data Capture', line: 'Build reliable foundations', href: `${base}/data/imports`, icon: <FileText /> }] : []),
    ...(showsActions
      ? [{ key: 'actions', title: 'Manage Workflow', line: 'Assign, track & review', href: `${base}/actions`, icon: <ListChecks /> }] : []),
  ];
  return (
    <>
      <DepartmentStrip departments={departments} currentKey="analysis" showMore={can(ctx, DEPARTMENTS_PERMISSION)} />
      <LobbyHero section="Financial Analysis" greeting="Welcome back. Your business, in perspective." orgName={orgName} orgLine={`Workspace · ${currency}`} />
      <div className="mt-8 flex flex-col gap-6">
        {askCard}
        {state.kind === 'awaiting_review' ? (
          <Card>
            <CardBody className="p-6 sm:p-8">
              <h2 className="text-2xl text-ink">Your import is waiting for review.</h2>
              <p className="mt-3 max-w-prose text-ink-muted">
                We found {state.rowCount} rows in{' '}
                <span className="font-mono">{state.filename}</span>. Check the {state.issueCount}{' '}
                {state.issueCount === 1 ? 'item' : 'items'} we flagged, then confirm, and your
                numbers will appear here.
              </p>
              <div className="mt-6">
                <ButtonLink href={`/app/${orgSlug}/data/imports/${state.batchId}`}>Review import</ButtonLink>
              </div>
            </CardBody>
          </Card>
        ) : <FirstRun orgSlug={orgSlug} canImport={canImport} />}
        {reportsBand}
      </div>
      <LobbyFooter line="Your figures appear here once they are added" />
    </>
  );
}

/** The reader's own waiting request, if any — the card says so rather than inviting a second one. */
async function waitingRequest(ctx: AccessContext): Promise<{ waitingSince: string | null }> {
  const waiting = (await listAccessRequests(ctx, { status: 'pending' }))
    .find((request) => request.requesterId === ctx.userId);
  return { waitingSince: waiting ? formatDate(waiting.createdAt) : null };
}

/**
 * "Request more information" (ADR-172; SOW: a 3rd party may "request access for additional
 * information if needed"), at the top of Home for a member who may ask and does not hold the detail.
 */
function RequestMoreCard({ href, waitingSince }: { href: string; waitingSince: string | null }) {
  return (
    <Card className={CLICKABLE_CARD}>
      <CardBody className="flex min-w-0 flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
        <div className="flex min-w-0 flex-1 gap-4">
          <IconBadge tint="pink"><KeyRound /></IconBadge>
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-ink">
              <CardLink href={href} className="after:rounded-[inherit]">Request more information</CardLink>
            </h2>
            <p className="mt-1 max-w-prose text-sm text-ink-muted">
              {waitingSince === null
                ? 'You can see this company’s overview — its headline figures, Business Health Score and reports. If you need more, such as the figures behind them or its documents, ask the owner or an admin.'
                : `You asked for more access on ${waitingSince}. Your request is waiting for the owner or an admin to answer.`}
            </p>
          </div>
        </div>
        <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent group-hover:border-accent group-hover:bg-accent-soft">
          {waitingSince === null ? 'Ask for more' : 'See your request'} <ChevronRight className="size-4" />
        </span>
      </CardBody>
    </Card>
  );
}

interface ReportLink {
  readonly key: string;
  readonly label: string;
  readonly line: string;
  readonly href: string;
  readonly icon: ReactNode;
  readonly tint: IconTint;
}

/**
 * The reports a reader without `financials.view` can open (RBAC_MATRIX §8.3): the Monthly Management
 * Reports, Funding Readiness while it is on, Marketing and Investment while their systems are on.
 * Each is a page the reader may open; none is listed that would refuse them.
 */
async function homeReports(ctx: AccessContext, base: string): Promise<ReportLink[]> {
  const reportsOn = moduleOn(ctx, 'reports');
  const [monthly, funding] = await Promise.all([
    reportsOn ? listAvailable(ctx) : Promise.resolve([]),
    fundingEnabled(ctx),
  ]);
  const links: ReportLink[] = monthly.slice(0, 3).map((report) => ({
    key: `monthly-${report.periodId}`,
    label: `Monthly Management Report — ${report.periodLabel}`,
    line: 'Figures, health and what changed in the month',
    href: `${base}/reports/monthly/${report.periodId}`,
    icon: <FileText />,
    tint: 'violet',
  }));
  if (funding) {
    links.push({ key: 'funding', label: 'Funding Readiness', line: 'An indicative assessment, not a lending decision', href: `${base}/funding`, icon: <HandCoins />, tint: 'pink' });
  }
  if (marketingEnabled(ctx)) {
    links.push({ key: 'marketing', label: 'Marketing', line: 'The marketing strategy report', href: `${base}/marketing`, icon: <Megaphone />, tint: 'violet' });
  }
  if (investmentEnabled(ctx)) {
    links.push({ key: 'investment', label: 'Investment', line: 'The investment pack', href: `${base}/investment`, icon: <PiggyBank />, tint: 'pink' });
  }
  return links;
}

function YourReports({ links, allHref }: { links: readonly ReportLink[]; allHref: string | null }) {
  return (
    <section aria-labelledby="your-reports-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="your-reports-heading" className="font-serif text-lg text-ink">Reports</h2>
        {allHref ? (
          <Link href={allHref} className="text-sm text-accent underline underline-offset-2">All reports</Link>
        ) : null}
      </div>
      <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {links.map((link) => (
          <li key={link.key} className="min-w-0">
            <Card className={`h-full ${CLICKABLE_CARD}`}>
              <CardBody className="flex min-w-0 items-start gap-3 p-4">
                <IconBadge tint={link.tint} size="sm">{link.icon}</IconBadge>
                <div className="min-w-0">
                  <CardLink href={link.href} className="block font-medium text-ink [overflow-wrap:anywhere] after:rounded-[inherit]">
                    {link.label}
                  </CardLink>
                  <p className="mt-0.5 text-sm text-ink-muted">{link.line}</p>
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

