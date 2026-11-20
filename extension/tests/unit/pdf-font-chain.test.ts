import { describe, expect, it } from 'vitest';
import { FontChain } from '@/lib/export/pdf/pdf-font-chain';

/** A stand-in font that has glyphs for exactly the characters given. */
const fontWith = (characters: string) => {
  const codePoints = new Set(Array.from(characters, (character) => character.codePointAt(0)!));
  return { hasGlyphForCodePoint: (codePoint: number) => codePoints.has(codePoint) };
};

const latin = fontWith('abc ');
const symbols = fontWith('★⚠');
const emoji = fontWith('⚠👍👨👩🏽');
const chain = new FontChain([latin, symbols, emoji]);

describe('FontChain', () => {
  it('keeps text the first font covers as one run', () => {
    expect(chain.runs('abc cab')).toEqual([{ font: 0, text: 'abc cab' }]);
    expect(chain.runs('')).toEqual([]);
  });

  it('draws each character with the first font that has it, merging neighbours that share a font', () => {
    expect(chain.runs('a★★ b👍c')).toEqual([
      { font: 0, text: 'a' },
      { font: 1, text: '★★' },
      { font: 0, text: ' b' },
      { font: 2, text: '👍' },
      { font: 0, text: 'c' },
    ]);
  });

  it('keeps a grapheme cluster in one font, looking past joiners and variation selectors', () => {
    expect(chain.runs('a⚠️')).toEqual([{ font: 0, text: 'a' }, { font: 1, text: '⚠️' }]);
    expect(chain.runs('👨‍👩 👍🏽')).toEqual([
      { font: 2, text: '👨‍👩' },
      { font: 0, text: ' ' },
      { font: 2, text: '👍🏽' },
    ]);
  });

  it('leaves a character no font has with the first font', () => {
    expect(chain.runs('a한b')).toEqual([{ font: 0, text: 'a한b' }]);
  });

  it('needs at least one font', () => {
    expect(() => new FontChain([])).toThrow('at least one font');
  });
});
