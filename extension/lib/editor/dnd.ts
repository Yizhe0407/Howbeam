import { useState } from 'react';
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  restrictToFirstScrollableAncestor,
  restrictToHorizontalAxis,
  restrictToVerticalAxis,
} from '@dnd-kit/modifiers';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { t } from '@/lib/shared/i18n';

/** The drag handle is a focusable button, so reordering must work without a
 * pointer: Space/Enter lifts, arrows move through the sortable neighbours. */
function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/** Keeps the dragged copy on the list's axis and inside the list's scroll box. */
export const verticalListModifiers: Modifier[] = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];
export const horizontalListModifiers: Modifier[] = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

/**
 * 1-based position of `id` among the movable items, with `activeId` moved onto
 * `overId` when both are given; 0 when `id` is fixed or unknown.
 */
function positionIn<T>(
  items: readonly T[],
  getId: (item: T) => UniqueIdentifier,
  isFixed: (item: T) => boolean,
  id: UniqueIdentifier,
  activeId?: UniqueIdentifier,
  overId?: UniqueIdentifier,
): number {
  const order = (activeId !== undefined && reorderById(items, activeId, overId, getId)) || items;
  let position = 0;
  for (const item of order) {
    if (isFixed(item)) continue;
    position += 1;
    if (getId(item) === id) return position;
  }
  return 0;
}

/**
 * dnd-kit's built-in announcements are English and describe raw ids, so a drag
 * is announced in the active language with the item's name and position. The
 * instructions that explain the keyboard pick-up are localized the same way.
 *
 * @param itemNoun what one row is called, from the i18n `sortable` nouns
 * @param positionOf 1-based position of `id`, as it would be with `activeId` dropped on `overId`
 */
function createSortableAccessibility(
  itemNoun: string,
  positionOf: (id: UniqueIdentifier, activeId?: UniqueIdentifier, overId?: UniqueIdentifier) => number,
): { announcements: Announcements; screenReaderInstructions: ScreenReaderInstructions } {
  const copy = () => t().sortable;
  const describe = (id: UniqueIdentifier) => copy().item(itemNoun, positionOf(id));
  return {
    screenReaderInstructions: { draggable: copy().keyboardInstructions },
    announcements: {
      onDragStart: ({ active }) => copy().dragStart(describe(active.id)),
      onDragOver: ({ active, over }) => (
        over ? copy().dragOver(describe(active.id), positionOf(active.id, active.id, over.id)) : undefined
      ),
      onDragEnd: ({ active, over }) => (
        over
          ? copy().dragEnd(describe(active.id), positionOf(active.id, active.id, over.id))
          : copy().dragEndInPlace(describe(active.id))
      ),
      onDragCancel: ({ active }) => copy().dragCancel(describe(active.id)),
    },
  };
}

/**
 * The whole sortable-list scaffold the editor's reorderable lists share:
 * sensors, localized announcements, the item-id list for SortableContext, the
 * drag handlers for DndContext, the element the dragged row draws its moving
 * copy into (SortableOverlay's), and each item's position as the drop would
 * leave it. A drop maps back onto
 * the caller's array and persistence failures are logged under `logLabel`.
 *
 * `isFixed` marks items that can't be picked up but still take a place in the
 * order (the rail's section headings); they don't count as a position.
 */
export function useSortableReorder<T>(
  items: T[],
  getId: (item: T) => UniqueIdentifier,
  onReorder: (reordered: T[]) => Promise<void>,
  {
    disabled = false,
    itemNoun,
    logLabel,
    isFixed = () => false,
  }: { disabled?: boolean; itemNoun: string; logLabel: string; isFixed?: (item: T) => boolean },
) {
  const sensors = useSortableSensors();
  const [drag, setDrag] = useState<{ activeId: UniqueIdentifier; overId?: UniqueIdentifier } | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const positionOf = (id: UniqueIdentifier, activeId?: UniqueIdentifier, overId?: UniqueIdentifier) =>
    positionIn(items, getId, isFixed, id, activeId, overId);
  const accessibility = createSortableAccessibility(itemNoun, positionOf);

  function handleDragEnd(event: DragEndEvent): void {
    setDrag(null);
    if (disabled) return;
    const reordered = reorderById(items, event.active.id, event.over?.id, getId);
    if (reordered) {
      void onReorder(reordered).catch((error) => {
        console.error(logLabel, error);
      });
    }
  }

  return {
    sensors,
    accessibility,
    itemIds: items.map(getId),
    handlers: {
      onDragStart: ({ active }: { active: { id: UniqueIdentifier } }) => setDrag({ activeId: active.id }),
      onDragOver: ({ active, over }: { active: { id: UniqueIdentifier }; over: { id: UniqueIdentifier } | null }) =>
        setDrag({ activeId: active.id, overId: over?.id }),
      onDragEnd: handleDragEnd,
      onDragCancel: () => setDrag(null),
    },
    overlayHost,
    setOverlayHost,
    /** 1-based place of `id` while a drag is shown, so numbers follow the preview. */
    previewPositionOf: (id: UniqueIdentifier) => positionOf(id, drag?.activeId, drag?.overId),
  };
}

export function reorderById<T>(
  items: readonly T[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier | undefined,
  getId: (item: T) => UniqueIdentifier,
): T[] | null {
  if (overId === undefined || activeId === overId) return null;
  const oldIndex = items.findIndex((item) => getId(item) === activeId);
  const newIndex = items.findIndex((item) => getId(item) === overId);
  return oldIndex === -1 || newIndex === -1 ? null : arrayMove([...items], oldIndex, newIndex);
}
