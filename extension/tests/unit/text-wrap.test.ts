import { describe, expect, it } from 'vitest';
import { segmentText, truncateText, wrapText } from '@/lib/export/text-wrap';

/** 14 layout pixels per code point, whatever the character. */
const measure = (text: string) => Array.from(text).length * 14;
const line = (characters: number) => characters * 14;

describe('wrapText', () => {
  it('wraps at word boundaries without chopping English words', () => {
    expect(wrapText(measure, 'wrap here now', line(10))).toEqual(['wrap here', 'now']);
  });

  it('normalizes CR/CRLF and keeps blank lines as empty output lines', () => {
    expect(wrapText(measure, 'one\r\n\rtwo', line(40))).toEqual(['one', '', 'two']);
  });

  it('splits a word wider than a whole line at grapheme boundaries', () => {
    const word = 'abcdefghijkl';
    const lines = wrapText(measure, word, line(5));
    expect(lines).toEqual(['abcde', 'fghij', 'kl']);
    expect(lines.join('')).toBe(word);
  });

  it('never splits inside an emoji ZWJ cluster', () => {
    const family = '👩‍👩‍👧‍👦';
    const lines = wrapText(measure, `ab${family}cd`, line(5));

    expect(lines.join('')).toBe(`ab${family}cd`);
    for (const wrapped of lines) {
      expect(wrapped.startsWith('‍')).toBe(false);
      expect(wrapped.endsWith('‍')).toBe(false);
    }
  });

  it('returns one empty line for empty input', () => {
    expect(wrapText(measure, '', 100)).toEqual(['']);
  });

  it('fills a CJK line to the margin instead of stopping at a dictionary-word boundary', () => {
    const text = '點擊瀏覽器工具列上的擴充功能圖示';
    const lines = wrapText(measure, text, line(10));

    expect(lines).toEqual(['點擊瀏覽器工具列上的', '擴充功能圖示']);
  });

  it('keeps every character of a long CJK paragraph exactly once', () => {
    const text = '點擊瀏覽器工具列上的擴充功能圖示開啟設定頁面'.repeat(8);
    const lines = wrapText(measure, text, line(30));

    expect(lines.join('')).toBe(text);
    for (const wrapped of lines.slice(0, -1)) expect(Array.from(wrapped).length).toBe(30);
  });

  describe('line-break rules for CJK punctuation', () => {
    it('lets a closing mark hang past the margin instead of starting the next line', () => {
      const lines = wrapText(measure, '一二三四五六七八九十。十一', line(10));

      expect(lines).toEqual(['一二三四五六七八九十。', '十一']);
    });

    it('hangs at most one mark: a second one starts the next line', () => {
      const lines = wrapText(measure, '一二三四五六七八九十。。十一', line(10));

      expect(lines[0]).toBe('一二三四五六七八九十。');
      expect(lines.join('')).toBe('一二三四五六七八九十。。十一');
    });

    it('moves an opening bracket down with the text it opens', () => {
      const lines = wrapText(measure, '一二三四五六七八九「十」', line(10));

      expect(lines).toEqual(['一二三四五六七八九', '「十」']);
    });

    it('applies the same rules to quotes and parentheses', () => {
      expect(wrapText(measure, '一二三四五六七八九十」十一', line(10))[0]).toBe('一二三四五六七八九十」');
      expect(wrapText(measure, '一二三四五六七八九（十）', line(10))).toEqual(['一二三四五六七八九', '（十）']);
    });

    it('leaves Latin punctuation attached to its word', () => {
      expect(wrapText(measure, 'one two three, four', line(9))).toEqual(['one two', 'three,', 'four']);
    });
  });

  it('mixes Latin words and CJK characters on one line', () => {
    const lines = wrapText(measure, 'Open 設定 and 頁面', line(10));

    expect(lines.join('').replace(/\s/g, '')).toBe('Open設定and頁面');
    for (const wrapped of lines) expect(measure(wrapped)).toBeLessThanOrEqual(line(10) + 14);
  });
});

describe('truncateText', () => {
  it('returns text unchanged when it fits', () => {
    expect(truncateText(measure, 'short', line(10))).toBe('short');
  });

  it('shortens with an ellipsis without splitting a grapheme cluster', () => {
    const family = '👩‍👩‍👧‍👦';
    // Budget of 6 code points: 'ab' (2) + family (7) + '…' (1) would be 10, so the whole cluster is dropped.
    expect(truncateText(measure, `ab${family}cdef`, line(6))).toBe('ab…');
  });
});

describe('segmentText', () => {
  it('segments words and grapheme clusters with Intl.Segmenter', () => {
    expect(segmentText('two words', 'word')).toEqual(['two', ' ', 'words']);
    expect(segmentText('a👩‍👩‍👧‍👦b', 'grapheme')).toEqual(['a', '👩‍👩‍👧‍👦', 'b']);
  });
});
