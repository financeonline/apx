import type { CSSProperties } from 'react';
import type { KeyIndicatorsPanel } from '@/modules/departments';
import { FeedbackButton } from './buttons';

/** "Key Report Indicators" (`#report-summary`) — Financial Analysis only: the financial year's story. */
export function KeyReportIndicators({ panel }: { panel: KeyIndicatorsPanel }) {
  return (
    <section className="report-summary" id="report-summary" data-section="report-summary" aria-labelledby="report-summary-title">
      <div className="report-summary-heading">
        <div><span className="eyebrow">FROM YOUR FINANCIAL REPORT</span><h3 id="report-summary-title">Key Report Indicators<span className="red-dot">.</span></h3></div>
        <div className="report-summary-tools">
          <span className="report-period">{panel.period}</span>
          <FeedbackButton section="report-summary" ariaLabel="Give feedback on report summary" />
        </div>
      </div>
      <div className="report-points">
        {panel.cards.map((card, i) => (
          <article className="report-point" key={card.number} style={{ '--apx-i': i } as CSSProperties}>
            <div className="report-point-top"><span className="report-number">{card.number}</span>{card.change ? <span className="report-change">{card.change}</span> : null}</div>
            <h4>{card.title}</h4>
            <strong className="report-value" style={{ '--apx-i': i } as CSSProperties}>{card.value}<span>{card.valueNote}</span></strong>
            <p>{card.sentence}</p>
            <div className="report-focus"><span>FOCUS</span>{card.focus}</div>
          </article>
        ))}
      </div>
      <p className="report-source">{panel.source}</p>
    </section>
  );
}
