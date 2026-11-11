// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  isDocumentScrollingKey,
  getRecordingTabUpdateAction,
  isInScrollableElementGutter,
  isInScrollbarGutter,
  isMatchingSnapshotViewport,
  isPointInsideViewport,
  isTrustedRecordedPageSender,
  isValidSnapshotViewportContext,
} from '@/lib/recording/recording-guards';

describe('isTrustedRecordedPageSender', () => {
  const validSender = {
    frameId: 0,
    url: 'https://example.com/page',
    tab: { id: 7, url: 'https://example.com/page' },
  };

  it('accepts a same-origin sender even when the path differs from the message URL', () => {
    // Regression: SPA pushState navigation leaves sender.url/tab.url briefly
    // behind location.href — must not reject an otherwise-legitimate click.
    expect(
      isTrustedRecordedPageSender('https://example.com/page', validSender, 7),
    ).toBe(true);
    expect(
      isTrustedRecordedPageSender('https://example.com/page/conversation-42', {
        ...validSender,
        url: 'https://example.com/page',
        tab: { id: 7, url: 'https://example.com/page' },
      }, 7),
    ).toBe(true);
  });

  it('rejects a wrong tab, a non-top frame, or a genuinely different origin', () => {
    expect(isTrustedRecordedPageSender('https://example.com/page', validSender, 8)).toBe(false);
    expect(isTrustedRecordedPageSender('https://example.com/page', { ...validSender, frameId: 1 }, 7)).toBe(false);
    expect(
      isTrustedRecordedPageSender('https://example.com/page', {
        ...validSender,
        url: 'https://evil.example/page',
      }, 7),
    ).toBe(false);
    expect(
      isTrustedRecordedPageSender('https://example.com/page', {
        ...validSender,
        tab: { id: 7, url: 'https://evil.example/page' },
      }, 7),
    ).toBe(false);
    expect(isTrustedRecordedPageSender('https://example.com/page', { frameId: 0 }, 7)).toBe(false);
  });
});

describe('isMatchingSnapshotViewport', () => {
  const viewport = { width: 1280, height: 720, scrollX: 20, scrollY: 40 };

  it('accepts subpixel scroll noise but rejects geometry, scroll, and DPR changes', () => {
    expect(isMatchingSnapshotViewport(viewport, 2, { ...viewport, scrollX: 20.5, scrollY: 39.5 }, 2)).toBe(true);
    expect(isMatchingSnapshotViewport(viewport, 2, { ...viewport, width: 1279 }, 2)).toBe(false);
    expect(isMatchingSnapshotViewport(viewport, 2, { ...viewport, scrollY: 42 }, 2)).toBe(false);
    expect(isMatchingSnapshotViewport(viewport, 2, viewport, 1)).toBe(false);
  });
});

describe('isValidSnapshotViewportContext', () => {
  const viewport = { width: 1280, height: 720, scrollX: 0, scrollY: 40 };

  it('accepts finite positive geometry and rejects malformed invalidation payloads', () => {
    expect(isValidSnapshotViewportContext(viewport, 2)).toBe(true);
    expect(isValidSnapshotViewportContext({ ...viewport, width: 0 }, 2)).toBe(false);
    expect(isValidSnapshotViewportContext({ ...viewport, scrollY: Number.NaN }, 2)).toBe(false);
    expect(isValidSnapshotViewportContext(viewport, 0)).toBe(false);
    expect(isValidSnapshotViewportContext(null, 2)).toBe(false);
  });
});

describe('isInScrollbarGutter', () => {
  const layout = { clientLeft: 0, clientTop: 0, clientWidth: 1200, clientHeight: 800 };

  it('flags the vertical and horizontal scrollbar gutters but not page content', () => {
    expect(isInScrollbarGutter(600, 400, layout)).toBe(false);
    expect(isInScrollbarGutter(1199, 799, layout)).toBe(false);
    // The vertical bar sits at or past clientWidth; the horizontal bar past clientHeight.
    expect(isInScrollbarGutter(1200, 400, layout)).toBe(true);
    expect(isInScrollbarGutter(1210, 400, layout)).toBe(true);
    expect(isInScrollbarGutter(600, 800, layout)).toBe(true);
    // The bottom-right corner box counts too.
    expect(isInScrollbarGutter(1205, 805, layout)).toBe(true);
  });

  it('accounts for scrollbars placed on the left or top edge', () => {
    const offsetLayout = { clientLeft: 14, clientTop: 10, clientWidth: 1186, clientHeight: 790 };

    expect(isInScrollbarGutter(13, 400, offsetLayout)).toBe(true);
    expect(isInScrollbarGutter(600, 9, offsetLayout)).toBe(true);
    expect(isInScrollbarGutter(14, 10, offsetLayout)).toBe(false);
    expect(isInScrollbarGutter(1199, 799, offsetLayout)).toBe(false);
    expect(isInScrollbarGutter(1200, 400, offsetLayout)).toBe(true);
  });
});

describe('isInScrollableElementGutter', () => {
  it('detects a nested vertical scrollbar without treating its content as a gutter', () => {
    const element = document.createElement('div');
    element.style.overflowY = 'auto';
    Object.defineProperties(element, {
      clientLeft: { configurable: true, value: 0 },
      clientTop: { configurable: true, value: 0 },
      clientWidth: { configurable: true, value: 180 },
      clientHeight: { configurable: true, value: 100 },
      offsetWidth: { configurable: true, value: 192 },
      offsetHeight: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 180 },
      scrollHeight: { configurable: true, value: 400 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 40, top: 20, right: 232, bottom: 120, width: 192, height: 100 }),
      },
    });
    expect(element.scrollHeight).toBe(400);
    expect(getComputedStyle(element).overflowY).toBe('auto');

    expect(isInScrollableElementGutter(100, 70, element)).toBe(false);
    expect(isInScrollableElementGutter(226, 70, element)).toBe(true);
    expect(isInScrollableElementGutter(240, 70, element)).toBe(false);
  });
});

describe('isPointInsideViewport', () => {
  const viewport = { width: 1200, height: 800 };

  it('distinguishes an in-page target replacement from actually leaving the viewport', () => {
    expect(isPointInsideViewport(600, 400, viewport)).toBe(true);
    expect(isPointInsideViewport(0, 0, viewport)).toBe(true);
    expect(isPointInsideViewport(-1, 400, viewport)).toBe(false);
    expect(isPointInsideViewport(1200, 400, viewport)).toBe(false);
    expect(isPointInsideViewport(600, 800, viewport)).toBe(false);
  });
});

describe('getRecordingTabUpdateAction', () => {
  it('never re-injects a snapshot recorder when the current document finishes loading', () => {
    expect(getRecordingTabUpdateAction('snapshot', { status: 'complete' })).toBe('ignore');
    expect(getRecordingTabUpdateAction('snapshot', { status: 'loading' })).toBe('stop-snapshot');
    expect(getRecordingTabUpdateAction('snapshot', { url: 'https://example.com/next' })).toBe('stop-snapshot');
  });

  it('re-injects steps mode only after navigation completes', () => {
    expect(getRecordingTabUpdateAction('steps', { status: 'loading' })).toBe('ignore');
    expect(getRecordingTabUpdateAction('steps', { status: 'complete' })).toBe('reinject');
  });
});

describe('isDocumentScrollingKey', () => {
  function target(html: string): Element {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild!;
  }

  it('claims every key the browser scrolls with', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']) {
      expect(isDocumentScrollingKey(key, document.body), key).toBe(true);
    }
    expect(isDocumentScrollingKey(' ', document.body)).toBe(true);
    expect(isDocumentScrollingKey('Enter', document.body)).toBe(false);
    expect(isDocumentScrollingKey('a', document.body)).toBe(false);
  });

  it('leaves activation and caret movement to the browser', () => {
    // Space activates a focused control; cancelling its default would break
    // the shield's own toolbar.
    expect(isDocumentScrollingKey(' ', target('<button type="button">完成</button>'))).toBe(false);
    expect(isDocumentScrollingKey(' ', target('<a href="/x">連結</a>'))).toBe(false);
    // Arrows still scroll from a button, so they stay claimed there.
    expect(isDocumentScrollingKey('ArrowDown', target('<button type="button">完成</button>'))).toBe(true);

    for (const html of ['<input />', '<textarea></textarea>', '<div contenteditable="true"></div>']) {
      expect(isDocumentScrollingKey('ArrowDown', target(html)), html).toBe(false);
      expect(isDocumentScrollingKey(' ', target(html)), html).toBe(false);
    }
  });

  it('ignores targets that are not elements', () => {
    expect(isDocumentScrollingKey('ArrowDown', null)).toBe(true);
    expect(isDocumentScrollingKey(' ', null)).toBe(true);
  });
});
