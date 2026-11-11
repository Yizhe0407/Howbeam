import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tokensCss } from '@/lib/shared/design-tokens';

const tokensFile = fileURLToPath(new URL('../../assets/tokens.css', import.meta.url));

describe('design tokens', () => {
  it('keeps assets/tokens.css generated from lib/shared/design-tokens.ts', () => {
    // `npm run tokens` rewrites the file instead of checking it.
    if (process.env.UPDATE_TOKENS) writeFileSync(tokensFile, tokensCss());
    expect(readFileSync(tokensFile, 'utf8')).toBe(tokensCss());
  });

  it('leaves no stylesheet with a literal copy of a token colour', () => {
    for (const stylesheet of ['../../assets/tailwind.css', '../../entrypoints/snapshot-shield/style.css']) {
      const css = readFileSync(fileURLToPath(new URL(stylesheet, import.meta.url)), 'utf8');
      expect(css, stylesheet).not.toMatch(/#[0-9a-f]{6}\b/i);
    }
  });
});
