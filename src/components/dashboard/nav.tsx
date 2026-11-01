import Link from 'next/link';
import { moduleOn, type AccessContext, type ModuleKey } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import type { Permission } from '@/core/permissions';

/**
 * Tenant navigation (UX_ARCHITECTURE.md §3.1, ADR-019).
 *
 * Nine items plus Settings, in a fixed order (Departments since ADR-143, Requests since ADR-144). Two rules make this a component rather than a list
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
  /**
   * Whether the section's route exists yet.
   *
   * The seven items are the `ROUTE_ARCHITECTURE.md §4` contract and stay declared here as the
   * product's shape; a section whose phase has not landed is simply not LINKED, because a link to a
   * 404 is worse than an absence — it tells a paying customer their product is broken rather than
   * unfinished (ADR-057.4). Each flips to true with the phase that builds it.
   */
  readonly built: boolean;
}

const PRIMARY: readonly NavItem[] = [
  {
    label: 'Home', path: 'home', permission: 'dashboard.view',
    hint: 'Your health score, headline numbers, top risks and what needs doing',
    built: true,
  },
  {
    // ADR-143: the Departmental Dashboard (Agreement §4). Gated on `financials.view`, not
    // `dashboard.view`: a suspended member keeps the frozen Home and nothing else (ADR-044.4).
    label: 'Departments', path: 'departments', permission: 'financials.view',
    hint: 'Every part of the business at a glance, and how APX is running',
    built: true,
  },
  {
    label: 'Insights', path: 'insights', permission: 'financials.view',
    hint: 'Biggest changes this period, alerts, and the reasons behind them',
    built: true,
  },
  {
    label: 'Money', path: 'money', permission: 'financials.view',
    hint: 'Profit and loss, cash, bank activity, who owes you and who you owe',
    built: true,
  },
  {
    label: 'Customers', path: 'customers', permission: 'customers.view',
    hint: 'Revenue by customer, concentration, overdue balances',
    built: true,
  },
  {
    label: 'Actions', path: 'actions', permission: 'actions.view',
    hint: 'Tasks assigned to people, with due dates and outcomes',
    built: true,
  },
  {
    // ADR-144: Team/Client Management — requests and deliverables.
    label: 'Requests', path: 'engagement', permission: 'actions.view',
    hint: 'What has been asked of the team, and what it is delivering',
    built: true,
  },
  {
    label: 'Reports', path: 'reports', permission: 'reports.view',
    hint: 'Daily, weekly, monthly, adviser and custom reports',
    built: true,
  },
  {
    label: 'Analyst', path: 'analyst', permission: 'ai.use',
    hint: 'Answers with evidence, drawn only from your validated numbers',
    built: true,
  },
];

/**
 * The Data menu (§3.1, ADR-037).
 *
 * Kept out of the primary seven so the navigation stays the length a person can scan, while an
 * adviser or admin still reaches the pages they work in with one click. A client never sees it.
 */
const DATA_MENU: readonly { label: string; path: string; built: boolean }[] = [
  { label: 'Add data', path: 'data/imports/new', built: true },
  { label: 'Imports', path: 'data/imports', built: true },
  // Owner, 2026-11-02: where each upload is, which months are covered, what is stuck (Compliance View opens it).
  { label: 'Progress', path: 'data/progress', built: true },
  { label: 'Documents', path: 'data/documents', built: true },
  { label: 'Accounts', path: 'data/accounts', built: true },
];

export function PrimaryNav({ ctx, orgSlug }: { ctx: AccessContext; orgSlug: string }) {
  const items = PRIMARY.filter((item) => item.built && can(ctx, item.permission));

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
        {DATA_MENU.filter((item) => item.built).map((item) => (
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

/** The sections a role may open, as plain data for the sidebar (ADR-155). Same filter as PrimaryNav. */
/** ADR-158: the sections that belong to a switchable system. */
const SECTION_MODULES: Readonly<Record<string, ModuleKey>> = {
  customers: 'customers', actions: 'actions', engagement: 'actions', reports: 'reports', analyst: 'analyst',
};

export function sectionLinks(ctx: AccessContext): ReadonlyArray<{ label: string; path: string; hint: string }> {
  return PRIMARY.filter((item) => item.built && can(ctx, item.permission))
    .filter((item) => { const m = SECTION_MODULES[item.path]; return m === undefined || moduleOn(ctx, m); })
    .map(({ label, path, hint }) => ({ label, path, hint }));
}

/** The Data menu's pages, for roles with `imports.review` only (§3.1). */
export function dataLinks(ctx: AccessContext): ReadonlyArray<{ label: string; path: string }> {
  if (!can(ctx, 'imports.review')) return [];
  return DATA_MENU.filter((item) => item.built).map(({ label, path }) => ({ label, path }));
}

/** Exported for tests: which items a role sees is a permission decision worth asserting. */
export function visibleNavItems(ctx: AccessContext): string[] {
  return PRIMARY.filter((item) => item.built && can(ctx, item.permission)).map((item) => item.label);
}

/**
 * The permission decision on its own, ignoring whether the route is built.
 *
 * Kept separate so the RBAC tests still assert the full §4 contract — that a client is not offered
 * Actions because of `actions.view`, not because Actions happens to be unbuilt. When the phase
 * lands, `built` flips and no permission test changes.
 */
export function permittedNavItems(ctx: AccessContext): string[] {
  return PRIMARY.filter((item) => can(ctx, item.permission)).map((item) => item.label);
}

/** The sections whose routes exist today. */
export function builtNavItems(): string[] {
  return PRIMARY.filter((item) => item.built).map((item) => item.label);
}

export function showsDataMenu(ctx: AccessContext): boolean {
  return can(ctx, 'imports.review') && DATA_MENU.some((item) => item.built);
}
