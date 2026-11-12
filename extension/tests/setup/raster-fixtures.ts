/** Minimal screenshot Blobs whose headers pass the shared screenshot rule
 * (lib/storage/screenshot-rules), for tests that write steps to storage. Only
 * the header is real; nothing here is ever decoded. */
export function pngBlob(width = 2, height = 2, padding = 0): Blob {
  const bytes = new Uint8Array(24 + padding);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
}

export function jpegBlob(width = 2, height = 2): Blob {
  return new Blob(
    [
      new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        (height >>> 8) & 255,
        height & 255,
        (width >>> 8) & 255,
        width & 255,
        0x03,
        0x01,
        0x11,
        0x00,
        0x02,
        0x11,
        0x00,
        0x03,
        0x11,
        0x00,
        0xff,
        0xd9,
      ]),
    ],
    { type: 'image/jpeg' },
  );
}
