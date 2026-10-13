import { KeyRound, UserCog } from 'lucide-react';
import { listPlatformUsers } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, EmptyState } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody } from '@/components/ui/table';
import { AddPlatformUserForm, PlatformUserRow } from './platform-user-forms';

export const dynamic = 'force-dynamic';

export default async function PlatformUsersPage() {
  const ctx = await getPlatformContext();
  // A failing read throws rather than rendering as an empty list — the one thing a platform page
  // must not show (PRODUCTION_AUDIT.md M2; ADR-070).
  const users = await listPlatformUsers(ctx);

  return (
    <>
      <PageHeader
        title="Platform accounts"
        description="Super admins and APX advisers. A platform account can never be a member of a customer organisation."
      />
      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader icon={<UserCog />} tint="violet" title="Accounts" />
          <CardBody>
            {users.length === 0 ? (
              <EmptyState title="No platform accounts yet">Add the first one below.</EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['Email', 'Name', 'Role', 'Status', '']} />
                <TBody>
                  {users.map((user) => (
                    <PlatformUserRow
                      key={user.userId}
                      userId={user.userId}
                      email={user.email}
                      fullName={user.fullName}
                      platformRole={user.platformRole}
                      status={user.status}
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
            title="Add a platform admin"
            description="Needs your password from the last ten minutes (Confirm it is you, above)."
          />
          <CardBody><AddPlatformUserForm /></CardBody>
        </Card>
      </div>
    </>
  );
}
