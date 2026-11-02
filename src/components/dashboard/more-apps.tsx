'use client';

import Link from 'next/link';
import { useRef, type ReactNode } from 'react';
import { Layers, LayoutGrid, Plus, X } from 'lucide-react';

/**
 * "More apps" (owner's reference, 2026-10-29): the last tile of "Your departments" opens a window —
 * "Your APX workspace" — with the departments this reader may open, the departments APX plans next,
 * and the Xero integration. A native modal `<dialog>`: Escape, the close button, "Back to dashboard"
 * or a click on the backdrop closes it, and focus returns to the tile.
 */
export interface MoreAppsDepartment {
  readonly key: string;
  readonly title: string;
  readonly href: string;
  readonly icon: ReactNode;
}

const PLANNED = [
  { title: 'Payroll & People', line: 'Employee costs and pay cycles' },
  { title: 'Tax & Compliance', line: 'Deadlines and filing checks' },
  { title: 'Reporting & Packs', line: 'Management and client reports' },
  { title: 'Document Library', line: 'Source documents and records' },
] as const;

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const TILE = 'flex min-w-0 items-center gap-3 rounded-[0.5625rem] border px-4 py-4';

export function MoreApps({ departments }: { departments: readonly MoreAppsDepartment[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => dialog.current?.close();
  const count = departments.length;
  const countWord = WORDS[count] ?? String(count);

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-haspopup="dialog"
        className="flex h-full min-h-[4.375rem] w-full min-w-0 items-center gap-2.5 rounded-[0.625rem] border border-dashed border-line-strong bg-surface-sunken px-3 py-3 text-left transition-[border-color,transform,background-color] duration-200 hover:-translate-y-0.5 hover:border-accent/50 hover:bg-accent-soft/40"
      >
        <span aria-hidden="true" className="flex size-[2.0625rem] shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent [&_svg]:size-[1.125rem]">
          <LayoutGrid strokeWidth={1.6} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[0.75rem] font-semibold text-ink">More Apps</span>
          <span className="mt-1 block text-[0.6875rem] leading-snug text-ink-muted">Explore more departments</span>
        </span>
        <Plus aria-hidden="true" className="size-4 shrink-0 text-ink-faint lg:hidden xl:block" />
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="more-apps-title"
        // A click on the backdrop lands on the dialog element itself, never on its panel.
        onClick={(event) => { if (event.target === dialog.current) close(); }}
        className="m-auto max-h-[85dvh] w-[min(40.625rem,calc(100vw-2.125rem))] overflow-y-auto rounded-2xl border border-line-strong bg-surface p-0 text-ink shadow-[0_20px_100px_rgb(0_0_0/0.25)] backdrop:bg-black/30 backdrop:backdrop-blur-[4px]"
      >
        <div className="relative px-5 pt-6 pb-6 sm:px-[1.5625rem] sm:pt-[1.5625rem]">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute top-4 right-4 flex size-10 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent sm:top-5 sm:right-5"
          >
            <X aria-hidden="true" className="size-5" strokeWidth={1.6} />
          </button>

          <p className="text-[0.625rem] font-semibold tracking-[0.18em] text-accent uppercase">Your APX workspace</p>
          <h2
            id="more-apps-title"
            className="mt-4 pr-12 font-[family-name:var(--lobby-serif,var(--font-serif))] text-[1.6875rem] leading-[1.15] font-normal tracking-[-0.02em] text-[color:var(--lobby-wine,var(--color-ink))] sm:text-[1.875rem]"
          >
            One system.
            <br />
            More possibilities.
          </h2>
          <p className="mt-4 text-[0.8125rem] leading-relaxed text-ink-muted">
            {count === 0
              ? 'Your departments appear here once you may open one.'
              : `Your ${countWord} active ${count === 1 ? 'department is' : 'departments are'} ready to explore.`}
          </p>

          {count > 0 ? (
            <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {departments.map((department) => (
                <li key={department.key} className="min-w-0">
                  <Link
                    href={department.href}
                    onClick={close}
                    className={`${TILE} h-full border-line bg-surface transition-[border-color,box-shadow] duration-200 hover:border-accent/40 hover:shadow-[var(--glow-card)]`}
                  >
                    <span aria-hidden="true" className="shrink-0 text-accent [&_svg]:size-[1.375rem] [&_svg]:stroke-[1.6]">{department.icon}</span>
                    <span className="min-w-0 leading-tight">
                      <span className="block truncate text-[0.75rem] font-semibold text-ink">{department.title}</span>
                      <span className="mt-1.5 block truncate text-[0.6875rem] text-ink-muted">Active department · Open</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <h3 className="mt-7 text-[0.8125rem] font-semibold text-[color:var(--lobby-wine,var(--color-ink))]">Additional departments · planned concepts</h3>
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PLANNED.map((planned) => (
              <li key={planned.title} className={`${TILE} border-line bg-surface-sunken`}>
                <Layers aria-hidden="true" className="size-[1.375rem] shrink-0 text-accent" strokeWidth={1.6} />
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[0.75rem] font-semibold text-ink">{planned.title}</span>
                  <span className="mt-1.5 block text-[0.6875rem] text-ink-muted">Planned · {planned.line}</span>
                </span>
              </li>
            ))}
          </ul>

          <section aria-labelledby="more-apps-xero" className="mt-5 rounded-[0.5625rem] border border-line bg-accent-soft p-[1.125rem]">
            <h3 id="more-apps-xero" className="text-base font-semibold text-ink">Xero integration</h3>
            <p className="mt-2 text-[0.75rem] leading-[1.8] text-ink-muted">
              Bring accounting data into APX with a secure connection and approval controls.
            </p>
          </section>

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={close}
              className="rounded-[0.4375rem] border border-line-strong bg-surface px-[1.0625rem] py-[0.6875rem] text-[0.75rem] text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
            >
              Back to dashboard
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
