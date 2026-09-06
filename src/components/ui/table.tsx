import type { ReactNode } from 'react';

/**
 * Wide tables scroll inside their own container; the page body never scrolls horizontally.
 *
 * Two classes carry that, and both are load-bearing.
 *
 * `min-w-0` because a flex or grid child defaults to `min-width: auto` — its CONTENT width — so the
 * container would refuse to shrink below the 36rem table.
 *
 * `relative` because the screen-reader text inside these tables is `position: absolute`, and an
 * absolutely-positioned box is laid out against its nearest POSITIONED ancestor. With none, that is
 * the page itself: the captions sat at x=600 inside the wide table, escaped the scroll container
 * entirely, and dragged the whole of Profit and loss 281px sideways on a 320px phone — while every
 * visible element was correctly clipped, which is why it took a browser to find (ADR-058.12).
 */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-w-0 overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function THead({ columns }: { columns: readonly string[] }) {
  return (
    <thead>
      <tr className="border-b border-line text-left">
        {columns.map((column) => (
          <th
            key={column}
            scope="col"
            className="px-5 py-2.5 text-xs font-medium uppercase tracking-[0.08em] text-ink-faint"
          >
            {column}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-line">{children}</tbody>;
}

export function TR({ children }: { children: ReactNode }) {
  return <tr className="align-top">{children}</tr>;
}

export function TD({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-5 py-3 ${className}`.trim()}>{children}</td>;
}
