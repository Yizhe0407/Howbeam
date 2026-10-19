import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      // Vite's speculative modulepreload links cross Chromium's extension/page world boundary and are rejected with noisy warnings; plain ESM imports work fine without it.
      modulePreload: false,
    },
  }),
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    // Chrome picks the manifest locale from the browser UI language, the same
    // source lib/shared/i18n reads for page copy: Chinese browsers get zh_TW,
    // every other language falls back to English.
    default_locale: 'en',
    // Floor derived from the APIs the extension actually ships (the background
    // message router deliberately uses the callback sendResponse contract, so
    // it imposes no floor — Chrome's promise-reply for runtime.onMessage
    // shipped in 144 and was reverted, crbug.com/40753031, and must never be
    // relied on). Constraints, highest last:
    //   88  MV3 service worker + scripting API baseline
    //   92  crypto.randomUUID, Array.prototype.at
    //   99  @layer (Tailwind v4 output)
    //  105  :has() (assets/tailwind.css label affordances)
    //  108  dvh viewport units (editor Lightbox)
    //  111  color-mix()/oklab in the Tailwind CSS v4 generated stylesheet —
    //       Tailwind v4's own documented browser floor is Chrome 111.
    // Uint8Array.prototype.toBase64 (140) is deliberately NOT a floor:
    // lib/export/base64.ts carries a pure-JS fallback.
    minimum_chrome_version: '111',
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting', 'downloads', 'clipboardWrite'],
    optional_host_permissions: ['<all_urls>'],
    // No default keys: users bind them at chrome://extensions/shortcuts so we
    // never hijack a site's own hotkeys (UX_PLAN §8.3).
    commands: {
      'toggle-pause': { description: '__MSG_cmdTogglePause__' },
      'undo-last-capture': { description: '__MSG_cmdUndoLastCapture__' },
      'finish-recording': { description: '__MSG_cmdFinishRecording__' },
    },
    web_accessible_resources: [
      {
        resources: ['snapshot-shield.html'],
        matches: ['<all_urls>'],
        // use_dynamic_url would hide the static URL, but Chrome fails to navigate a content-script iframe to the per-session GUID URL, so the static URL stays; exposure is limited to install fingerprinting since the page needs the storage-parked init token to do anything.
      },
    ],
    browser_specific_settings: {
      gecko: {
        id: 'howbeam@local',
        // No strict_min_version: the real floor is storage.session (Firefox 115), but data_collection_permissions below is itself a 140+ key, so declaring 115 would misrepresent support (web-ext flags this).
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  },
  hooks: {
    // Runtime content scripts make WXT infer a required host permission. The
    // recorder only needs it after an explicit Start action, so keep it optional.
    'build:manifestGenerated': (wxt, manifest) => {
      manifest.host_permissions = manifest.host_permissions?.filter((permission: string) => permission !== '<all_urls>');
      if (manifest.host_permissions?.length === 0) delete manifest.host_permissions;
      if (manifest.manifest_version === 2) {
        manifest.optional_permissions ??= [];
        if (!manifest.optional_permissions.includes('<all_urls>')) manifest.optional_permissions.push('<all_urls>');
      }
      // Keep each browser's manifest free of the other's vendor keys (harmless, but flagged by store linters).
      if (wxt.config.browser === 'firefox') {
        delete manifest.minimum_chrome_version;
      } else {
        delete manifest.browser_specific_settings;
      }
    },
  },
});
