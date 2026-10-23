import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTypographicMetrics } from '@/lib/export/pdf/pdf-fonts';
import { PdfLayouter } from '@/lib/export/pdf/pdf-layout';
import { PdfWriter } from '@/lib/export/pdf/pdf-render';
import { DEFAULT_PDF_EXPORT_SETTINGS } from '@/lib/export/pdf-export-settings';
import * as fontkit from 'fontkit';
import { describe, expect, it } from 'vitest';
import { firstItems } from '../setup/item-at';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const fontDirectory = path.join(root, 'public/fonts/pdf');

type Manifest = {
  source: { files: { license: { sha256: string } } };
  license: { file: string; sha256: string };
  fonts: { file: string; family: string; style: string; weight: number; bytes: number; sha256: string }[];
};

const manifest = JSON.parse(readFileSync(path.join(fontDirectory, 'manifest.json'), 'utf8')) as Manifest;
const sources = JSON.parse(readFileSync(path.join(root, 'scripts/pdf-fonts/sources.json'), 'utf8')) as Manifest['source'];

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const load = (file: string) => readFileSync(path.join(fontDirectory, file));
// The font tables are described in fontkit's own typings only partly; the name table and codepoint lookups are enough here.
const open = (file: string) => fontkit.create(load(file)) as fontkit.Font;

/** The 5,401 most frequently used Traditional characters (Big5 A440-C67E), as scripts/pdf-fonts/build.py selects them. */
function big5Level1(): string[] {
  const decoder = new TextDecoder('big5', { fatal: true });
  const characters: string[] = [];
  for (let lead = 0xa4; lead <= 0xc6; lead += 1) {
    const trails = [...Array.from({ length: 0x7f - 0x40 }, (_, index) => 0x40 + index)];
    if (lead !== 0xc6) trails.push(...Array.from({ length: 0xff - 0xa1 }, (_, index) => 0xa1 + index));
    for (const trail of trails) {
      try {
        characters.push(decoder.decode(Uint8Array.of(lead, trail)));
      } catch {
        // Unassigned code point.
      }
    }
  }
  return characters;
}

describe('PDF export fonts', () => {
  it('ships exactly the files the manifest records, byte for byte', () => {
    expect(manifest.fonts.map((font) => font.style).sort()).toEqual(['Bold', 'Regular']);
    for (const entry of manifest.fonts) {
      const data = load(entry.file);
      expect(data.length, entry.file).toBe(entry.bytes);
      expect(sha256(data), entry.file).toBe(entry.sha256);
    }
  });

  it('carries the upstream OFL text unchanged', () => {
    expect(sha256(load(manifest.license.file))).toBe(manifest.license.sha256);
    expect(manifest.license.sha256).toBe(sources.files.license.sha256);
    expect(load(manifest.license.file).toString('utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it.each(['Regular', 'Bold'])('%s is renamed, keeps the copyright and license notices, and never uses the reserved name', (style) => {
    const font = open(`HowbeamSansTC-${style}.ttf`);

    expect(font.familyName).toBe('Howbeam Sans TC');
    expect(font.postscriptName).toBe(`HowbeamSansTC-${style}`);
    expect(font.fullName).toBe(`Howbeam Sans TC ${style}`);
    for (const name of [font.familyName, font.postscriptName, font.fullName]) {
      expect(name).not.toMatch(/source|noto/i);
    }
    // Name IDs 0, 13 and 14 are the copyright statement and the license notice the OFL requires to travel with the font.
    expect(font.copyright).toContain('Adobe');
    const { license, licenseURL } = (font as unknown as { name: { records: { license: { en: string }; licenseURL: { en: string } } } }).name.records;
    expect(license.en).toContain('SIL Open Font License');
    expect(licenseURL.en).toContain('scripts.sil.org/OFL');
  });

  it('has a true Regular and a true Bold, both static', () => {
    const [regular, bold] = firstItems(['Regular', 'Bold'].map((style) => open(`HowbeamSansTC-${style}.ttf`)), 2);

    expect(regular['OS/2'].usWeightClass).toBe(400);
    expect(bold['OS/2'].usWeightClass).toBe(700);
    expect(regular.variationAxes).toEqual({});
    expect(bold.variationAxes).toEqual({});
    expect(bold.getGlyph(bold.glyphForCodePoint(0x6a19.valueOf()).id).advanceWidth).toBeGreaterThan(0);
  });

  it.each(['Regular', 'Bold'])('%s covers every common Traditional character, Latin, punctuation and kana', (style) => {
    const font = open(`HowbeamSansTC-${style}.ttf`);
    const required = [...big5Level1(), ...'ABCxyz0123456789 .,;:!?()[]{}"\'-–—…·「」『』，。、：；！？（）《》〈〉【】～ぁあいうえおアイウエオゔヴ・ー'];

    expect(big5Level1().length).toBe(5401);
    const missing = required.filter((character) => !font.hasGlyphForCodePoint(character.codePointAt(0)!));
    expect(missing.join('')).toBe('');
  });

  it.each(['Regular', 'Bold'])('%s: the renderer reads the same vertical metrics fontkit does', (style) => {
    const font = open(`HowbeamSansTC-${style}.ttf`);
    const os2 = font['OS/2'] as unknown as { typoAscender: number; typoDescender: number };

    const metrics = readTypographicMetrics(new Uint8Array(load(`HowbeamSansTC-${style}.ttf`)));

    expect(metrics.ascent).toBeCloseTo(os2.typoAscender / font.unitsPerEm);
    expect(metrics.descent).toBeCloseTo(-os2.typoDescender / font.unitsPerEm);
    // Together they are the 1em ideographic square the line box centres.
    expect(metrics.ascent + metrics.descent).toBeCloseTo(1);
  });

  it('rejects bytes that are not a usable font', () => {
    expect(() => readTypographicMetrics(new Uint8Array(32))).toThrow('no head or OS/2 table');
  });

  it('stays within the size budget the extension package was planned around', () => {
    for (const entry of manifest.fonts) expect(entry.bytes, entry.file).toBeLessThan(2.2 * 1024 * 1024);
  });

  it('embeds into a PDF as a subset, so a document costs kilobytes and not the whole font', async () => {
    const writer = await PdfWriter.create({
      title: 'Fonts',
      language: 'zh-Hant',
      fonts: { regular: new Uint8Array(load('HowbeamSansTC-Regular.ttf')), bold: new Uint8Array(load('HowbeamSansTC-Bold.ttf')) },
      maxPages: 10,
      maxBytes: 10 * 1024 * 1024,
    });
    const layouter = new PdfLayouter({
      settings: DEFAULT_PDF_EXPORT_SETTINGS,
      measure: (text, style) => writer.measure(text, style),
      footerTitle: 'Fonts',
      labels: { pageNumber: (page) => `Page ${page}`, credit: 'Made with Howbeam', missingDescription: '' },
    });
    layouter.addTitleBlock('安裝指南 Setup Guide', '點擊瀏覽器工具列上的擴充功能圖示，開啟設定頁面。');
    layouter.finish();
    for (const page of layouter.takePages()) writer.writePage(page);

    const output = await writer.finish();
    const text = Buffer.from(await output.arrayBuffer()).toString('latin1');

    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toMatch(/\+HowbeamSansTC-Bold/);
    expect(text).toMatch(/\+HowbeamSansTC-Regular/);
    expect(output.size).toBeLessThan(100 * 1024);
  });
});
