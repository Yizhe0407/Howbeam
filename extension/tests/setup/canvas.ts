/**
 * jsdom has no canvas drawing and no createImageBitmap. Previews draw into a
 * canvas, so tests get a decoder that reports a fixed size and a 2D context
 * that records what is drawn: assert on the recorded operations with
 * {@link canvasOps}. Only installed in a DOM environment.
 */
export interface CanvasOp {
  op: string;
  args: unknown[];
  /** Style properties at the time of the call. */
  fillStyle?: unknown;
  strokeStyle?: unknown;
}

const recorded = new WeakMap<HTMLCanvasElement, CanvasOp[]>();
const imageSizes = new WeakMap<Blob, { width: number; height: number }>();
let defaultImageSize = { width: 800, height: 600 };

/** The size a later decode of `blob` reports; others decode as {@link setDefaultImageSize}. */
export function setImageSize(blob: Blob, width: number, height: number): void {
  imageSizes.set(blob, { width, height });
}

export function setDefaultImageSize(width: number, height: number): void {
  defaultImageSize = { width, height };
}

/** Operations drawn on the canvas since its last clearRect (one full frame). */
export function canvasOps(canvas: Element | null): CanvasOp[] {
  const ops = canvas ? (recorded.get(canvas as HTMLCanvasElement) ?? []) : [];
  const lastClear = ops.map((entry) => entry.op).lastIndexOf('clearRect');
  return lastClear === -1 ? ops : ops.slice(lastClear);
}

/** fillRect calls drawn in pure black: the masks (and a privacy block). */
export function maskRects(canvas: Element | null): number[][] {
  return canvasOps(canvas)
    .filter((entry) => entry.op === 'fillRect' && entry.fillStyle === '#000000')
    .map((entry) => entry.args as number[]);
}

function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ops: CanvasOp[] = [];
  recorded.set(canvas, ops);
  const state: Record<string | symbol, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '10px sans-serif',
  };
  return new Proxy(state, {
    get(target, key) {
      if (key === 'canvas') return canvas;
      if (key === 'measureText') {
        return (text: string) => {
          const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(target.font))?.[1] ?? 10);
          return { width: text.length * size * 0.6, actualBoundingBoxAscent: size * 0.7, actualBoundingBoxDescent: 0 };
        };
      }
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        ops.push({ op: String(key), args, fillStyle: target.fillStyle, strokeStyle: target.strokeStyle });
      };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

if (typeof window !== 'undefined' && typeof HTMLCanvasElement !== 'undefined') {
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    let context = contexts.get(this);
    if (!context) {
      context = recordingContext(this);
      contexts.set(this, context);
    }
    return context;
  } as typeof HTMLCanvasElement.prototype.getContext;

  if (typeof globalThis.createImageBitmap === 'undefined') {
    globalThis.createImageBitmap = (async (source: unknown) => {
      const size = source instanceof Blob ? (imageSizes.get(source) ?? defaultImageSize) : defaultImageSize;
      return { ...size, close() {} } as ImageBitmap;
    }) as typeof createImageBitmap;
  }
}
