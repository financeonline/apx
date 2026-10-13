import type { PackTable } from '@/modules/investment';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shadcn';

/**
 * One of the pack's tables on screen (ADR-171), drawn as the Marketing report draws its tables
 * (ADR-170): the client's coloured header row in the app's dark design, the first column as the
 * row's header, figures right-aligned in tabular digits, and a total row (the portfolio's "TOTAL")
 * set apart by a coral rule. Every cell arrives as text from `presentInvestmentReport`; nothing is
 * worked out here.
 *
 * No hooks, so the pack's sections and the charts' "Show as table" can both use it.
 */
export function PackTableView({ table, bleed = true }: { table: PackTable; bleed?: boolean }) {
  return (
    // In a card the table spans it edge to edge, and scrolls inside itself on a narrow screen.
    <div className={bleed ? '-mx-6' : undefined}>
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
          {table.rows.map((row, r) => {
            const isTotal = table.total && r === table.rows.length - 1;
            return (
              <TableRow key={`${table.caption}:${r}`} className={isTotal ? 'border-t-2 border-accent/60 bg-accent-soft font-semibold' : undefined}>
                {row.map((cell, i) => {
                  const content = (
                    <>
                      {cell.text}
                      {cell.detail === null ? null : <span className="mt-0.5 block text-xs font-normal text-ink-muted">{cell.detail}</span>}
                    </>
                  );
                  return i === 0 ? (
                    <th key={`${r}:${i}`} scope="row" className="whitespace-pre-line px-5 py-3 text-left font-medium text-ink">{content}</th>
                  ) : (
                    <TableCell key={`${r}:${i}`} className={table.numeric[i] ? 'whitespace-nowrap text-right tabular text-ink' : 'whitespace-pre-line break-words text-ink'}>
                      {content}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
