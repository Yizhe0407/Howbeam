import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.output/',
      '.wxt/',
      'node_modules/',
      'test-results/',
      'dist/',
      'playwright-report/',
      'blob-report/',
      'coverage/',
    ],
  },
  js.configs.recommended,
  // Non-type-checked: keeps `pnpm lint` fast. `tsc --noEmit` already covers the
  // type-aware ground these rules would add.
  tseslint.configs.recommended,
  reactHooks.configs.recommended,
  {
    languageOptions: {
      globals: {
        // WXT entrypoints and content scripts run in extension pages, where both
        // the DOM and the WebExtension APIs (`browser`, `chrome`) are ambient.
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  {
    // Build/validation scripts and tooling configs run in Node.
    files: ['tests/build/**', '*.config.{ts,js,mjs}', '**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      // tsc's noUnusedLocals/noUnusedParameters already fail the build for these; keep the underscore escape hatch and let tsc own the rule.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // TypeScript resolves these; the core rules misfire on type-only and
      // ambient declarations.
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
      // Control characters in a regex are intentional here: every hit is an input sanitizer stripping \x00-\x1f before storage, an archive, or a message boundary.
      'no-control-regex': 'off',
    },
  },
  {
    // Every user-facing string lives in the i18n catalogs (lib/shared/i18n/messages),
    // so a Chinese literal anywhere else is copy that would not follow the UI
    // language. Regex literals stay allowed: they match page text, not UI copy.
    files: ['components/**/*.{ts,tsx}', 'entrypoints/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    ignores: ['lib/shared/i18n/messages/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal:not([regex])[raw=/[\\u3400-\\u9fff]/]',
          message: 'Put user-facing copy in lib/shared/i18n/messages and read it through t().',
        },
        {
          selector: 'TemplateElement[value.raw=/[\\u3400-\\u9fff]/]',
          message: 'Put user-facing copy in lib/shared/i18n/messages and read it through t().',
        },
        {
          selector: 'JSXText[value=/[\\u3400-\\u9fff]/]',
          message: 'Put user-facing copy in lib/shared/i18n/messages and read it through t().',
        },
      ],
    },
  },
  {
    // Playwright fixtures take a callback named `use`, which the React rule cannot distinguish from the `use` hook — a false positive.
    files: ['tests/e2e/**'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      // `async ({}, use) => …` is Playwright's own fixture signature.
      'no-empty-pattern': 'off',
    },
  },
  {
    // Test doubles legitimately reach for `any` when standing in for browser
    // APIs. Production code does not get that latitude.
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
