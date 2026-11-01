'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type CSSProperties, type FormEvent } from 'react';
import type { DashboardParams, DepartmentDashboard, WorkflowPanel } from '@/modules/departments';
import { useDash } from './dash-context';
import { NativeDialog } from './dialog';
import { DataIcon, Icon } from './icon';
import { dashHref } from './href';
import { MonthlyTargetsCard } from './targets-card';
import type { TargetsCheckView } from './types';

type Extras = DepartmentDashboard['extras'];

/**
 * "Make the next move." (`#industry-panel`, `operations.js`): four cards — the data-to-reporting
 * workflow, APAX (the AI analyst), Monthly Notifications (targets) and the review templates.
 * The sector briefing is left out for now (owner, 2026-11-01): its buttons are not rendered.
 */
export function OperationsPanel({ orgSlug, params, homePath, extras, initialCheck, currency }: {
  orgSlug: string; params: DashboardParams; homePath: string; extras: Extras; initialCheck: TargetsCheckView | null; currency: string;
}) {
  return (
    <section className="operations-panel" id="industry-panel" data-section="industry" aria-labelledby="industry-title">
      <div className="industry-heading">
        <div>
          <span className="eyebrow">APX INTELLIGENCE · OPERATIONS · TARGETS</span>
          <h2 id="industry-title">Make the next move<span className="red-dot">.</span></h2>
          <p>Connect the work, ask better questions and keep monthly progress visible.</p>
        </div>
        <span className="sector-pill" id="industry-sector">{extras.companyName}</span>
      </div>
      <div className="operations-grid">
        <WorkflowCard workflow={extras.workflow} params={params} homePath={homePath} />
        <ApaxCard analystHref={extras.can.askAnalyst ? extras.links.analyst : null} />
        <MonthlyTargetsCard orgSlug={orgSlug} targets={extras.targets} initialCheck={initialCheck} currency={currency} />
        <TemplatesCard financeLine={extras.financeLine} />
      </div>
    </section>
  );
}

function WorkflowCard({ workflow, params, homePath }: { workflow: WorkflowPanel; params: DashboardParams; homePath: string }) {
  const router = useRouter();
  return (
    <article className="ops-card workflow-card" data-section="systems" style={{ '--apx-i': 0 } as CSSProperties}>
      <div className="ops-card-header">
        <span className="eyebrow">01 / IMPROVE THE WAY YOU WORK</span>
        <h3>Manage Systems and Workflow<span className="red-dot">.</span></h3>
        <p>What can be improved, and which warnings need attention?</p>
      </div>
      <div className="workflow-visual" id="workflow-visual" aria-label="Data to reporting workflow infographic">
        <div className="workflow-path">
          {workflow.nodes.map((node, i) => (
            <Link key={`${node.label}-${i}`} className={`flow-node ${node.status}`} data-flow-department={node.dept} href={dashHref(homePath, params, { dept: node.dept })} scroll={false}>
              <span className="flow-number">0{i + 1}</span>
              <span className="flow-icon"><Icon name={node.icon} /></span>
              <strong>{node.label}</strong>
              <small>{node.detail}</small>
              <span className="flow-node-state">{node.status === 'ready' ? 'Recorded' : node.status === 'warning' ? 'Attention' : 'Awaiting checks'}</span>
            </Link>
          ))}
        </div>
        <div className="flow-caption"><span className="small-dot" />Source → Validate → Reconcile → Approve → Report</div>
      </div>
      <div className="workflow-content ops-card-footer">
        <div className="workflow-summary" id="workflow-summary">
          <strong>{workflow.toProcess}</strong><span>{workflow.toProcessLabel}</span>
          <strong>{workflow.reviewsOpen}</strong><span>{workflow.reviewsOpenLabel}</span>
        </div>
        <button
          type="button"
          className="primary-button ops-launch"
          id="workflow-open"
          onClick={() => {
            router.push(dashHref(homePath, params, { dept: 'workflow' }), { scroll: false });
            document.getElementById('department-title')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }}
        >
          Open Manage Workflow <DataIcon name="arrow" />
        </button>
      </div>
    </article>
  );
}

const PROMPTS = ['Plan 20% growth', 'Review my costs', 'Improve my workflow', 'Industry opportunities'] as const;

/**
 * APAX: the prototype's guided assistant becomes APX's real AI Financial Analyst — a prompt or a
 * question opens the analyst with it (`?ask=`), where the answer comes from the company's
 * calculated figures with its evidence.
 */
function ApaxCard({ analystHref }: { analystHref: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [avatar, setAvatar] = useState(true);

  const ask = (q: string) => {
    const text = q.trim();
    if (!text || !analystHref) return;
    router.push(`${analystHref}?ask=${encodeURIComponent(text)}`);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(question); };

  return (
    <article className="ops-card apax-card" data-section="apax" style={{ '--apx-i': 1 } as CSSProperties}>
      <div className="ops-card-header">
        <span className="eyebrow">02 / AN APX PERSPECTIVE</span>
        <h3>AI Insights<span className="red-dot">.</span></h3>
        <p>Meet <strong>APAX</strong>, your friendly guide to data, operations and knowledgeable growth.</p>
      </div>
      <div className="apax-visual">
        <div className="apax-orbit orbit-one" />
        <div className="apax-orbit orbit-two" />
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element -- the prototype's plain <img>; hidden if the file is missing.
          <img src="/brand/apax-casual.png" id="apax-avatar" className="apax-avatar" alt="APAX, a friendly natural male avatar with short hair wearing a blue APAX T-shirt" onError={() => setAvatar(false)}
            // A 404 before hydration fires no onError: check the loaded state once mounted.
            ref={(el) => { if (el && el.complete && el.naturalWidth === 0) setAvatar(false); }}
          />
        ) : null}
        <span className="apax-greeting">Hello I&rsquo;m<br /><strong>APAX</strong><span className="greeting-dot">.</span></span>
      </div>
      <div className="ops-card-footer">
        <button type="button" className="primary-button ops-launch" id="apax-open" aria-haspopup="dialog" aria-controls="apax-dialog" onClick={() => setOpen(true)}>
          Open APAX Insights <DataIcon name="arrow" />
        </button>
      </div>

      <NativeDialog
        id="apax-dialog"
        className="operations-dialog"
        labelledBy="apax-dialog-title"
        open={open}
        onClose={() => setOpen(false)}
        onOpen={(el) => el.querySelector<HTMLInputElement>('#apax-question')?.focus()}
      >
        <div className="dialog-top">
          <span className="eyebrow">APAX · ANALYSE · PLAN · ACT</span>
          <button type="button" className="icon-btn" data-close-operations="apax-dialog" aria-label="Close APAX insights" onClick={() => setOpen(false)}><DataIcon name="close" /></button>
        </div>
        <h2 id="apax-dialog-title">Hello I&rsquo;m APAX</h2>
        <p className="operations-dialog-intro">Explore your data, test growth scenarios and ask APX’s AI Financial Analyst.</p>
        <div className="apax-content">
          <span className="prototype-pill">AI FINANCIAL ANALYST</span>
          <div className="apax-prompts" id="apax-prompts">
            {PROMPTS.map((p) => (
              <button type="button" key={p} data-apax-prompt={p} disabled={!analystHref} onClick={() => { setQuestion(p); ask(p); }}>{p}</button>
            ))}
          </div>
          <form id="apax-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="apax-question">Ask APAX a question</label>
            <div className="apax-input">
              <input id="apax-question" placeholder="Ask about costs, growth or workflow…" maxLength={500} value={question} disabled={!analystHref} onChange={(e) => setQuestion(e.target.value)} />
              <button type="submit" aria-label="Ask APAX" disabled={!analystHref}><DataIcon name="arrow" /></button>
            </div>
          </form>
          <div className="apax-answer" id="apax-answer" aria-live="polite">
            <strong>What would you like to explore?</strong>
            <p>
              {analystHref
                ? 'Choose a prompt or ask a question. APAX opens the AI Financial Analyst, which answers from this company’s calculated figures and shows the evidence behind each answer.'
                : 'Your role in this company does not include the AI Financial Analyst. Ask an owner or admin if you need it.'}
            </p>
          </div>
          <p className="apax-limitation">Answers come from this company’s own figures in APX. The sector briefing is not included yet.</p>
        </div>
      </NativeDialog>
    </article>
  );
}

/** "Analyse your Reports and Pitch Decks" (`operations.js#reportTemplates`). */
function TemplatesCard({ financeLine }: { financeLine: string }) {
  const { showDialog, closeDialog } = useDash();

  function show(kind: 'catalogue' | 'report' | 'pitch') {
    if (kind === 'catalogue') {
      showDialog('REPORTS & PITCH DECKS · REVIEW TEMPLATES', (
        <>
          <h2 id="dialog-title">Start with a clear structure.</h2>
          <div className="dialog-copy"><p>Choose a template to organise your review. The financial snapshot comes from this company’s latest figures in APX.</p></div>
          <div className="template-options">
            <button type="button" data-report-template="report" onClick={() => show('report')}><Icon name="file" /><strong>Report analysis</strong><span>Performance, comparatives, data checks and next steps.</span></button>
            <button type="button" data-report-template="pitch" onClick={() => show('pitch')}><Icon name="layers" /><strong>Pitch deck review</strong><span>Proposition, evidence, financials and milestones.</span></button>
          </div>
        </>
      ), <button type="button" className="secondary-button" onClick={closeDialog}>Close templates</button>);
      return;
    }
    const sections: ReadonlyArray<readonly [string, string]> = kind === 'report' ? [
      ['01 / Source & period', 'Record the company, report date, currency, reporting basis and source. Confirm which period is complete.'],
      ['02 / Financial snapshot', financeLine],
      ['03 / Comparative review', 'Compare revenue, cost and profit with the prior period and budget. Explain material changes; distinguish whole financial years from the months shown on the dashboard.'],
      ['04 / Readiness & questions', 'Check missing data, reconciliation and approvals. Identify which explanations need supporting evidence.'],
      ['05 / Decisions & ownership', 'Summarise the key indicators, proposed actions, responsible owners and the next review date.'],
    ] : [
      ['01 / Business & proposition', '[Company name] · [Customer problem] · [Proposed solution] · [Evidence of demand]'],
      ['02 / Market & business model', '[Target customer] · [Market evidence] · [Revenue model] · [Differentiation]'],
      ['03 / Financial snapshot', financeLine],
      ['04 / Growth & execution', '[Growth driver] · [Costs and capacity] · [Funding needs] · [Milestones and owners]. Treat the 10%, 20% and 30% growth cases as scenarios, with assumptions.'],
      ['05 / Ask & evidence', '[Funding or decision requested] · [Use of funds] · [Risks] · [Source references]. Replace placeholders with verified business evidence.'],
    ];
    showDialog('TEMPLATE PREVIEW · ACTUAL FIGURES', (
      <>
        <h2 id="dialog-title">{kind === 'report' ? 'Report analysis' : 'Pitch deck review'} template.</h2>
        <div className="review-template">
          {sections.map(([title, copy]) => <section key={title}><h3>{title}</h3><p>{copy}</p></section>)}
        </div>
        <div className="dialog-callout">A review structure with this company’s figures. Uploading or automatically analysing documents is not connected to the templates yet.</div>
      </>
    ), (
      <>
        <button type="button" className="secondary-button" data-report-template="catalogue" onClick={() => show('catalogue')}>Choose another template</button>
        <button type="button" className="primary-button" onClick={closeDialog}>Back to dashboard</button>
      </>
    ));
  }

  return (
    <article className="ops-card templates-card" data-section="templates" style={{ '--apx-i': 3 } as CSSProperties}>
      <div className="ops-card-header">
        <span className="eyebrow">04 / PRESENT WITH CLARITY</span>
        <h3>Analyse your Reports and Pitch Decks<span className="red-dot">.</span></h3>
        <p>Start with a clear review template.</p>
      </div>
      <div className="report-template-visual">
        <TemplateStack />
        <span>REPORTS · PITCH DECKS</span>
      </div>
      <div className="ops-card-footer">
        <button type="button" className="primary-button ops-launch" id="report-templates-open" aria-haspopup="dialog" onClick={() => show('catalogue')}>View Templates <DataIcon name="arrow" /></button>
      </div>
    </article>
  );
}

/** The prototype's layered report / pitch-deck illustration, verbatim. */
function TemplateStack() {
  return (
    <svg className="report-template-stack" viewBox="0 0 220 185" role="img" aria-label="Layered report and pitch deck template icons">
      <g transform="translate(25 22) rotate(-10 70 70)">
        <rect width="122" height="145" rx="8" fill="#f0f7ff" stroke="#c8ddf0" /><rect x="14" y="16" width="70" height="5" rx="2" fill="#3284d8" />
        <path d="M14 36h88M14 46h65M14 56h79" stroke="#c4d9ed" strokeWidth="3" />
        <rect x="16" y="82" width="14" height="35" rx="2" fill="#9dc7e8" /><rect x="39" y="70" width="14" height="47" rx="2" fill="#3284d8" /><rect x="62" y="91" width="14" height="26" rx="2" fill="#b9d8ed" />
      </g>
      <g transform="translate(80 24) rotate(11 55 66)">
        <rect width="120" height="145" rx="8" fill="#fff5fc" stroke="#e5bfd9" /><rect x="14" y="16" width="72" height="5" rx="2" fill="#c12591" />
        <rect x="14" y="35" width="92" height="53" rx="4" fill="#f3d5e9" /><path d="M27 75 48 56 68 66 92 44" stroke="#c12591" fill="none" strokeWidth="3" />
        <path d="M14 104h87M14 115h62M14 126h76" stroke="#e3c6d9" strokeWidth="3" />
      </g>
      <g transform="translate(47 8)">
        <rect width="126" height="156" rx="8" fill="white" stroke="#d5e3ef" /><rect x="14" y="17" width="45" height="16" rx="3" fill="#f7e8f2" />
        <text x="21" y="28" fill="#b22e88" fontFamily="Arial,sans-serif" fontSize="7">REPORT</text>
        <path d="M14 47h97M14 57h73" stroke="#d7e3ee" strokeWidth="3" /><rect x="14" y="73" width="97" height="51" rx="4" fill="#f4f9fe" />
        <path d="M23 111 44 96 61 101 81 85 102 79" stroke="#3284d8" strokeWidth="2.5" fill="none" />
        <circle cx="44" cy="96" r="3" fill="#c12591" /><circle cx="81" cy="85" r="3" fill="#c12591" />
        <path d="M14 137h48M73 137h38" stroke="#e1eaf3" strokeWidth="3" />
      </g>
    </svg>
  );
}
