import type { ReactNode, RefObject } from 'react';
import { cn } from '@/lib/shared/utils';
import type { ImageEdit } from '@/lib/storage/image-edit-model';
import type { Redaction } from '@/lib/storage/models';
import ImageEditsSvg from './ImageEditsSvg';
import RedactionsCanvas from './RedactionsCanvas';
import { getValidScreenshotScale } from '@/lib/media/image-utils';
import type { ImageContentFrame } from './use-thumbnail-overlay-mapping';

interface Props {
  url: string | null;
  imgRef: RefObject<HTMLImageElement | null>;
  /** From useThumbnailOverlayMapping: false hides source pixels fail-closed
   * (privacy review pending, or redaction positions not yet remapped). */
  showPixels: boolean;
  privacyReviewRequired: boolean;
  alt: string;
  fit: 'cover' | 'contain';
  className?: string;
  imgClassName?: string;
  onImageLoad: () => void;
  contentFrame: ImageContentFrame | null;
  /** Privacy masks in screenshot CSS coordinates; painted above highlights and image edits. */
  redactions: readonly Redaction[];
  /** See usePreviewImage's `liveMosaic`. */
  liveMosaic: ImageBitmap | null;
  /** Device pixels per CSS pixel of the screenshot. */
  screenshotScale: number;
  /** Text, arrows and rectangles drawn on the image; painted above highlights and below masks. */
  imageEdits: readonly ImageEdit[];
  /** The screenshot's size in CSS pixels, the coordinate space of `imageEdits`. */
  imageCssSize: { width: number; height: number } | null;
  /** Content rendered over the exact image frame. */
  overlay?: ReactNode;
  /** The component-specific highlight overlays; hidden with the pixels while privacy review is pending. */
  children?: ReactNode;
}

/**
 * Rendered surface shared by the highlight thumbnails: screenshot img, component-specific overlays,
 * image edits, privacy masks, and content-frame slot. Layer order is load-bearing: image edits (z-5)
 * sit above the highlight overlays, redactions (z-10) must cover both, and the content frame (z-20)
 * sits above all of them.
 */
export default function ThumbnailSurface({
  url,
  imgRef,
  showPixels,
  privacyReviewRequired,
  alt,
  fit,
  className,
  imgClassName,
  onImageLoad,
  contentFrame,
  redactions,
  liveMosaic,
  screenshotScale,
  imageEdits,
  imageCssSize,
  overlay,
  children,
}: Props) {
  const defaultImgClass = fit === 'contain' ? 'max-h-full max-w-full w-auto h-auto' : 'w-full h-full';

  return (
    <div className={cn('relative inline-block leading-none', !showPixels && 'bg-black', className)}>
      {url && (
        <img
          ref={imgRef}
          src={url}
          decoding="async"
          alt={privacyReviewRequired ? '' : alt}
          aria-hidden={privacyReviewRequired || undefined}
          onLoad={onImageLoad}
          draggable={false}
          // `url` is the stored screenshot with the masks drawn over it: dragging it out or
          // opening it from the context menu would hand out the pixels the masks cover.
          onContextMenu={(event) => event.preventDefault()}
          className={cn('block', imgClassName ?? defaultImgClass)}
          style={{
            ...(imgClassName ? { objectFit: fit } : fit === 'cover' ? { objectFit: 'cover' } : {}),
            visibility: showPixels ? undefined : 'hidden',
          }}
        />
      )}
      {!privacyReviewRequired && children}
      {!privacyReviewRequired && contentFrame && imageCssSize && imageEdits.length > 0 && (
        <div data-howbeam-image-edits className="pointer-events-none absolute z-[5]" style={contentFrame}>
          <ImageEditsSvg edits={imageEdits} width={imageCssSize.width} height={imageCssSize.height} />
        </div>
      )}
      {!privacyReviewRequired && contentFrame && imageCssSize && redactions.length > 0 && (
        <div data-howbeam-redactions className="pointer-events-none absolute z-10" style={contentFrame}>
          {/* Live masks change with every brush movement: painted, not laid out. */}
          <RedactionsCanvas
            redactions={redactions}
            width={imageCssSize.width}
            height={imageCssSize.height}
            dpr={getValidScreenshotScale(screenshotScale)}
            mosaic={liveMosaic}
          />
        </div>
      )}
      {overlay && contentFrame && (
        <div
          data-howbeam-image-content-frame
          className="pointer-events-none absolute z-20"
          style={contentFrame}
        >
          <div className="relative h-full w-full">{overlay}</div>
        </div>
      )}
    </div>
  );
}
