import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FontChain } from '@/lib/export/pdf/pdf-font-chain';
import { PDF_FONT_CHAIN, typographicMetrics } from '@/lib/export/pdf/pdf-fonts';
import { PdfLayouter } from '@/lib/export/pdf/pdf-layout';
import { PdfWriter } from '@/lib/export/pdf/pdf-render';
import { DEFAULT_PDF_EXPORT_SETTINGS } from '@/lib/export/pdf-export-settings';
import * as fontkit from 'fontkit';
import { describe, expect, it } from 'vitest';
import { readDiskFonts } from '../setup/pdf-fonts';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const fontDirectory = path.join(root, 'public/fonts/pdf');

type FontEntry = { file: string; family: string; style: string; weight: number; license: string; bytes: number; sha256: string };
type Manifest = {
  source: { files: Record<string, { sha256: string }> };
  chain: Record<'Regular' | 'Bold', string[]>;
  licenses: { file: string; source: string; sha256: string }[];
  fonts: FontEntry[];
};

const manifest = JSON.parse(readFileSync(path.join(fontDirectory, 'manifest.json'), 'utf8')) as Manifest;
const sources = JSON.parse(readFileSync(path.join(root, 'scripts/pdf-fonts/sources.json'), 'utf8')) as Manifest['source'];

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const load = (file: string) => readFileSync(path.join(fontDirectory, file));
const opened = new Map<string, fontkit.Font>();
// The font tables are described in fontkit's own typings only partly; the name table and codepoint lookups are enough here.
const open = (file: string) => {
  let font = opened.get(file);
  if (!font) opened.set(file, (font = fontkit.create(load(file)) as fontkit.Font));
  return font;
};

function decode(encoding: string, leads: [number, number], trails: number[]): string[] {
  const decoder = new TextDecoder(encoding, { fatal: true });
  const characters: string[] = [];
  for (let lead = leads[0]; lead <= leads[1]; lead += 1) {
    for (const trail of trails) {
      try {
        const character = decoder.decode(Uint8Array.of(lead, trail));
        if (/\p{Script=Han}/u.test(character)) characters.push(character);
      } catch {
        // Unassigned code point.
      }
    }
  }
  return characters;
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** Every Han character of Big5, GB2312 and JIS X 0208: Traditional, Simplified and Japanese text. */
const big5 = () => decode('big5', [0xa4, 0xf9], [...range(0x40, 0x7e), ...range(0xa1, 0xfe)]);
const gb2312 = () => decode('gb18030', [0xb0, 0xf7], range(0xa1, 0xfe));
const jisX0208 = () => decode('euc-jp', [0xb0, 0xf4], range(0xa1, 0xfe));

describe('PDF export fonts', () => {
  it('ships exactly the files the manifest records, byte for byte', () => {
    for (const entry of manifest.fonts) {
      const data = load(entry.file);
      expect(data.length, entry.file).toBe(entry.bytes);
      expect(sha256(data), entry.file).toBe(entry.sha256);
    }
  });

  it('looks fonts up in the order build.py wrote', () => {
    expect(PDF_FONT_CHAIN.regular).toEqual(manifest.chain.Regular);
    expect(PDF_FONT_CHAIN.bold).toEqual(manifest.chain.Bold);
    expect(new Set([...manifest.chain.Regular, ...manifest.chain.Bold])).toEqual(new Set(manifest.fonts.map((font) => font.file)));
  });

  it('carries each upstream OFL text unchanged, and every font names one', () => {
    for (const license of manifest.licenses) {
      expect(sha256(load(license.file)), license.file).toBe(license.sha256);
      expect(license.sha256, license.file).toBe(sources.files[license.source]!.sha256);
      expect(load(license.file).toString('utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    }
    const shipped = new Set(manifest.licenses.map((license) => license.file));
    for (const font of manifest.fonts) expect(shipped, font.file).toContain(font.license);
  });

  it.each(manifest.fonts.map((entry) => [entry.file, entry] as const))(
    '%s is renamed, keeps the copyright and license notices, and never uses a reserved name',
    (file, entry) => {
      const font = open(file);
      const postscript = `${entry.family.replaceAll(' ', '')}-${entry.style}`;

      expect(font.familyName).toBe(entry.family);
      expect(font.postscriptName).toBe(postscript);
      expect(font.fullName).toBe(`${entry.family} ${entry.style}`);
      for (const name of [font.familyName, font.postscriptName, font.fullName]) expect(name).not.toMatch(/source|noto/i);
      // Name IDs 0, 13 and 14 are the copyright statement and the license notice the OFL requires to travel with the font.
      expect(font.copyright).toBeTruthy();
      const { license } = (font as unknown as { name: { records: { license: { en: string } } } }).name.records;
      expect(license.en).toContain('SIL Open Font License');
      expect(font['OS/2'].usWeightClass).toBe(entry.weight);
      expect(font.variationAxes).toEqual({});
    },
  );

  it('covers every Traditional, Simplified and Japanese Han character in common use, with Latin, punctuation and kana', async () => {
    const fonts = (await readDiskFonts()).regular.map((bytes) => fontkit.create(bytes as Buffer) as fontkit.Font);
    const covered = (character: string) => fonts.some((font) => font.hasGlyphForCodePoint(character.codePointAt(0)!));
    const required = [
      ...big5(),
      ...gb2312(),
      ...jisX0208(),
      ...'ABCxyz0123456789 .,;:!?()[]{}"\'-–—…·「」『』，。、：；！？（）《》〈〉【】～ぁあいうえおアイウエオゔヴ・ー',
    ];

    // The WHATWG decoder adds a few HKSCS characters to Big5's 13,053.
    expect(big5().length).toBeGreaterThanOrEqual(13_053);
    expect(gb2312().length).toBe(6_763);
    expect(jisX0208().length).toBe(6_355);
    expect(required.filter((character) => !covered(character)).join('')).toBe('');
  });

  it('draws symbols and emoji with the fallback fonts instead of a missing-glyph box', async () => {
    const fonts = (await readDiskFonts()).regular.map((bytes) => fontkit.create(bytes as Buffer) as fontkit.Font);
    const chain = new FontChain(fonts);
    const families = (text: string) => chain.runs(text).map((run) => fonts[run.font]!.familyName);

    expect(families('⚠️ 注意')).toEqual(['Howbeam Sans TC']);
    expect(families('✅ 完成')).toEqual(['Howbeam Emoji', 'Howbeam Sans TC']);
    expect(families('👍🏽 讚')).toEqual(['Howbeam Emoji', 'Howbeam Sans TC']);
    expect(families('这')).toEqual(['Howbeam Sans SC']);
    for (const symbol of ['★', '✔', 'ℹ️', '🚀', '😀', '👨‍👩‍👧']) {
      expect(chain.runs(symbol).every((run) => fonts[run.font]!.hasGlyphForCodePoint(run.text.codePointAt(0)!)), symbol).toBe(true);
    }
  });

  it('centres text by the em square of the font that is embedded', () => {
    const font = open('HowbeamSansTC-Regular.woff2');
    const metrics = typographicMetrics(font);

    expect(metrics.ascent).toBeCloseTo(font['OS/2'].typoAscender / font.unitsPerEm);
    expect(metrics.ascent + metrics.descent).toBeCloseTo(1);
  });

  it('rejects a font without usable vertical metrics', () => {
    expect(() => typographicMetrics({ unitsPerEm: 1000 })).toThrow('no OS/2 table');
    expect(() => typographicMetrics({ unitsPerEm: 1000, 'OS/2': { typoAscender: 0, typoDescender: -120 } })).toThrow('unusable vertical metrics');
  });

  it('stays within the size budget the extension package was planned around', () => {
    for (const entry of manifest.fonts) expect(entry.bytes, entry.file).toBeLessThan(3.5 * 1024 * 1024);
    expect(manifest.fonts.reduce((total, entry) => total + entry.bytes, 0)).toBeLessThan(13.5 * 1024 * 1024);
  });

  it('embeds every font of the chain as a subset, so a document costs kilobytes and not the whole font', async () => {
    const fonts = await readDiskFonts();
    const decoded = fonts.regular.map((bytes) => fontkit.create(bytes as Buffer) as fontkit.Font);
    // One character from each font that no font before it has, so every font in the chain is drawn.
    const sample = decoded
      .map((font, index) =>
        font.characterSet.find(
          (codePoint) => /\p{L}|\p{N}|\p{S}/u.test(String.fromCodePoint(codePoint)) && decoded.slice(0, index).every((earlier) => !earlier.hasGlyphForCodePoint(codePoint)),
        )!,
      )
      .map((codePoint) => String.fromCodePoint(codePoint))
      .join(' ');
    const writer = await PdfWriter.create({ title: 'Fonts', language: 'zh-Hant', fonts, maxPages: 10, maxBytes: 10 * 1024 * 1024 });
    const layouter = new PdfLayouter({
      settings: DEFAULT_PDF_EXPORT_SETTINGS,
      measure: (text, style) => writer.measure(text, style),
      footerTitle: 'Fonts',
      labels: { credit: 'Made with Howbeam' },
    });
    layouter.addTitleBlock('安裝指南 Setup Guide', sample);
    layouter.finish();
    for (const page of layouter.takePages()) writer.writePage(page);

    const output = await writer.finish();
    const text = Buffer.from(await output.arrayBuffer()).toString('latin1');

    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toMatch(/\+HowbeamSansTC-Bold/);
    for (const font of decoded) expect(text, font.postscriptName).toContain(`+${font.postscriptName}`);
    expect(output.size).toBeLessThan(100 * 1024);
  });
});
