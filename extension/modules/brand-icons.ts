import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { defineWxtModule } from 'wxt/modules';
import { ACTION_ICON_SIZES, BRAND_ICONS, brandIconFile, type BrandArt, type BrandIconSpec } from '../lib/shared/brand-icons';

/** Every brand SVG shares this square viewBox, so layers stack without scaling. */
const ART_VIEWBOX = 40;

export interface BrandArtwork {
  art: Record<BrandArt, string>;
  recordingDot: string;
}

function innerMarkup(svg: string, name: string): string {
  const match = /<svg\b[^>]*\bviewBox="0 0 40 40"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg.trim());
  if (!match) throw new Error(`[brand-icons] ${name} must be a single <svg> with viewBox="0 0 ${ART_VIEWBOX} ${ART_VIEWBOX}"`);
  return match[1];
}

/**
 * One icon as a standalone SVG: the chosen artwork, the recording dot when
 * asked for, and the inset expressed by widening the viewBox so the artwork
 * keeps its proportions.
 */
export function composeBrandIcon(spec: BrandIconSpec, artwork: BrandArtwork): string {
  const units = (ART_VIEWBOX * spec.size) / (spec.size - 2 * spec.inset);
  const offset = (units - ART_VIEWBOX) / 2;
  const layers = [
    innerMarkup(artwork.art[spec.art], `${spec.art} artwork`),
    spec.recording ? innerMarkup(artwork.recordingDot, 'recording dot') : '',
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.size}" height="${spec.size}" viewBox="${-offset} ${-offset} ${units} ${units}">${layers}</svg>`;
}

export function renderBrandIcon(spec: BrandIconSpec, artwork: BrandArtwork): Uint8Array {
  // The artwork is pure vector: scanning the machine's fonts for each icon only slows the render and
  // would let the installed fonts decide the output.
  return new Resvg(composeBrandIcon(spec, artwork), { fitTo: { mode: 'width', value: spec.size }, font: { loadSystemFonts: false } })
    .render()
    .asPng();
}

export async function loadBrandArtwork(root: string): Promise<BrandArtwork> {
  const read = (file: string) => readFile(path.join(root, 'assets/brand', file), 'utf8');
  const [full, compact, recordingDot] = await Promise.all([
    read('mascot.svg'),
    read('mascot-compact.svg'),
    read('recording-dot.svg'),
  ]);
  return { art: { full, compact }, recordingDot };
}

/**
 * Rasterises lib/shared/brand-icons.ts into the build's public assets. WXT
 * writes generated public files as UTF-8 text, so the PNGs are rendered into
 * the .wxt cache and handed over as copied files instead.
 */
export default defineWxtModule({
  name: 'brand-icons',
  setup(wxt) {
    wxt.hook('build:publicAssets', async (_wxt, files) => {
      const artwork = await loadBrandArtwork(wxt.config.root);
      const outDir = path.join(wxt.config.wxtDir, 'brand-icons');
      for (const spec of BRAND_ICONS) {
        if (files.some((file) => file.relativeDest === spec.file)) {
          throw new Error(`[brand-icons] public/${spec.file} would shadow the generated icon; delete it`);
        }
        const absoluteSrc = path.join(outDir, spec.file);
        await mkdir(path.dirname(absoluteSrc), { recursive: true });
        await writeFile(absoluteSrc, renderBrandIcon(spec, artwork));
        files.push({ absoluteSrc, relativeDest: spec.file });
      }
    });
    // The toolbar icon is declared rather than left to the `icons` fallback,
    // so its idle state is the exact set the background restores after a run.
    wxt.hook('build:manifestGenerated', (_wxt, manifest) => {
      const action = manifest.manifest_version === 2 ? (manifest.browser_action ??= {}) : (manifest.action ??= {});
      action.default_icon = Object.fromEntries(ACTION_ICON_SIZES.map((size) => [String(size), brandIconFile(size, false)]));
    });
  },
});
