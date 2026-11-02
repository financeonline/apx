'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { TargetsPanel } from '@/modules/departments';
import { useDash } from './dash-context';
import { NativeDialog } from './dialog';
import { DataIcon } from './icon';
import type { TargetsCheckView, TargetsRecord } from './types';

type Fields = { workflow: string; sales: string; marketing: string; costRatio: string; marketingRatio: string };
const FIELD_IDS: Record<keyof Fields, string> = {
  workflow: 'target-workflow', sales: 'target-sales', marketing: 'target-marketing', costRatio: 'target-cost-ratio', marketingRatio: 'target-marketing-ratio',
};
const fieldsOf = (t: TargetsRecord['targets']): Fields => ({
  workflow: String(t.workflow), sales: t.sales, marketing: t.marketing, costRatio: t.costRatio, marketingRatio: t.marketingRatio,
});
/** Who may save (`canManageTargets`: financials.view + financials.edit — owner, 2026-11-01). */
const WHO_SAVES = 'Only an owner, admin, analyst or accountant can save targets.';
const DEFAULT_FIELDS: Fields = { workflow: '80', sales: '300000', marketing: '15000', costRatio: '65', marketingRatio: '5' };

/** `operations.js#chartFrame` for the 340×125 card chart. */
const X0 = 39, Y0 = 13, W = 340 - 55, H = 125 - 40;

/**
 * "Monthly Notifications" (`operations.js`: `renderTargets`, `renderTargetsPreview`,
 * `renderTargetChart`, `loadTargets`, `saveTargets`): the card's sales line against the selected
 * target and its preview, and the targets dialog — the month, the five KPIs, Save, and the check.
 * Targets are the company's own record (`/api/dashboard/targets`); the check is `assessTargets`
 * on the server, re-run a moment after each edit.
 */
export function MonthlyTargetsCard({ orgSlug, targets, initialCheck, currency }: { orgSlug: string; targets: TargetsPanel; initialCheck: TargetsCheckView | null; currency: string }) {
  const { notify, actions } = useDash();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(targets.defaultMonth);
  const [fields, setFields] = useState<Fields>(DEFAULT_FIELDS);
  const [record, setRecord] = useState<TargetsRecord | null>(null);
  const [canManage, setCanManage] = useState(targets.canSave);
  const [status, setStatus] = useState('Loading saved targets…');
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<TargetsCheckView | null>(initialCheck);
  const dirty = useRef(false);
  const assessSeq = useRef(0);

  const savedLabel = useCallback((r: TargetsRecord) => {
    if (r.isDefault || !r.updatedAt) return 'Starting targets · save to keep this month’s settings.';
    const when = new Date(r.updatedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `Saved for ${r.month} · ${when} UK time`;
  }, []);

  const assess = useCallback(async (m: string, f: Fields) => {
    const mine = ++assessSeq.current;
    const result = await actions.assessTargets(orgSlug, m, f, targets.history);
    // An invalid entry (a blank field while typing) keeps the last check on screen.
    if (mine === assessSeq.current && result.ok) setCheck(result.view);
  }, [actions, orgSlug, targets.history]);

  const load = useCallback(async (m: string) => {
    try {
      const response = await fetch(`/api/dashboard/targets?org=${encodeURIComponent(orgSlug)}&month=${encodeURIComponent(m)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const r = (await response.json()) as TargetsRecord;
      setRecord(r);
      if (typeof r.canManage === 'boolean') setCanManage(r.canManage);
      const next = fieldsOf(r.targets);
      if (!dirty.current) setFields(next);
      setStatus(savedLabel(r));
      void assess(m, dirty.current ? fields : next);
    } catch {
      setStatus('Saved targets unavailable. Displaying the starting values.');
      void assess(m, fields);
    }
    // `fields` is read only as the fallback for an unsaved edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug, savedLabel, assess]);

  useEffect(() => {
    // The prototype's `loadTargets()` on start, in a callback so the effect itself sets no state.
    const timer = setTimeout(() => { void load(targets.defaultMonth); }, 0);
    return () => clearTimeout(timer);
  }, [load, targets.defaultMonth]);

  // Re-check a moment after typing stops (the prototype re-renders on every input).
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function edit(key: keyof Fields, v: string) {
    const next = { ...fields, [key]: v };
    setFields(next);
    dirty.current = true;
    setStatus('Unsaved target changes.');
    clearTimeout(typing.current);
    typing.current = setTimeout(() => { void assess(month, next); }, 300);
  }
  useEffect(() => () => clearTimeout(typing.current), []);

  function changeMonth(m: string) {
    setMonth(m);
    dirty.current = false;
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) void load(m);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { notify('Choose a valid reporting month.'); return; }
    setSaving(true);
    try {
      const response = await fetch(`/api/dashboard/targets?org=${encodeURIComponent(orgSlug)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ month, targets: fields, expectedRevision: record && record.month === month ? record.revision : 0 }),
      });
      if (response.status === 409) {
        setStatus('Targets changed in another session. Refresh and review the latest settings before saving.');
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string; issues?: Array<{ message: string }> } } | null;
        const issue = body?.error?.issues?.[0]?.message;
        setStatus(issue ? `${issue} Your entries are still here.` : response.status === 403
          ? `${WHO_SAVES} Your entries are still here.`
          : 'Targets could not be saved. Your entries are still here; try again.');
        return;
      }
      const r = (await response.json()) as TargetsRecord;
      setRecord(r);
      dirty.current = false;
      setFields(fieldsOf(r.targets));
      setStatus(savedLabel(r));
      void assess(month, fieldsOf(r.targets));
      notify('Monthly targets saved to this company’s dashboard.');
    } catch {
      setStatus('Targets could not be saved. Your entries are still here; try again.');
    } finally {
      setSaving(false);
    }
  }

  const chart = check?.chart ?? null;
  const n = chart?.labels.length ?? 0;
  const cap = chart && chart.cap > 0 ? chart.cap : 1;
  const x = (i: number) => (n <= 1 ? X0 + W / 2 : X0 + (i * W) / (n - 1));
  const y = (v: number) => Y0 + H - (v / cap) * H;
  const line = chart ? chart.sales.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter((p): p is string => p !== null).join(' ') : '';

  return (
    <article className="ops-card targets-card" data-section="targets" style={{ '--apx-i': 2 } as CSSProperties}>
      <div className="ops-card-header">
        <span className="eyebrow">03 / SET · TRACK · IMPROVE</span>
        <h3>Monthly Notifications<span className="red-dot">.</span></h3>
        <p>Set workflow and commercial KPIs, then see which targets need attention.</p>
      </div>
      <div className="targets-visual">
        <div className="mini-legend"><span><i className="sales-key" />Sales</span><span><i className="cost-key" />Selected target</span></div>
        <svg id="targets-chart" viewBox="0 0 340 125" role="img" aria-label="Monthly sales compared with the selected sales target">
          {chart ? (
            <>
              {[0, 0.5, 1].map((f, i) => (
                <g key={f}>
                  <line x1={X0} x2={X0 + W} y1={Y0 + H - f * H} y2={Y0 + H - f * H} stroke="var(--dash-line)" strokeDasharray="3 4" />
                  <text x={X0 - 7} y={Y0 + H - f * H + 3} textAnchor="end" fill="var(--dash-muted)" fontSize="8">{chart.ticks[i]}</text>
                </g>
              ))}
              <line x1={X0} x2={X0 + W} y1={y(chart.target)} y2={y(chart.target)} stroke="var(--dash-second)" strokeWidth="1.8" strokeDasharray="5 4" />
              {line ? <polyline key={line} className="apx-draw" pathLength={1} style={{ '--apx-len': 1 } as CSSProperties} points={line} fill="none" stroke="var(--dash-accent)" strokeWidth="2.5" /> : null}
              {chart.sales.map((v, i) => (
                <g key={i}>
                  {v === null ? null : (
                    <circle className="apx-pop" style={{ '--apx-i': i } as CSSProperties} cx={x(i)} cy={y(v)} r="3" fill="var(--dash-card)" stroke="var(--dash-accent)" strokeWidth="1.5"><title>{chart.titles[i]}</title></circle>
                  )}
                  <text x={x(i)} y="120" textAnchor="middle" fill="var(--dash-muted)" fontSize="8">{chart.labels[i]}</text>
                </g>
              ))}
            </>
          ) : null}
        </svg>
        <p>Sales history &amp; selected monthly target · actual figures</p>
      </div>
      <div className="targets-preview" id="targets-preview" aria-live="polite">
        {check?.preview ? (
          <>
            <div className="targets-preview-heading">
              <span className="targets-preview-month">{month} · actual figures</span>
              <strong className="targets-preview-status">{check.warnings ? `${check.warnings} KPIs need attention` : 'All KPIs on track'}</strong>
            </div>
            <div className="targets-preview-metrics">
              <div><span>Sales</span><strong>{check.preview.salesActual}</strong><small>{check.preview.salesTarget} target</small></div>
              <div><span>Marketing spend</span><strong>{check.preview.marketingActual}</strong><small>{check.preview.marketingTarget} budget</small></div>
            </div>
          </>
        ) : (
          <>
            <span className="targets-preview-month">{month}</span>
            <strong className="targets-preview-status">Missing actual data</strong>
            <p>Open monthly targets to set KPIs and review data readiness.</p>
          </>
        )}
      </div>
      <div className="ops-card-footer">
        <button type="button" className="primary-button ops-launch" id="targets-open" aria-haspopup="dialog" aria-controls="targets-dialog" onClick={() => setOpen(true)}>
          Manage Monthly Targets <DataIcon name="arrow" />
        </button>
      </div>

      <NativeDialog
        id="targets-dialog"
        className="operations-dialog"
        labelledBy="targets-dialog-title"
        open={open}
        onClose={() => setOpen(false)}
        onOpen={(el) => el.querySelector<HTMLInputElement>('#target-month')?.focus()}
      >
        <div className="dialog-top">
          <span className="eyebrow">MONTHLY NOTIFICATIONS · TARGETS</span>
          <button type="button" className="icon-btn" data-close-operations="targets-dialog" aria-label="Close monthly targets" onClick={() => setOpen(false)}><DataIcon name="close" /></button>
        </div>
        <h2 id="targets-dialog-title">Manage monthly targets</h2>
        <p className="operations-dialog-intro">Set your five KPIs and review which results need attention.</p>
        <div className="targets-content">
          <form id="targets-form" onSubmit={save}>
            <label className="field-label" htmlFor="target-month">Reporting month</label>
            <input type="month" id="target-month" className="growth-select" value={month} min="2020-01" max="2100-12" onChange={(e) => changeMonth(e.target.value)} />
            <details className="monthly-target-editor" open>
              <summary>Edit monthly targets</summary>
              <div className="target-fields">
                <label htmlFor={FIELD_IDS.workflow}>Monthly workflow target<span>completed tasks</span></label>
                <input id={FIELD_IDS.workflow} type="number" min="1" max="1000000" value={fields.workflow} required onChange={(e) => edit('workflow', e.target.value)} />
                <label htmlFor={FIELD_IDS.sales}>Sales target<span>{currency} per month</span></label>
                <input id={FIELD_IDS.sales} type="number" min="1" max="100000000" step="1" value={fields.sales} required onChange={(e) => edit('sales', e.target.value)} />
                <label htmlFor={FIELD_IDS.marketing}>Track marketing spend<span>maximum {currency} per month</span></label>
                <input id={FIELD_IDS.marketing} type="number" min="0" max="100000000" step="1" value={fields.marketing} required onChange={(e) => edit('marketing', e.target.value)} />
                <label htmlFor={FIELD_IDS.costRatio}>Cost vs Revenue target<span>maximum %</span></label>
                <input id={FIELD_IDS.costRatio} type="number" min="0" max="1000" step="0.1" value={fields.costRatio} required onChange={(e) => edit('costRatio', e.target.value)} />
                <label htmlFor={FIELD_IDS.marketingRatio}>Marketing vs Revenue target<span>maximum %</span></label>
                <input id={FIELD_IDS.marketingRatio} type="number" min="0" max="1000" step="0.1" value={fields.marketingRatio} required onChange={(e) => edit('marketingRatio', e.target.value)} />
              </div>
              {canManage ? (
                <button className="primary-button" id="targets-save" type="submit" disabled={saving}>Save monthly targets <DataIcon name="check" /></button>
              ) : null}
            </details>
            <p id="targets-save-status" className="targets-save-status" role="status">
              {canManage ? status : `${status} ${WHO_SAVES}`}
            </p>
          </form>
          <div id="monthly-notifications" aria-live="polite">
            {check && check.month === month && check.hasActuals ? (
              <>
                <div className="notification-heading"><strong>Monthly target check</strong><span className="warning-count">{check.warnings} need attention</span></div>
                {check.items.map((item) => (
                  <div className={`notification-row ${item.status}`} key={item.key}>
                    <div><strong>{item.label}</strong><span>{item.status === 'on-track' ? 'On track' : item.status === 'attention' ? 'Needs attention' : 'No figure'}</span></div>
                    <p>{item.actual} actual <span> / {item.target} target</span></p>
                    <div className="notification-meter"><i style={{ width: `${item.meterPercent}%` }} /></div>
                  </div>
                ))}
              </>
            ) : (
              <>
                <div className="notification-heading"><strong>Data completion required</strong><span className="warning-count">Missing data</span></div>
                <p className="missing-month">No actual financial or workflow data is available for {month}. You can save targets, but progress cannot be assessed yet.</p>
              </>
            )}
          </div>
          <p className="targets-note">In-dashboard notifications. Actuals are the company’s own figures for its last six months with figures; other months show missing-data warnings.</p>
        </div>
      </NativeDialog>
    </article>
  );
}
