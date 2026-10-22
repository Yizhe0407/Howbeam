import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fontDirectory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../public/fonts/pdf');

const read = (file: string) => new Uint8Array(readFileSync(path.join(fontDirectory, file)));

/** The PDF fonts as the extension package ships them, read from public/fonts/pdf. */
export async function readDiskFonts() {
  return { regular: read('HowbeamSansTC-Regular.ttf'), bold: read('HowbeamSansTC-Bold.ttf') };
}

/**
 * Stands in for the extension package in tests: the PDF fonts come from disk
 * instead of `browser.runtime.getURL`. Use inside
 * `vi.mock('@/lib/export/pdf/pdf-fonts', async (original) => (await import('../setup/pdf-fonts')).withDiskFonts(await original()))`.
 */
export function withDiskFonts<T extends object>(original: T): T {
  return { ...original, loadPdfFonts: readDiskFonts };
}
