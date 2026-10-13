import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type {
  InvestmentPresentation, PackBlock, PresentedPackCover, PresentedPackSection, PresentedPackSubsection,
} from '@/modules/investment';
import { Banner, Card, CardBody } from '@/components/ui/surfaces';
import { ChartBlock } from './charts';
import { PackTableView } from './pack-table';

/**
 * The Investment Pack on screen (ADR-171), in the app's dark design but in the client's document
 * shape: the cover with "INVESTMENT PACK | <month>", the strategic objective and the two headline
 * tiles; the executive capital allocation; "01 | Converting growth into surplus capital" and the
 * other sections with their tables, charts, options and priorities; the reference links. It draws
 * `presentInvestmentReport` — the same layout the Word file and the PDF draw — and decides no words
 * or figures of its own (SERVICE_ARCHITECTURE.md §8: components render view models). The important
 * notice is the page's, above and below this.
 *
 * Reference links open in a new tab and only http(s) addresses are links at all (the presentation
 * drops anything else); they are the model's suggestions, and the pack says APX has not checked them.
 */

function Cover({ cover }: { cover: PresentedPackCover }) {
  return (
    <header className="panel relative overflow-hidden rounded-card px-6 pb-6 pt-7 md:px-8">
      <div aria-hidden="true" className="bg-brand-gradient absolute inset-x-0 top-0 h-1" />
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{cover.dateLine}</p>
      <h2 id="investment-pack-title" className="mt-2 text-3xl md:text-4xl">{cover.organisationName}</h2>
      <p className="mt-2 text-sm font-semibold text-pink-icon">{cover.strapline}</p>
      <p className="mt-4 max-w-prose text-ink">
        <strong className="font-semibold">{cover.objectiveLead} </strong>
        {cover.objective}
      </p>
      <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cover.headlines.map((h, i) => (
          <li key={h.label} className={`rounded-2xl border border-line bg-surface-sunken p-4 border-t-2 ${i === 0 ? 'border-t-accent' : 'border-t-pink'}`}>
            <p className={`text-xs font-semibold uppercase tracking-[0.12em] ${i === 0 ? 'text-accent' : 'text-pink-icon'}`}>{h.label}</p>
            <p className="mt-1 font-mono text-4xl font-semibold tabular text-ink">{h.figure}</p>
            <p className="mt-1 text-sm text-ink-muted">{h.text}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-ink-muted">{cover.basis}</p>
    </header>
  );
}

function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-w-0 items-baseline gap-1 break-all text-accent hover:underline">
      {children}
      <ExternalLink aria-hidden="true" className="size-3.5 shrink-0 self-center" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Block({ block, heading }: { block: PackBlock; heading: string }) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p className="max-w-prose text-ink">
          {block.lead === null ? null : <strong className="font-semibold">{block.lead} </strong>}
          {block.text}
        </p>
      );
    case 'bullets':
      return (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-ink marker:text-accent">
          {block.items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      );
    case 'table':
      return <PackTableView table={block.table} />;
    case 'note':
      return <p className="text-xs italic text-ink-muted">{block.text}</p>;
    case 'notice':
      return <Banner tone={block.tone} title={block.title}>{block.text}</Banner>;
    case 'chart':
      return <ChartBlock chart={block.chart} heading={heading} />;
    case 'options':
      return (
        <ol className="flex flex-col gap-3">
          {block.items.map((o) => (
            <li key={o.number} className="rounded-2xl border border-line bg-surface-sunken p-4">
              <p className="flex items-baseline gap-3">
                <span className="tabular text-xl font-semibold text-accent">{o.number}</span>
                <span className="text-lg font-semibold text-ink">{o.name}</span>
              </p>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-pink-icon">Risk profile</span>
                <span aria-hidden="true" className="text-ink-faint">|</span>
                <span className="font-semibold text-ink">{o.riskLabel}</span>
              </p>
              {o.description === '' ? null : <p className="mt-1.5 text-sm text-ink">{o.description}</p>}
              {o.reference === null ? null : (
                <p className="mt-1.5 flex min-w-0 flex-wrap gap-x-1 text-xs text-ink-muted">
                  <span>Reference:</span>
                  <ExternalAnchor href={o.reference}>{o.reference}</ExternalAnchor>
                </p>
              )}
            </li>
          ))}
        </ol>
      );
    case 'priorities':
      return (
        <ol className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {block.items.map((p) => (
            <li key={p.label} className="rounded-2xl border border-line bg-surface-sunken p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">{p.label}</p>
              <p className="mt-1 font-semibold text-ink">{p.title}</p>
              {p.text === '' ? null : <p className="mt-1 text-sm text-ink-muted">{p.text}</p>}
            </li>
          ))}
        </ol>
      );
    case 'links':
      return (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink marker:text-accent">
          {block.items.map((item) => (
            <li key={`${item.label}:${item.url ?? ''}`} className="min-w-0">
              {item.url === null ? item.label : item.label === item.url
                ? <ExternalAnchor href={item.url}>{item.url}</ExternalAnchor>
                : <><span>{item.label}: </span><ExternalAnchor href={item.url}>{item.url}</ExternalAnchor></>}
            </li>
          ))}
        </ul>
      );
  }
}

function Blocks({ blocks, heading }: { blocks: readonly PackBlock[]; heading: string }) {
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block, i) => <Block key={`${block.kind}:${i}`} block={block} heading={heading} />)}
    </div>
  );
}

function Subsection({ sub }: { sub: PresentedPackSubsection }) {
  return (
    <Card id={sub.id} className="scroll-mt-6">
      <CardBody>
        <h3 id={`${sub.id}-title`} className="text-lg text-ink">{sub.title}</h3>
        <div className="mt-3"><Blocks blocks={sub.blocks} heading={sub.title} /></div>
      </CardBody>
    </Card>
  );
}

function Section({ section }: { section: PresentedPackSection }) {
  return (
    <section id={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-6">
      <h2 id={`${section.id}-title`} className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-accent/40 pb-2 text-2xl">
        {section.label === null ? null : (
          <>
            <span className="tabular font-semibold text-accent">{section.label}</span>
            <span aria-hidden="true" className="text-ink-faint">|</span>
          </>
        )}
        <span>{section.title}</span>
      </h2>
      <div className="flex flex-col gap-4">
        {section.blocks.length === 0 ? null : <Card><CardBody><Blocks blocks={section.blocks} heading={section.title} /></CardBody></Card>}
        {section.subsections.map((sub) => <Subsection key={sub.id} sub={sub} />)}
      </div>
    </section>
  );
}

export function PackView({ presentation }: { presentation: InvestmentPresentation }) {
  return (
    <article aria-labelledby="investment-pack-title" className="flex flex-col gap-8">
      <Cover cover={presentation.cover} />
      <nav aria-label="Pack sections" className="-mt-4 flex flex-wrap gap-2 text-sm">
        {presentation.sections.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="rounded-full border border-line bg-surface px-3 py-1 text-ink-muted transition-colors hover:border-accent/60 hover:bg-accent-soft hover:text-accent">
            {s.label === null ? s.title : `${s.label} · ${s.title}`}
          </a>
        ))}
      </nav>
      {presentation.sections.map((s) => <Section key={s.id} section={s} />)}
      <p className="text-xs text-ink-faint">{presentation.provenance}</p>
    </article>
  );
}
