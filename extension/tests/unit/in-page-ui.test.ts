// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { IN_PAGE_UI_STYLES, mountInPageUi } from '@/lib/capture/in-page-ui';
import { isExtensionOverlay } from '@/lib/capture/viewport-overlay-host';

afterEach(() => document.documentElement.querySelectorAll('[data-test-ui]').forEach((host) => host.remove()));

describe('in-page UI kit', () => {
  it('mounts a page-proof host with the kit’s theme, the piece’s own styles and a themed layer', () => {
    const ui = mountInPageUi('data-test-ui', { styles: '.mine { color: red; }', shadowMode: 'open' });

    expect(ui.host.isConnected).toBe(true);
    expect(isExtensionOverlay(ui.host)).toBe(true);
    expect(ui.host.style.getPropertyValue('pointer-events')).toBe('none');
    const style = ui.root.querySelector('style')!.textContent!;
    expect(style.startsWith(IN_PAGE_UI_STYLES)).toBe(true);
    expect(style).toContain('.mine { color: red; }');
    expect(ui.layer.className).toBe('hb-layer');

    ui.remove();
    ui.remove();
    expect(ui.host.isConnected).toBe(false);
  });

  it('defines every primitive the in-page UI is built from, and a dark theme', () => {
    // The plain .hb-action is the primary one.
    for (const selector of [
      '.hb-layer',
      '.hb-pill',
      '.hb-icon-button',
      '.hb-action',
      '.hb-action--accent',
      '.hb-action--muted',
      '.hb-action--quiet',
    ]) {
      expect(IN_PAGE_UI_STYLES, selector).toContain(`${selector} {`);
    }
    expect(IN_PAGE_UI_STYLES).toContain('prefers-color-scheme: dark');
  });
});
