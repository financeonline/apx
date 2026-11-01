'use client';

import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import type { DepartmentId, PriorityItem, Queue } from '@/modules/departments';
import { useDash } from './dash-context';
import { AsyncButton } from './async-button';
import { Icon } from './icon';

type Filter = 'open' | 'all' | 'reviewed';

/**
 * "Priorities & observations" / "Tasks & approvals" / "Analyst review queue" (`app.js#renderQueue`,
 * `#openItem`): the filter, the rows and the item dialog. A client asks for an analyst's review (an
 * engagement request); an analyst marks an observation reviewed (the alert's status) or completes a
 * task (the action's status). Every item also opens its own page.
 */
export function PrioritiesQueue({ orgSlug, dept, queue, isAnalyst, can }: {
  orgSlug: string; dept: DepartmentId; queue: Queue; isAnalyst: boolean;
  can: { readonly requestReview: boolean; readonly markReviewed: boolean; readonly completeTasks: boolean };
}) {
  const { showDialog, closeDialog, actions } = useDash();
  const [filter, setFilter] = useState<Filter>('open');
  const workflow = dept === 'workflow';
  const items = queue.items.filter((p) => filter === 'all' || (filter === 'reviewed' ? p.reviewed : !p.reviewed));

  function open(item: PriorityItem) {
    const mayReview = isAnalyst && ((item.kind === 'alert' && can.markReviewed) || (item.kind === 'action' && can.completeTasks));
    const reviewLabel = item.kind === 'action'
      ? (item.reviewed ? 'Reopen task' : 'Complete task')
      : (item.reviewed ? 'Reopen observation' : 'Mark as reviewed');
    const callout = item.reviewed
      ? (item.kind === 'action' ? 'This task is completed.' : 'This observation has been reviewed.')
      : item.requested ? 'A review request has been recorded for your analyst.' : 'From this company’s own figures.';
    const primary = mayReview ? (
      <AsyncButton run={() => actions.setItemReviewed(orgSlug, item.kind as 'alert' | 'action', item.recordId, !item.reviewed)}>{reviewLabel}</AsyncButton>
    ) : !isAnalyst && can.requestReview ? (
      <AsyncButton disabled={item.requested} run={() => actions.requestReview(orgSlug, { title: item.title, context: item.context, href: item.href })}>
        {item.requested ? 'Review requested' : 'Request analyst review'}
      </AsyncButton>
    ) : null;

    showDialog(`${isAnalyst ? 'ANALYST REVIEW' : 'CLIENT PERSPECTIVE'} · ACTUAL FIGURES`, (
      <>
        <h2 id="dialog-title">{item.title}</h2>
        <div className="dialog-copy">
          <p><strong>What we see</strong><br />{item.context}</p>
          <p><strong>Suggested next step</strong><br />{item.nextStep}</p>
        </div>
        <div className="dialog-callout">{callout} Requests and reviews are recorded in APX for the company’s team; nothing is sent outside APX.</div>
      </>
    ), (
      <>
        {primary}
        <Link className="secondary-button" href={item.href} onClick={closeDialog}>Open</Link>
        <button type="button" className="secondary-button" onClick={closeDialog}>Close</button>
      </>
    ));
  }

  const empty = queue.items.length === 0
    ? 'Nothing needs attention here right now.'
    : filter === 'reviewed'
      ? (workflow ? 'No completed tasks yet.' : 'No reviewed items yet.')
      : 'All items have been reviewed. Select All items to revisit them.';

  return (
    <section className="queue-card relocated-priorities" data-section="priorities" style={{ '--apx-i': 1 } as CSSProperties}>
      <div className="queue-heading">
        <div><span className="eyebrow" id="queue-kicker">{queue.kicker}</span><h3 id="queue-title">{queue.title}</h3></div>
        <label>
          <span className="sr-only">Priority filter</span>
          <select id="queue-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="open">Open items</option>
            <option value="all">All items</option>
            <option value="reviewed">{queue.reviewedWord}</option>
          </select>
        </label>
      </div>
      <div id="queue">
        {items.length ? items.map((p) => (
          <button type="button" className="queue-row" data-item={p.id} key={p.id} onClick={() => open(p)}>
            <span className="row-symbol"><Icon name={p.reviewed ? 'check' : p.icon} /></span>
            <span className="row-content"><strong>{p.title}</strong><small>{p.subtitle}</small></span>
            <span className={`row-tag ${p.reviewed ? 'reviewed' : ''}`}>{p.reviewed ? queue.reviewedWord : p.requested ? 'Requested' : p.tag}</span>
            <Icon name="arrow" />
          </button>
        )) : <div className="empty-queue">{empty}</div>}
      </div>
      <p className="queue-footnote" id="queue-footnote">{queue.footnote}</p>
    </section>
  );
}
