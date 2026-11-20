import { useLayoutEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/shared/utils';
import { getEntryPrivacyState, type StepEntry } from '@/lib/storage/models';
import { useEntryPreview, type EntryPreviewOptions } from '@/lib/editor/use-entry-preview';
import { useObjectUrl } from '@/lib/editor/use-object-url';
import { computeOverlayGeometry, type ImageContentFrame } from './use-thumbnail-overlay-mapping';

interface Props extends EntryPreviewOptions {
  entry: StepEntry;
  alt: string;
  fit?: 'cover' | 'contain';
  className?: string;
  imgClassName?: string;
  /** Content laid over exactly the image's pixels. */
  overlay?: ReactNode;
  /** False holds off rendering, for a preview that is not near the screen yet. */
  enabled?: boolean;
}

/** Where the image's pixels sit inside its element, kept current as the element resizes. */
function useContentFrame(img: HTMLImageElement | null, fit: 'cover' | 'contain', wanted: boolean): ImageContentFrame | null {
  const [frame, setFrame] = useState<ImageContentFrame | null>(null);
  useLayoutEffect(() => {
    if (!wanted || !img) {
      setFrame(null);
      return undefined;
    }
    const measure = () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      setFrame(computeOverlayGeometry(img, img.naturalWidth, img.naturalHeight, 1, fit).contentFrame);
    };
    measure();
    img.addEventListener('load', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(img);
    return () => {
      img.removeEventListener('load', measure);
      observer?.disconnect();
    };
  }, [img, fit, wanted]);
  return frame;
}

/**
 * An entry's finished image, exactly as it is copied or exported: highlight
 * boxes, drawings and burned-in masks are all pixels of one raster (see
 * useEntryPreview), so a preview costs the page one image and nothing else,
 * however much was drawn on it. Shows nothing until that image exists; while
 * privacy review is pending the image is entirely black.
 */
export default function EntryPreview({
  entry,
  alt,
  fit = 'cover',
  className,
  imgClassName,
  overlay,
  enabled = true,
  maxPixelWidth,
  badges,
}: Props) {
  const blob = useEntryPreview(entry, { maxPixelWidth, badges }, enabled);
  const url = useObjectUrl(blob) || null;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const contentFrame = useContentFrame(img, fit, Boolean(overlay && url));
  const privacyReviewRequired = getEntryPrivacyState(entry).reviewRequired;

  return (
    <div className={cn('relative inline-block leading-none', className)}>
      {url && (
        <img
          ref={setImg}
          src={url}
          decoding="async"
          alt={privacyReviewRequired ? '' : alt}
          aria-hidden={privacyReviewRequired || undefined}
          draggable={false}
          className={cn('block', imgClassName ?? 'h-full w-full')}
          style={{ objectFit: fit }}
        />
      )}
      {overlay && contentFrame && (
        <div data-howbeam-image-content-frame className="pointer-events-none absolute z-20" style={contentFrame}>
          <div className="relative h-full w-full">{overlay}</div>
        </div>
      )}
    </div>
  );
}
