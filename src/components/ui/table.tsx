import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './shadcn';

/**
 * MOTION's tables, on shadcn/ui's Table (SOW §6; ADR-151). Wide tables scroll inside their own
 * container; the page body never scrolls horizontally (the container keeps `min-w-0` and `relative`,
 * ADR-058.12 — see `shadcn/table.tsx`).
 */
export function TableWrap({ children }: { children: ReactNode }) {
  return <Table>{children}</Table>;
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

export function TD({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <TableCell className={className}>{children}</TableCell>;
}
