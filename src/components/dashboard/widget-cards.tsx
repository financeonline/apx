'use client';

import type { ReactNode } from 'react';
import { DraggableWidgetGrid, type WidgetItem } from '@/components/ui/shadcn';

/**
 * Cards in the widget grid's design (ADR-152): the template's surface, ring, radius, resting shadow
 * and entrance, in a fixed order — dragging is off. The cards arrive rendered by the server; this
 * only lays them out.
 *
 * On any screen (owner, 2026-10-14): one card to a row on a phone, two from about 450px, three from
 * about 750px; `rowHeight` is the least a row is, and a row grows when a card's lines wrap in a
 * narrow column rather than cutting them off.
 */

export interface WidgetCard {
  readonly id: string;
  readonly label: string;
  readonly node: ReactNode;
}

export function WidgetCards({
  cards,
  rowHeight = 216,
}: {
  cards: readonly WidgetCard[];
  rowHeight?: number;
}) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const items: WidgetItem[] = cards.map((c) => ({ id: c.id, size: 'sm', label: c.label }));
  return (
    <div data-testid="widget-cards">
      <DraggableWidgetGrid
        items={items}
        editable={false}
        maxColumns={3}
        minColumns={1}
        cellSize={300}
        rowHeight={rowHeight}
        growRows
        // As every card (`rounded-card`, 16px; ADR-155).
        radius={16}
        gap={16}
        renderItem={(item) => byId.get(item.id)?.node}
      />
    </div>
  );
}
