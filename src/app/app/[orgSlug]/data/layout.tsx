import { getAccessContext } from '@/modules/tenancy';
import { dataLinks } from '@/components/dashboard/nav';
import { SectionTabs } from '@/components/dashboard/section-tabs';

/**
 * The Data & Forms section shell (ADR-155): the Data menu's pages as tabs, now that the sidebar has
 * one "Data & Forms" item. Shown only to roles with `imports.review` (§3.1); a client never sees
 * it, and each page still checks its own permission.
 */
export default async function DataLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  const links = dataLinks(ctx);
  return (
    <>
      {links.length > 0 ? (
        <SectionTabs label="Data" tabs={links.map((l) => ({ label: l.label, href: `/app/${orgSlug}/${l.path}` }))} />
      ) : null}
      {children}
    </>
  );
}
