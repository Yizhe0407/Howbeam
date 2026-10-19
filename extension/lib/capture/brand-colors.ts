/**
 * Canonical Howbeam brand colors for TS-injected styles (toolbar, region
 * capture). CSS files cannot import TS, so assets/tailwind.css (--sora) and
 * entrypoints/snapshot-shield/style.css keep literal copies; change them together.
 *
 * BRAND_DANGER is the on-page selection red and deliberately equals the
 * annotation HIGHLIGHT_COLOR, so what the user drags matches what gets drawn.
 * The app UI's record button uses the deeper --recording instead, which keeps
 * white label text above 4.5:1 contrast.
 */
export const BRAND_ACCENT = '#a8d8ff';
export const BRAND_DANGER = '#ff4747';
