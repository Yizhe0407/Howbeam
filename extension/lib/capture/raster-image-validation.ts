export const RASTER_IMAGE_LIMITS = Object.freeze({
  maxDimension: 16_384,
  maxPixels: 64 * 1024 * 1024,
});

type SupportedRasterMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/** PNG and WebP headers sit at fixed offsets well inside this many bytes. */
const HEADER_PREFIX_BYTES = 64;
/** JPEG SOF usually appears within the first tens of KB; EXIF-heavy files can
 * push it further out, so the scan grows the prefix instead of failing. */
const JPEG_SCAN_INITIAL_BYTES = 64 * 1024;
const JPEG_SCAN_GROWTH_FACTOR = 4;

export interface RasterImageDimensions {
  width: number;
  height: number;
  mediaType: SupportedRasterMediaType;
}

export class RasterImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RasterImageValidationError';
  }
}

function invalid(message: string): never {
  throw new RasterImageValidationError(message);
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function uint8(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getUint8(offset);
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getUint16(offset);
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getUint16(offset, true);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return uint16le(bytes, offset) | (uint8(bytes, offset + 2) << 16);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getUint32(offset);
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getUint32(offset, true);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    invalid('The data is not a valid PNG image.');
  }
  if (uint32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') {
    invalid('The PNG image is missing its required IHDR header.');
  }
  return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Scans JPEG segments for a SOF header. Returns `null` when the scan walked
 * off the end of an incomplete prefix — the caller must retry with more bytes
 * — so large-EXIF files are never mistaken for truncated ones. Truncation
 * errors are only raised once `complete` says the whole blob was scanned. */
function jpegDimensions(bytes: Uint8Array, complete = true): { width: number; height: number } | null {
  if (bytes.length < 4) {
    if (!complete) return null;
    invalid('The data is not a valid JPEG image.');
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid('The data is not a valid JPEG image.');
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = uint8(bytes, offset++);
    if (marker === 0x00) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) {
      if (!complete) return null;
      invalid('The JPEG image contains a truncated segment.');
    }
    const segmentLength = uint16be(bytes, offset);
    if (segmentLength < 2) invalid('The JPEG image contains an invalid segment.');
    if (offset + segmentLength > bytes.length) {
      if (!complete) return null;
      invalid('The JPEG image contains an invalid segment.');
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) invalid('The JPEG frame header is truncated.');
      return { height: uint16be(bytes, offset + 3), width: uint16be(bytes, offset + 5) };
    }
    offset += segmentLength;
  }
  if (!complete) return null;
  invalid('The JPEG image is missing a supported frame header.');
}

function webpDimensions(bytes: Uint8Array, totalByteLength: number): { width: number; height: number } {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    invalid('The data is not a valid WebP image.');
  }
  const declaredLength = uint32le(bytes, 4) + 8;
  if (declaredLength > totalByteLength || declaredLength < 20) invalid('The WebP container length is invalid.');
  const chunkType = ascii(bytes, 12, 4);
  const chunkLength = uint32le(bytes, 16);
  if (20 + chunkLength > declaredLength) invalid('The WebP image contains a truncated image chunk.');

  if (chunkType === 'VP8X') {
    if (chunkLength < 10) invalid('The WebP VP8X header is truncated.');
    return { width: uint24le(bytes, 24) + 1, height: uint24le(bytes, 27) + 1 };
  }
  if (chunkType === 'VP8L') {
    if (chunkLength < 5 || bytes[20] !== 0x2f) invalid('The WebP VP8L header is invalid.');
    const bits = uint32le(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunkType === 'VP8 ') {
    if (chunkLength < 10 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      invalid('The WebP VP8 frame header is invalid.');
    }
    return {
      width: uint16le(bytes, 26) & 0x3fff,
      height: uint16le(bytes, 28) & 0x3fff,
    };
  }
  invalid('The WebP image has an unsupported primary chunk.');
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    invalid('The raster image has invalid dimensions.');
  }
  if (width > RASTER_IMAGE_LIMITS.maxDimension || height > RASTER_IMAGE_LIMITS.maxDimension) {
    invalid(`The raster image exceeds the ${RASTER_IMAGE_LIMITS.maxDimension}-pixel dimension limit.`);
  }
  if (width * height > RASTER_IMAGE_LIMITS.maxPixels) {
    invalid(`The raster image exceeds the ${RASTER_IMAGE_LIMITS.maxPixels}-pixel allocation limit.`);
  }
}

async function readPrefix(blob: Blob, byteLength: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, byteLength).arrayBuffer());
}

/** Reads progressively larger prefixes until the SOF scan either finds the
 * frame header or has seen the complete blob, so multi-MB screenshots are
 * never buffered whole just to sniff their dimensions. */
async function jpegBlobDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  let prefixLength = Math.min(JPEG_SCAN_INITIAL_BYTES, blob.size);
  for (;;) {
    const complete = prefixLength >= blob.size;
    const dimensions = jpegDimensions(await readPrefix(blob, prefixLength), complete);
    if (dimensions) return dimensions;
    prefixLength = Math.min(prefixLength * JPEG_SCAN_GROWTH_FACTOR, blob.size);
  }
}

/** Verifies MIME/magic-byte agreement and bounds raster allocation before
 * decoding. Only bounded header prefixes are read into memory. */
export async function validateRasterImageBlob(blob: Blob): Promise<RasterImageDimensions> {
  const mediaType = blob.type as SupportedRasterMediaType;
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp') {
    invalid(`Unsupported raster image media type ${JSON.stringify(blob.type)}.`);
  }
  const dimensions = mediaType === 'image/png'
    ? pngDimensions(await readPrefix(blob, HEADER_PREFIX_BYTES))
    : mediaType === 'image/webp'
      ? webpDimensions(await readPrefix(blob, HEADER_PREFIX_BYTES), blob.size)
      : await jpegBlobDimensions(blob);
  validateDimensions(dimensions.width, dimensions.height);
  return { ...dimensions, mediaType };
}
