'use client';

import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import type { ClientRow } from '@/modules/departments';
import { useDash } from './dash-context';
import { AsyncButton } from './async-button';
import { Icon } from './icon';

/**
 * "Your client portfolio" (`app.js#renderClients`) — Client Management only: search, status filter,
 * the company's customers and the profile dialog. "Record review" (analysts) adds an engagement
 * item `Client review: <name>`; no customer is contacted.
 */
export function ClientWorkspace({ orgSlug, clients, canRecordReview }: { orgSlug: string; clients: readonly ClientRow[]; canRecordReview: boolean }) {
  const { showDialog, closeDialog, actions } = useDash();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'attention' | 'on-track'>('all');
  const q = query.trim().toLowerCase();
  const rows = clients.filter((c) => (!q || `${c.name} ${c.sector}`.toLowerCase().includes(q)) && (status === 'all' || c.status === status));

  function profile(c: ClientRow) {
    showDialog('CLIENT PROFILE · ACTUAL FIGURES', (
      <>
        <h2 id="dialog-title">{c.name}</h2>
        <div className="dialog-copy">
          <p><strong>Profile</strong> {c.sector}<br /><strong>Sales</strong> {c.owner}<br /><strong>Next review</strong> {c.nextReview}</p>
          <p><strong>Service scope</strong><br />{c.service}</p>
          <p><strong>Next step</strong><br />{c.nextStep}</p>
        </div>
        <div className="dialog-callout">From this company’s own invoices. Recording a review adds it to Client Management for the company’s team; it does not contact the customer or change the figures.</div>
      </>
    ), (
      <>
        {canRecordReview ? (
          <AsyncButton disabled={c.reviewRecorded} run={() => actions.recordClientReview(orgSlug, { name: c.name, nextStep: c.nextStep })}>
            {c.reviewRecorded ? 'Review recorded' : 'Record review'}
          </AsyncButton>
        ) : null}
        <Link className="secondary-button" href={c.href} onClick={closeDialog}>Open</Link>
        <button type="button" className="secondary-button" onClick={closeDialog}>Close</button>
      </>
    ));
  }

  return (
    <section className="client-workspace queue-card" id="client-workspace" data-section="clients" aria-labelledby="client-workspace-title" style={{ '--apx-i': 4 } as CSSProperties}>
      <div className="queue-heading">
        <div><span className="eyebrow">RELATIONSHIPS · OWNERSHIP · DELIVERY</span><h3 id="client-workspace-title">Your client portfolio</h3></div>
        <span className="sample-tag">YOUR CUSTOMERS</span>
      </div>
      <div className="client-controls">
        <label><span className="sr-only">Search clients</span><input id="client-search" type="search" placeholder="Search client or sector" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <label>
          <span className="sr-only">Client status</span>
          <select id="client-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">All clients</option>
            <option value="attention">Needs attention</option>
            <option value="on-track">On track</option>
          </select>
        </label>
      </div>
      <div id="client-list">
        {rows.length ? rows.map((c) => (
          <button type="button" className="client-row" data-client={c.id} key={c.id} onClick={() => profile(c)}>
            <span className="client-avatar">{c.name.slice(0, 1).toUpperCase()}</span>
            <span className="client-name"><strong>{c.name}</strong><small>{c.sector} · {c.owner}</small></span>
            <span className="client-review">Next review<strong>{c.nextReview}</strong></span>
            <span className={`client-tag ${c.status}`}>{c.reviewRecorded ? 'Review recorded' : c.status === 'attention' ? 'Needs attention' : 'On track'}</span>
            <Icon name="arrow" />
          </button>
        )) : <p className="empty-queue">{clients.length ? 'No clients match these filters.' : 'No customers yet. They appear once the company adds its sales invoices.'}</p>}
      </div>
      <p className="queue-footnote">Your company’s customers, from its sales invoices. Reviews are recorded in APX; no client is contacted.</p>
    </section>
  );
}
