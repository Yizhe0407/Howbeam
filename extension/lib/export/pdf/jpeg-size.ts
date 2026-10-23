export interface JpegSize {
  width: number;
  height: number;
}

/** Start-of-frame markers; 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC) share the range but carry no frame header. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Reads the pixel size from a JPEG's frame header without decoding the image. */
export function readJpegSize(bytes: Uint8Array): JpegSize {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG image.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = view.getUint8(offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Markers without a length: byte stuffing, TEM, RSTn, SOI and EOI.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) break;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += 2 + length;
  }
  throw new Error('JPEG image has no readable frame header.');
}
