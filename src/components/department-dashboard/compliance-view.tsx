import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { ComplianceCardView } from '@/modules/departments';
import { ABOVE_CARD_LINK, CardLink } from '@/components/ui/clickable-card';
import { DataIcon } from './icon';

/**
 * "Compliance View" — exactly the older Home's "Workspace status" lines (owner, 2026-11-02; ADR-179):
 * the calculation's state, the basis line, and for whoever keeps the data the uploads waiting for
 * review, the last data added, VAT and Corporation Tax. A line the reader may not see is left out.
 *
 * The whole card opens Data progress (`/data/progress`) — its one primary link, "Add or check your
 * data", stretched over the card (`CardLink`); each line keeps its own page and sits above that layer.
 * A reader who may not open Data progress gets a plain card. `checks` keeps the prop's earlier name.
 */
export function ComplianceView({ checks: card }: { checks: ComplianceCardView }) {
  const linked = card.progressHref !== null;
  return (
    <section
      className={`compliance-card${linked ? ' is-link' : ''}`}
      style={{ '--apx-i': 2 } as CSSProperties}
      aria-labelledby="compliance-title"
    >
      <div className="mini-heading"><span className="eyebrow">COMPLETENESS &amp; CONNECTIONS</span><DataIcon name="shield" /></div>
      <h3 id="compliance-title">Compliance view<span className="red-dot">.</span></h3>
      <div className={`compliance-status${card.recalculating ? '' : ' is-current'}`} id="compliance-status">
        <span className={card.recalculating ? 'warning-dot' : 'current-dot'} />
        <strong>{card.status}</strong>
      </div>
      {card.basisLine ? <p className="compliance-basis">{card.basisLine}</p> : null}
      {card.rows.length > 0 ? (
        <ul className="compliance-lines" id="compliance-checks">
          {card.rows.map((row) => (
            <li key={row.key}>
              <Link href={row.href} className={`compliance-row ${row.attention ? 'warning' : 'ok'} ${ABOVE_CARD_LINK}`}>
                <span className="check-state" aria-hidden="true">{row.attention ? '!' : '✓'}</span>
                <div><strong>{row.title}</strong></div>
                <span>{row.value}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {linked ? (
        <CardLink href={card.progressHref!} className="text-button compliance-more">
          Add or check your data <DataIcon name="arrow" />
        </CardLink>
      ) : null}
    </section>
  );
}
