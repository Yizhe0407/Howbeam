import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import type { ImageCssSize } from './image-edit-geometry';
import {
  anchorAt,
  clampZoom,
  fitSize,
  maxZoomFor,
  MIN_ZOOM,
  scrollDeltaForAnchor,
  wheelZoomFactor,
  ZOOM_STEP,
  type ZoomAnchor,
} from './image-edit-viewport';

/** Breathing room kept around the image at every zoom, so edge masks are easy to reach and its edges show when scrolled to. */
export const FIT_MARGIN = 24;

interface ViewportOptions {
  /** Alt + wheel: called with the factor the wheel would have zoomed by. Never zooms. */
  onAltWheel?: (factor: number) => void;
}

/**
 * The image editor's viewport: the image is laid out at the fitted size times
 * the zoom inside a scrollable box, so scrolling pans, the wheel zooms around
 * the pointer (Alt + wheel is handed to `onAltWheel` instead, for every tool
 * alike), and middle button, Space + drag, or the pointer tool on empty space
 * pans.
 */
export function useImageEditViewport(imageSize: ImageCssSize | null, { onAltWheel }: ViewportOptions = {}) {
  const onAltWheelRef = useRef(onAltWheel);
  onAltWheelRef.current = onAltWheel;
  // The dialog content mounts through a portal after the editor first renders,
  // so the elements are tracked as state: effects re-run when they actually exist.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<ImageCssSize | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const zoomRef = useRef(MIN_ZOOM);
  const anchorRef = useRef<ZoomAnchor | null>(null);

  // The fit is measured on a box that scrollbars cannot resize, otherwise the
  // scrollbar appearing would change the fit and with it the scrollbar.
  useLayoutEffect(() => {
    if (!frame) return undefined;
    const measure = () =>
      setFrameSize({ width: frame.clientWidth, height: frame.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);

  const fit =
    imageSize && frameSize ? fitSize(frameSize, imageSize, FIT_MARGIN) : null;
  const maxZoom = maxZoomFor(fit, imageSize);
  const maxZoomRef = useRef(maxZoom);
  maxZoomRef.current = maxZoom;

  const zoomTo = useCallback(
    (nextZoom: number, client: { x: number; y: number } | null) => {
      const clamped = clampZoom(nextZoom, maxZoomRef.current);
      if (clamped === zoomRef.current) return;
      const canvas = canvasRef.current?.getBoundingClientRect();
      anchorRef.current = client && canvas ? anchorAt(client, canvas) : null;
      zoomRef.current = clamped;
      setZoom(clamped);
    },
    [],
  );

  const frameCenter = useCallback(() => {
    const rect = frame?.getBoundingClientRect();
    return rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null;
  }, [frame]);

  // After the zoom is laid out, scroll so the image point under the pointer stays under it.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const canvas = canvasRef.current?.getBoundingClientRect();
    anchorRef.current = null;
    if (!anchor || !scroller || !canvas) return;
    const { dx, dy } = scrollDeltaForAnchor(anchor, canvas);
    scroller.scrollLeft += dx;
    scroller.scrollTop += dy;
  }, [zoom, scroller]);

  // Wheel zoom needs preventDefault, which React's passive wheel handler cannot do.
  useEffect(() => {
    if (!scroller) return undefined;
    const onWheel = (event: WheelEvent) => {
      // Also keeps the browser's own Alt + wheel action (history navigation in some browsers) from running.
      event.preventDefault();
      if (event.altKey) {
        onAltWheelRef.current?.(wheelZoomFactor(event.deltaY, event.deltaMode));
        return;
      }
      zoomTo(zoomRef.current * wheelZoomFactor(event.deltaY, event.deltaMode), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [scroller, zoomTo]);

  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const startPan = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!scroller) return;
      panRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: scroller.scrollLeft,
        top: scroller.scrollTop,
      };
      scroller.setPointerCapture(event.pointerId);
      setPanning(true);
    },
    [scroller],
  );

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) =>
      target instanceof HTMLButtonElement ||
      target instanceof HTMLTextAreaElement;
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      event.preventDefault();
      setSpaceHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const endPan = () => {
    panRef.current = null;
    setPanning(false);
  };

  const scrollerHandlers = {
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      // Working on the canvas moves keyboard focus onto it (as in any editor), so
      // Space pans here instead of pressing whichever toolbar button was last used.
      event.currentTarget.focus({ preventScroll: true });
      if (event.button === 1 || (event.button === 0 && spaceHeld)) {
        event.preventDefault();
        event.stopPropagation();
        startPan(event);
      }
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const pan = panRef.current;
      if (!pan || !scroller || pan.pointerId !== event.pointerId) return;
      scroller.scrollLeft = pan.left - (event.clientX - pan.x);
      scroller.scrollTop = pan.top - (event.clientY - pan.y);
    },
    onPointerUp: endPan,
    onPointerCancel: endPan,
  };

  return {
    setFrame,
    scroller,
    setScroller,
    canvasRef,
    fit,
    zoom,
    maxZoom,
    canvasStyle: fit ? { width: fit.width * zoom, height: fit.height * zoom } : undefined,
    zoomIn: () => zoomTo(zoomRef.current * ZOOM_STEP, frameCenter()),
    zoomOut: () => zoomTo(zoomRef.current / ZOOM_STEP, frameCenter()),
    zoomFit: () => zoomTo(MIN_ZOOM, frameCenter()),
    spaceHeld,
    panning,
    startPan,
    scrollerHandlers,
  };
}
