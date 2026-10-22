import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('.', import.meta.url)) },
      // The PDF export ships pdfkit's browser build; tests run that same build instead of its Node one.
      { find: /^pdfkit$/, replacement: fileURLToPath(new URL('./node_modules/pdfkit/js/pdfkit.browser.mjs', import.meta.url)) },
    ],
  },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup/browser-storage.ts', 'tests/setup/i18n.ts'],
    coverage: {
      provider: 'v8',
      // Opt-in via `pnpm test:coverage`; no thresholds yet so the report
      // informs without failing CI while coverage is still being built out.
      include: ['lib/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'entrypoints/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});
