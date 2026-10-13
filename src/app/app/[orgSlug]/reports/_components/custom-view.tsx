import {
  CUSTOM_DIMENSIONS, INDICATIVE_TEXT, NOT_AVAILABLE_TEXT, type CustomReportContent, type CustomSection, type FixedArea,
} from '@/modules/reporting';
import { Building2, HandCoins, Landmark, Receipt, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, CardBody, IconBadge, type IconTint } from '@/components/ui/surfaces';
import { AnswerView } from '../../analyst/answer-view';

const SECTION_ICONS: Readonly<Record<FixedArea, { icon: ReactNode; tint: IconTint }>> = {
  loans: { icon: <HandCoins />, tint: 'pink' },
  assets: { icon: <Building2 />, tint: 'violet' },
  vat: { icon: <Receipt />, tint: 'pink' },
  corporation_tax: { icon: <Landmark />, tint: 'violet' },
};

/**
 * One fixed section (ADR-156): MOTION's own figures for a chosen area, as stored with the report.
 * A figure that was not available says so, with its reason, instead of showing a number.
 */
function SectionCard({ section }: { section: CustomSection }) {
  const look = SECTION_ICONS[section.area];
  const boxed = section.rows.some((row) => row.box !== undefined);
  return (
    <Card>
      <CardBody>
        <div className="flex min-w-0 items-start gap-3">
          <IconBadge tint={look.tint} size="sm">{look.icon}</IconBadge>
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-ink">{section.title}</h2>
            {section.subtitle === null ? null : <p className="text-sm text-ink-muted">{section.subtitle}</p>}
          </div>
          {section.indicative ? <span className="ml-auto shrink-0"><Badge tone="warn">{INDICATIVE_TEXT}</Badge></span> : null}
        </div>
        {section.rows.length === 0 ? null : (
          <table className="mt-4 w-full border-collapse text-sm">
            <caption className="sr-only">{section.title}{section.subtitle === null ? '' : ` — ${section.subtitle}`}</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">
                {boxed ? <th scope="col" className="w-14 py-2 pr-3 font-medium">Box</th> : null}
                <th scope="col" className="py-2 pr-3 font-medium">Figure</th>
                <th scope="col" className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {section.rows.map((row) => (
                <tr key={`${row.box ?? ''}:${row.label}`} className="align-top">
                  {boxed ? <td className="py-2.5 pr-3 text-ink-muted">{row.box ?? ''}</td> : null}
                  <th scope="row" className="py-2.5 pr-3 text-left font-normal text-ink">
                    {row.label}
                    {row.value === null && row.reason !== null ? (
                      <span className="mt-0.5 block text-xs text-ink-muted">{row.reason}</span>
                    ) : null}
                  </th>
                  <td className="whitespace-nowrap py-2.5 text-right tabular-nums text-ink">
                    {row.value ?? <span className="text-ink-muted">{NOT_AVAILABLE_TEXT}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {section.notes.length === 0 ? null : (
          <ul className="mt-3 flex flex-col gap-1 text-xs text-ink-muted">
            {section.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The Custom AI Report on screen (Phase 17, R17-4): each question as it was asked, and the analyst's
 * stored answer rendered by the analyst's own component — the same sections, kind badges, evidence
 * links and "report this" control the analyst shows. Nothing is re-worded for the report.
 */
export function CustomView({
  content, orgSlug, canCreateAction,
}: { content: CustomReportContent; orgSlug: string; canCreateAction: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      {content.dimensions.length === 0 ? null : (
        <p className="text-sm text-ink-muted">
          Looking at: {content.dimensions.map((d) => CUSTOM_DIMENSIONS[d]).join(', ')}.
        </p>
      )}
      {(content.sections ?? []).length === 0 ? null : (
        <>
          <p className="text-xs text-ink-faint">
            These figures are APX&apos;s own, worked out when the report was produced — not the AI Analyst&apos;s.
          </p>
          {(content.sections ?? []).map((section) => <SectionCard key={section.area} section={section} />)}
        </>
      )}
      {content.entries.length === 0 ? (
        <p className="text-sm text-ink-muted">No question was answered by the AI Analyst in this report.</p>
      ) : (
        <p className="text-xs text-ink-faint">
          Every answer below is the AI Analyst&apos;s, under its usual checks: figures come from APX&apos;s
          calculations, and each statement says whether it is a fact, a calculation, an estimate, analysis
          or a recommendation.
        </p>
      )}
      {content.entries.map((entry, index) => (
        <Card key={entry.messageId}>
          <CardBody>
            <div className="flex min-w-0 items-start gap-3">
              <IconBadge tint="violet" size="sm"><Sparkles /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">{index + 1}. {entry.asked}</h2>
            </div>
            <div className="mt-4">
              <AnswerView
                orgSlug={orgSlug}
                message={{
                  id: entry.messageId, role: 'assistant', content: null, structured: entry.answer,
                  groundingStatus: entry.groundingStatus, evidenceBundleId: entry.evidenceBundleId, flagged: false,
                }}
                facts={null}
                canCreateAction={canCreateAction}
                animate={false}
              />
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
