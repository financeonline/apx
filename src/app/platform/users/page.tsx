import { KeyRound, UserCog } from 'lucide-react';
import { toMotionError } from '@/core/errors';
import { getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, EmptyState } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody } from '@/components/ui/table';
import { GrantRoleForm, PlatformUserRow } from './platform-user-forms';

export const dynamic = 'force-dynamic';

interface PlatformUserRecord {
  user_id: string;
  platform_role: string;
  status: string;
}

export default async function PlatformUsersPage() {
  const ctx = await getPlatformContext();
  const { data, error } = await ctx.db
    .from('platform_users')
    .select('user_id, platform_role, status')
    .order('platform_role');

  // Never `data ?? []` on its own: a failing query rendered as an empty list is the one thing a
  // platform page must not show (PRODUCTION_AUDIT.md M2; ADR-070).
  if (error) throw toMotionError(error, ctx.requestId);
  const users = (data ?? []) as PlatformUserRecord[];

  return (
    <>
      <PageHeader
        title="Platform accounts"
        description="Super admins and MOTION advisers. A platform account can never be a member of a customer organisation."
      />
      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader icon={<UserCog />} tint="violet" title="Accounts" />
          <CardBody>
            {users.length === 0 ? (
              <EmptyState title="No platform accounts yet">Grant the first one below.</EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['User', 'Role', 'Status', '']} />
                <TBody>
                  {users.map((user) => (
                    <PlatformUserRow
                      key={user.user_id}
                      userId={user.user_id}
                      platformRole={user.platform_role}
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
            title="Grant a platform role"
            description="Requires two-step sign-in and a recent re-authentication."
          />
          <CardBody><GrantRoleForm /></CardBody>
        </Card>
      </div>
    </>
  );
}
