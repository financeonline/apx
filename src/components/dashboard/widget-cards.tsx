'use client';

import type { ReactNode } from 'react';
import { DraggableWidgetGrid, type WidgetItem } from '@/components/ui/shadcn';

/**
 * Cards in the widget grid's design (ADR-152): the template's surface, ring, radius, resting shadow
 * and entrance, in a fixed order — dragging is off. The cards arrive rendered by the server; this
 * only lays them out.
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
        cellSize={240}
        rowHeight={rowHeight}
        // The reference's tiles: very rounded, as every card (`rounded-card`, 28px; ADR-154).
        radius={28}
        gap={16}
        renderItem={(item) => byId.get(item.id)?.node}
      />
    </div>
  );
}
