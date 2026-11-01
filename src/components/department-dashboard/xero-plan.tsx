'use client';

import { useDash } from './dash-context';

/** `app.js#showXeroPlan` — the proposed Xero build, opened from More Apps and the Compliance View. */
export function useXeroPlan(): () => void {
  const { showDialog, closeDialog } = useDash();
  return () => showDialog('XERO · PROPOSED BUILD', (
    <>
      <h2 id="dialog-title">Connect the numbers.<br />Keep control.</h2>
      <div className="dialog-copy">
        <p><strong>Recommended approach</strong><br />Keep APX as the dashboard and workflow layer. Add a secure backend that connects each Xero organisation using OAuth 2.0, with encrypted tokens stored on the server and access checked for each client.</p>
        <ol>
          <li><strong>Read-only pilot.</strong> Connect one authorised demo or pilot organisation. Bring in P&amp;L, balance sheet, receivables, payables and cash information using the relevant read-only API permissions. Check scope and plan eligibility before the pilot.</li>
          <li><strong>Reliable reporting.</strong> Map accounts and tracking categories, agree cash or accrual basis and date ranges, reconcile totals to Xero, and show the source organisation and last successful sync.</li>
          <li><strong>Controlled workflow.</strong> Prepare invoice or bill drafts in APX, validate tax coding and duplicates, and require an authorised reviewer before any write to Xero. Keep an audit trail and the returned Xero record ID.</li>
          <li><strong>Ongoing sync.</strong> Queue supported webhook events and scheduled refreshes with retries, deduplication and clear failed-sync states.</li>
        </ol>
        <p>
          <a href="https://developer.xero.com/documentation/guides/oauth2/auth-flow/" target="_blank" rel="noopener noreferrer">Xero OAuth guidance</a>
          {' · '}<a href="https://developer.xero.com/documentation/guides/oauth2/scopes/" target="_blank" rel="noopener noreferrer">API permissions</a>
          {' · '}<a href="https://developer.xero.com/pricing" target="_blank" rel="noopener noreferrer">Developer plans</a>
        </p>
      </div>
      <div className="dialog-callout">Build recommendation only. Xero is not connected yet: APX’s figures come from the data added in Data Capture, and what each person may do comes from their role in the company.</div>
    </>
  ), <button type="button" className="primary-button" onClick={closeDialog}>Back to APX</button>);
}
