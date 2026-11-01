'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { GrowthBaselineView } from '@/modules/departments';
import { useDash } from './dash-context';
import { DataIcon } from './icon';
import type { GrowthRowsView } from './types';

type Row = { readonly rate: number; readonly revenue: string; readonly cost: string; readonly profit: string; readonly uplift: string; readonly profitCompact?: string };

const RATES = [10, 20, 30] as const;
const isZero = (s: string) => /^\s*0*(\.0*)?\s*$/.test(s);

/**
 * "How can I Grow?" (`app.js#renderGrowth`): the baseline select, +10 / +20 / +30 %, "Adjust costs &
 * investment" (cost behaviour, additional investment), the comparison table, the assumptions line
 * and dialog. The service precomputes the rows with no investment; an investment is applied by
 * `projectGrowthAction` (Decimal, on the server) a moment after typing stops.
 */
export function GrowthCard({ orgSlug, baselines, currency }: { orgSlug: string; baselines: readonly GrowthBaselineView[]; currency: string }) {
  const { showDialog, closeDialog, actions } = useDash();
  const [basisKey, setBasisKey] = useState(baselines[0]?.key ?? '');
  const [rate, setRate] = useState<number>(20);
  const [costMode, setCostMode] = useState<'fixed' | 'scale'>('fixed');
  const [investment, setInvestment] = useState('0');
  const [adjusted, setAdjusted] = useState<{ key: string; view: GrowthRowsView } | null>(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);

  const base = baselines.find((b) => b.key === basisKey) ?? baselines[0];
  const zero = isZero(investment);
  const requestKey = `${base?.key}|${costMode}|${investment.trim()}`;

  useEffect(() => {
    if (!base || zero) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setPending(true);
      const result = await actions.projectGrowth(orgSlug, { revenue: base.revenue, grossProfit: base.grossProfit, profit: base.profit }, costMode, investment);
      if (mine !== seq.current) return;
      setPending(false);
      if (result.ok) setAdjusted({ key: requestKey, view: result.view });
    }, 250);
    return () => clearTimeout(timer);
  }, [orgSlug, base, costMode, investment, zero, requestKey, actions]);

  if (!base) {
    return (
      <section className="growth-card" id="growth-card" data-section="growth" aria-labelledby="growth-title" style={{ '--apx-i': 3 } as CSSProperties}>
        <div className="growth-heading"><span className="eyebrow">TURN INSIGHT INTO OPPORTUNITY</span><DataIcon name="forecast" /></div>
        <h3 id="growth-title">How can I Grow<span className="red-dot">?</span></h3>
        <p className="growth-intro">Growth scenarios appear here once APX has a full month of sales and costs for this company.</p>
      </section>
    );
  }

  const fresh = adjusted && adjusted.key === requestKey ? adjusted.view : null;
  const rows: readonly Row[] = zero ? base.rows[costMode] : (fresh?.rows ?? (adjusted?.view.rows ?? base.rows[costMode]));
  const selected = rows.find((r) => r.rate === rate) ?? rows[0];
  const investmentText = zero ? 'none' : (fresh?.investmentDisplay ?? '…');

  function assumptions() {
    showDialog('GROWTH · ASSUMPTIONS', (
      <>
        <h2 id="dialog-title">What sits behind the projection?</h2>
        <div className="dialog-copy">
          <p><strong>{base!.label}</strong><br />Baseline revenue: {base!.revenueDisplay}. Baseline {base!.profitLabel.toLowerCase()}: {base!.profitDisplay}.</p>
          <p>Each row applies a one-off 10%, 20% or 30% revenue increase over an annual period. It is not monthly compound growth.</p>
          <p><strong>Overheads fixed:</strong> projected profit = baseline profit + incremental revenue × baseline gross margin − additional investment. Where APX has no gross profit for the baseline, the operating margin stands in for it.</p>
          <p><strong>All costs scale:</strong> projected profit = baseline profit × (1 + revenue growth) − additional investment.</p>
          <p>The financial-year option is the latest whole financial year in APX. The window option annualises the selected 1, 3 or 6 months, assumes the same pace continues, and does not model seasonality.</p>
          <p>Working capital, tax, additional financing, capacity constraints and changes in pricing or product mix are not modelled. Validate these before treating a scenario as a business plan.</p>
        </div>
      </>
    ), <button type="button" className="primary-button" onClick={closeDialog}>Back to growth</button>);
  }

  return (
    <section className="growth-card" id="growth-card" data-section="growth" aria-labelledby="growth-title" style={{ '--apx-i': 3 } as CSSProperties}>
      <div className="growth-heading"><span className="eyebrow">TURN INSIGHT INTO OPPORTUNITY</span><DataIcon name="forecast" /></div>
      <h3 id="growth-title">How can I Grow<span className="red-dot">?</span></h3>
      <p className="growth-intro">Explore an APX perspective of what 10%, 20% or 30% revenue growth could mean for your business.</p>
      <label className="field-label" htmlFor="projection-basis">Financial baseline</label>
      <select id="projection-basis" className="growth-select" value={base.key} onChange={(e) => setBasisKey(e.target.value)}>
        {baselines.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
      </select>
      <div className="growth-rates" id="growth-rates" role="group" aria-label="Revenue growth target">
        {RATES.map((r) => <button type="button" key={r} data-growth-rate={r} aria-pressed={rate === r} onClick={() => setRate(r)}>+{r}%</button>)}
      </div>
      <div className="growth-result" aria-busy={pending}>
        <span id="growth-result-label">Projected annual revenue · +{rate}%</span>
        <strong id="growth-revenue" key={`${base.key}-${rate}`}>{selected?.revenue}</strong>
        <small id="growth-uplift">{selected ? `${selected.uplift} revenue · ${selected.profitCompact ?? selected.profit} ${base.profitLabel.toLowerCase()}` : ''}</small>
      </div>
      <details className="growth-adjust">
        <summary>Adjust costs &amp; investment</summary>
        <label className="field-label" htmlFor="projection-costs">Cost behaviour</label>
        <select id="projection-costs" className="growth-select" value={costMode} onChange={(e) => setCostMode(e.target.value === 'scale' ? 'scale' : 'fixed')}>
          <option value="fixed">Gross margin steady; overheads fixed</option>
          <option value="scale">All costs scale with sales</option>
        </select>
        <label className="field-label" htmlFor="projection-investment">Additional annual investment ({currency})</label>
        <input id="projection-investment" className="growth-select" type="number" min="0" max="10000000" step="1000" value={investment} onChange={(e) => setInvestment(e.target.value)} />
      </details>
      <table className="growth-table">
        <thead><tr><th>Growth</th><th>Revenue</th><th>Cost</th><th id="projection-profit-label">{base.profitLabel}</th></tr></thead>
        <tbody id="growth-comparison">
          {rows.map((r) => (
            <tr key={r.rate} className={r.rate === rate ? 'selected' : undefined}><th scope="row">+{r.rate}%</th><td>{r.revenue}</td><td>{r.cost}</td><td>{r.profit}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="growth-note" id="growth-assumptions">
        {base.label}. Baseline revenue {base.revenueDisplay}. {costMode === 'fixed' ? 'Gross margin stays constant; overheads stay fixed.' : 'All baseline costs scale with sales.'} Additional investment {investmentText}. Illustration, not a guaranteed outcome.
      </p>
      <button type="button" className="text-button" id="growth-details" onClick={assumptions}>View assumptions <DataIcon name="arrow" /></button>
    </section>
  );
}
