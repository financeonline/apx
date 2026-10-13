import type {
  MarketingPresentation, PresentedCover, PresentedSection, PresentedSubsection, ReportBlock, ReportTable,
} from '@/modules/marketing';
import { Banner, Card, CardBody } from '@/components/ui/surfaces';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shadcn';

/**
 * The Marketing report on screen (ADR-170), in the app's dark design but in the client's document
 * shape: the cover, the executive overview, "SECTION 0X | Title" with its numbered parts, the sources.
 * It draws `presentMarketingReport` — the same layout the Word file and the PDF draw — and decides no
 * words or figures of its own (SERVICE_ARCHITECTURE.md §8: components render view models).
 *
 * APX's fixed notices (competitors directional, budget illustrative, figures from APX) are banners
 * where the document puts them, so nobody reads a comparator or a budget line without its caveat.
 */

/** The effort split's colours, the chart palette in order (static, so Tailwind sees them). */
const SHARE_FILL = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5', 'bg-chart-6'] as const;

function Cover({ cover }: { cover: PresentedCover }) {
  return (
    <header className="panel relative overflow-hidden rounded-card px-6 pb-6 pt-7 md:px-8">
      <div aria-hidden="true" className="bg-brand-gradient absolute inset-x-0 top-0 h-1" />
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{cover.title}</p>
      <h2 id="marketing-report-title" className="mt-2 text-3xl md:text-4xl">{cover.organisationName}</h2>
      <p className="mt-3 text-sm font-semibold uppercase tracking-[0.08em] text-pink-icon">{cover.strapline}</p>
      <p className="mt-1 text-sm text-ink-muted">{cover.dateLine}</p>
      {cover.links.length === 0 ? null : (
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {cover.links.map((link) => (
            <li key={`${link.label}:${link.url}`} className="min-w-0">
              <span className="text-ink-faint">{link.label}: </span>
              <span className="break-all text-ink">{link.url}</span>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

function ReportTableView({ table }: { table: ReportTable }) {
  return (
    // The table spans the card edge to edge and scrolls inside itself on a narrow screen.
    <div className="-mx-6">
      <Table>
        <caption className="sr-only">{table.caption}</caption>
        <TableHeader>
          <TableRow className="border-b border-line bg-pink-soft align-baseline">
            {table.columns.map((column, i) => (
              <TableHead key={`${i}:${column}`} scope="col" className={table.numeric[i] ? 'text-right text-pink-icon' : 'text-pink-icon'}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row, r) => (
            <TableRow key={`${table.caption}:${r}`}>
              {row.map((cell, i) => {
                const content = (
                  <>
                    {cell.text}
                    {cell.detail === null ? null : <span className="mt-0.5 block text-xs font-normal text-ink-muted">{cell.detail}</span>}
                  </>
                );
                // The first column names the row (a sector, a year's indicator), so it is the row's header.
                return i === 0 ? (
                  <th key={`${r}:${i}`} scope="row" className="whitespace-pre-line px-5 py-3 text-left font-medium text-ink">{content}</th>
                ) : (
                  <TableCell key={`${r}:${i}`} className={table.numeric[i] ? 'whitespace-nowrap text-right tabular text-ink' : 'whitespace-pre-line break-words text-ink'}>
                    {content}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Block({ block }: { block: ReportBlock }) {
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
      return <ReportTableView table={block.table} />;
    case 'note':
      return <p className="text-xs italic text-ink-muted">{block.text}</p>;
    case 'notice':
      return <Banner tone={block.tone} title={block.title}>{block.text}</Banner>;
    case 'concepts':
      return (
        <ol className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {block.items.map((c) => (
            <li key={c.number} className="rounded-2xl border border-line bg-surface-sunken p-4">
              <p className="flex items-baseline gap-2">
                <span className="tabular text-lg font-semibold text-accent">{c.number}</span>
                <span className="font-semibold text-ink">{c.title}</span>
              </p>
              <p className="mt-1.5 text-sm text-ink">{c.description}</p>
              {c.purpose === '' ? null : <p className="mt-1 text-xs text-ink-muted">{c.purpose}</p>}
            </li>
          ))}
        </ol>
      );
    case 'split':
      return (
        <div>
          <p className="font-semibold text-ink">{block.lead}</p>
          <div aria-hidden="true" className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken">
            {block.shares.map((s, i) => (s.width === null ? null : (
              <span key={s.label} className={SHARE_FILL[i % SHARE_FILL.length]} style={{ width: s.width }} />
            )))}
          </div>
          <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {block.shares.map((s, i) => (
              <li key={s.label} className="flex items-center gap-2">
                <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${SHARE_FILL[i % SHARE_FILL.length]}`} />
                <span className="min-w-0 flex-1 text-ink">{s.label}</span>
                <span className="tabular text-ink-muted">{s.share}</span>
              </li>
            ))}
          </ul>
          {block.note === null ? null : <p className="mt-2 text-xs text-ink-muted">{block.note}</p>}
        </div>
      );
  }
}

function Blocks({ blocks }: { blocks: readonly ReportBlock[] }) {
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block, i) => <Block key={`${block.kind}:${i}`} block={block} />)}
    </div>
  );
}

function Subsection({ sub }: { sub: PresentedSubsection }) {
  return (
    <Card id={sub.id} className="scroll-mt-6">
      <CardBody>
        <h3 id={`${sub.id}-title`} className="text-lg text-ink">
          {sub.number === null ? null : <span className="mr-2 tabular text-pink-icon">{sub.number}</span>}
          {sub.title}
        </h3>
        <div className="mt-3"><Blocks blocks={sub.blocks} /></div>
      </CardBody>
    </Card>
  );
}

function Section({ section }: { section: PresentedSection }) {
  return (
    <section id={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-6">
      <h2 id={`${section.id}-title`} className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-accent/40 pb-2 text-2xl">
        {section.label === null ? null : (
          <>
            <span className="text-sm font-semibold uppercase tracking-[0.14em] text-accent">{section.label}</span>
            <span aria-hidden="true" className="text-ink-faint">|</span>
          </>
        )}
        <span>{section.title}</span>
      </h2>
      <div className="flex flex-col gap-4">
        {section.blocks.length === 0 ? null : <Card><CardBody><Blocks blocks={section.blocks} /></CardBody></Card>}
        {section.subsections.map((sub) => <Subsection key={sub.id} sub={sub} />)}
      </div>
    </section>
  );
}

export function ReportView({ presentation }: { presentation: MarketingPresentation }) {
  return (
    <article aria-labelledby="marketing-report-title" className="flex flex-col gap-8">
      <Cover cover={presentation.cover} />
      <nav aria-label="Report sections" className="-mt-4 flex flex-wrap gap-2 text-sm">
        {presentation.sections.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="rounded-full border border-line bg-surface px-3 py-1 text-ink-muted transition-colors hover:border-accent/60 hover:bg-accent-soft hover:text-accent">
            {s.label === null ? s.title : `${s.label.replace('SECTION', 'Section')} · ${s.title}`}
          </a>
        ))}
      </nav>
      {presentation.sections.map((s) => <Section key={s.id} section={s} />)}
      <p className="text-xs text-ink-faint">{presentation.provenance}</p>
    </article>
  );
}
