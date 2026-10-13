'use client';

import { useState, type ReactNode } from 'react';
import type { PackTable } from '@/modules/investment';
import { Button } from '@/components/ui/shadcn';
import { PackTableView } from './pack-table';

/**
 * A chart of the pack with its text equivalent (ADR-171; UX_ARCHITECTURE.md §11), as the trend
 * charts do it: the drawing carries a one-sentence summary for a screen reader, and the chart's own
 * table is ALWAYS in the document — "Show as table" changes whether it is visible, never whether it
 * exists, so a screen reader has every figure whatever a sighted reader has chosen.
 */
export function ChartFrame({
  id,
  title,
  showTitle,
  table,
  children,
}: {
  id: string;
  title: string;
  /** False when the heading above already says the same ("Relative risk positioning"). */
  showTitle: boolean;
  table: PackTable;
  children: ReactNode;
}) {
  const [tableVisible, setTableVisible] = useState(false);
  const tableId = `${id}-table`;
  return (
    <figure aria-label={title} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {showTitle ? <figcaption className="font-semibold text-accent">{title}</figcaption> : <span />}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={tableVisible}
          aria-controls={tableId}
          onClick={() => setTableVisible((visible) => !visible)}
        >
          {tableVisible ? 'Hide table' : 'Show as table'}
        </Button>
      </div>
      {children}
      <div id={tableId} className={tableVisible ? 'mt-1' : 'sr-only'}>
        <PackTableView table={table} bleed={false} />
      </div>
    </figure>
  );
}
