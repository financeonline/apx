'use client';

import type { CSSProperties } from 'react';
import type { MarketingPanel } from '@/modules/departments';
import { useDash } from './dash-context';
import { DataIcon } from './icon';

/**
 * "Marketing vs Revenue" (`operations.js#renderMarketing`): the whole circle is revenue, the blue
 * wedge is marketing spend within it, with the leader line to the spend figure, and the monthly
 * table behind the button (`#marketing-data-btn`).
 */
const CX = 175, CY = 108, R = 89;

export function MarketingVsRevenue({ panel, snapshotLabel, currency }: { panel: MarketingPanel | null; snapshotLabel: string; currency: string }) {
  const { showDialog, closeDialog } = useDash();
  const share = panel?.share === null || panel?.share === undefined ? 0 : Math.max(0, Math.min(1, panel.share));
  const angle = -Math.PI / 2 + share * 2 * Math.PI;
  const ex = CX + R * Math.cos(angle), ey = CY + R * Math.sin(angle);

  function table() {
    if (!panel) return;
    showDialog('MARKETING VS REVENUE · ACTUAL FIGURES', (
      <>
        <h2 id="dialog-title">Marketing within your revenue.</h2>
        <div className="dialog-copy"><p>{snapshotLabel} · {panel.period} · Actual figures. {currency}, rounded to the nearest whole unit.</p></div>
        <table className="data-table">
          <thead><tr><th>Month</th><th>Revenue</th><th>Marketing spend</th><th>Spend / revenue</th></tr></thead>
          <tbody>{panel.rows.map((r) => <tr key={r.month}><th>{r.month}</th><td>{r.revenue}</td><td>{r.spend}</td><td>{r.ratio}</td></tr>)}</tbody>
        </table>
        <div className="dialog-copy"><p>{panel.source} The whole pie is total revenue; marketing is a slice within that amount. The remainder is revenue less marketing spend, not profit. This comparison does not establish attribution or return on advertising spend.</p></div>
      </>
    ), <button type="button" className="primary-button" onClick={closeDialog}>Back to dashboard</button>);
  }

  return (
    <section className="chart-card marketing-card" data-section="marketing" aria-labelledby="marketing-title" style={{ '--apx-i': 1 } as CSSProperties}>
      <div className="chart-heading">
        <div><span className="eyebrow">SPEND &amp; COMMERCIAL PERFORMANCE</span><h3 id="marketing-title">Marketing vs Revenue</h3></div>
        <button type="button" className="icon-btn" id="marketing-data-btn" aria-label="View marketing and revenue figures" title="View marketing and revenue figures" onClick={table} disabled={!panel}>
          <DataIcon name="table" />
        </button>
      </div>
      <div className="marketing-context">
        <div className="mini-legend"><span><i className="sales-key" />Revenue base</span><span><i className="cost-key" />Marketing spend</span></div>
        <span id="marketing-period">{panel ? `${panel.period} · Actual figures` : ''}</span>
      </div>
      {panel ? (
        <svg id="marketing-chart" viewBox="0 0 680 220" role="img" aria-labelledby="marketing-title marketing-desc">
          <circle className="apx-fade" cx={CX} cy={CY} r={R} fill="#c12591"><title>{`Total revenue ${panel.revenueDisplay}. Marketing is a share within this total.`}</title></circle>
          {share >= 1 ? <circle className="apx-fade" style={{ '--apx-i': 4 } as CSSProperties} cx={CX} cy={CY} r={R} fill="#3284d8" />
            : share > 0 ? (
              <path className="apx-fade" style={{ '--apx-i': 4 } as CSSProperties} d={`M ${CX} ${CY} L ${CX} ${CY - R} A ${R} ${R} 0 ${share > 0.5 ? 1 : 0} 1 ${ex} ${ey} Z`} fill="#3284d8">
                <title>{`Marketing spend ${panel.spendDisplay} · ${panel.shareDisplay}`}</title>
              </path>
            ) : null}
          <text x={CX} y="99" textAnchor="middle" fill="white" fontSize="12">Revenue</text>
          <text x={CX} y="128" textAnchor="middle" fill="white" fontSize="25">{panel.revenueDisplay}</text>
          <path className="apx-draw" pathLength={1} style={{ '--apx-len': 1, '--apx-i': 3 } as CSSProperties} d="M 194 22 L 297 22 L 330 55" fill="none" stroke="#3284d8" strokeWidth="1.2" />
          <circle className="apx-pop" cx="194" cy="22" r="3" fill="#3284d8" />
          <text x="350" y="71" fill="#4f6f8f" fontSize="12">Marketing spend</text>
          <text x="350" y="108" fill="#2f78c4" fontSize="29">{panel.spendDisplay}</text>
          <text x="350" y="135" fill="#5d7489" fontSize="12">{panel.share === null ? 'Share not known' : panel.shareDisplay}</text>
        </svg>
      ) : (
        <p className="marketing-note">No revenue figures for these months yet, so there is nothing to compare marketing spend with.</p>
      )}
      <p id="marketing-desc" className="sr-only">
        {panel ? `Revenue is the whole pie, ${panel.revenueDisplay}. Marketing spend is ${panel.spendDisplay}, ${panel.shareDisplay}. ${panel.period}. View figures for exact monthly amounts.` : ''}
      </p>
      <div className="marketing-summary" id="marketing-summary" />
      <p className="marketing-note">{panel ? `${panel.source} · ` : ''}The whole circle is revenue; the blue slice is marketing spend within it. This does not attribute revenue to marketing.</p>
    </section>
  );
}
