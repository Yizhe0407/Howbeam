import { throwIfAborted } from '../shared/abort';

/** Width of a string in the layout unit, for one fixed font and size. */
export type MeasureText = (text: string) => number;

type TextSegmenter = { segment(input: string): Iterable<{ segment: string }> };

const segmenters: { word?: TextSegmenter; grapheme?: TextSegmenter } =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? {
        word: new Intl.Segmenter(undefined, { granularity: 'word' }),
        grapheme: new Intl.Segmenter(undefined, { granularity: 'grapheme' }),
      }
    : {};

export function segmentText(text: string, granularity: 'word' | 'grapheme'): string[] {
  const segmenter = segmenters[granularity];
  if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment);
  // Per-code-point fallback for runtimes without Intl.Segmenter.
  return Array.from(text);
}

/** Punctuation that must not start a line: closing brackets and quotes, commas, full stops, marks. */
const NO_LINE_START = new Set(
  '，。、．；：？！…‥）］｝〕〉》」』】〗〙〟’”ー・ゝゞヽヾぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ,.;:?!)]}%',
);
/** Punctuation that must not end a line: opening brackets and quotes. */
const NO_LINE_END = new Set('（［｛〔〈《「『【〖〘〝‘“([{');

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f]/u;

const startsWithNoLineStart = (text: string) => {
  const [first] = text;
  return first !== undefined && NO_LINE_START.has(first);
};
const endsWithNoLineEnd = (text: string) => {
  const last = [...text].at(-1);
  return last !== undefined && NO_LINE_END.has(last);
};

/**
 * Chunks a paragraph into the units a line may break between: a Latin word (and
 * the space after it) stays whole, while every CJK character is its own unit so
 * a line fills to the margin instead of stopping at a dictionary-word boundary.
 */
function lineBreakUnits(paragraph: string): string[] {
  const units: string[] = [];
  for (const word of segmentText(paragraph, 'word')) {
    if (CJK.test(word)) units.push(...segmentText(word, 'grapheme'));
    else units.push(word);
  }
  return units;
}

/** Shortens text with an ellipsis, never splitting a grapheme cluster. */
export function truncateText(measure: MeasureText, text: string, maxWidth: number): string {
  if (measure(text) <= maxWidth) return text;
  const ellipsis = '…';
  let result = '';
  for (const grapheme of segmentText(text, 'grapheme')) {
    if (measure(result + grapheme + ellipsis) > maxWidth) break;
    result += grapheme;
  }
  return result + ellipsis;
}

/**
 * Greedy line wrapping against measured widths. A Latin word is never chopped
 * unless it is wider than a whole line, and a grapheme cluster (emoji, combining
 * marks) is never split. CJK text follows the usual line-break rules: a closing
 * mark such as 。 hangs past the margin instead of starting a line, and an
 * opening bracket moves down with the text it opens.
 */
export function wrapText(measure: MeasureText, text: string, maxWidth: number, signal?: AbortSignal): string[] {
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
    for (const unit of lineBreakUnits(paragraph)) {
      poll();
      const candidate = `${line}${unit}`;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      // A closing mark hangs past the margin, by at most its own width, rather than starting a line.
      if (line && unit.trim() === unit && startsWithNoLineStart(unit) && measure(candidate) <= maxWidth + measure(unit)) {
        line = candidate;
        continue;
      }

      const wrapped = unit.trimStart();
      if (measure(wrapped) <= maxWidth) {
        let carried = '';
        // An opening bracket must not be left alone at the end of a line.
        while (line.length > 1 && endsWithNoLineEnd(line.trimEnd())) {
          const lastGrapheme = segmentText(line.trimEnd(), 'grapheme').at(-1)!;
          carried = lastGrapheme + carried;
          line = line.trimEnd().slice(0, -lastGrapheme.length);
        }
        if (line) lines.push(line.trimEnd());
        line = carried + wrapped;
        continue;
      }

      // Wider than a whole line: split it, but never inside a grapheme cluster.
      for (const grapheme of segmentText(unit, 'grapheme')) {
        poll();
        const graphemeCandidate = `${line}${grapheme}`;
        if (line && measure(graphemeCandidate) > maxWidth) {
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

/** At most `maxLength` characters, ending in an ellipsis when cut, without splitting a grapheme cluster. */
export function shortenText(text: string, maxLength: number): string {
  const graphemes = segmentText(text, 'grapheme');
  if (graphemes.length <= maxLength) return text;
  return `${graphemes.slice(0, maxLength - 1).join('')}…`;
}
