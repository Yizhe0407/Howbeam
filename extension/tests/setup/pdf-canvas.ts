import { vi } from 'vitest';

/**
 * Stands in for OffscreenCanvas where the PDF pipeline runs without a real
 * browser canvas: measures 14px per code point (content width 1072px, so 76
 * code points fit per line) and rasterizes each finished page to `pageBlob`.
 * Returns the shared 2D-context spies plus the image-bitmap close spy;
 * callers stub globals, so pair with `vi.unstubAllGlobals()`.
 */
export function stubPdfCanvas(
  options: {
    pageBlob?: Blob;
    bitmap?: { width: number; height: number };
    /**
     * Overrides the encoded output per convertToBlob call (receives the canvas
     * size and encode options, e.g. the JPEG quality), so budget tests can
     * make the page raster and a screenshot re-encode produce different bytes.
     */
    convertToBlob?: (
      canvas: { width: number; height: number },
      encodeOptions?: { type?: string; quality?: number },
    ) => Blob;
  } = {},
) {
  const pageBlob = options.pageBlob ?? new Blob(['jpeg-page'], { type: 'image/jpeg' });
  const bitmap = options.bitmap ?? { width: 1_600, height: 900 };
  const bitmapClose = vi.fn();
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    roundRect: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: Array.from(text).length * 14 })),
  };
  class OffscreenCanvasStub {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return context;
    }
    async convertToBlob(encodeOptions?: { type?: string; quality?: number }) {
      return options.convertToBlob?.(this, encodeOptions) ?? pageBlob;
    }
  }
  vi.stubGlobal('OffscreenCanvas', OffscreenCanvasStub);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: bitmap.width, height: bitmap.height, close: bitmapClose })),
  );
  return Object.assign(context, { bitmapClose });
}
