'use client';

import type { CSSProperties } from 'react';
import type { ComparativePanel } from '@/modules/departments';
import { useDash } from './dash-context';
import { DataIcon } from './icon';

/** `operations.js#chartFrame` for the 340×175 history chart. */
const X0 = 39, Y0 = 13, W = 340 - 55, H = 175 - 40;

/**
 * "Comparative Financials" (`operations.js#renderHistory`, `#historyTable`): sales and total costs
 * for the company's last financial years as paired bars, and the historical table.
 */
export function ComparativeFinancials({ panel }: { panel: ComparativePanel | null }) {
  const { showDialog, closeDialog } = useDash();
  const cap = panel && panel.cap > 0 ? panel.cap : 1;
  const y = (v: number) => Y0 + H - (v / cap) * H;
  const n = panel?.years.length ?? 0;
  const x = (i: number) => (n <= 1 ? X0 + W / 2 : X0 + 35 + (i * (W - 70)) / (n - 1));
  const tickY = (i: number, count: number) => Y0 + H - (i / Math.max(1, count - 1)) * H;

  function table() {
    if (!panel) return;
    showDialog('COMPARATIVE FINANCIALS · YOUR FINANCIAL YEARS', (
      <>
        <h2 id="dialog-title">Comparative financials, in perspective.</h2>
        <table className="data-table">
          <thead><tr><th>Year</th><th>Sales</th><th>Total costs</th><th>Net profit</th></tr></thead>
          <tbody>{panel.years.map((p) => <tr key={p.year}><th>{p.year}</th><td>{p.salesDisplay}</td><td>{p.costDisplay}</td><td>{p.profitDisplay}</td></tr>)}</tbody>
        </table>
        <div className="dialog-copy">
          <p>Source: the company’s financial years as calculated by APX from the data it added. A dash means APX has no figure for that year.</p>
          <p>Total costs are derived as sales less net profit, so they include operating costs, funding costs and any adjustments. They are not just cost of goods sold.</p>
          <p>These annual figures stay the same when the dashboard’s period changes.</p>
        </div>
      </>
    ), <button type="button" className="primary-button" onClick={closeDialog}>Back to dashboard</button>);
  }

  return (
    <section className="history-card" style={{ '--apx-i': 0 } as CSSProperties}>
      <div className="mini-heading"><span className="eyebrow">SALES &amp; COST TREND</span><DataIcon name="chart" /></div>
      <h3>Comparative Financials<span className="red-dot">.</span></h3>
      <p className="mini-copy">Annual sales and total costs{panel ? ` · ${panel.span}` : ''}</p>
      <div className="mini-legend"><span><i className="sales-key" />Sales</span><span><i className="cost-key" />Total costs</span></div>
      {panel ? (
        <svg id="pnl-bars" viewBox="0 0 340 175" role="img" aria-label={`Annual sales and total costs: ${panel.years.map((p) => `${p.year} sales ${p.salesDisplay}, total costs ${p.costDisplay}`).join('; ')}`}>
          {panel.ticks.map((label, i) => (
            <g key={`g${i}`}>
              <line x1={X0} x2={X0 + W} y1={tickY(i, panel.ticks.length)} y2={tickY(i, panel.ticks.length)} stroke="var(--dash-line)" strokeDasharray="3 4" />
              <text x={X0 - 7} y={tickY(i, panel.ticks.length) + 3} textAnchor="end" fill="var(--dash-muted)" fontSize="8">{label}</text>
            </g>
          ))}
          {panel.years.map((p, i) => (
            <g key={p.year}>
              {p.sales === null ? null : (
                <rect className="apx-grow" style={{ '--apx-i': i * 2 } as CSSProperties} x={x(i) - 21} y={y(p.sales)} width="18" height={Math.max(0, y(0) - y(p.sales))} rx="3" fill="var(--dash-accent)">
                  <title>{`${p.year} Sales: ${p.salesDisplay}`}</title>
                </rect>
              )}
              {p.cost === null ? null : (
                <rect className="apx-grow" style={{ '--apx-i': i * 2 + 1 } as CSSProperties} x={x(i) + 3} y={y(p.cost)} width="18" height={Math.max(0, y(0) - y(p.cost))} rx="3" fill="var(--dash-second)">
                  <title>{`${p.year} Total costs: ${p.costDisplay}`}</title>
                </rect>
              )}
              <text x={x(i)} y="165" textAnchor="middle" fill="var(--dash-muted)" fontSize="9">{p.year}</text>
            </g>
          ))}
        </svg>
      ) : (
        <p className="history-footnote">Comparative figures appear once APX has a whole financial year for this company.</p>
      )}
      <p className="history-footnote">Calculated by APX from the company’s own data. Total costs = sales less net profit.</p>
      <button type="button" className="text-button" data-history-table onClick={table} disabled={!panel}>View historical figures <DataIcon name="arrow" /></button>
    </section>
  );
}
