import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { browser } from 'wxt/browser';
import {
  clampToolbarPosition,
  isRecordingToolbarCorner,
  positionForToolbarCorner,
  RECORDING_TOOLBAR_CORNER_KEY,
  snapToolbarCorner,
  toolbarCornerLabel,
  type RecordingToolbarCorner,
  type ToolbarPoint,
} from './recording-toolbar-position';
import { t } from '@/lib/shared/i18n';

interface UseToolbarPositionOptions {
  /** The floating element being positioned (toolbar or its collapsed pill). */
  floatingRef: RefObject<HTMLElement | null>;
  /** Changes whenever the floating element remounts or discretely resizes
   * (collapse toggles, phase switches), so the reposition pass re-runs and
   * the ResizeObserver re-attaches to the fresh element. */
  layoutKey: string;
  /** Blocks drag starts while a toolbar command is in flight. */
  isInteractionBlocked: () => boolean;
  /** Screen-reader announcement channel for corner moves. */
  announce: (message: string) => void;
}

/**
 * Corner/position state for the floating recording toolbar: the persisted
 * corner, its restore on mount, viewport-tracked repositioning, and the
 * pointer-drag plus arrow-key corner controls.
 */
export function useToolbarPosition({
  floatingRef,
  layoutKey,
  isInteractionBlocked,
  announce,
}: UseToolbarPositionOptions) {
  const [corner, setCorner] = useState<RecordingToolbarCorner>('bottom-right');
  const [position, setPosition] = useState<ToolbarPoint | null>(null);
  /** True once the saved corner has been read (or failed to), so the toolbar is not drawn in the default corner first. */
  const [ready, setReady] = useState(false);
  /** Set when a drag actually moved the element, so the click that ends the
   * same gesture (e.g. on the collapsed pill) must be swallowed. */
  const suppressNextClick = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPosition: ToolbarPoint;
    position: ToolbarPoint;
    moved: boolean;
  } | null>(null);

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  // The stacked (compact) toolbar spans the viewport minus 8px a side; the
  // single-row one keeps a 16px gutter.
  const margin = () => (floatingRef.current?.hasAttribute('data-compact') ? 8 : 16);
  const floatingSize = () => {
    const rect = floatingRef.current?.getBoundingClientRect();
    return {
      width: rect && rect.width > 0 ? rect.width : 44,
      height: rect && rect.height > 0 ? rect.height : 44,
    };
  };

  const persistCorner = (nextCorner: RecordingToolbarCorner) => {
    void browser.storage.local.set({ [RECORDING_TOOLBAR_CORNER_KEY]: nextCorner }).catch((error) => {
      console.warn('[howbeam] failed to save recording toolbar position', error);
    });
  };

  const moveToCorner = (nextCorner: RecordingToolbarCorner, persist = true) => {
    setCorner(nextCorner);
    setPosition(positionForToolbarCorner(nextCorner, floatingSize(), viewport(), margin()));
    if (persist) persistCorner(nextCorner);
  };

  useEffect(() => {
    let active = true;
    void browser.storage.local.get(RECORDING_TOOLBAR_CORNER_KEY).then((stored) => {
      const saved = stored[RECORDING_TOOLBAR_CORNER_KEY];
      if (!active) return;
      setReady(true);
      if (!isRecordingToolbarCorner(saved)) return;
      // Mount-time restore applies the saved corner without persisting it
      // back; inlined instead of moveToCorner(saved, false) so this one-shot
      // effect depends on nothing reactive.
      setCorner(saved);
      setPosition(positionForToolbarCorner(saved, floatingSize(), viewport(), margin()));
    }).catch((error) => {
      console.warn('[howbeam] failed to load recording toolbar position', error);
      if (active) setReady(true);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const reposition = () => {
      if (dragRef.current) return;
      const next = positionForToolbarCorner(corner, floatingSize(), viewport(), margin());
      setPosition((current) => current?.x === next.x && current.y === next.y ? current : next);
    };
    reposition();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition);
    if (floatingRef.current) observer?.observe(floatingRef.current);
    window.addEventListener('resize', reposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corner, layoutKey, ready]);

  const handlePositionPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0 || isInteractionBlocked()) return;
    const rect = floatingRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startPosition = { x: rect.left, y: rect.top };
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition,
      position: startPosition,
      moved: false,
    };
  };

  const handlePositionPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    floatingRef.current?.setAttribute('data-dragging', '');
    drag.position = clampToolbarPosition(
      { x: drag.startPosition.x + deltaX, y: drag.startPosition.y + deltaY },
      floatingSize(),
      viewport(),
      margin(),
    );
    setPosition(drag.position);
  };

  const finishPositionDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    floatingRef.current?.removeAttribute('data-dragging');
    if (!drag.moved) return;
    suppressNextClick.current = true;
    const nextCorner = snapToolbarCorner(drag.position, floatingSize(), viewport());
    moveToCorner(nextCorner);
    announce(t().toolbar.movedTo(toolbarCornerLabel(nextCorner)));
  };

  return {
    corner,
    position,
    ready,
    suppressNextClick,
    handlePositionPointerDown,
    handlePositionPointerMove,
    finishPositionDrag,
  };
}
