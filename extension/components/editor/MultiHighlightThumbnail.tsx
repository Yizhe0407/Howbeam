import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { BADGE_RADIUS, BADGE_TEXT_COLOR, HIGHLIGHT_COLOR, HIGHLIGHT_LINE_WIDTH, HIGHLIGHT_RADIUS, LEADER_LINE_WIDTH, MARKER_INNER_RADIUS, MARKER_RADIUS, MARKER_RING_WIDTH, type Annotation } from '@/lib/media/annotation-contract';
import { getBadgeFontSize } from '@/lib/media/annotation-geometry';
import { layoutAnnotations } from '@/lib/media/annotation-layout';
import { usePreviewImage } from '@/lib/editor/use-preview-image';
import { type ImageEdit, type Redaction } from '@/lib/storage/models';
import { getValidScreenshotScale } from '@/lib/media/image-utils';
import ThumbnailSurface from './ThumbnailSurface';
import HighlightFrame from './HighlightFrame';
import {
  computeOverlayGeometry,
  isDrawableHighlightFrame,
  useThumbnailOverlayMapping,
  type OverlayGeometry,
} from './use-thumbnail-overlay-mapping';

const NO_REDACTIONS: Redaction[] = [];
const NO_EDITS: ImageEdit[] = [];

interface Props {
  blob: Blob;
  annotations: Annotation[];
  /** Opaque masks in screenshot CSS coordinates. */
  redactions?: Redaction[];
  /** Hide all source pixels until privacy metadata is explicitly reviewed. */
  privacyReviewRequired?: boolean;
  /** The image element is exactly the image's box (see useThumbnailOverlayMapping). */
  exactBox?: boolean;
  /** Text, arrows and rectangles drawn on the image. */
  imageEdits?: ImageEdit[];
  /** Image editor only: show the stored pixels with masks drawn live on top
   * instead of burned in (see usePreviewImage). */
  liveMasks?: boolean;
  screenshotScale: number;
  numbered: boolean;
  /** False drops the marker numbers and their leader lines, for previews too small to read them. */
  badges?: boolean;
  alt: string;
  className?: string;
  imgClassName?: string;
  /** Content rendered over the exact image frame. */
  overlay?: ReactNode;
  /** 'cover' crops to fill a fixed box. 'contain' shows the full uncropped
   * screenshot at its natural aspect ratio (editor cards). */
  fit?: 'cover' | 'contain';
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
}

interface BoxStyle {
  order: number;
  markerOnly: boolean;
  /** False when the mapped frame is a clamped-to-edge degenerate the raster
   * path would also skip stroking. */
  drawFrame: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  anchorLeft: number;
  anchorTop: number;
  badgeAnchorLeft: number;
  badgeAnchorTop: number;
  calloutLeft: number | null;
  calloutTop: number | null;
  borderWidth: number;
  borderRadius: number;
  badgeSize: number;
  badgeFontSize: number;
  markerSize: number;
  markerRingWidth: number;
  leaderWidth: number;
  leaderPoints: string;
}

/** Single-image mode counterpart of HighlightThumbnail: draws every annotation's box as CSS overlays, mirroring compositeMultiHighlight's geometry so the preview matches the export. */
export default function MultiHighlightThumbnail({
  blob,
  annotations,
  redactions = NO_REDACTIONS,
  privacyReviewRequired = false,
  exactBox = false,
  imageEdits = NO_EDITS,
  liveMasks = false,
  screenshotScale,
  numbered,
  badges = true,
  alt,
  className,
  imgClassName,
  overlay,
  fit = 'cover',
  loading = 'eager',
  decoding = 'async',
}: Props) {
  const { url, masksBurnedIn } = usePreviewImage(blob, { redactions, screenshotScale, privacyReviewRequired, liveMasks });
  const [boxes, setBoxes] = useState<BoxStyle[]>([]);
  const [imageSize, setImageSize] = useState<{ url: string; width: number; height: number } | null>(null);
  const annotationSignature = useMemo(
    () =>
      annotations
        .map(({ bounds, order }) => `${order}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`)
        .join('|'),
    [annotations],
  );
  // Rebuilding from the signature (not `annotations`) keeps array identity stable across
  // equivalent-but-new `annotations` props, avoiding an expensive re-layout/remap below.
  const stableAnnotations = useMemo<Annotation[]>(() => {
    if (!annotationSignature) return [];
    return annotationSignature.split('|').map((entry) => {
      const [order = '', bounds = ''] = entry.split(':');
      const [x = 0, y = 0, width = 0, height = 0] = bounds.split(',').map(Number);
      return { bounds: { x, y, width, height }, order: Number(order) };
    });
  }, [annotationSignature]);
  const dpr = getValidScreenshotScale(screenshotScale);
  const layouts = useMemo(() => {
    if (!url || imageSize?.url !== url || !imageSize.width || !imageSize.height) return [];
    return layoutAnnotations(stableAnnotations, imageSize.width / dpr, imageSize.height / dpr);
  }, [dpr, imageSize, stableAnnotations, url]);

  const measure = useCallback((img: HTMLImageElement) => {
    if (!url || imageSize?.url !== url || !imageSize.width || !imageSize.height) return null;
    return computeOverlayGeometry(img, imageSize.width, imageSize.height, screenshotScale, fit);
  }, [fit, imageSize, screenshotScale, url]);

  const mapOverlays = useCallback((geometry: OverlayGeometry) => {
    const { scale, mapX, mapY, visibleLeft, visibleTop, visibleRight, visibleBottom } = geometry;
    const fitCenter = (value: number, radius: number, start: number, end: number) => {
      const extent = Math.max(end - start, 0);
      return extent <= radius * 2
        ? start + extent / 2
        : Math.min(Math.max(value, start + radius), end - radius);
    };

    setBoxes(
      layouts.map((layout) => {
        const badgeSize = Math.max(BADGE_RADIUS * 2 * dpr * scale, 14);
        const markerSize = Math.max(MARKER_RADIUS * 2 * dpr * scale, 10);
        const anchorLeft = fitCenter(mapX(layout.anchor.x), markerSize / 2, visibleLeft, visibleRight);
        const anchorTop = fitCenter(mapY(layout.anchor.y), markerSize / 2, visibleTop, visibleBottom);
        const badgeAnchorLeft = fitCenter(mapX(layout.badgeAnchor.x), badgeSize / 2, visibleLeft, visibleRight);
        const badgeAnchorTop = fitCenter(mapY(layout.badgeAnchor.y), badgeSize / 2, visibleTop, visibleBottom);
        const calloutLeft = layout.callout
          ? fitCenter(mapX(layout.callout.x), badgeSize / 2, visibleLeft, visibleRight)
          : null;
        const calloutTop = layout.callout
          ? fitCenter(mapY(layout.callout.y), badgeSize / 2, visibleTop, visibleBottom)
          : null;
        let leaderPoints = '';
        if (layout.leader.length >= 2 && calloutLeft !== null && calloutTop !== null) {
          const dx = calloutLeft - anchorLeft;
          const dy = calloutTop - anchorTop;
          const length = Math.hypot(dx, dy);
          if (length > markerSize / 2 + badgeSize / 2) {
            const ux = dx / length;
            const uy = dy / length;
            leaderPoints = [
              `${anchorLeft + ux * markerSize / 2},${anchorTop + uy * markerSize / 2}`,
              `${calloutLeft - ux * badgeSize / 2},${calloutTop - uy * badgeSize / 2}`,
            ].join(' ');
          }
        }

        return {
          order: layout.order,
          markerOnly: layout.markerOnly,
          drawFrame: isDrawableHighlightFrame(layout.frame),
          left: mapX(layout.frame.x),
          top: mapY(layout.frame.y),
          width: layout.frame.width * dpr * scale,
          height: layout.frame.height * dpr * scale,
          anchorLeft,
          anchorTop,
          badgeAnchorLeft,
          badgeAnchorTop,
          calloutLeft,
          calloutTop,
          borderWidth: Math.max(HIGHLIGHT_LINE_WIDTH * dpr * scale, 1),
          borderRadius: Math.max(HIGHLIGHT_RADIUS * dpr * scale, 0),
          badgeSize,
          badgeFontSize: Math.max(getBadgeFontSize(layout.order, badgeSize), 7),
          markerSize,
          markerRingWidth: Math.max(MARKER_RING_WIDTH * dpr * scale, 1),
          leaderWidth: Math.max(LEADER_LINE_WIDTH * dpr * scale, 1),
          leaderPoints,
        };
      }),
    );
  }, [dpr, layouts]);

  const clearOverlays = useCallback(() => setBoxes([]), []);

  const { imgRef, contentFrame, imageCssSize, redactionBoxes, showPixels } = useThumbnailOverlayMapping({
    url,
    fit,
    screenshotScale,
    redactions,
    privacyReviewRequired,
    masksBurnedIn,
    exactBox,
    measure,
    mapOverlays,
    clearOverlays,
  });

  const onImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img || !url) return;
    setImageSize((current) => {
      if (current?.url === url && current.width === img.naturalWidth && current.height === img.naturalHeight) {
        return current;
      }
      return { url, width: img.naturalWidth, height: img.naturalHeight };
    });
  }, [imgRef, url]);

  return (
    <ThumbnailSurface
      url={url}
      imgRef={imgRef}
      showPixels={showPixels}
      privacyReviewRequired={privacyReviewRequired}
      masksBurnedIn={masksBurnedIn}
      alt={alt}
      fit={fit}
      loading={loading}
      decoding={decoding}
      className={className}
      imgClassName={imgClassName}
      // Records natural size; the layout memo (depends on imageSize) drives the remap here,
      // unlike HighlightThumbnail's synchronous remap on load.
      onImageLoad={onImageLoad}
      contentFrame={contentFrame}
      redactionBoxes={redactionBoxes}
      imageEdits={imageEdits}
      imageCssSize={imageCssSize}
      overlay={overlay}
    >
        <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
          {boxes.map(
            (box) =>
              badges && box.calloutLeft !== null && box.calloutTop !== null && (
                <polyline
                  key={`leader-${box.order}`}
                  points={box.leaderPoints}
                  fill="none"
                  stroke={HIGHLIGHT_COLOR}
                  strokeWidth={box.leaderWidth}
                />
              ),
          )}
        </svg>
        {boxes.map((box) => (
          <div key={box.order}>
            {box.markerOnly ? (
              <div
                className="pointer-events-none absolute rounded-full bg-white"
                style={{
                  left: box.anchorLeft,
                  top: box.anchorTop,
                  width: box.markerSize,
                  height: box.markerSize,
                  marginLeft: -box.markerSize / 2,
                  marginTop: -box.markerSize / 2,
                  borderStyle: 'solid',
                  borderWidth: box.markerRingWidth,
                  borderColor: HIGHLIGHT_COLOR,
                }}
              >
                <div
                  className="absolute rounded-full"
                  style={{
                    inset: `${(1 - MARKER_INNER_RADIUS / MARKER_RADIUS) * 50}%`,
                    backgroundColor: HIGHLIGHT_COLOR,
                  }}
                />
              </div>
            ) : box.drawFrame && <HighlightFrame box={box} order={box.order} />}
            {badges && (numbered || box.calloutLeft) && (
              <div
                className="pointer-events-none absolute flex items-center justify-center rounded-full font-semibold shadow"
                style={{
                  left: box.calloutLeft ?? box.badgeAnchorLeft,
                  top: box.calloutTop ?? box.badgeAnchorTop,
                  width: box.badgeSize,
                  height: box.badgeSize,
                  marginLeft: -box.badgeSize / 2,
                  marginTop: -box.badgeSize / 2,
                  backgroundColor: HIGHLIGHT_COLOR,
                  color: BADGE_TEXT_COLOR,
                  fontSize: box.badgeFontSize,
                }}
              >
                {box.order}
              </div>
            )}
          </div>
        ))}
    </ThumbnailSurface>
  );
}
