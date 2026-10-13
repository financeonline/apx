import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './shadcn';

/**
 * MOTION's tables, on shadcn/ui's Table (SOW §6; ADR-151). Wide tables scroll inside their own
 * container; the page body never scrolls horizontally (the container keeps `min-w-0` and `relative`,
 * ADR-058.12 — see `shadcn/table.tsx`).
 *
 * `stack` (owner, 2026-10-14): where the table IS the page's content — a statement, a list of
 * invoices, of customers, of transactions — a phone shows each row as a small block of its own, one
 * cell to a line with the column's name beside it, instead of a table to scroll sideways. The column
 * names come from each cell's `label`; a cell without one (the row's name, its links) takes the
 * whole line. From `sm` up it is the same table as ever. The header row stays in the document for a
 * screen reader, which reads the labels as well.
 */
const STACKED = [
  'max-sm:block max-sm:min-w-0',
  'max-sm:[&>thead]:sr-only',
  'max-sm:[&>tbody]:block',
  // 16px in from the card's edge, as the card's own header is on a phone (`shadcn/card.tsx`).
  'max-sm:[&>tbody>tr]:block max-sm:[&>tbody>tr]:px-4 max-sm:[&>tbody>tr]:py-3',
  // Each cell on its own line, aligned as its column is (a "Why?" column stays on the right).
  'max-sm:[&>tbody>tr>*]:block max-sm:[&>tbody>tr>*]:px-0 max-sm:[&>tbody>tr>*]:py-0.5',
  // A labelled cell: its column's name on the left, its value on the right.
  'max-sm:[&>tbody>tr>[data-label]]:flex max-sm:[&>tbody>tr>[data-label]]:items-baseline max-sm:[&>tbody>tr>[data-label]]:justify-between max-sm:[&>tbody>tr>[data-label]]:gap-4 max-sm:[&>tbody>tr>[data-label]]:text-right',
  "max-sm:[&>tbody>tr>[data-label]]:before:shrink-0 max-sm:[&>tbody>tr>[data-label]]:before:text-left max-sm:[&>tbody>tr>[data-label]]:before:text-xs max-sm:[&>tbody>tr>[data-label]]:before:uppercase max-sm:[&>tbody>tr>[data-label]]:before:tracking-[0.08em] max-sm:[&>tbody>tr>[data-label]]:before:text-ink-faint max-sm:[&>tbody>tr>[data-label]]:before:content-[attr(data-label)]",
].join(' ');

export function TableWrap({
  children,
  stack = false,
  className,
}: {
  children: ReactNode;
  /** One block per row on a phone, for a table that is the page's content (see above). */
  stack?: boolean;
  /** Passed to the table: `min-w-0`, say, for two or three narrow columns that need no scrolling. */
  className?: string;
}) {
  return <Table className={cn(stack && STACKED, className)}>{children}</Table>;
}

export function THead({ columns }: { columns: readonly string[] }) {
  return (
    <TableHeader>
      <TableRow className="border-b border-line align-baseline">
        {columns.map((column) => <TableHead key={column} scope="col">{column}</TableHead>)}
      </TableRow>
    </TableHeader>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <TableBody>{children}</TableBody>;
}

export function TR({ children }: { children: ReactNode }) {
  return <TableRow>{children}</TableRow>;
}

export function TD({
  children,
  className = '',
  label,
}: {
  children: ReactNode;
  className?: string;
  /**
   * The cell's column name, shown beside it when a `stack` table is a list of blocks on a phone. The
   * value is wrapped so it stays one piece on that line, however many parts it has.
   */
  label?: string;
}) {
  if (label === undefined) return <TableCell className={className}>{children}</TableCell>;
  return (
    <TableCell className={className} data-label={label}>
      <span className="min-w-0">{children}</span>
    </TableCell>
  );
}
