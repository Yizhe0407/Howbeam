import { describe, expect, it, vi } from 'vitest';
import {
  RASTER_IMAGE_LIMITS,
  RasterImageValidationError,
  validateRasterImageBlob,
} from '@/lib/media/raster-image-validation';

function png(width: number, height: number, type = 'image/png'): Blob {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return new Blob([bytes], { type });
}

function jpeg(width: number, height: number): Blob {
  return new Blob([new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ])], { type: 'image/jpeg' });
}

/** JPEG whose SOF sits behind `exifSegments` maximum-length APP1 segments, so
 * it lands past the initial bounded sniffing prefix (2 segments ≈ 128 KiB). */
function jpegWithLargeExif(width: number, height: number, exifSegments = 2): Blob {
  const parts = [new Uint8Array([0xff, 0xd8])];
  for (let segment = 0; segment < exifSegments; segment++) {
    const app1 = new Uint8Array(2 + 0xffff);
    app1.set([0xff, 0xe1, 0xff, 0xff], 0);
    parts.push(app1);
  }
  parts.push(new Uint8Array([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]));
  return new Blob(parts, { type: 'image/jpeg' });
}

function webpVp8x(width: number, height: number): Blob {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255], 24);
  bytes.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 27);
  return new Blob([bytes], { type: 'image/webp' });
}

describe('raster image validation', () => {
  it('reads bounded PNG, JPEG, and WebP dimensions without decoding pixels', async () => {
    await expect(validateRasterImageBlob(png(320, 200))).resolves.toEqual({ width: 320, height: 200, mediaType: 'image/png' });
    await expect(validateRasterImageBlob(jpeg(640, 480))).resolves.toEqual({ width: 640, height: 480, mediaType: 'image/jpeg' });
    await expect(validateRasterImageBlob(webpVp8x(1024, 768))).resolves.toEqual({ width: 1024, height: 768, mediaType: 'image/webp' });
  });

  it('sniffs only bounded prefixes instead of buffering the whole blob', async () => {
    const blob = png(320, 200);
    const fullRead = vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('whole-blob read'));

    await expect(validateRasterImageBlob(blob)).resolves.toEqual({ width: 320, height: 200, mediaType: 'image/png' });
    expect(fullRead).not.toHaveBeenCalled();
  });

  it('grows the JPEG scan window past large EXIF segments instead of rejecting', async () => {
    await expect(validateRasterImageBlob(jpegWithLargeExif(800, 600))).resolves.toEqual({
      width: 800,
      height: 600,
      mediaType: 'image/jpeg',
    });
  });

  it('still rejects a complete JPEG whose segment overruns the file', async () => {
    const overrun = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00])], { type: 'image/jpeg' });
    await expect(validateRasterImageBlob(overrun)).rejects.toThrow(/invalid segment/);
  });

  it('rejects MIME spoofing and truncated headers', async () => {
    await expect(validateRasterImageBlob(png(1, 1, 'image/jpeg'))).rejects.toBeInstanceOf(RasterImageValidationError);
    await expect(validateRasterImageBlob(new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }))).rejects.toBeInstanceOf(RasterImageValidationError);
  });

  it('rejects dimensions and pixel counts that could exhaust canvas memory', async () => {
    await expect(validateRasterImageBlob(png(RASTER_IMAGE_LIMITS.maxDimension + 1, 1))).rejects.toThrow(/dimension limit/);
    await expect(validateRasterImageBlob(png(16_384, 16_384))).rejects.toThrow(/allocation limit/);
  });
});
