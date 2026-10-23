import { throwIfAborted } from '../shared/abort';

/** Standard (RFC 4648) alphabet. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const OUTPUT_CHUNK_SIZE = 32_768;

/** Multiple of three, so every native chunk encodes without padding and the
 * concatenation of chunk outputs is byte-identical to one whole-input encode.
 * Three MB keeps the abort signal polled a few hundred times per second even
 * on slow hardware. */
const NATIVE_INPUT_CHUNK_BYTES = 3 * 1024 * 1024;

/** `Uint8Array.prototype.toBase64` (Chrome 140+); TS 5.9 lacks the lib type. */
const nativeToBase64: ((this: Uint8Array) => string) | undefined = (
  Uint8Array.prototype as Uint8Array & { toBase64?: (this: Uint8Array) => string }
).toBase64;

/**
 * Encodes bytes to standard base64 with padding, returned as consecutive
 * pieces whose concatenation is the full base64 text. Lets a caller hand each
 * piece to a Blob instead of ever materialising one multi-MB string.
 *
 * Prefers the native `Uint8Array.prototype.toBase64` (about three orders of
 * magnitude faster than any JS loop for multi-MB screenshots), chunked so
 * large inputs still poll the abort signal. Falls back to the chunked JS
 * encoder on runtimes without it.
 */
export function encodeBase64Parts(bytes: Uint8Array, signal?: AbortSignal): string[] {
  throwIfAborted(signal);
  if (!nativeToBase64) return encodeBase64FallbackParts(bytes, signal);
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += NATIVE_INPUT_CHUNK_BYTES) {
    throwIfAborted(signal);
    parts.push(nativeToBase64.call(bytes.subarray(index, index + NATIVE_INPUT_CHUNK_BYTES)));
  }
  return parts;
}

/** Pure-JS path for runtimes without `toBase64`, avoiding one array entry per
 * output character. Exported so tests cover it on runtimes that never take it. */
export function encodeBase64Fallback(bytes: Uint8Array, signal?: AbortSignal): string {
  return encodeBase64FallbackParts(bytes, signal).join('');
}

function encodeBase64FallbackParts(bytes: Uint8Array, signal?: AbortSignal): string[] {
  const chunks: string[] = [];
  let chunk = '';

  for (let index = 0; index < bytes.length; index += 3) {
    if ((index & 0xffff) === 0) throwIfAborted(signal);
    // Bytes past the end count as zero padding.
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    chunk += BASE64_ALPHABET[(value >>> 18) & 63];
    chunk += BASE64_ALPHABET[(value >>> 12) & 63];
    chunk += index + 1 < bytes.length ? BASE64_ALPHABET[(value >>> 6) & 63] : '=';
    chunk += index + 2 < bytes.length ? BASE64_ALPHABET[value & 63] : '=';

    if (chunk.length >= OUTPUT_CHUNK_SIZE) {
      chunks.push(chunk);
      chunk = '';
    }
  }

  if (chunk) chunks.push(chunk);
  throwIfAborted(signal);
  return chunks;
}
