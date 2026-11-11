import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { drawAnnotationScene, type AnnotationScene } from '@/lib/media/annotation-scene';
import { decodeImage } from '@/lib/media/decode-image';
import { getValidScreenshotScale } from '@/lib/media/image-utils';
import { cn } from '@/lib/shared/utils';

interface Props {
  blob: Blob;
  scene: AnnotationScene;
  screenshotScale: number;
  alt: string;
  className?: string;
  /** Sizing for the canvas, which sizes like an image of the screenshot's natural size. */
  imgClassName?: string;
  /** Content laid exactly over the image's pixels (letterboxing excluded). */
  overlay?: ReactNode;
  /** 'cover' fills a fixed box, cropping; 'contain' shows the whole screenshot. */
  fit?: 'cover' | 'contain';
  /** 'lazy' decodes only once the preview is near the viewport. */
  loading?: 'lazy' | 'eager';
}

interface Layout {
  /** The canvas element's box inside its positioned parent. */
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ContentFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** On-screen CSS pixels per screenshot pixel. */
  scale: number;
}

/** Where the image's pixels land in the canvas box under object-fit. */
function contentFrame(layout: Layout, naturalWidth: number, naturalHeight: number, fit: 'cover' | 'contain'): ContentFrame {
  const scale = fit === 'cover'
    ? Math.max(layout.width / naturalWidth, layout.height / naturalHeight)
    : Math.min(layout.width / naturalWidth, layout.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: layout.left + (layout.width - width) / 2,
    top: layout.top + (layout.height - height) / 2,
    width,
    height,
    scale,
  };
}

function useDecodedImage(blob: Blob, enabled: boolean): ImageBitmap | null {
  const [decoded, setDecoded] = useState<{ blob: Blob; bitmap: ImageBitmap } | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let bitmap: ImageBitmap | null = null;
    decodeImage(blob).then((result) => {
      bitmap = result;
      if (cancelled) result.close();
      else setDecoded({ blob, bitmap: result });
    }, (error) => {
      console.error('[howbeam] failed to decode a preview image', error);
    });
    return () => {
      cancelled = true;
      bitmap?.close();
    };
  }, [blob, enabled]);
  return decoded?.blob === blob ? decoded.bitmap : null;
}

function useNearViewport(lazy: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(!lazy || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !ref.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: '200px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near]);
  return { ref, near };
}

/**
 * A screenshot with its scene drawn into the same pixels, by the very code an
 * export uses (drawAnnotationScene). Masks are part of the pixels, so saving
 * or dragging the preview can never reveal what they hide.
 */
export default function AnnotatedImage({
  blob,
  scene,
  screenshotScale,
  alt,
  className,
  imgClassName,
  overlay,
  fit = 'cover',
  loading = 'eager',
}: Props) {
  const { ref: wrapperRef, near } = useNearViewport(loading === 'lazy');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmap = useDecodedImage(blob, near);
  const [layout, setLayout] = useState<Layout | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const measure = () => {
      const next = { left: canvas.offsetLeft, top: canvas.offsetTop, width: canvas.clientWidth, height: canvas.clientHeight };
      setLayout((current) => (
        current && current.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height
          ? current
          : next
      ));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [bitmap]);

  const frame = bitmap && layout && layout.width > 0 && layout.height > 0
    ? contentFrame(layout, bitmap.width, bitmap.height, fit)
    : null;

  const frameScale = frame?.scale ?? null;
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap) return;
    // A fixed-size cover box only needs its on-screen pixels; a contain image
    // keeps its natural size, because that size is what the layout sizes it by.
    const deviceRatio = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const backing = fit === 'cover' && frameScale ? Math.min(1, frameScale * deviceRatio) : 1;
    const width = Math.max(1, Math.round(bitmap.width * backing));
    const height = Math.max(1, Math.round(bitmap.height * backing));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(width / bitmap.width, 0, 0, height / bitmap.height, 0, 0);
    ctx.clearRect(0, 0, bitmap.width, bitmap.height);
    if (!scene.privacyBlock) ctx.drawImage(bitmap, 0, 0);
    const dpr = getValidScreenshotScale(screenshotScale);
    drawAnnotationScene(ctx, scene, {
      dpr,
      viewportWidth: bitmap.width / dpr,
      viewportHeight: bitmap.height / dpr,
      screenPixel: frameScale ? 1 / frameScale : 0,
    });
  }, [bitmap, fit, frameScale, scene, screenshotScale]);

  const marks = scene.annotations.length + (scene.highlight ? 1 : 0);
  return (
    <div ref={wrapperRef} className={cn('relative inline-block leading-none', !bitmap && 'bg-black/5', className)}>
      <canvas
        ref={canvasRef}
        role={alt && !scene.privacyBlock ? 'img' : undefined}
        aria-label={alt && !scene.privacyBlock ? alt : undefined}
        aria-hidden={!alt || scene.privacyBlock || undefined}
        data-howbeam-annotated-image=""
        data-howbeam-marks={marks}
        data-howbeam-privacy-block={scene.privacyBlock || undefined}
        className={cn('block', imgClassName ?? (fit === 'contain' ? 'h-auto max-h-full w-auto max-w-full' : 'h-full w-full'))}
        style={{ objectFit: fit, visibility: bitmap ? undefined : 'hidden' }}
      />
      {overlay && frame && (
        <div
          data-howbeam-image-content-frame
          className="pointer-events-none absolute z-20"
          style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
        >
          <div className="relative h-full w-full">{overlay}</div>
        </div>
      )}
    </div>
  );
}
