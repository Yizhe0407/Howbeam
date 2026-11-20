import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PdfFontData } from '@/lib/export/pdf/pdf-fonts';

const fontDirectory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../public/fonts/pdf');

/** The chain build.py recorded; reading it here keeps this helper free of the module tests mock. */
const { chain } = JSON.parse(readFileSync(path.join(fontDirectory, 'manifest.json'), 'utf8')) as {
  chain: Record<'Regular' | 'Bold', string[]>;
};

const cache = new Map<string, Uint8Array>();
/** One shared copy per file, as the extension's loader hands both styles the same bytes. */
const read = (file: string) => {
  let bytes = cache.get(file);
  if (!bytes) cache.set(file, (bytes = new Uint8Array(readFileSync(path.join(fontDirectory, file)))));
  return bytes;
};

/** The PDF font chain as the extension package ships it, read from public/fonts/pdf. */
export async function readDiskFonts(): Promise<PdfFontData> {
  return { regular: chain.Regular.map(read), bold: chain.Bold.map(read) };
}

/**
 * Stands in for the extension package in tests: the PDF fonts come from disk
 * instead of `browser.runtime.getURL`. Use inside
 * `vi.mock('@/lib/export/pdf/pdf-fonts', async (original) => (await import('../setup/pdf-fonts')).withDiskFonts(await original()))`.
 */
export function withDiskFonts<T extends object>(original: T): T {
  return { ...original, loadPdfFonts: readDiskFonts };
}
