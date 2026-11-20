import { useLayoutEffect, useRef } from 'react';
import { drawRedactions, paintMosaicStroke } from '@/lib/media/redaction-render';
import type { Redaction } from '@/lib/storage/models';

interface Props {
  redactions: readonly Redaction[];
  /** The screenshot's size in CSS pixels, the coordinate space of `redactions`. */
  width: number;
  height: number;
  /** Device pixels per CSS pixel of the screenshot: the canvas has the screenshot's own resolution. */
  dpr: number;
  /** The screenshot pixelated on the mosaic grid; null paints strokes solid until it exists. */
  mosaic: ImageBitmap | null;
}

interface Painted {
  redactions: readonly Redaction[];
  mosaic: ImageBitmap | null;
  width: number;
  height: number;
}

function samePoints(a: readonly { x: number; y: number }[], b: readonly { x: number; y: number }[], count: number): boolean {
  for (let index = 0; index < count; index += 1) {
    if (a[index]!.x !== b[index]!.x || a[index]!.y !== b[index]!.y) return false;
  }
  return true;
}

function sameRedaction(a: Redaction, b: Redaction): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.kind !== b.kind) return false;
  if (a.kind === 'solid' && b.kind === 'solid') {
    return a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y && a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height;
  }
  return a.kind === 'pixelate' && b.kind === 'pixelate'
    && a.size === b.size && a.points.length === b.points.length && samePoints(a.points, b.points, a.points.length);
}

/**
 * How much of `next` is already on the canvas: every mask but the last must be
 * unchanged, and the last must be the stroke being painted, grown at its end.
 * Returns the point to continue painting it from, or null when a full repaint is needed.
 */
function continuedFrom(painted: Painted, next: Props): number | null {
  if (painted.mosaic !== next.mosaic || painted.width !== next.width || painted.height !== next.height) return null;
  const before = painted.redactions;
  const after = next.redactions;
  const last = after.at(-1);
  if (!last || last.kind !== 'pixelate') return null;
  if (after.length === before.length + 1) {
    // A stroke just started.
    return before.every((redaction, index) => sameRedaction(redaction, after[index]!)) ? 0 : null;
  }
  if (after.length !== before.length) return null;
  const previous = before.at(-1)!;
  if (
    previous.kind !== 'pixelate' || previous.id !== last.id || previous.size !== last.size
    || previous.points.length > last.points.length || !samePoints(previous.points, last.points, previous.points.length)
  ) {
    return null;
  }
  for (let index = 0; index < after.length - 1; index += 1) {
    if (!sameRedaction(before[index]!, after[index]!)) return null;
  }
  return previous.points.length;
}

/**
 * The image editor's privacy masks, painted on a canvas at the screenshot's
 * own resolution with the same drawing code as exports. While a stroke is
 * being painted only its newest stretch is drawn; anything else repaints all.
 */
export default function RedactionsCanvas({ redactions, width, height, dpr, mosaic }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paintedRef = useRef<Painted | null>(null);
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const next = { redactions, mosaic, width, height };
    const painted = paintedRef.current;
    const start = painted && canvas.width === pixelWidth && canvas.height === pixelHeight ? continuedFrom(painted, { ...next, dpr }) : null;
    if (start === null) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawRedactions(ctx, redactions, width, height, dpr, mosaic);
    } else {
      paintMosaicStroke(ctx, redactions.at(-1) as Extract<Redaction, { kind: 'pixelate' }>, mosaic, dpr, start);
    }
    paintedRef.current = next;
  }, [redactions, mosaic, width, height, dpr, pixelWidth, pixelHeight]);

  return (
    <canvas
      ref={canvasRef}
      data-howbeam-redactions-canvas=""
      width={pixelWidth}
      height={pixelHeight}
      className="absolute inset-0 size-full"
      aria-hidden="true"
    />
  );
}
