import { browser } from 'wxt/browser';

export interface PdfFontData {
  regular: Uint8Array;
  bold: Uint8Array;
}

export interface TypographicMetrics {
  /** Distance from the baseline up to the top of the em square, in em. */
  ascent: number;
  /** Distance from the baseline down to the bottom of the em square, in em. */
  descent: number;
}

/**
 * Reads a TrueType font's typographic ascender and descender (OS/2 table), which
 * together make the em square of an ideographic font. Text is centred in its
 * line box by this square, so it is read from the font file that is embedded
 * rather than written down beside it.
 */
export function readTypographicMetrics(font: Uint8Array): TypographicMetrics {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = new Map<string, number>();
  for (let index = 0, count = view.getUint16(4); index < count; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...font.subarray(record, record + 4));
    tables.set(tag, view.getUint32(record + 8));
  }
  const head = tables.get('head');
  const os2 = tables.get('OS/2');
  if (head === undefined || os2 === undefined) throw new Error('The PDF font has no head or OS/2 table.');

  const unitsPerEm = view.getUint16(head + 18);
  const ascent = view.getInt16(os2 + 68) / unitsPerEm;
  const descent = -view.getInt16(os2 + 70) / unitsPerEm;
  if (!(unitsPerEm > 0 && ascent > 0 && descent >= 0)) throw new Error('The PDF font has unusable vertical metrics.');
  return { ascent, descent };
}

async function fetchFont(path: '/fonts/pdf/HowbeamSansTC-Regular.ttf' | '/fonts/pdf/HowbeamSansTC-Bold.ttf'): Promise<Uint8Array> {
  const response = await fetch(browser.runtime.getURL(path));
  if (!response.ok) throw new Error(`Couldn't load the PDF font ${path} (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

let loading: Promise<PdfFontData> | undefined;

/** Loads the two fonts the PDF export embeds from the extension package, once per page. */
export function loadPdfFonts(): Promise<PdfFontData> {
  loading ??= Promise.all([
    fetchFont('/fonts/pdf/HowbeamSansTC-Regular.ttf'),
    fetchFont('/fonts/pdf/HowbeamSansTC-Bold.ttf'),
  ])
    .then(([regular, bold]) => ({ regular, bold }))
    .catch((error: unknown) => {
      // A failed load must not be remembered: the next export tries again.
      loading = undefined;
      throw error;
    });
  return loading;
}
