import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getValidScreenshotScale } from '@/lib/media/image-utils';
import { type Redaction } from '@/lib/storage/models';

// Re-exported for the thumbnails: the drawable-frame guard is the raster compositor's contract.
export { isDrawableHighlightFrame } from '@/lib/media/annotation-contract';

/** CSS lengths: pixels (numbers) once measured, or percentages of the image box when the box is exact. */
export interface ImageContentFrame {
  left: number | string;
  top: number | string;
  width: number | string;
  height: number | string;
}

/** Everything needed to map screenshot CSS coordinates onto rendered pixels. */
export interface OverlayGeometry {
  naturalWidth: number;
  naturalHeight: number;
  dpr: number;
  scale: number;
  contentFrame: ImageContentFrame;
  /** Intersection of the content frame with the element box — the area actual image pixels occupy
   * on screen (differs from the content frame under `cover`, where content overflows and is cropped). */
  visibleLeft: number;
  visibleTop: number;
  visibleRight: number;
  visibleBottom: number;
  mapX: (x: number) => number;
  mapY: (y: number) => number;
}

/**
 * Content-frame math shared by the highlight thumbnails: where the image's pixels actually land
 * inside the (possibly letterboxed or cropped) element box, and how a screenshot CSS coordinate maps onto them.
 */
export function computeOverlayGeometry(
  img: HTMLImageElement,
  naturalWidth: number,
  naturalHeight: number,
  screenshotScale: number,
  fit: 'cover' | 'contain',
): OverlayGeometry {
  const dpr = getValidScreenshotScale(screenshotScale);
  const renderedBox = img.getBoundingClientRect();
  const boxWidth = renderedBox.width || naturalWidth;
  const boxHeight = renderedBox.height || naturalHeight;
  const scale = fit === 'cover'
    ? Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight)
    : Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  const contentWidth = naturalWidth * scale;
  const contentHeight = naturalHeight * scale;
  const offsetLeft = img.offsetLeft + (boxWidth - contentWidth) / 2;
  const offsetTop = img.offsetTop + (boxHeight - contentHeight) / 2;
  return {
    naturalWidth,
    naturalHeight,
    dpr,
    scale,
    contentFrame: {
      left: offsetLeft,
      top: offsetTop,
      width: contentWidth,
      height: contentHeight,
    },
    visibleLeft: Math.max(offsetLeft, img.offsetLeft),
    visibleTop: Math.max(offsetTop, img.offsetTop),
    visibleRight: Math.min(offsetLeft + contentWidth, img.offsetLeft + boxWidth),
    visibleBottom: Math.min(offsetTop + contentHeight, img.offsetTop + boxHeight),
    mapX: (x: number) => offsetLeft + x * dpr * scale,
    mapY: (y: number) => offsetTop + y * dpr * scale,
  };
}

interface UseThumbnailOverlayMappingOptions {
  url: string | null;
  fit: 'cover' | 'contain';
  screenshotScale: number;
  /** Privacy masks in screenshot CSS coordinates. */
  redactions: readonly Redaction[];
  privacyReviewRequired: boolean;
  /**
   * The image's pixels already have every mask burned in (usePreviewImage).
   * The overlay masks then only keep drawings beneath them covered, as in an
   * export, and a mask whose position is not yet known exposes nothing, so the
   * image is never hidden for it.
   */
  masksBurnedIn: boolean;
  /**
   * The image element is exactly the image's own box: it has the image's aspect
   * ratio, so nothing is letterboxed or cropped. Masks and the content frame are
   * then plain percentages of that box and cannot drift from the pixels they
   * cover, however the box is resized, so no remap (or hiding) is needed on resize.
   */
  exactBox?: boolean;
  /** Measure the mounted image, or return null while it has no usable size. */
  measure: (img: HTMLImageElement) => OverlayGeometry | null;
  /** Recompute the component's own overlays from fresh geometry. */
  mapOverlays: (geometry: OverlayGeometry) => void;
  /** Drop the component's own overlays when the image is unmeasurable. */
  clearOverlays: () => void;
}

const EXACT_CONTENT_FRAME: ImageContentFrame = { left: 0, top: 0, width: '100%', height: '100%' };

/**
 * Shared overlay-mapping lifecycle for the highlight thumbnails. It owns one
 * piece of state, the measured `geometry` of the image on screen, and derives
 * everything else from it:
 *
 * - Masks are drawn over the content frame in the image's own coordinates,
 *   so adding, moving or deleting a mask never leaves a frame where the
 *   image is hidden or a mask sits at a stale position.
 * - The fail-closed contract is about *geometry*: while the image has not been
 *   measured, or its on-screen size is changing (load, resize), no source
 *   pixel is shown behind a mask whose position cannot yet be trusted
 *   (`showPixels`). Remaps are coalesced into one animation frame per burst.
 */
export function useThumbnailOverlayMapping({
  url,
  fit,
  screenshotScale,
  redactions,
  privacyReviewRequired,
  masksBurnedIn,
  exactBox = false,
  measure,
  mapOverlays,
  clearOverlays,
}: UseThumbnailOverlayMappingOptions) {
  const imgRef = useRef<HTMLImageElement>(null);
  const mapFrameRef = useRef<number | null>(null);
  const [geometry, setGeometry] = useState<OverlayGeometry | null>(null);
  // True from the moment the on-screen size may have changed until the next
  // measurement lands: `geometry` is then the last known one, not a current one.
  const [stale, setStale] = useState(true);

  // The observer and frame callbacks outlive renders, so they read the latest
  // measure/redaction state through a ref instead of being re-subscribed.
  // Only live masks over stored pixels gate what may be shown.
  const gatesPixels = !masksBurnedIn && redactions.length > 0;
  const latest = useRef({ measure, gatesPixels, exactBox });
  latest.current = { measure, gatesPixels, exactBox };

  const remap = useCallback(() => {
    const img = imgRef.current;
    setGeometry(img ? latest.current.measure(img) : null);
    setStale(false);
  }, []);

  const scheduleMapping = useCallback(() => {
    // Hide the source image before the next paint, not after React's render,
    // so a resize can never show it next to a mask still at its old position.
    // An exact box has nothing to go stale: masks are percentages of the box itself.
    if (!latest.current.exactBox) {
      if (latest.current.gatesPixels && imgRef.current) imgRef.current.style.visibility = 'hidden';
      setStale(true);
    }
    if (mapFrameRef.current !== null) return;
    mapFrameRef.current = requestAnimationFrame(() => {
      mapFrameRef.current = null;
      remap();
    });
  }, [remap]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const observer = new ResizeObserver(scheduleMapping);
    observer.observe(img);
    // A new image has no geometry of its own yet; never reuse the previous one.
    setGeometry(null);
    scheduleMapping();
    return () => {
      observer.disconnect();
      if (mapFrameRef.current !== null) cancelAnimationFrame(mapFrameRef.current);
      mapFrameRef.current = null;
    };
  }, [url, scheduleMapping]);

  // A different way of measuring (fit, capture scale, decoded size) changes the
  // geometry itself, so it re-measures; ordinary mask or highlight edits do not.
  const firstMeasure = useRef(true);
  useEffect(() => {
    if (firstMeasure.current) {
      firstMeasure.current = false;
      return;
    }
    scheduleMapping();
  }, [fit, screenshotScale, measure, scheduleMapping]);

  useLayoutEffect(() => {
    if (geometry) mapOverlays(geometry);
    else clearOverlays();
  }, [geometry, mapOverlays, clearOverlays]);

  const showPixels = !privacyReviewRequired && (!gatesPixels || (geometry !== null && (exactBox || !stale)));
  const contentFrame = geometry ? (exactBox ? EXACT_CONTENT_FRAME : geometry.contentFrame) : null;

  const imageCssSize = useMemo(
    () => (geometry ? { width: geometry.naturalWidth / geometry.dpr, height: geometry.naturalHeight / geometry.dpr } : null),
    [geometry],
  );

  return { imgRef, contentFrame, imageCssSize, showPixels, remap };
}
