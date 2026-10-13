import Link from 'next/link';
import type { ConversationRef } from '@/modules/ai';
import { conversationLabel } from '@/components/dashboard';
import { formatDate } from '@/components/labels';

/**
 * The caller's own conversations, newest first — the left rail on desktop (UX §5). On a phone it sits
 * above the conversation, so it is kept short and scrolls within itself: a long history must not push
 * the question box off the screen (owner, 2026-10-14).
 */
export function ConversationRail({
  orgSlug,
  conversations,
  current,
}: {
  orgSlug: string;
  conversations: readonly ConversationRef[];
  current: string | null;
}) {
  return (
    <nav aria-label="Your conversations" className="panel flex min-w-0 flex-col gap-1 self-start rounded-card p-2 text-sm max-md:max-h-56 max-md:overflow-y-auto">
      <Link
        href={`/app/${orgSlug}/analyst`}
        aria-current={current === null ? 'page' : undefined}
        className={current === null
          ? 'rounded-xl bg-accent-soft px-3 py-2 font-medium text-accent'
          : 'rounded-xl px-3 py-2 text-ink-muted transition-colors hover:bg-accent-soft/40 hover:text-ink'}
      >
        New conversation
      </Link>
      {conversations.map((c) => (
        <Link
          key={c.id}
          href={`/app/${orgSlug}/analyst/${c.id}`}
          aria-current={current === c.id ? 'page' : undefined}
          className={current === c.id
            ? 'rounded-xl bg-accent-soft px-3 py-2 font-medium text-accent'
            : 'rounded-xl px-3 py-2 text-ink-muted transition-colors hover:bg-accent-soft/40 hover:text-ink'}
        >
          <span className="block truncate">{conversationLabel(c)}</span>
          <span className="block text-xs text-ink-faint">{formatDate(c.lastMessageAt ?? c.createdAt)}</span>
        </Link>
      ))}
    </nav>
  );
}
