import type { ReactNode, RefObject } from 'react';
import { cn } from '@/lib/shared/utils';
import type { ImageEdit } from '@/lib/storage/image-edit-model';
import ImageEditsSvg from './ImageEditsSvg';
import type { ImageContentFrame, RedactionStyle } from './use-thumbnail-overlay-mapping';

interface Props {
  url: string | null;
  imgRef: RefObject<HTMLImageElement | null>;
  /** From useThumbnailOverlayMapping: false hides source pixels fail-closed
   * (privacy review pending, or redaction positions not yet remapped). */
  showPixels: boolean;
  privacyReviewRequired: boolean;
  /** False only in the image editor, where `url` is the stored screenshot with
   * masks drawn on top: the image then refuses to be dragged out or opened
   * from the context menu, which would bypass those masks. */
  masksBurnedIn: boolean;
  alt: string;
  fit: 'cover' | 'contain';
  loading: 'lazy' | 'eager';
  decoding: 'async' | 'sync' | 'auto';
  className?: string;
  imgClassName?: string;
  onImageLoad: () => void;
  contentFrame: ImageContentFrame | null;
  redactionBoxes: RedactionStyle[];
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
 * image edits, redaction boxes, and content-frame slot. Layer order is load-bearing: image edits (z-5)
 * sit above the highlight overlays, redactions (z-10) must cover both, and the content frame (z-20)
 * sits above all of them.
 */
export default function ThumbnailSurface({
  url,
  imgRef,
  showPixels,
  privacyReviewRequired,
  masksBurnedIn,
  alt,
  fit,
  loading,
  decoding,
  className,
  imgClassName,
  onImageLoad,
  contentFrame,
  redactionBoxes,
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
          loading={loading}
          decoding={decoding}
          alt={privacyReviewRequired ? '' : alt}
          aria-hidden={privacyReviewRequired || undefined}
          onLoad={onImageLoad}
          draggable={false}
          onContextMenu={masksBurnedIn ? undefined : (event) => event.preventDefault()}
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
      {!privacyReviewRequired && redactionBoxes.map((redaction) => (
        <div
          key={redaction.id}
          data-howbeam-redaction={redaction.id}
          className="pointer-events-none absolute z-10"
          style={{
            left: redaction.left,
            top: redaction.top,
            width: redaction.width,
            height: redaction.height,
            backgroundColor: '#000',
          }}
        />
      ))}
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
