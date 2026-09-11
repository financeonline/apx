import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import { isMotionError } from '@/core/errors';
import { aiQuotaStatus, findConversation, listConversations, loadMessages } from '@/modules/ai';
import { loadHome } from '@/modules/dashboard';
import { getAccessContext } from '@/modules/tenancy';
import { PageHeader } from '@/components/ui/surfaces';
import { conversationLabel } from '@/components/dashboard';
import { AnalystChat, type MessageView } from '../analyst-chat';
import { ConversationRail } from '../conversation-rail';
import { FactsCard } from '../facts-card';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * `/analyst/[conversationId]` (ROUTE_ARCHITECTURE.md §122).
 *
 * Two questions, answered by two different functions: may the caller CONTINUE this conversation
 * (`findConversation` — theirs, here, active), and may they READ it (`loadMessages` — RLS admits
 * an owner or admin to a colleague's). A conversation that is neither is 404, uniform with one
 * that never existed (SECURITY_MODEL.md §14). A colleague's is shown read-only.
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ orgSlug: string; conversationId: string }>;
}) {
  const { orgSlug, conversationId } = await params;
  const ctx = await getAccessContext(orgSlug);
  if (!ctx.orgId) notFound();
  requirePermission(ctx, 'ai.use');
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) notFound();

  let own = true;
  try {
    await findConversation(ctx, conversationId);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') own = false;
    else throw error;
  }

  let stored;
  try {
    stored = await loadMessages(ctx, conversationId);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const [conversations, quota, home] = await Promise.all([
    listConversations(ctx),
    aiQuotaStatus(ctx),
    loadHome(ctx.db, ctx.orgId, orgSlug, ctx.requestId, { suspended: ctx.organizationStatus === 'suspended' }),
  ]);
  const facts = home.kind === 'ready' || home.kind === 'bank_only' ? <FactsCard view={home.view} /> : null;
  const current = conversations.find((c) => c.id === conversationId) ?? null;

  const messages: MessageView[] = stored.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    structured: m.structured,
    groundingStatus: m.groundingStatus,
    evidenceBundleId: m.evidenceBundleId,
    flagged: m.flagged,
  }));

  return (
    <>
      <PageHeader
        eyebrow="AI Analyst"
        title={current ? conversationLabel(current) : 'A conversation'}
        description={own ? undefined : "A colleague's conversation. You can read it, not continue it."}
      />
      <div className="mt-6 grid gap-6 md:grid-cols-[220px_1fr]">
        <ConversationRail orgSlug={orgSlug} conversations={conversations} current={conversationId} />
        <AnalystChat
          orgSlug={orgSlug}
          conversationId={conversationId}
          initialMessages={messages}
          quota={quota}
          facts={facts}
          initialAsk={null}
          canCreateAction={can(ctx, 'actions.create')}
          readOnly={!own}
        />
      </div>
    </>
  );
}
