import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

async function readManifest(directory) {
  const manifestPath = path.join(root, '.output', directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  return { manifest, manifestPath, directory };
}

async function requireFiles(build, files) {
  for (const file of files) await access(path.join(root, '.output', build.directory, file));
}

const chrome = await readManifest('chrome-mv3');
const firefox = await readManifest('firefox-mv2');

if (chrome.manifest.manifest_version !== 3 || chrome.manifest.background?.service_worker !== 'background.js') {
  throw new Error(`Invalid Chrome MV3 background manifest: ${chrome.manifestPath}`);
}
if (chrome.manifest.action?.default_popup !== 'popup.html') {
  throw new Error(`Chrome popup is missing from ${chrome.manifestPath}`);
}
if ((chrome.manifest.host_permissions ?? []).includes('<all_urls>')) {
  throw new Error('Chrome must not require <all_urls>; it is intentionally an optional permission.');
}
if (!(chrome.manifest.optional_host_permissions ?? []).includes('<all_urls>')) {
  throw new Error('Chrome optional host permission is missing.');
}

if (firefox.manifest.manifest_version !== 2 || !firefox.manifest.background?.scripts?.includes('background.js')) {
  throw new Error(`Invalid Firefox MV2 background manifest: ${firefox.manifestPath}`);
}
if (firefox.manifest.browser_action?.default_popup !== 'popup.html') {
  throw new Error(`Firefox popup is missing from ${firefox.manifestPath}`);
}
if ((firefox.manifest.permissions ?? []).includes('<all_urls>')) {
  throw new Error('Firefox must not require <all_urls>; it is intentionally an optional permission.');
}
if (!(firefox.manifest.optional_permissions ?? []).includes('<all_urls>')) {
  throw new Error('Firefox optional host permission is missing.');
}
if (firefox.manifest.browser_specific_settings?.gecko?.id !== 'howbeam@local') {
  throw new Error('Firefox add-on ID is missing or unexpected.');
}

const htmlEntrypoints = [
  'popup.html',
  'editor.html',
  'library.html',
  'options.html',
  'welcome.html',
  'snapshot-shield.html',
];

for (const build of [chrome, firefox]) {
  await requireFiles(build, [
    'background.js',
    ...htmlEntrypoints,
    'content-scripts/content.js',
  ]);
  for (const entrypoint of htmlEntrypoints) {
    const html = await readFile(path.join(root, '.output', build.directory, entrypoint), 'utf8');
    if (html.includes('rel="modulepreload"')) {
      throw new Error(`${build.directory}/${entrypoint} must not preload extension chunks across Chromium worlds.`);
    }
  }
}

for (const build of [chrome, firefox]) {
  // Settings live on the options page, opened in a full tab.
  if (build.manifest.options_ui?.page !== 'options.html' || build.manifest.options_ui.open_in_tab !== true) {
    throw new Error(`${build.directory} must declare options.html as a tab-opened options page.`);
  }
}

// Icons are rendered from assets/brand at build time (modules/brand-icons.ts);
// check the rendered pixels, not just the names, so a broken render can't ship.
const MANIFEST_ICON_SIZES = [16, 32, 48, 96, 128];
const TOOLBAR_ICON_SIZES = [16, 32];

async function pngSize(build, file) {
  const png = await readFile(path.join(root, '.output', build.directory, file));
  if (png.length < 24 || png.toString('latin1', 1, 4) !== 'PNG') {
    throw new Error(`${build.directory}/${file} is not a PNG.`);
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

for (const build of [chrome, firefox]) {
  for (const size of MANIFEST_ICON_SIZES) {
    const declared = build.manifest.icons?.[String(size)];
    if (declared !== `icon/${size}.png`) {
      throw new Error(`${build.directory} manifest must declare icon/${size}.png as its ${size}px icon.`);
    }
  }
  const action = build.manifest.action ?? build.manifest.browser_action;
  for (const size of TOOLBAR_ICON_SIZES) {
    if (action?.default_icon?.[String(size)] !== `icon/${size}.png`) {
      throw new Error(`${build.directory} toolbar action must declare icon/${size}.png as its ${size}px icon.`);
    }
  }
  const files = [
    ...MANIFEST_ICON_SIZES.map((size) => [`icon/${size}.png`, size]),
    ...TOOLBAR_ICON_SIZES.map((size) => [`icon/recording-${size}.png`, size]),
  ];
  for (const [file, size] of files) {
    const actual = await pngSize(build, file);
    if (actual.width !== size || actual.height !== size) {
      throw new Error(`${build.directory}/${file} is ${actual.width}x${actual.height}, expected ${size}x${size}.`);
    }
  }
}

console.log('Chrome MV3 and Firefox MV2 artifacts are structurally valid.');
