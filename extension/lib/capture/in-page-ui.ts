import { darkPalette, palette, RADIUS_PX } from '../shared/design-tokens';
import { OVERLAY_FONT_STACK } from './overlay-font';
import { OVERLAY_LAYER, releaseTopLayer, showInTopLayer, type OverlayLayer } from './overlay-layers';
import { createViewportOverlayHost } from './viewport-overlay-host';

/**
 * The one kit every piece of UI the extension puts into a page is built from:
 * the recording toolbar, the region selector and the recapture hint (and the
 * toolbar again inside the snapshot shield). Each mounts through
 * mountInPageUi (a host page CSS cannot reach, in the top layer, with a
 * shadow root) and draws with the same theme and primitives:
 *
 *   .hb-layer        the root: theme variables, font, light/dark
 *   .hb-pill         a sticker surface: 2px ink outline, full round
 *   .hb-icon-button  a round icon button
 *   .hb-action       a text button; --primary (sora), --accent (tamago),
 *                    --muted (paper), --quiet (no fill)
 */

const dark = { ...palette, ...darkPalette };

const darkTheme = `
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

export const IN_PAGE_UI_STYLES = `
  /* ":host" only matches in a shadow root; the shield frame mounts the toolbar
   * straight into its own document, so the theme is declared on .hb-layer too. */
  :host, .hb-layer {
    color-scheme: light;
    --hb-radius: ${RADIUS_PX}px;
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
    --hb-mark: ${palette.mark};
    --hb-mark-fill: ${palette.markPreviewFill};
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
      ${darkTheme}
    }
  }
  /* An explicit theme beats the media query, which reads light inside the shield frame. */
  .hb-layer[data-theme='dark'] {
    ${darkTheme}
  }
  * { box-sizing: border-box; letter-spacing: 0; }
  button { font: inherit; }
  .hb-layer {
    position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
    font-family: ${OVERLAY_FONT_STACK};
    font-size: 14px; line-height: 1.4; color: var(--hb-text);
  }

  .hb-pill {
    display: flex; align-items: center; gap: 8px; padding: 4px;
    border: 2px solid var(--hb-border); border-radius: 999px; background: var(--hb-surface); color: var(--hb-text);
  }

  .hb-icon-button {
    width: 36px; height: 36px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0; border: 0; border-radius: 99px; background: transparent; color: var(--hb-btn-text); cursor: pointer; transition: background .15s, color .15s;
  }
  .hb-icon-button:hover:not(:disabled) { background: var(--hb-btn-hover-bg); color: var(--hb-text); }
  .hb-icon-button[data-danger="true"]:hover:not(:disabled) { background: var(--hb-btn-danger-hover-bg); color: var(--hb-btn-danger-hover-text); }
  .hb-icon-button:disabled { opacity: .42; cursor: default; }
  .hb-icon-button svg { width: 17px; height: 17px; }

  .hb-action {
    height: 32px; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 0 14px; border: 2px solid var(--hb-border); border-radius: 999px;
    background: var(--hb-primary); color: var(--hb-primary-text);
    font-weight: 700; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s;
  }
  .hb-action:hover:not(:disabled) { background: var(--hb-primary-hover); }
  .hb-action:disabled { opacity: .5; cursor: default; }
  .hb-action--accent { background: var(--hb-segment-active-bg); color: ${palette.onAccent}; }
  .hb-action--accent:hover:not(:disabled) { background: var(--hb-segment-active-bg); filter: brightness(.96); }
  .hb-action--muted { background: var(--hb-actions-bg); color: var(--hb-text); }
  .hb-action--muted:hover:not(:disabled) { background: var(--hb-segment-active-bg); color: ${palette.onAccent}; }
  .hb-action--quiet { border-color: transparent; background: transparent; color: var(--hb-muted); }
  .hb-action--quiet:hover:not(:disabled) { background: var(--hb-btn-hover-bg); color: var(--hb-text); }

  .hb-icon-button:focus-visible, .hb-action:focus-visible { outline: 2px solid var(--hb-focus); outline-offset: 2px; }
  .hb-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) { .hb-layer * { animation: none !important; transition: none !important; } }
`;

export interface InPageUi {
  host: HTMLElement;
  root: ShadowRoot;
  /** The themed .hb-layer the UI's own elements go in. */
  layer: HTMLDivElement;
  remove(): void;
}

export interface InPageUiOptions {
  /** Styles of this piece of UI, on top of the kit's. */
  styles?: string;
  /** Host declarations beyond the full-viewport, page-proof base (e.g. pointer-events). */
  hostStyles?: Record<string, string>;
  /** Which top-layer slot it takes; omitted, the host is not shown in the top layer. */
  layer?: OverlayLayer;
  shadowMode?: ShadowRootMode;
}

/** A host page CSS cannot reach, with a shadow root holding the kit's theme and primitives. */
export function createInPageHost(
  attribute: string,
  {
    hostStyles = {},
    shadowMode = 'closed',
    popover = true,
  }: { hostStyles?: Record<string, string>; shadowMode?: ShadowRootMode; popover?: boolean } = {},
): { host: HTMLElement; root: ShadowRoot } {
  const host = createViewportOverlayHost(attribute, { 'pointer-events': 'none', ...hostStyles }, { popover });
  return { host, root: host.attachShadow({ mode: shadowMode }) };
}

/** Mounts a piece of in-page UI built from the kit and returns where its elements go. */
export function mountInPageUi(attribute: string, options: InPageUiOptions = {}): InPageUi {
  const { host, root } = createInPageHost(attribute, {
    hostStyles: options.hostStyles,
    shadowMode: options.shadowMode,
    popover: options.layer !== undefined,
  });
  const style = document.createElement('style');
  style.textContent = IN_PAGE_UI_STYLES + (options.styles ?? '');
  const layer = document.createElement('div');
  layer.className = 'hb-layer';
  root.append(style, layer);
  document.documentElement.append(host);
  if (options.layer !== undefined) showInTopLayer(host, options.layer);
  let removed = false;
  return {
    host,
    root,
    layer,
    remove() {
      if (removed) return;
      removed = true;
      if (options.layer !== undefined) releaseTopLayer(host);
      host.remove();
    },
  };
}

export { OVERLAY_LAYER };
