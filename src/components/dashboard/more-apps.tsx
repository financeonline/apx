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

const TILE = 'flex min-w-0 items-center gap-4 rounded-[0.875rem] border px-6 py-5';

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
        className="flex h-full w-full min-w-0 items-center gap-3 rounded-[0.625rem] border border-dashed border-line-strong bg-surface-sunken px-4 py-3 text-left transition-colors hover:border-accent/50"
      >
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent [&_svg]:size-[1.125rem]">
          <LayoutGrid />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-semibold text-ink">More apps</span>
          <span className="mt-0.5 block truncate text-xs text-ink-muted">Every department</span>
        </span>
        <Plus aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="more-apps-title"
        // A click on the backdrop lands on the dialog element itself, never on its panel.
        onClick={(event) => { if (event.target === dialog.current) close(); }}
        className="theme-lobby m-auto max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-2rem))] overflow-y-auto rounded-[1.5rem] border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/35 backdrop:backdrop-blur-[2px]"
      >
        <div className="relative px-6 pt-8 pb-8 sm:px-10 sm:pt-10">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute top-6 right-6 flex size-14 items-center justify-center rounded-full border-2 border-pink text-ink transition-colors hover:bg-accent-soft sm:top-8 sm:right-8"
          >
            <X aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </button>

          <p className="text-[0.6875rem] font-semibold tracking-[0.24em] text-accent uppercase">Your APX workspace</p>
          <h2
            id="more-apps-title"
            className="mt-6 pr-16 font-[family-name:var(--lobby-serif)] text-4xl leading-[1.1] font-normal text-[color:var(--lobby-wine)] sm:text-5xl"
          >
            One system.
            <br />
            More possibilities.
          </h2>
          <p className="mt-8 text-[0.9375rem] text-ink-muted">
            {count === 0
              ? 'Your departments appear here once you may open one.'
              : `Your ${countWord} active ${count === 1 ? 'department is' : 'departments are'} ready to explore.`}
          </p>

          {count > 0 ? (
            <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {departments.map((department) => (
                <li key={department.key} className="min-w-0">
                  <Link
                    href={department.href}
                    onClick={close}
                    className={`${TILE} h-full border-line bg-surface transition-[border-color,box-shadow] duration-200 hover:border-accent/40 hover:shadow-[var(--glow-card)]`}
                  >
                    <span aria-hidden="true" className="shrink-0 text-accent [&_svg]:size-7 [&_svg]:stroke-[1.5]">{department.icon}</span>
                    <span className="min-w-0 leading-tight">
                      <span className="block truncate text-[0.9375rem] font-semibold text-ink">{department.title}</span>
                      <span className="mt-1.5 block truncate text-sm text-ink-muted">Active department · Open</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <h3 className="mt-10 text-base font-semibold text-[color:var(--lobby-wine)]">Additional departments · planned concepts</h3>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {PLANNED.map((planned) => (
              <li key={planned.title} className={`${TILE} border-line bg-surface-sunken`}>
                <Layers aria-hidden="true" className="size-7 shrink-0 text-accent" strokeWidth={1.5} />
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[0.9375rem] font-semibold text-ink">{planned.title}</span>
                  <span className="mt-1.5 block text-sm text-ink-muted">Planned · {planned.line}</span>
                </span>
              </li>
            ))}
          </ul>

          <section aria-labelledby="more-apps-xero" className="mt-6 rounded-[0.875rem] border border-line bg-surface-sunken px-6 py-6 sm:px-8">
            <h3 id="more-apps-xero" className="text-xl font-semibold text-[color:var(--lobby-wine)]">Xero integration</h3>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-muted">
              Bring accounting data into APX with a secure connection and approval controls.
            </p>
          </section>

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={close}
              className="rounded-[0.75rem] border border-line-strong bg-surface px-8 py-3.5 text-[0.9375rem] text-ink transition-colors hover:border-accent/50"
            >
              Back to dashboard
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
