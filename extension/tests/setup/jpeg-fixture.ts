/**
 * A JPEG with the given pixel size: a real start-of-image, a frame header and
 * an end-of-image, which is everything a PDF embeds and the layout reads. It
 * is not decodable, so it only suits code that never decodes.
 */
export function jpegOfSize(width: number, height: number, extraSegments: Uint8Array[] = []): Uint8Array<ArrayBuffer> {
  const frame = Uint8Array.of(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  );
  const parts = [Uint8Array.of(0xff, 0xd8), ...extraSegments, frame, Uint8Array.of(0xff, 0xd9)];
  const bytes = new Uint8Array(new ArrayBuffer(parts.reduce((sum, part) => sum + part.length, 0)));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
