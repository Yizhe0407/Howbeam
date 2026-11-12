/**
 * The design tokens: the one place every colour of the app and of the UI it
 * puts into recorded pages is defined. TypeScript-injected styles (recording
 * toolbar, region capture, the recapture hint) read them here; stylesheets read
 * them as CSS variables from assets/tokens.css, which is generated from this
 * file (`npm run tokens`) and checked by tests/unit/design-tokens.test.ts.
 */

/** Light palette. Pastel fills always carry ink text (`onAccent`). */
export const palette = {
  canvas: '#fbf5ea',
  surface: '#fffdf8',
  surfaceMuted: '#f2e9d9',
  /** A panel that sits on top of `surface` (annotation rows, export cards). */
  surfaceRaised: '#f8f1e4',
  text: '#1f1b16',
  textMuted: '#6b6156',
  line: '#1f1b16',
  lineSoft: 'rgb(31 27 22 / 0.14)',
  /** Background of a hovered plain control. */
  hoverTint: 'rgb(31 27 22 / 0.1)',

  sora: '#a8d8ff',
  soraHover: '#93ceff',
  tamago: '#ffe27a',
  sakura: '#ffb5c5',
  matcha: '#b8e0a0',
  onAccent: '#1f1b16',

  brand: '#a8d8ff',
  brandText: '#2b5fc8',
  brandBgSoft: '#e4f2ff',
  selected: '#ffe27a',
  /** The record/destructive red; white text on it stays above 4.5:1. */
  recording: '#d93a3f',
  recordingHover: '#c4333a',
  recordingText: '#ffffff',
  focus: '#2f6fed',
  /** Destructive hover affordances. */
  dangerText: '#c8323a',
  dangerSoft: '#ffe6e6',
  warningText: '#9a6b00',
  warningSoft: '#fff4c2',

  /** The annotation red: highlight boxes, marks, and what the user drags on a page. */
  mark: '#ff4747',
  markFill: 'rgba(255, 71, 71, 0.055)',
  markPreviewFill: 'rgba(255, 71, 71, 0.09)',
  /** Masks hide pixels completely. */
  mask: '#000000',
} as const;

export type PaletteToken = keyof typeof palette;

/** Dark mode follows the OS. Pastel fills and the annotation red keep their light values. */
export const darkPalette: Partial<Record<PaletteToken, string>> = {
  canvas: '#1a1714',
  surface: '#24201b',
  surfaceMuted: '#322c25',
  surfaceRaised: '#2b261f',
  text: '#f6eedf',
  textMuted: '#b5aa99',
  line: '#d9cdb8',
  lineSoft: 'rgb(246 238 223 / 0.16)',
  hoverTint: 'rgb(246 238 223 / 0.12)',
  brandText: '#8ab4ff',
  brandBgSoft: 'rgb(168 216 255 / 0.16)',
  focus: '#8ab4ff',
  dangerText: '#ff8a8a',
  dangerSoft: 'rgb(217 58 63 / 0.22)',
  warningText: '#ffe27a',
  warningSoft: 'rgb(255 226 122 / 0.16)',
};

/** One radius for every surface and control. */
export const RADIUS_PX = 12;

function cssName(token: string): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function declarations(values: Partial<Record<string, string>>, indent: string): string {
  return Object.entries(values)
    .map(([token, value]) => `${indent}${cssName(token)}: ${value};`)
    .join('\n');
}

/** The contents of assets/tokens.css. */
export function tokensCss(): string {
  return [
    '/* Generated from lib/shared/design-tokens.ts by `npm run tokens`; do not edit. */',
    ':root {',
    `  --radius: ${RADIUS_PX}px;`,
    declarations(palette, '  '),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root {',
    declarations(darkPalette, '    '),
    '  }',
    '}',
    '',
  ].join('\n');
}
