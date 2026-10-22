import { describe, expect, it } from 'vitest';
import { readJpegSize } from '@/lib/export/pdf/jpeg-size';
import { jpegOfSize } from '../setup/jpeg-fixture';

describe('readJpegSize', () => {
  it('reads the size from the frame header', () => {
    expect(readJpegSize(jpegOfSize(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(readJpegSize(jpegOfSize(7, 65_000))).toEqual({ width: 7, height: 65_000 });
  });

  it('skips segments that come before the frame, such as JFIF and Exif', () => {
    const app0 = Uint8Array.of(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
    const comment = Uint8Array.of(0xff, 0xfe, 0x00, 0x06, 0x61, 0x62, 0x63, 0x64);
    // A DHT marker (0xC4) sits in the start-of-frame range but is not a frame.
    const huffman = Uint8Array.of(0xff, 0xc4, 0x00, 0x04, 0x00, 0x00);

    expect(readJpegSize(jpegOfSize(640, 480, [app0, comment, huffman]))).toEqual({ width: 640, height: 480 });
  });

  it('reads progressive JPEGs (SOF2) too', () => {
    const progressive = jpegOfSize(300, 200);
    const frame = progressive.indexOf(0xc0, 2);
    progressive[frame] = 0xc2;

    expect(readJpegSize(progressive)).toEqual({ width: 300, height: 200 });
  });

  it('rejects bytes that are not a JPEG', () => {
    expect(() => readJpegSize(new TextEncoder().encode('not an image'))).toThrow('Not a JPEG image.');
    expect(() => readJpegSize(Uint8Array.of(0xff, 0xd8))).toThrow('Not a JPEG image.');
  });

  it('rejects a JPEG without a readable frame header', () => {
    expect(() => readJpegSize(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00))).toThrow('no readable frame header');
    expect(() => readJpegSize(jpegOfSize(0, 0))).toThrow('no readable frame header');
  });
});
