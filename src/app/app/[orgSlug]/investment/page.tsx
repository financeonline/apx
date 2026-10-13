import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileDown, FileText, FileUp, LoaderCircle, PiggyBank } from 'lucide-react';
import { isMotionError } from '@/core/errors';
import { can } from '@/core/permissions';
import {
  INVESTMENT_DISCLAIMER, getInvestmentView, presentInvestmentReport, presentInvestmentStart,
  type InvestmentStart, type InvestmentView,
} from '@/modules/investment';
import { getAccessContext } from '@/modules/tenancy';
import { ButtonLink, buttonClass } from '@/components/ui/button';
import { Banner, Card, CardBody, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { requireModulePage, requirePermission } from '@/app/_lib/authz';
import { AutoRefresh } from '../marketing/_components/auto-refresh';
import { PackView } from './_components/pack-view';
import { RequestPackControl } from './_components/request-control';

export const dynamic = 'force-dynamic';

/**
 * Investment (ADR-171). Opening it shows a ready-made Investment Pack — nobody types a question —
 * shaped on the client's own example: the surplus split between the business, external investments
 * and liquidity; five years of growth and profit; three to five investment options from lower to very
 * high risk with an illustrative portfolio and its return scenarios; governance and the committee's
 * priorities. ChatGPT writes the words in a background job; every figure is APX's own arithmetic on
 * the company's figures. It downloads as Word or PDF. Marketing's page in shape (ADR-170).
 *
 * The page is a function of the pack's state, one panel per state: APX holds no figures yet (the
 * pack is built on them — import them, or enter the amount to allocate); ready to create (the base
 * year and the surplus APX would allocate, with an optional amount of one's own); being written (the
 * previous pack stays visible and the page refreshes itself, at once when the tab is shown again);
 * the last attempt failed (say why, offer a retry, keep the previous pack); and the pack itself, with
 * its toolbar. The important notice — illustrative, not advice — heads the page in every state and
 * closes the pack. `reports.view` reads it; switched off for the company is NOT FOUND for every role
 * (ADR-158).
 */

type Amount = { readonly required: boolean; readonly hint: string };

function NoFigures({ view, importHref }: { view: InvestmentView; importHref: string | null }) {
  return (
    <Card>
      <CardBody className="flex min-w-0 items-start gap-4">
        <IconBadge tint="pink"><FileUp /></IconBadge>
        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <h2 className="text-lg">APX needs the company’s figures</h2>
            <p className="mt-1 max-w-prose text-sm text-ink-muted">
              The pack starts from the latest year of revenue and net profit: it projects five years of growth from them and,
              by default, allocates that year’s net profit. APX holds no figures for {view.organisationName} yet.
            </p>
          </div>
          {importHref === null
            ? <p className="text-sm text-ink-muted">Ask your adviser to import the company’s figures.</p>
            : <div><ButtonLink href={importHref}><FileUp aria-hidden="true" /> Import the figures</ButtonLink></div>}
          {/* No pack without figures, even with an amount entered: every growth table and the comparison
              start from the base year's revenue and margin (ADR-171), so the request is refused. */}
        </div>
      </CardBody>
    </Card>
  );
}

function ReadyToCreate({ view, start, amount, orgSlug }: { view: InvestmentView; start: InvestmentStart; amount: Amount; orgSlug: string }) {
  return (
    <Card>
      <CardBody className="flex min-w-0 items-start gap-4">
        <IconBadge tint="violet"><PiggyBank /></IconBadge>
        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <h2 className="text-lg">No investment pack yet</h2>
            <p className="mt-1 max-w-prose text-sm text-ink-muted">
              ChatGPT writes the words from the company profile — the strategic objective, the reinvestment levers, three to
              five investment options from lower to very high risk, governance and the committee’s priorities — and APX works
              out every figure: the surplus split, five years of growth and profit, the portfolio and its return scenarios. It
              usually takes under a minute.
            </p>
          </div>
          <div className="rounded-2xl border border-line bg-surface-sunken p-4 text-sm">
            <p className="text-ink"><span className="text-ink-muted">Built on </span><span className="tabular">{start.basis}</span></p>
            {start.sourceNote === null ? null : <p className="mt-1 text-xs text-ink-muted">{start.sourceNote}</p>}
            <p className="mt-3 font-medium text-ink">{start.surplusLine}</p>
          </div>
          {view.canRefresh
            ? <RequestPackControl orgSlug={orgSlug} label="Create the investment pack" amount={amount} />
            : <p className="text-sm text-ink-muted">An owner or adviser can create it.</p>}
        </div>
      </CardBody>
    </Card>
  );
}

function Preparing({ hasPrevious }: { hasPrevious: boolean }) {
  return (
    <Card>
      <CardBody className="flex min-w-0 items-start gap-4">
        <IconBadge tint="pink"><LoaderCircle className="animate-spin" /></IconBadge>
        <div className="min-w-0" role="status">
          <h2 className="text-lg">Preparing your investment pack — usually under a minute</h2>
          <p className="mt-1 text-sm text-ink-muted">
            {hasPrevious
              ? 'ChatGPT is writing a new pack from the company profile, and APX is working out its figures. The previous pack stays below until it is ready.'
              : 'ChatGPT is writing the pack from the company profile, and APX is working out its figures.'}
          </p>
          <AutoRefresh />
        </div>
      </CardBody>
    </Card>
  );
}

export default async function InvestmentPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'reports.view');
  requireModulePage(ctx, 'investment');

  let view: InvestmentView;
  try {
    view = await getInvestmentView(ctx);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const base = `/app/${orgSlug}`;
  const preparing = view.status === 'queued' || view.status === 'running';
  const failed = view.status === 'failed';
  const presentation = view.report === null ? null : presentInvestmentReport(view.report);
  const start = presentInvestmentStart(view);
  const amount: Amount = { required: start.amountRequired, hint: start.amountHint };
  const mayRequest = view.canRefresh && !preparing;
  const importHref = can(ctx, 'imports.review') ? `${base}/data/imports/new` : null;
  const download = (format: 'docx' | 'pdf') => `${base}/investment/download?format=${format}`;

  return (
    <>
      <PageHeader
        eyebrow="Investment"
        title="Investment pack"
        description={`A ready-made, illustrative investment pack for ${view.organisationName}: how its surplus could be split between growing the business, external investments and liquidity.`}
      />

      <div className="flex flex-col gap-6">
        <Banner tone="warn" title="Illustrative scenarios, not financial advice">{INVESTMENT_DISCLAIMER}</Banner>

        {presentation === null && !preparing && !failed
          ? (start.hasFigures
            ? <ReadyToCreate view={view} start={start} amount={amount} orgSlug={orgSlug} />
            : <NoFigures view={view} importHref={importHref} />)
          : null}

        {preparing ? <Preparing hasPrevious={presentation !== null} /> : null}

        {failed ? (
          <Banner tone="danger" title="The pack could not be prepared">
            <p>{view.failure ?? 'Something went wrong while the pack was being written.'}</p>
            {presentation === null ? null : <p className="mt-1">The previous pack is still below.</p>}
            {presentation === null && !start.hasFigures && importHref !== null ? (
              <p className="mt-2"><Link href={importHref} className="font-medium underline">Import the company’s figures</Link></p>
            ) : null}
            {mayRequest ? (
              <div className="mt-3">
                <p className="mb-3">{start.surplusLine}</p>
                <RequestPackControl orgSlug={orgSlug} label="Try again" tone="secondary" amount={amount} />
              </div>
            ) : null}
          </Banner>
        ) : null}

        {presentation === null ? null : (
          <>
            <Card>
              <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-ink">
                      {preparing || failed ? 'Previous pack, generated ' : 'Generated '}
                      <span className="tabular">{presentation.generatedOn}</span>
                    </p>
                    <p className="text-xs text-ink-muted">{presentation.authorship}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <a href={download('docx')} download className={buttonClass('secondary')}>
                      <FileText aria-hidden="true" /> Download Word
                    </a>
                    <a href={download('pdf')} download className={buttonClass('secondary')}>
                      <FileDown aria-hidden="true" /> Download PDF
                    </a>
                  </div>
                </div>
                {mayRequest && !failed ? (
                  <div className="border-t border-line pt-4">
                    <p className="mb-3 text-sm text-ink-muted">{start.surplusLine}</p>
                    <RequestPackControl orgSlug={orgSlug} label="Refresh pack" tone="secondary" amount={amount} compact />
                  </div>
                ) : null}
              </CardBody>
            </Card>
            <PackView presentation={presentation} />
            <Banner tone="warn" title="Illustrative scenarios, not financial advice">{presentation.disclaimer.text}</Banner>
          </>
        )}
      </div>
    </>
  );
}
