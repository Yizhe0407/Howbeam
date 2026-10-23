import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DragOverlay } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

const HANDLE = 'flex size-7 shrink-0 items-center justify-center rounded-md border-none bg-transparent text-muted-foreground outline-none';

interface Props {
  id: string;
  /**
   * Render prop: receives a ready-made drag handle, so the caller can place it anywhere in its own
   * layout, and — while this row is dragged — the element to portal the row's moving copy into.
   */
  children: (handle: ReactNode, overlay: HTMLElement | null) => ReactNode;
  /** Extra classes for the row's <li> element. */
  className?: string;
  /** Extra classes for the handle button — rows that sit the handle on top of
   * an image need their own contrast treatment. */
  handleClassName?: string;
  disabled?: boolean;
  /** Can't be picked up, but still makes room and takes drops (a section heading). */
  fixed?: boolean;
  /** SortableOverlay's element, from useSortableReorder. */
  overlayHost?: HTMLElement | null;
}

/**
 * A drag-to-reorder row: only the handle carries drag listeners, so buttons/inputs in the content stay clickable.
 * While dragged, the row stays in the list as a faded ghost marking the drop place, and draws the copy
 * that follows the pointer into SortableOverlay itself, so that copy shows the row's live state without
 * mounting a second instance of it.
 * Uses CSS.Translate (not CSS.Transform) since Transform also applies scaleX/scaleY, squashing rows of differing heights.
 */
export default function SortableItem({
  id,
  children,
  className,
  handleClassName,
  disabled = false,
  fixed = false,
  overlayHost = null,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: fixed ? { draggable: true, droppable: false } : disabled,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };

  const handle = fixed ? null : (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label={t().sortable.handle}
      // Names the interaction for screen readers, which otherwise just announce "button".
      aria-roledescription={t().sortable.roleDescription}
      disabled={disabled}
      className={cn(
        HANDLE,
        'cursor-grab touch-none transition-colors focus-ring hover:bg-secondary hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40',
        handleClassName,
      )}
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(className, isDragging && 'opacity-40')}
    >
      {children(handle, isDragging ? overlayHost : null)}
    </li>
  );
}

/** The handle as drawn on a row's moving copy: same look, nothing to press. */
export function StaticHandle({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn(HANDLE, 'bg-secondary text-foreground', className)}>
      <GripVertical className="size-4" />
    </span>
  );
}

/**
 * Where the dragged row draws its moving copy. It lives in a portal on <body>,
 * outside the list's scroll box, so moving it can't grow the list.
 */
export function SortableOverlay({ onHost }: { onHost: (host: HTMLElement | null) => void }) {
  return createPortal(
    // The copy is the row's own portal, gone the moment the drag ends, so there is nothing to animate back.
    <DragOverlay dropAnimation={null}>
      <div ref={onHost} className="size-full cursor-grabbing" />
    </DragOverlay>,
    document.body,
  );
}
