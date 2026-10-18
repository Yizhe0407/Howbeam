import { describe, expect, it } from 'vitest';
import { encodeBase64Fallback, encodeBase64Parts } from '@/lib/export/base64';

function encodeBase64(bytes: Uint8Array, signal?: AbortSignal): string {
  return encodeBase64Parts(bytes, signal).join('');
}

describe('chunked base64 encoding', () => {
  it('matches the platform encoder across chunk boundaries and padding lengths', () => {
    for (const size of [0, 1, 2, 3, 32_767, 32_768, 65_537]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) & 255);
      const expected = Buffer.from(bytes).toString('base64');
      expect(encodeBase64(bytes)).toBe(expected);
      // The pure-JS fallback must stay byte-identical for runtimes without
      // the native Uint8Array.prototype.toBase64 fast path.
      expect(encodeBase64Fallback(bytes)).toBe(expected);
    }
  });

  it('splits large inputs into parts whose concatenation is the whole encoding', () => {
    const bytes = Uint8Array.from({ length: 7 * 1024 * 1024 + 1 }, (_, index) => (index * 13 + 5) & 255);
    const parts = encodeBase64Parts(bytes);
    expect(parts.length).toBeGreaterThan(1);
    expect(Math.max(...parts.map((part) => part.length))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(parts.join('')).toBe(Buffer.from(bytes).toString('base64'));
    expect(encodeBase64Parts(new Uint8Array(0)).join('')).toBe('');
  });

  it('matches the platform encoder across the native input chunk boundary', () => {
    // The native fast path encodes 3 MiB sub-slices; a payload just past one
    // boundary exercises chunk concatenation plus a padded final chunk.
    const size = 3 * 1024 * 1024 + 5;
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) & 255;
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('polls AbortSignal during large encodes', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => encodeBase64(new Uint8Array(100_000), controller.signal)).toThrowError(/abort/i);
    expect(() => encodeBase64Fallback(new Uint8Array(100_000), controller.signal)).toThrowError(/abort/i);
  });
});
