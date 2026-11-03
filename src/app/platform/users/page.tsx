import { KeyRound, UserCog } from 'lucide-react';
import { analystCompanies, listPlatformUsers, readableOrganizations } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, EmptyState } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody } from '@/components/ui/table';
import { AddPlatformUserForm, PlatformUserRow } from './platform-user-forms';

export const dynamic = 'force-dynamic';

export default async function PlatformUsersPage() {
  const ctx = await getPlatformContext();
  // A failing read throws rather than rendering as an empty list — the one thing a platform page
  // must not show (PRODUCTION_AUDIT.md M2; ADR-070).
  const [users, organizations, assignedTo] = await Promise.all([
    listPlatformUsers(ctx),
    readableOrganizations(ctx.db),
    analystCompanies(ctx),
  ]);
  // ADR-182: the super admin ticks which companies each Financial Analyst can open, here.
  const companies = organizations
    .filter((o) => o.status !== 'deleted')
    .map((o) => ({ id: String(o.id), name: String(o.name), slug: String(o.slug) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        title="Platform accounts"
        description="You and your team of Financial Analysts. Choose which companies each analyst can open. A platform account can never be a member of a customer organisation."
      />
      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader icon={<UserCog />} tint="violet" title="Accounts" />
          <CardBody>
            {users.length === 0 ? (
              <EmptyState title="No platform accounts yet">Add the first one below.</EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['Email', 'Name', 'Role', 'Companies', 'Status', '']} />
                <TBody>
                  {users.map((user) => (
                    <PlatformUserRow
                      key={user.userId}
                      userId={user.userId}
                      email={user.email}
                      fullName={user.fullName}
                      platformRole={user.platformRole}
                      status={user.status}
                      companies={companies}
                      assigned={assignedTo.get(user.userId) ?? []}
                    />
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            icon={<KeyRound />}
            tint="pink"
            title="Add a Financial Analyst to your team"
            description="Give them a name, their email and, if you like, a password; tick the companies they may open."
          />
          <CardBody><AddPlatformUserForm companies={companies} /></CardBody>
        </Card>
      </div>
    </>
  );
}
