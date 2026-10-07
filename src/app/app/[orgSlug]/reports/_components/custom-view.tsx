import { CUSTOM_DIMENSIONS, type CustomReportContent } from '@/modules/reporting';
import { Sparkles } from 'lucide-react';
import { Card, CardBody, IconBadge } from '@/components/ui/surfaces';
import { AnswerView } from '../../analyst/answer-view';

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
      <p className="text-xs text-ink-faint">
        Every answer below is the AI Analyst&apos;s, under its usual checks: figures come from MOTION&apos;s
        calculations, and each statement says whether it is a fact, a calculation, an estimate, analysis
        or a recommendation.
      </p>
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
