import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  segmentPdfText,
  truncatePdfText,
  wrapPdfText,
  type PdfTextMeasureContext,
} from '@/lib/export/pdf-text-layout';

/** 14px per code point, mirroring the shared stubPdfCanvas measurement model. */
function measureContext(): PdfTextMeasureContext {
  return {
    measureText: (text: string) => ({ width: Array.from(text).length * 14 }) as TextMetrics,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('wrapPdfText', () => {
  it('wraps at word boundaries without chopping English words', () => {
    // 10 code points per line; 'wrap here now' breaks between words.
    const lines = wrapPdfText(measureContext(), 'wrap here now', 10 * 14);
    expect(lines).toEqual(['wrap here', 'now']);
  });

  it('normalizes CR/CRLF and keeps blank lines as empty output lines', () => {
    const lines = wrapPdfText(measureContext(), 'one\r\n\rtwo', 40 * 14);
    expect(lines).toEqual(['one', '', 'two']);
  });

  it('splits a segment wider than a whole line at grapheme boundaries', () => {
    // A single 12-code-point 'word' cannot fit a 5-code-point line, so the
    // grapheme fallback must split it instead of dropping or overflowing it.
    const word = 'abcdefghijkl';
    const lines = wrapPdfText(measureContext(), word, 5 * 14);
    expect(lines).toEqual(['abcde', 'fghij', 'kl']);
    expect(lines.join('')).toBe(word);
  });

  it('never splits inside an emoji ZWJ cluster when grapheme-splitting', () => {
    // The family emoji is 7 code points (98px) — wider than the 5-code-point
    // line — so it lands on its own line rather than being cut mid-cluster.
    const family = '👩‍👩‍👧‍👦';
    const lines = wrapPdfText(measureContext(), `ab${family}cd`, 5 * 14);
    expect(lines.join('')).toBe(`ab${family}cd`);
    for (const line of lines) {
      const clusterUnits = [...line].filter((point) => point === '‍');
      // A broken cluster would leave a dangling ZWJ at a line edge.
      expect(line.startsWith('‍')).toBe(false);
      expect(line.endsWith('‍')).toBe(false);
      expect(clusterUnits.length === 0 || line.includes(family)).toBe(true);
    }
  });

  it('returns one empty line for empty input', () => {
    expect(wrapPdfText(measureContext(), '', 100)).toEqual(['']);
  });
});

describe('truncatePdfText', () => {
  it('returns text unchanged when it fits', () => {
    expect(truncatePdfText(measureContext(), 'short', 10 * 14)).toBe('short');
  });

  it('shortens with an ellipsis without splitting a grapheme cluster', () => {
    const family = '👩‍👩‍👧‍👦';
    // Budget of 6 code points: 'ab' (2) + family (7) + '…' (1) would be 10, so
    // the whole cluster is dropped rather than split.
    const result = truncatePdfText(measureContext(), `ab${family}cdef`, 6 * 14);
    expect(result).toBe('ab…');
  });
});

describe('segmentPdfText', () => {
  it('segments words and grapheme clusters with Intl.Segmenter', () => {
    expect(segmentPdfText('two words', 'word')).toEqual(['two', ' ', 'words']);
    expect(segmentPdfText('a👩‍👩‍👧‍👦b', 'grapheme')).toEqual(['a', '👩‍👩‍👧‍👦', 'b']);
  });

  it('falls back to per-code-point segmentation without Intl.Segmenter', async () => {
    // The segmenters are captured at module load, so reload the module with
    // Intl.Segmenter removed to exercise the fallback wiring.
    vi.resetModules();
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
    const { segmentPdfText: segmentWithoutSegmenter } = await import('@/lib/export/pdf-text-layout');
    expect(segmentWithoutSegmenter('ab 中', 'word')).toEqual(['a', 'b', ' ', '中']);
    expect(segmentWithoutSegmenter('👦x', 'grapheme')).toEqual(['👦', 'x']);
  });
});
