import { getAccessContext } from '@/modules/tenancy';
import { requireModulePage } from '@/app/_lib/authz';

/** ADR-158: this section belongs to the "banking" system, which the super admin may switch off per company. */
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  requireModulePage(await getAccessContext(orgSlug), 'banking');
  return <>{children}</>;
}
