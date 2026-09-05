import Link from 'next/link';
import type { AccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import type { Permission } from '@/core/permissions';

/**
 * Tenant navigation (UX_ARCHITECTURE.md §3.1, ADR-019).
 *
 * Seven items plus Settings, in a fixed order. Two rules make this a component rather than a list
 * in the layout:
 *
 *   - **An item the role lacks is hidden entirely, never shown disabled** (RBAC §5, §7.4). A
 *     disabled item tells somebody what exists and that they cannot have it, which is both a poor
 *     experience and a small information leak.
 *   - The permission is declared beside the item, so adding a section cannot forget to gate it.
 */

interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly permission: Permission;
  /** The §3.1 "what you'll find here" line, shown as the link title. */
  readonly hint: string;
}

const PRIMARY: readonly NavItem[] = [
  {
    label: 'Home', path: 'home', permission: 'dashboard.view',
    hint: 'Your health score, headline numbers, top risks and what needs doing',
  },
  {
    label: 'Insights', path: 'insights', permission: 'financials.view',
    hint: 'Biggest changes this period, alerts, and the reasons behind them',
  },
  {
    label: 'Money', path: 'money', permission: 'financials.view',
    hint: 'Profit and loss, cash, bank activity, who owes you and who you owe',
  },
  {
    label: 'Customers', path: 'customers', permission: 'customers.view',
    hint: 'Revenue by customer, concentration, overdue balances',
  },
  {
    label: 'Actions', path: 'actions', permission: 'actions.view',
    hint: 'Tasks assigned to people, with due dates and outcomes',
  },
  {
    label: 'Reports', path: 'reports', permission: 'reports.view',
    hint: 'The Monthly Management Report',
  },
  {
    label: 'Analyst', path: 'analyst', permission: 'ai.use',
    hint: 'Answers with evidence, drawn only from your validated numbers',
  },
];

/**
 * The Data menu (§3.1, ADR-037).
 *
 * Kept out of the primary seven so the navigation stays the length a person can scan, while an
 * adviser or admin still reaches the pages they work in with one click. A client never sees it.
 */
const DATA_MENU: readonly { label: string; path: string }[] = [
  { label: 'Add data', path: 'data/imports/new' },
  { label: 'Imports', path: 'data/imports' },
  { label: 'Documents', path: 'data/documents' },
  { label: 'Accounts', path: 'data/accounts' },
];

export function PrimaryNav({ ctx, orgSlug }: { ctx: AccessContext; orgSlug: string }) {
  const items = PRIMARY.filter((item) => can(ctx, item.permission));

  return (
    <nav aria-label="Sections" className="flex flex-wrap items-center gap-4 text-sm">
      {items.map((item) => (
        <Link
          key={item.path}
          href={`/app/${orgSlug}/${item.path}`}
          title={item.hint}
          className="text-ink-muted transition-colors hover:text-ink"
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function DataMenu({ ctx, orgSlug }: { ctx: AccessContext; orgSlug: string }) {
  // §3.1: shown to roles with `imports.review`; a client never sees it.
  if (!can(ctx, 'imports.review')) return null;

  return (
    <details className="relative">
      <summary className="cursor-pointer list-none text-ink-muted transition-colors hover:text-ink">
        Data
      </summary>
      <div className="absolute right-0 z-10 mt-2 min-w-44 rounded-[0.5rem] border border-line bg-surface p-1">
        {DATA_MENU.map((item) => (
          <Link
            key={item.path}
            href={`/app/${orgSlug}/${item.path}`}
            className="block rounded-[0.375rem] px-3 py-2 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
          >
            {item.label}
          </Link>
        ))}
      </div>
    </details>
  );
}

/** Exported for tests: which items a role sees is a permission decision worth asserting. */
export function visibleNavItems(ctx: AccessContext): string[] {
  return PRIMARY.filter((item) => can(ctx, item.permission)).map((item) => item.label);
}

export function showsDataMenu(ctx: AccessContext): boolean {
  return can(ctx, 'imports.review');
}
