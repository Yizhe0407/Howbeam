import { useCallback, useState, type ReactNode } from 'react';
import { HIGHLIGHT_LINE_WIDTH, HIGHLIGHT_RADIUS } from '@/lib/media/annotation-contract';
import { fitHighlightFrame } from '@/lib/media/annotation-geometry';
import { usePreviewImage } from '@/lib/editor/use-preview-image';
import type { CropOrigin } from '@/lib/media/crop-offset';
import { type Bounds, type ImageEdit, type Redaction } from '@/lib/storage/models';
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
  bounds: Bounds | null;
  /** Privacy masks in screenshot CSS coordinates. */
  redactions?: Redaction[];
  /** Where `blob` was cut from the stored screenshot, so mosaic cells stay on its grid. */
  mosaicOrigin?: CropOrigin;
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
  alt: string;
  className?: string;
  imgClassName?: string;
  /** Content rendered over the exact image frame. */
  overlay?: ReactNode;
  /** 'cover' crops to fill a fixed box (popup thumbnails). 'contain' shows the
   * full uncropped screenshot at its natural aspect ratio (editor cards). */
  fit?: 'cover' | 'contain';
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
}

interface BoxStyle {
  left: number;
  top: number;
  width: number;
  height: number;
  borderWidth: number;
  borderRadius: number;
}

/**
 * Renders a screenshot, with its masks burned into the pixels (see usePreviewImage), and the
 * highlight box drawn as a CSS overlay (not baked into the image).
 * Border width is scaled by (rendered width / natural width) so it matches the exported image's border proportionally.
 */
export default function HighlightThumbnail({
  blob,
  bounds,
  redactions = NO_REDACTIONS,
  privacyReviewRequired = false,
  exactBox = false,
  imageEdits = NO_EDITS,
  liveMasks = false,
  mosaicOrigin,
  screenshotScale,
  alt,
  className,
  imgClassName,
  overlay,
  fit = 'cover',
  loading = 'eager',
  decoding = 'async',
}: Props) {
  const { url, masksBurnedIn, mosaicUrl, liveMosaic } = usePreviewImage(blob, { redactions, screenshotScale, privacyReviewRequired, liveMasks, mosaicOrigin });
  const [box, setBox] = useState<BoxStyle | null>(null);

  const measure = useCallback((img: HTMLImageElement) => (
    img.naturalWidth && img.naturalHeight
      ? computeOverlayGeometry(img, img.naturalWidth, img.naturalHeight, screenshotScale, fit)
      : null
  ), [fit, screenshotScale]);

  const mapOverlays = useCallback((geometry: OverlayGeometry) => {
    if (!bounds) {
      setBox(null);
      return;
    }
    const { dpr, scale, mapX, mapY } = geometry;
    const frame = fitHighlightFrame(bounds, geometry.naturalWidth / dpr, geometry.naturalHeight / dpr);
    if (!isDrawableHighlightFrame(frame)) {
      setBox(null);
      return;
    }
    setBox({
      left: mapX(frame.x),
      top: mapY(frame.y),
      width: frame.width * dpr * scale,
      height: frame.height * dpr * scale,
      borderWidth: Math.max(HIGHLIGHT_LINE_WIDTH * dpr * scale, 1),
      borderRadius: Math.max(HIGHLIGHT_RADIUS * dpr * scale, 0),
    });
  }, [bounds]);

  const clearOverlays = useCallback(() => setBox(null), []);

  const { imgRef, contentFrame, imageCssSize, showPixels, remap } = useThumbnailOverlayMapping({
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
      // Single-image mode remaps synchronously on load, unlike MultiHighlightThumbnail.
      onImageLoad={remap}
      contentFrame={contentFrame}
      redactions={redactions}
      mosaicUrl={mosaicUrl}
      liveMosaic={liveMosaic}
      screenshotScale={screenshotScale}
      imageEdits={imageEdits}
      imageCssSize={imageCssSize}
      overlay={overlay}
    >
      {box && <HighlightFrame box={box} />}
    </ThumbnailSurface>
  );
}
