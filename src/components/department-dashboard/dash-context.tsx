'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NativeDialog } from './dialog';
import { Icon } from './icon';
import type { ActionResult } from '@/components/action-result';
import type { TargetActuals } from '@/modules/departments';
import type { GrowthRowsView, TargetsCheckView } from './types';

/**
 * The dashboard's shared client state — the prototype's `notify()` toast, `showDialog()` detail
 * dialog, the feedback dialog and the guide — so every card can open them (`app.js`).
 */

export interface FeedbackContext {
  readonly orgSlug: string;
  readonly department: string;       // `?dept=` key
  readonly departmentName: string;
  readonly role: string;             // "Owner", "Financial Analyst" …
  readonly period: string;           // "Apr – Sep 2026"
  readonly months: string;           // "6"
  readonly view: string;             // "Current" | "Last Completed"
  readonly scenario: string;         // "Actual figures" | "Workflow snapshot"
}

export type Outcome<T> = { ok: true; view: T } | { ok: false; error: ActionResult };

/**
 * The page's server actions (`home/actions.ts`), handed down as props — the components never
 * import from `src/app`. Each re-checks the caller on the server.
 */
export interface DashActions {
  requestReview(orgSlug: string, item: { title: string; context: string; href: string }): Promise<ActionResult>;
  setItemReviewed(orgSlug: string, kind: 'alert' | 'action', recordId: string, reviewed: boolean): Promise<ActionResult>;
  recordClientReview(orgSlug: string, client: { name: string; nextStep: string }): Promise<ActionResult>;
  projectGrowth(orgSlug: string, baseline: { revenue: string; grossProfit: string; profit: string }, costMode: 'fixed' | 'scale', investment: string): Promise<Outcome<GrowthRowsView>>;
  assessTargets(orgSlug: string, month: string, targets: unknown, actuals: readonly TargetActuals[]): Promise<Outcome<TargetsCheckView>>;
}

interface DialogState { readonly kicker: string; readonly body: ReactNode; readonly actions: ReactNode }

interface DashApi {
  notify(message: string): void;
  showDialog(kicker: string, body: ReactNode, actions?: ReactNode): void;
  closeDialog(): void;
  openFeedback(section?: string): void;
  openHelp(): void;
  readonly feedback: FeedbackContext;
  readonly actions: DashActions;
}

const DashContext = createContext<DashApi | null>(null);

export function useDash(): DashApi {
  const api = useContext(DashContext);
  if (!api) throw new Error('useDash outside DashProvider');
  return api;
}

/** The prototype's `#feedback-section` options, in order (labels as the select shows them). */
export const FEEDBACK_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['branding', '01 · Branding, logo & identity'],
  ['departments', '02 · Department navigation'],
  ['metrics', '03 · Financial metrics'],
  ['performance', '04 · Main performance chart'],
  ['composition', '05 · Composition chart'],
  ['perspective', '06 · Comparative Financials'],
  ['priorities', '07 · Workflow & priorities'],
  ['workspace', '08 · Compliance & connections'],
  ['report-summary', '09 · Financial report summary'],
  ['growth', '10 · How can I Grow'],
  ['clients', '11 · Client Management'],
  ['industry', '12 · Operations insights'],
  ['systems', '13 · Manage Systems and Workflow'],
  ['apax', '14 · APAX AI Insights'],
  ['targets', '15 · Monthly Notifications'],
  ['marketing', '16 · Marketing vs Revenue'],
  ['templates', '17 · Reports & Pitch Decks'],
];
/** `app.js#feedbackSections` — the label the composed note carries ("Financial / task metrics"). */
const NOTE_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(FEEDBACK_OPTIONS),
  metrics: '03 · Financial / task metrics',
};

const DRAFT_KEY = 'apx-feedback-v1';
const IDLE_STATUS = 'Your note goes to the APX team inside APX. Nothing is shared outside APX.';

export function DashProvider({ feedback, actions, children }: { feedback: FeedbackContext; actions: DashActions; children: ReactNode }) {
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [section, setSection] = useState('metrics');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState(IDLE_STATUS);
  const [sending, setSending] = useState(false);

  // The prototype keeps the unsent draft in this browser (`apx-feedback-v1`); read when the dialog opens.
  const readDraft = (): { section: string; notes: string } | null => {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as { section?: unknown; notes?: unknown } | null;
      if (draft && typeof draft.section === 'string' && NOTE_LABELS[draft.section] && typeof draft.notes === 'string') {
        return { section: draft.section, notes: draft.notes.slice(0, 4000) };
      }
    } catch { /* storage unavailable: start empty */ }
    return null;
  };
  const saveDraft = (next: { section: string; notes: string }) => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const showDialog = useCallback((kicker: string, body: ReactNode, actions: ReactNode = null) => {
    setDialog({ kicker, body, actions });
  }, []);
  const closeDialog = useCallback(() => setDialog(null), []);

  const openFeedback = useCallback((wanted?: string) => {
    const draft = readDraft();
    if (draft) setNotes(draft.notes);
    if (wanted && NOTE_LABELS[wanted]) setSection(wanted);
    else if (draft) setSection(draft.section);
    setStatus(IDLE_STATUS);
    setFeedbackOpen(true);
  }, []);
  // The prototype's guide opens in the shared detail dialog (`#help-btn` → showDialog).
  const openHelp = useCallback(() => setDialog({
    kicker: 'THE APX DASHBOARD',
    body: <HelpBody />,
    actions: <button type="button" className="primary-button" onClick={() => setDialog(null)}>Explore APX</button>,
  }), []);

  const api = useMemo<DashApi>(
    () => ({ notify, showDialog, closeDialog, openFeedback, openHelp, feedback, actions }),
    [notify, showDialog, closeDialog, openFeedback, openHelp, feedback, actions],
  );

  const composed = `APX dashboard feedback\nSection: ${NOTE_LABELS[section]}\nDepartment: ${feedback.departmentName}\nUser view: ${feedback.role}\nPeriod: ${feedback.period}\nScenario: ${feedback.scenario}\nRequested change: ${notes.trim() || '[Describe the change here]'}\nKeep other sections unchanged.`;

  async function send() {
    if (!notes.trim() || sending) return;
    setSending(true);
    setStatus('Sending your note to APX…');
    try {
      const response = await fetch(`/api/dashboard/feedback?org=${encodeURIComponent(feedback.orgSlug)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          section, department: feedback.department, notes: notes.trim(),
          context: { period: feedback.period, view: feedback.view, months: feedback.months, scenario: feedback.scenario },
        }),
      });
      if (response.status === 429) {
        setStatus('You have sent a lot of notes in the last hour. Try again a little later; your note is still here.');
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setStatus(body?.error?.message ? `${body.error.message} Your note is still here.` : 'Your note could not be sent. It is still here; try again.');
        return;
      }
      setNotes('');
      saveDraft({ section, notes: '' });
      setStatus('Sent to the APX team. Thank you.');
      notify('Feedback sent to APX.');
    } catch {
      setStatus('Your note could not be sent. It is still here; try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <DashContext.Provider value={api}>
      {children}

      <NativeDialog id="detail-dialog" labelledBy="dialog-title" open={dialog !== null} onClose={closeDialog}>
        <div className="dialog-top">
          <span className="eyebrow" id="dialog-kicker">{dialog?.kicker ?? 'APX PERSPECTIVE'}</span>
          <button type="button" className="icon-btn" id="close-dialog" aria-label="Close dialog" onClick={closeDialog}><span data-icon="close"><Icon name="close" /></span></button>
        </div>
        <div id="dialog-body">{dialog?.body}</div>
        <div className="dialog-actions" id="dialog-actions">{dialog?.actions}</div>
      </NativeDialog>

      <NativeDialog
        id="feedback-dialog"
        labelledBy="feedback-title"
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        onOpen={(el) => el.querySelector<HTMLTextAreaElement>('#feedback-notes')?.focus()}
      >
        <div className="dialog-top">
          <span className="eyebrow">APX DESIGN FEEDBACK</span>
          <button type="button" className="icon-btn" id="feedback-close" aria-label="Close feedback" onClick={() => setFeedbackOpen(false)}><span data-icon="close"><Icon name="close" /></span></button>
        </div>
        <h2 id="feedback-title">Tell me what to change.</h2>
        <p className="dialog-copy">Choose a section and describe your edit. Your note, with what is on screen, goes to the APX team inside APX.</p>
        <label className="field-label" htmlFor="feedback-section">Dashboard section</label>
        <select
          id="feedback-section"
          className="feedback-field"
          value={section}
          onChange={(e) => { setSection(e.target.value); saveDraft({ section: e.target.value, notes }); }}
        >
          {FEEDBACK_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <label className="field-label" htmlFor="feedback-notes">What would you like changed?</label>
        <textarea
          id="feedback-notes"
          className="feedback-field"
          rows={4}
          maxLength={4000}
          placeholder="Example: Make the operating profit figure larger and show the margin beside it."
          value={notes}
          onChange={(e) => { const next = e.target.value.slice(0, 4000); setNotes(next); saveDraft({ section, notes: next }); }}
        />
        <label className="field-label" htmlFor="feedback-output">Your note, with the dashboard context</label>
        <textarea id="feedback-output" className="feedback-field feedback-output" rows={8} readOnly value={composed} />
        <p className="feedback-status" id="feedback-status" role="status">{status}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" id="feedback-done" onClick={() => setFeedbackOpen(false)}>Close</button>
          <button type="button" className="primary-button" id="feedback-copy" disabled={!notes.trim() || sending} onClick={send}>Send feedback to APX</button>
        </div>
      </NativeDialog>

      <div className="toast" id="toast" role="status" aria-live="polite" hidden={toast === null}>{toast}</div>
    </DashContext.Provider>
  );
}

/** The prototype's guide (`#help-btn`), with the demo wording replaced by what each part does here. */
function HelpBody() {
  return (
    <>
      <h2 id="dialog-title">Your financial world.<br />Ready to explore.</h2>
      <div className="dialog-copy">
        <ol>
          <li><strong>Choose a department.</strong> The five cards change the metrics, charts, insights and observations — all from this company’s own figures.</li>
          <li><strong>Your view follows your role.</strong> What you can do comes from your role in this company: a client can ask an analyst to review an item; an analyst can mark observations as reviewed and complete tasks. The identity shows your role and when you last signed in.</li>
          <li><strong>Explore the numbers.</strong> Change the period to 1, 3 or 6 months and, in Financial Analysis, choose Current or Last Completed. Manage Workflow shows the company’s real actions, owners and due dates. Toggle chart series and the grey baseline (the same months a year earlier); focus or hover over points for values.</li>
          <li><strong>Give direct feedback.</strong> Use Give feedback, choose a section and send your note to the APX team. More Apps shows active and planned departments plus the Xero build plan.</li>
          <li><strong>Take a closer look.</strong> Use the chart data button for the exact table, or Export for a CSV of what is on screen.</li>
        </ol>
        <p>Figures come from the data the company added to APX and the calculations APX ran on it; nothing is illustrative. Review requests, reviews and monthly targets you save are recorded in APX for the company’s team.</p>
      </div>
      <div className="dialog-callout">Xero is not connected yet: figures arrive through the uploads in Data Capture. What-if scenarios are kept separate from these actual figures.</div>
    </>
  );
}
