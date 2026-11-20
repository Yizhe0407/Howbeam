import type { CropOrigin } from './crop-offset';
import { getValidScreenshotScale, rasterContext } from './image-utils';
import { pixelatedCopy } from './redaction-render';

/**
 * The whole source image pixelated on the mosaic grid, for the image editor:
 * there the masks are painted live over the stored pixels, and a mosaic stroke
 * shows this bitmap through its shape. One result per source and grid; a
 * failure is not remembered.
 */
const mosaicCache = new WeakMap<Blob, Map<string, Promise<ImageBitmap>>>();

export function getMosaicBitmap(source: Blob, screenshotScale: number, mosaicOrigin: CropOrigin): Promise<ImageBitmap> {
  const dpr = getValidScreenshotScale(screenshotScale);
  const key = `${dpr}#${mosaicOrigin.x},${mosaicOrigin.y}`;
  let results = mosaicCache.get(source);
  if (!results) {
    results = new Map();
    mosaicCache.set(source, results);
  }
  const owner = results;
  const existing = owner.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const bitmap = await createImageBitmap(source);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = rasterContext(canvas);
      ctx.drawImage(bitmap, 0, 0);
      return await createImageBitmap(pixelatedCopy(canvas, dpr, mosaicOrigin));
    } finally {
      bitmap.close();
    }
  })();
  promise.catch(() => {
    if (owner.get(key) === promise) owner.delete(key);
  });
  owner.set(key, promise);
  return promise;
}
