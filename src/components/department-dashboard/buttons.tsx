'use client';

import { useDash } from './dash-context';
import { DataIcon } from './icon';

/** A section's "Feedback" button (`[data-feedback-section]`): the feedback dialog, pre-set to it. */
export function FeedbackButton({ section, ariaLabel }: { section: string; ariaLabel?: string }) {
  const { openFeedback } = useDash();
  return (
    <button type="button" className="subtle-button" data-feedback-section={section} aria-label={ariaLabel} onClick={() => openFeedback(section)}>
      <DataIcon name="feedback" /> Feedback
    </button>
  );
}

/**
 * The prototype masthead's identity block (`.header-identity`): Give feedback, the private label,
 * the guide, the person's REAL role (no Client/Analyst switch — the role decides the view) and the
 * previous sign-in. It sits at the top of the dashboard because the dialogs it opens live here; the
 * APX shell's own header is shared by every company page and stays as it is.
 */
export function IdentityStrip({ name, role, isAnalyst, lastLogin }: {
  name: string; role: string; isAnalyst: boolean;
  lastLogin: { readonly time: string; readonly zone: string } | null;
}) {
  const { openFeedback, openHelp } = useDash();
  return (
    <div className="header-identity apx-dash-identity">
      <div className="top-actions">
        <button type="button" className="feedback-button" id="feedback-btn" onClick={() => openFeedback()}>
          <DataIcon name="feedback" /> Give feedback
        </button>
        <span className="private-label" title="Your company’s private APX workspace"><DataIcon name="lock" /> Private workspace</span>
        <button type="button" className="icon-btn" id="help-btn" aria-label="Dashboard guide" title="Dashboard guide" onClick={openHelp}>
          <DataIcon name="help" />
        </button>
        <div className="identity" title={name}>
          <DataIcon name={isAnalyst ? 'analyst' : 'client'} className="identity-avatar" />
          <span className="sr-only">Signed in as {name}, </span>
          {/* Styled as the prototype's `.identity select` (12px, 600) — a label now, not a switch. */}
          <span className="identity-role" id="role" style={{ fontSize: 12, fontWeight: 600, maxWidth: 160, padding: '5px 3px' }}>{role}</span>
        </div>
      </div>
      <div className="last-login">
        <DataIcon name="pin" className="location-mark" />
        <div>
          <strong>LAST LOGIN</strong>
          <p id="login-time">{lastLogin ? lastLogin.time : 'First sign-in'}</p>
          <span id="login-location">{lastLogin ? lastLogin.zone : 'Welcome to APX'}</span>
        </div>
      </div>
    </div>
  );
}
