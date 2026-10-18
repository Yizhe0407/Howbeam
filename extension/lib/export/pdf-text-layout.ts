import { throwIfAborted } from '../shared/abort';

/** The only canvas surface the text-layout helpers need: measured widths. */
export type PdfTextMeasureContext = Pick<OffscreenCanvasRenderingContext2D, 'measureText'>;

type TextSegmenter = { segment(input: string): Iterable<{ segment: string }> };

const pdfSegmenters: { word?: TextSegmenter; grapheme?: TextSegmenter } =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? {
        word: new Intl.Segmenter(undefined, { granularity: 'word' }),
        grapheme: new Intl.Segmenter(undefined, { granularity: 'grapheme' }),
      }
    : {};

export function segmentPdfText(text: string, granularity: 'word' | 'grapheme'): string[] {
  const segmenter = pdfSegmenters[granularity];
  if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment);
  // Per-code-point fallback for runtimes without Intl.Segmenter.
  return Array.from(text);
}

/** Shortens footer text with an ellipsis, never splitting a grapheme cluster. */
export function truncatePdfText(context: PdfTextMeasureContext, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let result = '';
  for (const grapheme of segmentPdfText(text, 'grapheme')) {
    if (context.measureText(result + grapheme + ellipsis).width > maxWidth) break;
    result += grapheme;
  }
  return result + ellipsis;
}

/**
 * Greedy line wrapping against measured widths. Breaks at word boundaries
 * first (Intl.Segmenter also dictionary-segments CJK), and only splits a
 * segment wider than a whole line at grapheme-cluster boundaries, so English
 * words are not chopped mid-word and emoji/combining sequences never split
 * into broken glyphs.
 */
export function wrapPdfText(
  context: PdfTextMeasureContext,
  text: string,
  maxWidth: number,
  signal?: AbortSignal,
): string[] {
  const lines: string[] = [];
  let steps = 0;
  const poll = () => {
    if ((steps++ & 255) === 0) throwIfAborted(signal);
  };

  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }

    let line = '';
    for (const word of segmentPdfText(paragraph, 'word')) {
      poll();
      const candidate = `${line}${word}`;
      if (context.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      const wrapped = word.trimStart();
      if (line && context.measureText(wrapped).width <= maxWidth) {
        lines.push(line.trimEnd());
        line = wrapped;
        continue;
      }
      // Wider than a whole line: split it, but never inside a grapheme cluster.
      for (const grapheme of segmentPdfText(word, 'grapheme')) {
        poll();
        const graphemeCandidate = `${line}${grapheme}`;
        if (line && context.measureText(graphemeCandidate).width > maxWidth) {
          lines.push(line.trimEnd());
          line = grapheme.trimStart();
        } else {
          line = graphemeCandidate;
        }
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.length > 0 ? lines : [''];
}
