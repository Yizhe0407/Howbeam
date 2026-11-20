import type { Font } from 'fontkit';
import { segmentText } from '../text-wrap';

export interface FontRun {
  /** Index of the font in the chain. */
  font: number;
  text: string;
}

/** Joiners and variation selectors draw nothing of their own, so a font need not map them to carry a cluster. */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * Picks, for every grapheme cluster, the first font in the chain that has a
 * glyph for each of its characters, the way a browser falls back across fonts.
 * A cluster no font covers stays with the first font, which draws it as its
 * missing-glyph box.
 */
export class FontChain {
  constructor(private readonly fonts: readonly Pick<Font, 'hasGlyphForCodePoint'>[]) {
    if (fonts.length === 0) throw new Error('A font chain needs at least one font.');
  }

  /** `text` split into the longest runs that one font draws, in reading order. */
  runs(text: string): FontRun[] {
    if (this.covers(0, text)) return text ? [{ font: 0, text }] : [];
    const runs: FontRun[] = [];
    for (const cluster of segmentText(text, 'grapheme')) {
      const font = Math.max(0, this.fonts.findIndex((_, index) => this.covers(index, cluster)));
      const last = runs.at(-1);
      if (last?.font === font) last.text += cluster;
      else runs.push({ font, text: cluster });
    }
    return runs;
  }

  private covers(index: number, text: string): boolean {
    const font = this.fonts[index]!;
    for (const character of text) {
      if (!DEFAULT_IGNORABLE.test(character) && !font.hasGlyphForCodePoint(character.codePointAt(0)!)) return false;
    }
    return true;
  }
}
