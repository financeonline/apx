'use client';

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DraggableWidgetGrid, type WidgetItem } from '@/components/ui/shadcn';

/**
 * Cards the reader can put in their own order (Home's headline numbers).
 *
 * The cards arrive rendered by the server; this only arranges them. "Arrange cards" turns dragging
 * on (mouse, long press on touch, or Alt + arrow keys); outside it the cards are ordinary and their
 * links work. The order is a per-browser preference kept in localStorage for each company — it
 * changes no figure and nothing is sent anywhere. Storage may be unavailable (private windows); the
 * cards then keep the default order.
 */

export interface ArrangeableCard {
  readonly id: string;
  readonly label: string;
  readonly node: ReactNode;
}

const CHANGED = 'motion:card-order';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parseOrder(raw: string | null): string[] | null {
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function writeOrder(key: string, ids: string[] | null): void {
  try {
    if (ids === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // A preference only; the default order stands.
  }
  window.dispatchEvent(new Event(CHANGED));
}

const noSubscription = () => () => {};

/** The saved order applied to today's cards: unknown ids dropped, new cards appended. */
function ordered(cards: readonly ArrangeableCard[], saved: string[] | null): string[] {
  const ids = cards.map((c) => c.id);
  if (saved === null) return ids;
  const known = saved.filter((id) => ids.includes(id));
  return [...known, ...ids.filter((id) => !known.includes(id))];
}

export function ArrangeableCards({
  storageKey,
  cards,
  rowHeight = 208,
}: {
  storageKey: string;
  cards: readonly ArrangeableCard[];
  rowHeight?: number;
}) {
  const raw = useSyncExternalStore(subscribe, () => readRaw(storageKey), () => null);
  const order = ordered(cards, parseOrder(raw));
  const [arranging, setArranging] = useState(false);
  // The grid takes its order at mount and keeps it. It is remounted when the order is set from
  // outside it — once the saved order is readable after hydration, and on reset — but not after a
  // drop inside it, so its animation is not replayed.
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  const [resets, setResets] = useState(0);

  const byId = new Map(cards.map((c) => [c.id, c]));
  const items: WidgetItem[] = order.flatMap((id) => {
    const card = byId.get(id);
    return card === undefined ? [] : [{ id, size: 'sm' as const, label: card.label }];
  });

  return (
    <div data-testid="arrangeable-cards">
      <div className="mb-2 flex justify-end gap-2">
        {arranging ? (
          <Button
            tone="quiet"
            type="button"
            onClick={() => {
              writeOrder(storageKey, null);
              setResets((n) => n + 1);
            }}
          >
            Reset order
          </Button>
        ) : null}
        <Button
          tone={arranging ? 'primary' : 'quiet'}
          type="button"
          aria-pressed={arranging}
          onClick={() => setArranging((a) => !a)}
        >
          {arranging ? 'Done' : 'Arrange cards'}
        </Button>
      </div>
      {arranging ? (
        <p className="mb-2 text-sm text-ink-muted" aria-live="polite">
          Drag a card to move it. On a touch screen, press and hold first; with a keyboard, focus a card
          and use Alt with the arrow keys.
        </p>
      ) : null}
      <DraggableWidgetGrid
        key={`${hydrated ? 'saved' : 'default'}-${resets}`}
        items={items}
        editable={arranging}
        maxColumns={3}
        cellSize={240}
        gap={16}
        rowHeight={rowHeight}
        // Figures read at once on arrival; only rearranging moves them.
        appear={false}
        onChange={(next) => {
          writeOrder(storageKey, next.map((i) => i.id));
        }}
        renderItem={(item) => byId.get(item.id)?.node}
      />
    </div>
  );
}
