import { darkPalette, palette, RADIUS_PX } from '../shared/design-tokens';
import { OVERLAY_FONT_STACK } from '../capture/overlay-font';

const dark = { ...palette, ...darkPalette };

/** The dark palette, applied by the OS preference or by an explicit `data-theme`. */
const darkTokens = `
  color-scheme: dark;
  --hb-surface: ${dark.surface};
  --hb-text: ${dark.text};
  --hb-status-text: ${dark.text};
  --hb-muted: ${dark.textMuted};
  --hb-border: ${dark.line};
  --hb-focus: ${dark.focus};
  --hb-divider: ${dark.lineSoft};
  --hb-actions-bg: ${dark.surfaceMuted};
  --hb-btn-text: ${dark.text};
  --hb-btn-hover-bg: ${dark.hoverTint};
  --hb-btn-danger-hover-bg: ${dark.dangerSoft};
  --hb-btn-danger-hover-text: ${dark.dangerText};
  --hb-error-text: ${dark.dangerText};
  --hb-warning: ${dark.warningText};
  --hb-link: ${dark.brandText};
`;

/**
 * The recording toolbar's stylesheet, injected as a <style> tag inside its
 * mount target rather than relying on any page CSS.
 */
export const recordingToolbarStyles = `
  /* The toolbar mounts in two places: a closed shadow root on recorded pages
   * (recording-toolbar-host.tsx) and directly in the snapshot-shield iframe
   * document (entrypoints/snapshot-shield/main.tsx). ":host" only matches in
   * the shadow-root case, so every theme variable is declared on ".hb-layer"
   * as well — otherwise the iframe copy renders with unset variables
   * (transparent surface, wrong text colors). */
  :host, .hb-layer {
    color-scheme: light;
    /* The app's "sticker" style, from the shared design tokens: 2px ink
     * outlines, flat pastel fills with ink text, one 12px radius, no shadows. */
    --hb-radius: ${RADIUS_PX}px;
    /* One height for the bar in both shapes, expanded and collapsed. */
    --hb-bar-height: 58px;
    --hb-surface: ${palette.surface};
    --hb-text: ${palette.text};
    --hb-status-text: ${palette.text};
    --hb-muted: ${palette.textMuted};
    --hb-border: ${palette.line};
    --hb-primary: ${palette.sora};
    --hb-primary-hover: ${palette.soraHover};
    --hb-primary-text: ${palette.onAccent};
    --hb-count: ${palette.tamago};
    --hb-count-text: ${palette.onAccent};
    --hb-recording: ${palette.mark};
    --hb-focus: ${palette.focus};
    --hb-divider: ${palette.lineSoft};
    --hb-actions-bg: ${palette.surfaceMuted};
    --hb-segment-active-bg: ${palette.selected};
    --hb-btn-text: ${palette.text};
    --hb-btn-hover-bg: ${palette.hoverTint};
    --hb-btn-danger-hover-bg: ${palette.dangerSoft};
    --hb-btn-danger-hover-text: ${palette.dangerText};
    --hb-error-text: ${palette.dangerText};
    --hb-warning: ${palette.warningText};
    --hb-link: ${palette.brandText};
  }
  @media (prefers-color-scheme: dark) {
    :host, .hb-layer:not([data-theme]) {
      ${darkTokens}
    }
  }
  /* An explicit theme beats the media query, which reads light inside the shield frame. */
  .hb-layer[data-theme='dark'] {
    ${darkTokens}
  }
  * { box-sizing: border-box; letter-spacing: 0; }
  button { font: inherit; }
  .hb-layer {
    position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
    font-family: ${OVERLAY_FONT_STACK};
    font-size: 14px; line-height: 1.4;
  }
  .hb-position {
    position: absolute; left: 0; top: 0; z-index: 2; max-width: calc(100vw - 32px); pointer-events: auto;
  }
  .hb-modal-backdrop { position: absolute; inset: 0; z-index: 1; pointer-events: auto; background: transparent; }
  .hb-toolbar {
    height: var(--hb-bar-height); width: max-content; max-width: calc(100vw - 32px); display: flex; align-items: center; gap: 12px;
    padding: 0 8px 0 18px; border: 2px solid var(--hb-border); border-radius: 999px;
    background: var(--hb-surface); color: var(--hb-text);
  }
  .hb-toolbar--invalidated {
    width: min(520px, calc(100vw - 32px)); height: auto; max-width: calc(100vw - 32px); gap: 10px;
    padding: 8px; border-radius: var(--hb-radius);
  }
  .hb-invalidated-status { min-width: 0; flex: 1 1 240px; display: flex; align-items: center; gap: 8px; }
  .hb-invalidated-status svg { width: 18px; height: 18px; flex: none; color: var(--hb-warning); }
  .hb-invalidated-copy { min-width: 0; font-size: 12px; font-weight: 600; white-space: normal; }
  .hb-invalidated-actions { flex: none; display: flex; align-items: center; gap: 2px; }
  .hb-status {
    flex: none; height: 42px; display: flex; align-items: center; gap: 9px;
    padding: 0; border: 0; background: transparent; color: inherit; white-space: nowrap; cursor: grab;
    touch-action: none;
  }
  .hb-status:active, .hb-collapsed:active { cursor: grabbing; }
  .hb-dot { width: 10px; height: 10px; flex: none; border-radius: 99px; background: var(--hb-recording); box-shadow: 0 0 0 3px var(--hb-btn-danger-hover-bg); }
  .hb-dot[data-tone="muted"] { background: var(--hb-muted); box-shadow: none; }
  .hb-grip { width: 18px; height: 22px; flex: none; color: var(--hb-muted); }
  .hb-count-badge[data-size="small"] { min-width: 22px; height: 22px; font-size: 12px; }
  .hb-count-badge[data-tone="muted"] { background: var(--hb-actions-bg); color: var(--hb-muted); }
  .hb-count-badge { min-width: 26px; height: 26px; padding: 0 8px; border: 2px solid var(--hb-border); border-radius: 99px; background: var(--hb-count); color: var(--hb-count-text); font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; }
  .hb-actions-group { flex: none; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 999px; background: var(--hb-actions-bg); }
  /* Pill track with pill options, so the nested curves stay concentric; the
   * active option is the same tamago sticker as the app's selected state. */
  .hb-mode-switch { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 999px; background: var(--hb-actions-bg); }
  .hb-mode-switch button {
    height: 30px; min-width: 52px; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    padding: 0 12px; border: 2px solid transparent; border-radius: 999px; background: transparent; color: var(--hb-muted);
    font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s;
  }
  .hb-mode-switch button:hover:not(:disabled):not([aria-checked="true"]) { background: var(--hb-btn-hover-bg); color: var(--hb-text); }
  .hb-mode-switch button[aria-checked="true"] { border-color: var(--hb-border); background: var(--hb-segment-active-bg); color: ${palette.onAccent}; }
  .hb-mode-switch button:disabled { opacity: .5; cursor: default; }
  .hb-mode-switch button:focus-visible { outline: 2px solid var(--hb-focus); outline-offset: 2px; }
  .hb-mode-switch svg { width: 14px; height: 14px; }
  .hb-button {
    width: 36px; height: 36px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0; border: 0; border-radius: 99px; background: transparent; color: var(--hb-btn-text); cursor: pointer; transition: background .15s, color .15s;
  }
  .hb-button:hover:not(:disabled) { background: var(--hb-btn-hover-bg); color: var(--hb-text); }
  .hb-button[data-danger="true"]:hover:not(:disabled) { background: var(--hb-btn-danger-hover-bg); color: var(--hb-btn-danger-hover-text); }
  .hb-button:disabled { opacity: .42; cursor: default; }
  /* The one action that moves the flow forward in the current state. */
  .hb-button[data-emphasis="true"], .hb-button[aria-pressed="true"] { background: var(--hb-segment-active-bg); color: ${palette.onAccent}; }
  .hb-primary {
    height: 38px; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 0 16px; border: 2px solid var(--hb-border); border-radius: 999px; background: var(--hb-segment-active-bg);
    color: ${palette.onAccent}; font-size: 14px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: filter .15s;
  }
  .hb-primary:hover:not(:disabled) { filter: brightness(.95); }
  .hb-primary[data-quiet] { background: transparent; color: var(--hb-btn-text); }
  .hb-primary:disabled { opacity: .68; cursor: wait; }
  .hb-primary:focus-visible { outline: 2px solid var(--hb-focus); outline-offset: 2px; }
  .hb-primary svg { width: 16px; height: 16px; }
  .hb-button:focus-visible, .hb-status:focus-visible, .hb-collapsed:focus-visible, .hb-finish:focus-visible,
  .hb-secondary:focus-visible, .hb-confirm button:focus-visible,
  .hb-snackbar button:focus-visible {
    outline: 2px solid var(--hb-focus); outline-offset: 2px;
  }
  .hb-button svg { width: 17px; height: 17px; }
  .hb-finish {
    height: 42px; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 0 22px; border: 2px solid var(--hb-border); border-radius: 999px; background: var(--hb-primary);
    color: var(--hb-primary-text); font-size: 15px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background .15s;
  }
  .hb-finish:hover:not(:disabled) { background: var(--hb-primary-hover); }
  .hb-finish:disabled { opacity: .68; cursor: wait; }
  .hb-secondary {
    height: 36px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0 11px; border: 0; border-radius: 999px; background: transparent; color: var(--hb-muted);
    font-weight: 700; cursor: pointer; white-space: nowrap;
  }
  .hb-secondary:hover:not(:disabled) { background: var(--hb-btn-hover-bg); color: var(--hb-text); }
  .hb-secondary:disabled { opacity: .5; cursor: wait; }
  .hb-collapsed {
    position: relative; height: var(--hb-bar-height); padding: 0 8px 0 16px; display: flex; align-items: center; gap: 11px;
    border: 2px solid var(--hb-border); border-radius: 999px; background: var(--hb-surface); color: var(--hb-text);
    cursor: pointer; touch-action: none;
  }
  .hb-collapsed-expand { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 999px; background: var(--hb-actions-bg); color: var(--hb-text); }
  .hb-hint {
    position: absolute; right: 0; bottom: calc(100% + 8px); width: max-content; max-width: min(320px, calc(100vw - 32px));
    padding: 7px 12px; border: 2px solid var(--hb-border); border-radius: 999px; background: var(--hb-surface);
    color: var(--hb-muted); font-size: 12px; font-weight: 600; pointer-events: none;
  }
  .hb-position[data-vertical="top"] .hb-hint { top: calc(100% + 8px); bottom: auto; }
  .hb-position[data-horizontal="left"] .hb-hint { left: 0; right: auto; }
  .hb-message, .hb-snackbar, .hb-confirm {
    position: absolute; right: 0; bottom: calc(100% + 8px); min-width: 220px; max-width: min(320px, calc(100vw - 32px));
    padding: 10px 12px; border: 2px solid var(--hb-border); border-radius: var(--hb-radius); background: var(--hb-surface);
    color: var(--hb-text); font-size: 12px; font-weight: 700;
  }
  .hb-message { display: flex; align-items: center; gap: 8px; min-width: 0; width: max-content; }
  .hb-message[data-kind="error"] { color: var(--hb-error-text); }
  .hb-snackbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .hb-snackbar button { border: 0; background: transparent; color: var(--hb-link); font-weight: 700; cursor: pointer; }
  .hb-position[data-vertical="top"] .hb-message,
  .hb-position[data-vertical="top"] .hb-snackbar,
  .hb-position[data-vertical="top"] .hb-confirm { top: calc(100% + 8px); bottom: auto; }
  .hb-position[data-horizontal="left"] .hb-message,
  .hb-position[data-horizontal="left"] .hb-snackbar,
  .hb-position[data-horizontal="left"] .hb-confirm { left: 0; right: auto; }
  .hb-confirm { width: min(300px, calc(100vw - 32px)); padding: 16px; }
  .hb-confirm-title { margin: 0; font-size: 14px; font-weight: 700; }
  .hb-confirm-copy { margin: 6px 0 16px; color: var(--hb-muted); font-size: 12px; font-weight: 400; line-height: 1.5; }
  .hb-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .hb-confirm button {
    min-height: 36px; padding: 0 12px; border: 2px solid var(--hb-border); border-radius: var(--hb-radius);
    background: var(--hb-surface); color: var(--hb-text); font-weight: 700; cursor: pointer;
  }
  .hb-confirm button[data-danger="true"] { background: var(--hb-recording); color: ${palette.recordingText}; }
  .hb-confirm button:disabled { opacity: .5; cursor: wait; }
  .hb-success { width: 18px; height: 18px; color: var(--hb-link); }
  .hb-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  /* CSS-only tooltip: shows on hover/focus with no delay (unlike the browser's
   * native title attribute, which is slow and unstyleable). Kept as plain CSS
   * rather than the app's shadcn Tooltip because this toolbar renders in a
   * closed shadow root and a separate iframe, neither of which load Tailwind. */
  [data-tooltip] { position: relative; }
  [data-dragging] [data-tooltip]::after, [data-dragging][data-tooltip]::after { display: none; }
  [data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute; left: 50%; bottom: calc(100% + 8px); z-index: 4;
    padding: 5px 9px; border-radius: var(--hb-radius); background: var(--hb-text); color: var(--hb-surface);
    font-size: 11px; font-weight: 600; line-height: 1.3; white-space: nowrap;
    pointer-events: none; opacity: 0; visibility: hidden;
    transform: translate(-50%, 2px); transition: opacity .08s ease, transform .08s ease;
  }
  [data-tooltip]:hover::after, [data-tooltip]:focus-visible::after {
    opacity: 1; visibility: visible; transform: translate(-50%, 0);
  }
  /* The last button sits at the toolbar's edge: anchor its tooltip there so it cannot leave the viewport. */
  .hb-collapse[data-tooltip]::after { left: auto; right: 0; transform: translate(0, 2px); }
  .hb-collapse[data-tooltip]:hover::after, .hb-collapse[data-tooltip]:focus-visible::after { transform: translate(0, 0); }
  .hb-position[data-vertical="top"] [data-tooltip]::after { bottom: auto; top: calc(100% + 8px); transform: translate(-50%, -2px); }
  .hb-position[data-vertical="top"] [data-tooltip]:hover::after,
  .hb-position[data-vertical="top"] [data-tooltip]:focus-visible::after { transform: translate(-50%, 0); }
  /* Stacked layout, chosen by measurement rather than a viewport breakpoint:
   * recording-toolbar.tsx sets data-compact only when the single row would
   * overflow, so the switch follows the real content width in every language. */
  .hb-position:has(.hb-toolbar[data-compact]) { max-width: calc(100vw - 16px); }
  .hb-toolbar[data-compact]:not(.hb-toolbar--invalidated) {
    width: calc(100vw - 16px); height: auto; min-height: 0; max-width: calc(100vw - 16px);
    flex-wrap: wrap; gap: 6px; padding: 7px 8px; border-radius: var(--hb-radius);
  }
  .hb-toolbar[data-compact]:not(.hb-toolbar--invalidated) .hb-status { flex: 1 1 100%; height: 32px; padding: 0 4px; }
  .hb-toolbar[data-compact]:not(.hb-toolbar--invalidated) .hb-mode-switch { flex: 1 1 100%; }
  .hb-toolbar[data-compact]:not(.hb-toolbar--invalidated) .hb-mode-switch button { flex: 1; }
  .hb-toolbar[data-compact]:not(.hb-toolbar--invalidated) .hb-actions-group { flex: 1 1 0; justify-content: space-around; gap: 0; padding: 3px; }
  .hb-toolbar[data-compact]:not(.hb-toolbar--invalidated) .hb-button { width: 32px; height: 32px; }
  .hb-toolbar[data-compact]:not(.hb-toolbar--invalidated) .hb-finish { height: 38px; padding: 0 14px; font-size: 14px; }
  .hb-toolbar--invalidated[data-compact] { width: calc(100vw - 16px); max-width: calc(100vw - 16px); flex-wrap: wrap; }
  .hb-toolbar--invalidated[data-compact] .hb-invalidated-status { flex-basis: 100%; padding: 2px 4px; }
  .hb-toolbar--invalidated[data-compact] .hb-invalidated-actions { width: 100%; }
  .hb-toolbar--invalidated[data-compact] .hb-invalidated-actions .hb-secondary,
  .hb-toolbar--invalidated[data-compact] .hb-invalidated-actions .hb-finish { flex: 1; }
  @media (prefers-reduced-motion: reduce) { .hb-layer * { animation: none !important; transition: none !important; } }
`;
