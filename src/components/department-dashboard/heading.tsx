'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { DashboardParams, MainChart, PeriodMonths, ReportView } from '@/modules/departments';
import { DataIcon } from './icon';
import { dashHref } from './href';
import { FeedbackButton } from './buttons';
import { ExportButton } from './main-chart';
import type { ExportMeta } from './export-csv';

/** The welcome band (`section.welcome`): breadcrumb, the two-line headline, greeting, company. */
export function Welcome({ deptName, greeting, companyName, companyLine }: {
  deptName: string; greeting: string; companyName: string; companyLine: string;
}) {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <div>
        <div className="breadcrumb"><span>WORKSPACE</span><i>/</i><strong id="breadcrumb">{deptName}</strong></div>
        <h1 id="welcome-title">Clarity today.<br /><em>Confidence tomorrow.</em></h1>
        <p className="welcome-copy" id="welcome-copy">{greeting}</p>
      </div>
      <div className="workspace-summary">
        <DataIcon name="layers" className="summary-icon" />
        <div><strong>{companyName}</strong><span>{companyLine}</span></div>
      </div>
    </section>
  );
}

/** `.section-heading`: the department's kicker and name, Feedback and Export. */
export function SectionHeading({ kicker, name, chart, meta }: { kicker: string; name: string; chart: MainChart; meta: ExportMeta }) {
  return (
    <div className="section-heading">
      <div><p className="eyebrow" id="department-kicker">{kicker}</p><h2 id="department-title">{name}<span className="red-dot">.</span></h2></div>
      <div className="heading-actions">
        <FeedbackButton section="metrics" />
        <ExportButton chart={chart} meta={meta} />
      </div>
    </div>
  );
}

const PERIODS: ReadonlyArray<readonly [PeriodMonths, string]> = [[1, '1 month'], [3, '3 months'], [6, '6 months']];
const VIEWS: ReadonlyArray<readonly [ReportView, string]> = [['current', 'Current'], ['last', 'Last Completed']];

/**
 * `.controlbar`: the period (1 / 3 / 6 months) and, for Financial Analysis, Current / Last
 * Completed — both are URL state, so the server renders the new window. They stay `<button>`s with
 * `aria-pressed`, as in the prototype (its stylesheet targets `.period-control button`), and navigate
 * on click.
 */
export function ControlBar({ params, homePath, periodCaption, showReportView, showScenario, whatIfHref }: {
  params: DashboardParams; homePath: string; periodCaption: string;
  showReportView: boolean; showScenario: boolean; whatIfHref: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (patch: Partial<DashboardParams>) => startTransition(() => router.push(dashHref(homePath, params, patch), { scroll: false }));

  return (
    <div className="controlbar" aria-busy={pending}>
      <div className="period-control" role="group" aria-label="Reporting period">
        {PERIODS.map(([months, label]) => (
          <button type="button" key={months} data-period={months} aria-pressed={params.months === months} onClick={() => go({ months })}>{label}</button>
        ))}
      </div>
      <div className="period-control report-view-control" id="report-view-control" role="group" aria-label="Financial reporting view" hidden={!showReportView}>
        {VIEWS.map(([view, label]) => (
          <button type="button" key={view} data-report-view={view === 'last' ? 'last-completed' : view} aria-pressed={params.view === view} onClick={() => go({ view })}>{label}</button>
        ))}
      </div>
      <span className="period-caption" id="period-caption">{periodCaption}</span>
      <label className="scenario-control" id="scenario-control" hidden={!showScenario}>
        <DataIcon name="sliders" />
        <span className="sr-only">Scenario</span>
        {/*
          The prototype's Base / Growth / Cash pressure options multiplied the sample figures. APX
          never multiplies real figures: this dashboard shows the company's actuals only, and a
          scenario is a separate What-if model with its own page. So the one option here is
          "Actual figures", and choosing What-if opens that page instead of changing these numbers.
        */}
        <select
          id="scenario"
          value="actual"
          onChange={(e) => { if (e.target.value === 'what-if' && whatIfHref) router.push(whatIfHref); }}
        >
          <option value="actual">Actual figures</option>
          {whatIfHref ? <option value="what-if">What-if scenarios…</option> : null}
        </select>
      </label>
    </div>
  );
}
