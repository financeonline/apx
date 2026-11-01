'use client';

import type { CSSProperties } from 'react';
import type { ComplianceCheck } from '@/modules/departments';
import { useDash } from './dash-context';
import { DataIcon } from './icon';
import { useXeroPlan } from './xero-plan';

/** "Compliance View" (`operations.js#renderCompliance`, `#showChecks`, Integration plan). */
export function ComplianceView({ checks }: { checks: readonly ComplianceCheck[] }) {
  const { showDialog, closeDialog } = useDash();
  const xeroPlan = useXeroPlan();
  const warnings = checks.filter((c) => c.type === 'warning').length;

  function review() {
    showDialog('COMPLIANCE & READINESS', (
      <>
        <h2 id="dialog-title">Know what still needs attention.</h2>
        <div className="dialog-copy">
          {checks.map((c) => <p key={c.title}><strong>{c.title} · {c.status}</strong><br />{c.text}</p>)}
          <p>These checks combine the known connection state with the company’s own uploads, actions and tax dates in APX. They do not certify regulatory compliance or verify a filing.</p>
        </div>
      </>
    ), <button type="button" className="primary-button" onClick={closeDialog}>Close checks</button>);
  }

  return (
    <section className="compliance-card" style={{ '--apx-i': 2 } as CSSProperties}>
      <div className="mini-heading"><span className="eyebrow">COMPLETENESS &amp; CONNECTIONS</span><DataIcon name="shield" /></div>
      <h3>Compliance View<span className="red-dot">.</span></h3>
      <div className="compliance-status" id="compliance-status">
        <span className="warning-dot" />
        <strong>{warnings === 0 ? 'No checks need attention' : `${warnings} ${warnings === 1 ? 'check needs' : 'checks need'} attention`}</strong>
        <span className="not-verified-tag">Compliance unverified</span>
      </div>
      <div id="compliance-checks">
        {checks.map((c) => (
          <div className={`compliance-row ${c.type}`} key={c.title}>
            <span className="check-state">{c.type === 'ok' ? '✓' : c.type === 'warning' ? '!' : '?'}</span>
            <div><strong>{c.title}</strong><small>{c.text}</small></div>
            <span>{c.status}</span>
          </div>
        ))}
      </div>
      <p className="history-footnote">Operational readiness checks. Statutory compliance is not verified by APX.</p>
      <div className="compliance-actions">
        <button type="button" className="text-button" id="refresh-btn" onClick={review}>Review checks <DataIcon name="arrow" /></button>
        <button type="button" className="text-button xero-plan" id="xero-plan-btn" onClick={xeroPlan}>Integration plan <DataIcon name="link" /></button>
      </div>
    </section>
  );
}
