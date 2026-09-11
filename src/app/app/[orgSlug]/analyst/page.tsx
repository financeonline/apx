import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import { aiQuotaStatus, listConversations } from '@/modules/ai';
import { loadHome } from '@/modules/dashboard';
import { getAccessContext } from '@/modules/tenancy';
import { AnalystNoConversationsEmpty, AnalystNoDataEmpty } from '@/components/dashboard';
import { PageHeader } from '@/components/ui/surfaces';
import { AnalystChat } from './analyst-chat';
import { ConversationRail } from './conversation-rail';
import { FactsCard } from './facts-card';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * `/analyst` — a new conversation (ROUTE_ARCHITECTURE.md §121; UX_ARCHITECTURE.md §5 `AnalystChat`, §6).
 *
 * The page decides three things on the server and hands the rest to the chat shell: whether there
 * is any committed data to ask about (no → the §6 empty state, no chat), what the allowance is
 * (the notice with its reset time, before the route's 429), and the figures for the asked period
 * — so that when the analyst is unavailable the reader still gets "Facts we can show you" from
 * current snapshots, deterministic and model-free (§7.2).
 */
export default async function AnalystPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ ask?: string }>;
}) {
  const { orgSlug } = await params;
  const { ask } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  if (!ctx.orgId) notFound();
  requirePermission(ctx, 'ai.use');

  const home = await loadHome(ctx.db, ctx.orgId, orgSlug, ctx.requestId, {
    suspended: ctx.organizationStatus === 'suspended',
  });
  if (home.kind === 'first_run' || home.kind === 'awaiting_review') {
    return (
      <>
        <PageHeader eyebrow="AI Analyst" title="Ask about the numbers" />
        <div className="mt-6">
          <AnalystNoDataEmpty addDataHref={`/app/${orgSlug}/data/imports/new`} />
        </div>
      </>
    );
  }

  const [conversations, quota] = await Promise.all([listConversations(ctx), aiQuotaStatus(ctx)]);

  return (
    <>
      <PageHeader
        eyebrow="AI Analyst"
        title="Ask about the numbers"
        description="Answers with evidence, drawn only from your validated numbers."
      />
      <div className="mt-6 grid gap-6 md:grid-cols-[220px_1fr]">
        <ConversationRail orgSlug={orgSlug} conversations={conversations} current={null} />
        <div className="flex flex-col gap-6">
          {conversations.length === 0 && !ask ? (
            <AnalystNoConversationsEmpty askHrefBase={`/app/${orgSlug}/analyst`} />
          ) : null}
          <AnalystChat
            orgSlug={orgSlug}
            conversationId={null}
            initialMessages={[]}
            quota={quota}
            facts={<FactsCard view={home.view} />}
            initialAsk={ask ?? null}
            canCreateAction={can(ctx, 'actions.create')}
            readOnly={false}
          />
        </div>
      </div>
    </>
  );
}
