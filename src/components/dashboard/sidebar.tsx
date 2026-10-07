'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity, ArrowLeftRight, Bell, Briefcase, Building2, ChartColumn, CircleUser, Database, FileText, FileUp,
  House, Inbox, Landmark, LayoutGrid, Lightbulb, ListChecks, Settings, ShieldAlert, Sparkles, Users, Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * The tenant sidebar (ADR-155), as the owner's reference: an icon and a label per section, the
 * current one a solid violet pill. The server decides WHICH links exist (permissions, flags —
 * `nav.tsx`, RBAC §5); this only draws them and marks the current one.
 */

export type SidebarIcon =
  | 'home' | 'departments' | 'insights' | 'money' | 'customers' | 'actions' | 'engagement' | 'reports'
  | 'analyst' | 'funding' | 'add-data' | 'imports' | 'documents' | 'accounts' | 'notifications' | 'settings'
  | 'portfolio' | 'switch' | 'account' | 'alerts' | 'assignments' | 'jobs' | 'audit' | 'users';

const ICONS: Readonly<Record<SidebarIcon, LucideIcon>> = {
  home: House, departments: LayoutGrid, insights: Lightbulb, money: Wallet, customers: Users,
  actions: ListChecks, engagement: Inbox, reports: ChartColumn, analyst: Sparkles, funding: Landmark,
  'add-data': FileUp, imports: Database, documents: FileText, accounts: ListChecks,
  notifications: Bell, settings: Settings, portfolio: Building2, switch: ArrowLeftRight, account: CircleUser,
  alerts: ShieldAlert, assignments: Briefcase, jobs: Activity, audit: FileText, users: Users,
};

export interface SidebarLink {
  readonly label: string;
  readonly href: string;
  readonly icon: SidebarIcon;
  readonly hint?: string;
  /** The path prefix that marks this link current, when it is not the href (a section's pages). */
  readonly match?: string;
  /** A count shown as a small pill, with its words for screen readers. */
  readonly count?: { readonly value: number; readonly srText: string };
}

export interface SidebarGroup {
  readonly label: string;
  readonly links: readonly SidebarLink[];
}

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Item({ link, current }: { link: SidebarLink; current: boolean }) {
  const Icon = ICONS[link.icon];
  return (
    <Link
      href={link.href}
      title={link.hint}
      aria-current={current ? 'page' : undefined}
      className={`flex items-center gap-3 rounded-xl px-3 py-2 text-[0.9375rem] transition-colors ${
        current
          ? 'bg-accent font-medium text-on-accent shadow-[0_10px_24px_-12px_rgb(106_69_229/0.7)]'
          : 'text-ink hover:bg-accent-soft hover:text-accent'
      }`}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{link.label}</span>
      {link.count && link.count.value > 0 ? (
        <>
          <span aria-hidden="true" className={`rounded-full px-1.5 text-xs ${current ? 'bg-white/25' : 'bg-accent text-on-accent'}`}>
            {link.count.value}
          </span>
          <span className="sr-only"> ({link.count.srText})</span>
        </>
      ) : null}
    </Link>
  );
}

export function SidebarNav({ groups }: { groups: readonly SidebarGroup[] }) {
  const pathname = usePathname() ?? '';
  // The longest matching link is the current one, so /money/banking marks Money, not Home.
  const all = groups.flatMap((g) => g.links);
  const current = all
    .filter((l) => isCurrent(pathname, l.match ?? l.href))
    .sort((a, b) => (b.match ?? b.href).length - (a.match ?? a.href).length)[0]?.href ?? null;

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <nav key={group.label} aria-label={group.label} className="flex flex-col gap-1">
          {group.links.map((link) => <Item key={link.href} link={link} current={link.href === current} />)}
        </nav>
      ))}
    </div>
  );
}
