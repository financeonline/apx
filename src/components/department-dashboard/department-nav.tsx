'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { DashboardParams, DepartmentDashboard } from '@/modules/departments';
import { useDash } from './dash-context';
import { DataIcon, Icon } from './icon';
import { dashHref } from './href';
import { useXeroPlan } from './xero-plan';

const PLANNED = [
  ['Payroll & People', 'Employee costs and pay cycles'],
  ['Tax & Compliance', 'Deadlines and filing checks'],
  ['Reporting & Packs', 'Management and client reports'],
  ['Document Library', 'Source documents and records'],
] as const;

/**
 * "Your departments" (`#departments` + `#more-apps-btn`): five tiles that switch `?dept=` (keeping
 * the months and the view), and More Apps — the prototype's "Your APX workspace" window with the
 * active departments, the planned ones and "View Xero build plan".
 */
export function DepartmentNav({ departments, params, homePath }: {
  departments: DepartmentDashboard['departments']; params: DashboardParams; homePath: string;
}) {
  const { showDialog, closeDialog } = useDash();
  const xeroPlan = useXeroPlan();

  function moreApps() {
    showDialog('YOUR APX WORKSPACE', (
      <>
        <h2 id="dialog-title">One system.<br />More possibilities.</h2>
        <div className="dialog-copy">Your {departments.length === 5 ? 'five' : departments.length} active departments are ready to explore.</div>
        <div className="app-catalogue">
          {departments.map((d) => (
            <Link key={d.id} className="app-tile" href={dashHref(homePath, params, { dept: d.id as DashboardParams['dept'] })} scroll={false} onClick={closeDialog}>
              <Icon name={d.icon} />
              <span><strong>{d.name}</strong><small>Active department · Open</small></span>
            </Link>
          ))}
        </div>
        <div className="dialog-copy"><strong>Additional departments · planned concepts</strong></div>
        <div className="app-catalogue">
          {PLANNED.map(([name, copy]) => (
            <div key={name} className="app-tile planned"><Icon name="layers" /><span><strong>{name}</strong><small>Planned · {copy}</small></span></div>
          ))}
        </div>
        <div className="xero-build">
          <h3>Xero integration</h3>
          <p>Bring accounting data into APX with a secure connection and approval controls. View the recommended build approach.</p>
          <button type="button" className="text-button" data-xero-plan onClick={xeroPlan}>View Xero build plan <Icon name="arrow" /></button>
        </div>
      </>
    ), <button type="button" className="secondary-button" onClick={closeDialog}>Back to dashboard</button>);
  }

  return (
    <section className="department-nav" aria-label="Department navigation" data-section="departments">
      <div className="nav-label"><span className="eyebrow">YOUR DEPARTMENTS</span><span>{String(departments.length).padStart(2, '0')} ACTIVE</span></div>
      <nav className="departments" id="departments" aria-label="Departments">
        {departments.map((d, i) => (
          <Link
            key={d.id}
            href={dashHref(homePath, params, { dept: d.id as DashboardParams['dept'] })}
            scroll={false}
            className="department"
            data-department={d.id}
            aria-current={d.id === params.dept ? 'true' : undefined}
            aria-label={`${d.name}: ${d.caption}`}
            style={{ '--apx-i': i } as CSSProperties}
          >
            <span className="department-icon"><Icon name={d.icon} /></span>
            <span className="department-text"><strong>{d.name}</strong><small>{d.caption}</small></span>
            <span className="dept-number">0{i + 1}</span>
          </Link>
        ))}
      </nav>
      <button type="button" className="department more-apps" id="more-apps-btn" aria-haspopup="dialog" onClick={moreApps} style={{ '--apx-i': departments.length } as CSSProperties}>
        <DataIcon name="apps" className="department-icon" />
        <span className="department-text"><strong>More Apps</strong><small>Explore more departments</small></span>
        <DataIcon name="plus" />
      </button>
    </section>
  );
}
