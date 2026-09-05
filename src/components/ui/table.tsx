import type { ReactNode } from 'react';

/** Wide tables scroll inside their own container; the page body never scrolls horizontally. */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
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
