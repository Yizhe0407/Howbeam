import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_ICON_SIZES,
  BRAND_ICONS,
  MANIFEST_ICON_SIZES,
  actionIconPaths,
} from '@/lib/shared/brand-icons';
import { composeBrandIcon, loadBrandArtwork, renderBrandIcon } from '@/modules/brand-icons';
import { firstItems, itemAt } from '../setup/item-at';

const artwork = await loadBrandArtwork(path.resolve(__dirname, '../..'));

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}


describe('brand icon table', () => {
  it('covers every manifest size and the toolbar recording variants exactly once', () => {
    const files = BRAND_ICONS.map((icon) => icon.file);
    expect(new Set(files).size).toBe(files.length);
    for (const size of MANIFEST_ICON_SIZES) expect(files).toContain(`icon/${size}.png`);
    for (const size of ACTION_ICON_SIZES) expect(files).toContain(`icon/recording-${size}.png`);
  });

  it('draws the compact mascot at toolbar sizes and the full one above', () => {
    for (const icon of BRAND_ICONS) expect(icon.art).toBe(icon.size <= 32 ? 'compact' : 'full');
  });

  it('pads only the 128px store icon, to 96px artwork', () => {
    for (const icon of BRAND_ICONS) expect(icon.inset).toBe(icon.size === 128 ? 16 : 0);
  });

  it('gives setIcon the same files the build writes', () => {
    const written = new Set(BRAND_ICONS.map((icon) => `/${icon.file}`));
    for (const recording of [false, true]) {
      for (const file of Object.values(actionIconPaths(recording))) expect(written.has(file)).toBe(true);
    }
  });
});

describe('brand icon rendering', () => {
  it('widens the viewBox so the inset keeps the artwork proportional', () => {
    const store = BRAND_ICONS.find((icon) => icon.size === 128)!;
    const svg = composeBrandIcon(store, artwork);
    // 40 artwork units fill 96px, so the 128px canvas spans 40 × 128 / 96 units.
    const [x, y, width, height] = firstItems(itemAt(/viewBox="([^"]+)"/.exec(svg)!, 1).split(' ').map(Number), 4);
    expect(width).toBeCloseTo((40 * 128) / 96);
    expect(height).toBeCloseTo((40 * 128) / 96);
    // Centred: the margin is split evenly on both sides.
    expect(x).toBeCloseTo(-(width - 40) / 2);
    expect(y).toBeCloseTo(-(height - 40) / 2);
  });

  it('adds the recording dot only to recording variants', () => {
    for (const icon of BRAND_ICONS) {
      expect(composeBrandIcon(icon, artwork).includes('#d93a3f')).toBe(icon.recording);
    }
  });

  it('renders each icon as a PNG of its declared size', () => {
    for (const icon of BRAND_ICONS) expect(pngSize(renderBrandIcon(icon, artwork))).toEqual({ width: icon.size, height: icon.size });
  });

  it('rejects artwork drawn on a different canvas instead of silently misplacing it', () => {
    const wrong = { ...artwork, recordingDot: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>' };
    const recording = BRAND_ICONS.find((icon) => icon.recording)!;
    expect(() => composeBrandIcon(recording, wrong)).toThrow(/viewBox="0 0 40 40"/);
  });
});
