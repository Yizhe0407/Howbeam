import { BRAND_ACCENT, BRAND_DANGER } from '../capture/brand-colors';
import { OVERLAY_FONT_STACK } from '../capture/overlay-font';

/** The dark palette, applied by the OS preference or by an explicit `data-theme`. */
const darkTokens = `
  color-scheme: dark;
  --ft-surface: #24201b;
  --ft-text: #f6eedf;
  --ft-status-text: #f6eedf;
  --ft-muted: #b5aa99;
  --ft-border: #d9cdb8;
  --ft-focus: #8ab4ff;
  --ft-divider: rgba(246, 238, 223, .16);
  --ft-actions-bg: #322c25;
  --ft-btn-text: #f6eedf;
  --ft-btn-hover-bg: rgba(246, 238, 223, .12);
  --ft-btn-danger-hover-bg: rgba(217, 58, 63, .22);
  --ft-btn-danger-hover-text: #ff8a8a;
  --ft-error-text: #ff8a8a;
  --ft-warning: #ffe27a;
  --ft-link: #8ab4ff;
`;

/**
 * The recording toolbar's stylesheet, injected as a <style> tag inside its
 * mount target rather than relying on any page CSS.
 */
export const recordingToolbarStyles = `
  /* The toolbar mounts in two places: a closed shadow root on recorded pages
   * (recording-toolbar-host.tsx) and directly in the snapshot-shield iframe
   * document (entrypoints/snapshot-shield/main.tsx). ":host" only matches in
   * the shadow-root case, so every theme variable is declared on ".ft-layer"
   * as well — otherwise the iframe copy renders with unset variables
   * (transparent surface, wrong text colors). */
  :host, .ft-layer {
    color-scheme: light;
    /* Mirrors the app's "sticker" tokens (assets/tailwind.css): 2px ink
     * outlines, flat pastel fills with ink text, one 12px radius, no shadows. */
    --ft-radius: 12px;
    /* One height for the bar in both shapes, expanded and collapsed. */
    --ft-bar-height: 58px;
    --ft-surface: #fffdf8;
    --ft-text: #1f1b16;
    --ft-status-text: #1f1b16;
    --ft-muted: #6b6156;
    --ft-border: #1f1b16;
    --ft-primary: ${BRAND_ACCENT};
    --ft-primary-hover: #93ceff;
    --ft-primary-text: #1f1b16;
    --ft-count: #ffe27a;
    --ft-count-text: #1f1b16;
    --ft-recording: ${BRAND_DANGER};
    --ft-focus: #2f6fed;
    --ft-divider: rgba(31, 27, 22, .14);
    --ft-actions-bg: #f2e9d9;
    --ft-segment-active-bg: #ffe27a;
    --ft-btn-text: #1f1b16;
    --ft-btn-hover-bg: rgba(31, 27, 22, .1);
    --ft-btn-danger-hover-bg: #ffe6e6;
    --ft-btn-danger-hover-text: #c8323a;
    --ft-error-text: #c8323a;
    --ft-warning: #9a6b00;
    --ft-link: #2b5fc8;
  }
  @media (prefers-color-scheme: dark) {
    :host, .ft-layer:not([data-theme]) {
      ${darkTokens}
    }
  }
  /* An explicit theme beats the media query, which reads light inside the shield frame. */
  .ft-layer[data-theme='dark'] {
    ${darkTokens}
  }
  * { box-sizing: border-box; letter-spacing: 0; }
  button { font: inherit; }
  .ft-layer {
    position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
    font-family: ${OVERLAY_FONT_STACK};
    font-size: 14px; line-height: 1.4;
  }
  .ft-position {
    position: absolute; left: 0; top: 0; z-index: 2; max-width: calc(100vw - 32px); pointer-events: auto;
  }
  .ft-modal-backdrop { position: absolute; inset: 0; z-index: 1; pointer-events: auto; background: transparent; }
  .ft-toolbar {
    height: var(--ft-bar-height); width: max-content; max-width: calc(100vw - 32px); display: flex; align-items: center; gap: 12px;
    padding: 0 8px 0 18px; border: 2px solid var(--ft-border); border-radius: 999px;
    background: var(--ft-surface); color: var(--ft-text);
  }
  .ft-toolbar--invalidated {
    width: min(520px, calc(100vw - 32px)); height: auto; max-width: calc(100vw - 32px); gap: 10px;
    padding: 8px; border-radius: var(--ft-radius);
  }
  .ft-invalidated-status { min-width: 0; flex: 1 1 240px; display: flex; align-items: center; gap: 8px; }
  .ft-invalidated-status svg { width: 18px; height: 18px; flex: none; color: var(--ft-warning); }
  .ft-invalidated-copy { min-width: 0; font-size: 12px; font-weight: 600; white-space: normal; }
  .ft-invalidated-actions { flex: none; display: flex; align-items: center; gap: 2px; }
  .ft-status {
    flex: none; height: 42px; display: flex; align-items: center; gap: 9px;
    padding: 0; border: 0; background: transparent; color: inherit; white-space: nowrap; cursor: grab;
    touch-action: none;
  }
  .ft-status:active, .ft-collapsed:active { cursor: grabbing; }
  .ft-dot { width: 10px; height: 10px; flex: none; border-radius: 99px; background: var(--ft-recording); box-shadow: 0 0 0 3px var(--ft-btn-danger-hover-bg); }
  .ft-state-icon { width: 20px; height: 20px; flex: none; color: var(--ft-recording); }
  .ft-state-icon[data-tone="muted"] { color: var(--ft-muted); }
  .ft-grip { width: 18px; height: 22px; flex: none; color: var(--ft-muted); }
  .ft-count-badge[data-tone="muted"] { background: var(--ft-actions-bg); color: var(--ft-muted); }
  .ft-count-badge { min-width: 26px; height: 26px; padding: 0 8px; border: 2px solid var(--ft-border); border-radius: 99px; background: var(--ft-count); color: var(--ft-count-text); font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; }
  .ft-actions-group { flex: none; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 999px; background: var(--ft-actions-bg); }
  /* Pill track with pill options, so the nested curves stay concentric; the
   * active option is the same tamago sticker as the app's selected state. */
  .ft-mode-switch { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 999px; background: var(--ft-actions-bg); }
  .ft-mode-switch button {
    height: 30px; min-width: 52px; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    padding: 0 12px; border: 2px solid transparent; border-radius: 999px; background: transparent; color: var(--ft-muted);
    font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s;
  }
  .ft-mode-switch button:hover:not(:disabled):not([aria-checked="true"]) { background: var(--ft-btn-hover-bg); color: var(--ft-text); }
  .ft-mode-switch button[aria-checked="true"] { border-color: var(--ft-border); background: var(--ft-segment-active-bg); color: #1f1b16; }
  .ft-mode-switch button:disabled { opacity: .5; cursor: default; }
  .ft-mode-switch button:focus-visible { outline: 2px solid var(--ft-focus); outline-offset: 2px; }
  .ft-mode-switch svg { width: 14px; height: 14px; }
  .ft-button {
    width: 36px; height: 36px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0; border: 0; border-radius: 99px; background: transparent; color: var(--ft-btn-text); cursor: pointer; transition: background .15s, color .15s;
  }
  .ft-button:hover:not(:disabled) { background: var(--ft-btn-hover-bg); color: var(--ft-text); }
  .ft-button[data-danger="true"]:hover:not(:disabled) { background: var(--ft-btn-danger-hover-bg); color: var(--ft-btn-danger-hover-text); }
  .ft-button:disabled { opacity: .42; cursor: default; }
  /* The one action that moves the flow forward in the current state. */
  .ft-button[data-emphasis="true"] { background: var(--ft-segment-active-bg); color: #1f1b16; }
  .ft-primary {
    height: 38px; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 0 16px; border: 2px solid var(--ft-border); border-radius: 999px; background: var(--ft-segment-active-bg);
    color: #1f1b16; font-size: 14px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: filter .15s;
  }
  .ft-primary:hover:not(:disabled) { filter: brightness(.95); }
  .ft-primary[data-quiet] { background: transparent; color: var(--ft-btn-text); }
  .ft-primary:disabled { opacity: .68; cursor: wait; }
  .ft-primary:focus-visible { outline: 2px solid var(--ft-focus); outline-offset: 2px; }
  .ft-primary svg { width: 16px; height: 16px; }
  .ft-button:focus-visible, .ft-status:focus-visible, .ft-collapsed:focus-visible, .ft-finish:focus-visible,
  .ft-secondary:focus-visible, .ft-confirm button:focus-visible,
  .ft-snackbar button:focus-visible {
    outline: 2px solid var(--ft-focus); outline-offset: 2px;
  }
  .ft-button svg { width: 17px; height: 17px; }
  .ft-finish {
    height: 42px; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 0 22px; border: 2px solid var(--ft-border); border-radius: 999px; background: var(--ft-primary);
    color: var(--ft-primary-text); font-size: 15px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background .15s;
  }
  .ft-finish:hover:not(:disabled) { background: var(--ft-primary-hover); }
  .ft-finish:disabled { opacity: .68; cursor: wait; }
  .ft-secondary {
    height: 36px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0 11px; border: 0; border-radius: 999px; background: transparent; color: var(--ft-muted);
    font-weight: 700; cursor: pointer; white-space: nowrap;
  }
  .ft-secondary:hover:not(:disabled) { background: var(--ft-btn-hover-bg); color: var(--ft-text); }
  .ft-secondary:disabled { opacity: .5; cursor: wait; }
  .ft-collapsed {
    position: relative; height: var(--ft-bar-height); padding: 0 8px 0 16px; display: flex; align-items: center; gap: 11px;
    border: 2px solid var(--ft-border); border-radius: 999px; background: var(--ft-surface); color: var(--ft-text);
    cursor: pointer; touch-action: none;
  }
  .ft-collapsed-expand { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 999px; background: var(--ft-actions-bg); color: var(--ft-text); }
  .ft-hint {
    position: absolute; right: 0; bottom: calc(100% + 8px); width: max-content; max-width: min(320px, calc(100vw - 32px));
    padding: 7px 12px; border: 2px solid var(--ft-border); border-radius: 999px; background: var(--ft-surface);
    color: var(--ft-muted); font-size: 12px; font-weight: 600; pointer-events: none;
  }
  .ft-position[data-vertical="top"] .ft-hint { top: calc(100% + 8px); bottom: auto; }
  .ft-position[data-horizontal="left"] .ft-hint { left: 0; right: auto; }
  .ft-message, .ft-snackbar, .ft-confirm {
    position: absolute; right: 0; bottom: calc(100% + 8px); min-width: 220px; max-width: min(320px, calc(100vw - 32px));
    padding: 10px 12px; border: 2px solid var(--ft-border); border-radius: var(--ft-radius); background: var(--ft-surface);
    color: var(--ft-text); font-size: 12px; font-weight: 700;
  }
  .ft-message { display: flex; align-items: center; gap: 8px; }
  .ft-message[data-kind="error"] { color: var(--ft-error-text); }
  .ft-snackbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .ft-snackbar button { border: 0; background: transparent; color: var(--ft-link); font-weight: 700; cursor: pointer; }
  .ft-position[data-vertical="top"] .ft-message,
  .ft-position[data-vertical="top"] .ft-snackbar,
  .ft-position[data-vertical="top"] .ft-confirm { top: calc(100% + 8px); bottom: auto; }
  .ft-position[data-horizontal="left"] .ft-message,
  .ft-position[data-horizontal="left"] .ft-snackbar,
  .ft-position[data-horizontal="left"] .ft-confirm { left: 0; right: auto; }
  .ft-confirm { width: min(300px, calc(100vw - 32px)); padding: 16px; }
  .ft-confirm-title { margin: 0; font-size: 14px; font-weight: 700; }
  .ft-confirm-copy { margin: 6px 0 16px; color: var(--ft-muted); font-size: 12px; font-weight: 400; line-height: 1.5; }
  .ft-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .ft-confirm button {
    min-height: 36px; padding: 0 12px; border: 2px solid var(--ft-border); border-radius: var(--ft-radius);
    background: var(--ft-surface); color: var(--ft-text); font-weight: 700; cursor: pointer;
  }
  .ft-confirm button[data-danger="true"] { background: var(--ft-recording); color: #fff; }
  .ft-confirm button:disabled { opacity: .5; cursor: wait; }
  .ft-success { width: 18px; height: 18px; color: var(--ft-link); }
  .ft-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  /* CSS-only tooltip: shows on hover/focus with no delay (unlike the browser's
   * native title attribute, which is slow and unstyleable). Kept as plain CSS
   * rather than the app's shadcn Tooltip because this toolbar renders in a
   * closed shadow root and a separate iframe, neither of which load Tailwind. */
  [data-tooltip] { position: relative; }
  [data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute; left: 50%; bottom: calc(100% + 8px); z-index: 4;
    padding: 5px 9px; border-radius: var(--ft-radius); background: var(--ft-text); color: var(--ft-surface);
    font-size: 11px; font-weight: 600; line-height: 1.3; white-space: nowrap;
    pointer-events: none; opacity: 0; visibility: hidden;
    transform: translate(-50%, 2px); transition: opacity .08s ease, transform .08s ease;
  }
  [data-tooltip]:hover::after, [data-tooltip]:focus-visible::after {
    opacity: 1; visibility: visible; transform: translate(-50%, 0);
  }
  /* The last button sits at the toolbar's edge: anchor its tooltip there so it cannot leave the viewport. */
  .ft-collapse[data-tooltip]::after { left: auto; right: 0; transform: translate(0, 2px); }
  .ft-collapse[data-tooltip]:hover::after, .ft-collapse[data-tooltip]:focus-visible::after { transform: translate(0, 0); }
  .ft-position[data-vertical="top"] [data-tooltip]::after { bottom: auto; top: calc(100% + 8px); transform: translate(-50%, -2px); }
  .ft-position[data-vertical="top"] [data-tooltip]:hover::after,
  .ft-position[data-vertical="top"] [data-tooltip]:focus-visible::after { transform: translate(-50%, 0); }
  /* Stacked layout, chosen by measurement rather than a viewport breakpoint:
   * recording-toolbar.tsx sets data-compact only when the single row would
   * overflow, so the switch follows the real content width in every language. */
  .ft-position:has(.ft-toolbar[data-compact]) { max-width: calc(100vw - 16px); }
  .ft-toolbar[data-compact]:not(.ft-toolbar--invalidated) {
    width: calc(100vw - 16px); height: auto; min-height: 0; max-width: calc(100vw - 16px);
    flex-wrap: wrap; gap: 6px; padding: 7px 8px; border-radius: var(--ft-radius);
  }
  .ft-toolbar[data-compact]:not(.ft-toolbar--invalidated) .ft-status { flex: 1 1 100%; height: 32px; padding: 0 4px; }
  .ft-toolbar[data-compact]:not(.ft-toolbar--invalidated) .ft-mode-switch { flex: 1 1 100%; }
  .ft-toolbar[data-compact]:not(.ft-toolbar--invalidated) .ft-mode-switch button { flex: 1; }
  .ft-toolbar[data-compact]:not(.ft-toolbar--invalidated) .ft-actions-group { flex: 1 1 0; justify-content: space-around; gap: 0; padding: 3px; }
  .ft-toolbar[data-compact]:not(.ft-toolbar--invalidated) .ft-button { width: 32px; height: 32px; }
  .ft-toolbar[data-compact]:not(.ft-toolbar--invalidated) .ft-finish { height: 38px; padding: 0 14px; font-size: 14px; }
  .ft-toolbar--invalidated[data-compact] { width: calc(100vw - 16px); max-width: calc(100vw - 16px); flex-wrap: wrap; }
  .ft-toolbar--invalidated[data-compact] .ft-invalidated-status { flex-basis: 100%; padding: 2px 4px; }
  .ft-toolbar--invalidated[data-compact] .ft-invalidated-actions { width: 100%; }
  .ft-toolbar--invalidated[data-compact] .ft-invalidated-actions .ft-secondary,
  .ft-toolbar--invalidated[data-compact] .ft-invalidated-actions .ft-finish { flex: 1; }
  @media (prefers-reduced-motion: reduce) { .ft-layer * { animation: none !important; transition: none !important; } }
`;
