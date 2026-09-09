import Link from 'next/link';
import type { ConversationRef } from '@/modules/ai';
import { conversationLabel } from '@/components/dashboard';
import { formatDate } from '@/components/labels';

/** The caller's own conversations, newest first — the left rail on desktop (UX §5). */
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
    <nav aria-label="Your conversations" className="flex flex-col gap-1 text-sm">
      <Link
        href={`/app/${orgSlug}/analyst`}
        aria-current={current === null ? 'page' : undefined}
        className={current === null
          ? 'rounded-md bg-accent-soft px-3 py-2 text-accent'
          : 'rounded-md px-3 py-2 text-ink-muted hover:text-ink'}
      >
        New conversation
      </Link>
      {conversations.map((c) => (
        <Link
          key={c.id}
          href={`/app/${orgSlug}/analyst/${c.id}`}
          aria-current={current === c.id ? 'page' : undefined}
          className={current === c.id
            ? 'rounded-md bg-accent-soft px-3 py-2 text-accent'
            : 'rounded-md px-3 py-2 text-ink-muted hover:text-ink'}
        >
          <span className="block truncate">{conversationLabel(c)}</span>
          <span className="block text-xs text-ink-faint">{formatDate(c.lastMessageAt ?? c.createdAt)}</span>
        </Link>
      ))}
    </nav>
  );
}
