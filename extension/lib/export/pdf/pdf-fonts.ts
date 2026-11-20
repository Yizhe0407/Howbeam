import { browser } from 'wxt/browser';
import type { Font } from 'fontkit';
import type { PdfWeight } from './pdf-spec';

/**
 * The font files of each style in lookup order: a character is drawn with the
 * first font that has a glyph for it. Traditional Chinese leads, then the
 * Simplified Chinese and Japanese characters it lacks, then symbols and
 * monochrome emoji. Matches `chain` in public/fonts/pdf/manifest.json, which
 * scripts/pdf-fonts/build.py writes.
 */
export const PDF_FONT_CHAIN = {
  regular: [
    'HowbeamSansTC-Regular.woff2',
    'HowbeamSansSC-Regular.woff2',
    'HowbeamSansJP-Regular.woff2',
    'HowbeamSymbols-Regular.woff2',
    'HowbeamSymbols2-Regular.woff2',
    'HowbeamEmoji-Regular.woff2',
  ],
  bold: [
    'HowbeamSansTC-Bold.woff2',
    'HowbeamSansSC-Bold.woff2',
    'HowbeamSansJP-Bold.woff2',
    'HowbeamSymbols-Bold.woff2',
    'HowbeamSymbols2-Regular.woff2',
    'HowbeamEmoji-Bold.woff2',
  ],
} as const satisfies Record<PdfWeight, readonly string[]>;

type PdfFontFile = (typeof PDF_FONT_CHAIN)[PdfWeight][number];

/** Each style's font files in chain order; a file both styles use is the same bytes. */
export type PdfFontData = Record<PdfWeight, Uint8Array[]>;

export interface TypographicMetrics {
  /** Distance from the baseline up to the top of the em square, in em. */
  ascent: number;
  /** Distance from the baseline down to the bottom of the em square, in em. */
  descent: number;
}

/**
 * A font's typographic ascender and descender (OS/2 table), which together
 * make the em square of an ideographic font. Text is centred in its line box by
 * this square, so it is read from the font that is embedded rather than
 * written down beside it.
 */
export function typographicMetrics(font: Pick<Font, 'unitsPerEm'> & { 'OS/2'?: unknown }): TypographicMetrics {
  const os2 = font['OS/2'] as { typoAscender?: number; typoDescender?: number } | undefined;
  if (os2?.typoAscender === undefined || os2.typoDescender === undefined) throw new Error('The PDF font has no OS/2 table.');
  const ascent = os2.typoAscender / font.unitsPerEm;
  const descent = -os2.typoDescender / font.unitsPerEm;
  if (!(font.unitsPerEm > 0 && ascent > 0 && descent >= 0)) throw new Error('The PDF font has unusable vertical metrics.');
  return { ascent, descent };
}

async function fetchFont(file: PdfFontFile): Promise<Uint8Array> {
  const path = `/fonts/pdf/${file}` as const;
  const response = await fetch(browser.runtime.getURL(path));
  if (!response.ok) throw new Error(`Couldn't load the PDF font ${path} (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

let loading: Promise<PdfFontData> | undefined;

/** Loads the font chain the PDF export embeds from the extension package, once per page. */
export function loadPdfFonts(): Promise<PdfFontData> {
  loading ??= (async () => {
    const files = [...new Set<PdfFontFile>([...PDF_FONT_CHAIN.regular, ...PDF_FONT_CHAIN.bold])];
    const bytes = new Map(await Promise.all(files.map(async (file) => [file, await fetchFont(file)] as const)));
    const chain = (style: PdfWeight) => PDF_FONT_CHAIN[style].map((file) => bytes.get(file)!);
    return { regular: chain('regular'), bold: chain('bold') };
  })().catch((error: unknown) => {
    // A failed load must not be remembered: the next export tries again.
    loading = undefined;
    throw error;
  });
  return loading;
}
