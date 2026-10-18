// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

import {
  createStepFrameRelayLimiter,
  findIframeForWindow,
  resolveRelayedStepFrameHop,
  stepFrameClickMessageType,
} from '@/lib/recording/frame-relay';

/**
 * How a hop from a child frame is routed: which iframe sent it, and where its
 * rect lands in this frame's viewport. jsdom has no layout, so each iframe's
 * box is given explicitly.
 */

const messageType = stepFrameClickMessageType('test-extension');

function payload(overrides: Record<string, unknown> = {}) {
  return {
    type: messageType,
    captureId: 'capture-id',
    relayToken: 'relay-token',
    rect: { x: 10, y: 20, width: 30, height: 40 },
    originTimestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/** An iframe whose border box sits at (left, top) with a 2px border. */
function placeIframe(parent: ParentNode, box = { left: 100, top: 50, width: 304, height: 204 }): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  parent.appendChild(frame);
  const rect = DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
  frame.getBoundingClientRect = () => rect;
  frame.getClientRects = () => [rect] as unknown as DOMRectList;
  Object.defineProperties(frame, {
    offsetWidth: { value: box.width },
    offsetHeight: { value: box.height },
    clientLeft: { value: 2 },
    clientTop: { value: 2 },
  });
  return frame;
}

/** jsdom gives an iframe inside a shadow root no window; this one stands in for it. */
function placeShadowIframe(shadow: ShadowRoot): { frame: HTMLIFrameElement; source: object } {
  const frame = placeIframe(shadow);
  const source = {};
  Object.defineProperty(frame, 'contentWindow', { value: source });
  return { frame, source };
}

/** A MessageEvent as the browser delivers it; jsdom cannot mint a trusted one. */
function hop(source: unknown, data: unknown = payload(), isTrusted = true): MessageEvent {
  return { isTrusted, data, source } as unknown as MessageEvent;
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 720);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('findIframeForWindow', () => {
  it('finds the iframe whose window sent the message, including inside shadow roots', () => {
    const direct = placeIframe(document.body);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadowed = placeShadowIframe(host.attachShadow({ mode: 'open' }));

    expect(findIframeForWindow(direct.contentWindow)).toBe(direct);
    expect(findIframeForWindow(shadowed.source)).toBe(shadowed.frame);
  });

  it('answers nothing for this window, a missing source or a window it does not host', () => {
    placeIframe(document.body);

    expect(findIframeForWindow(window)).toBeNull();
    expect(findIframeForWindow(null)).toBeNull();
    expect(findIframeForWindow({})).toBeNull();
  });

  it('stops looking past the shadow nesting limit', () => {
    const nestShadows = (levels: number): ShadowRoot => {
      let root: ParentNode = document.body;
      for (let depth = 0; depth < levels; depth++) {
        const host = document.createElement('div');
        root.appendChild(host);
        root = host.attachShadow({ mode: 'open' });
      }
      return root as ShadowRoot;
    };
    const deepest = placeShadowIframe(nestShadows(8));
    const buried = placeShadowIframe(nestShadows(9));

    expect(findIframeForWindow(deepest.source)).toBe(deepest.frame);
    expect(findIframeForWindow(buried.source)).toBeNull();
  });
});

describe('resolveRelayedStepFrameHop', () => {
  it('maps the child rect through the iframe border into this viewport', () => {
    const frame = placeIframe(document.body);

    const relayed = resolveRelayedStepFrameHop(hop(frame.contentWindow), messageType, createStepFrameRelayLimiter());

    expect(relayed).toEqual({
      payload: payload(),
      frame,
      rect: { x: 112, y: 72, width: 30, height: 40 },
    });
  });

  it('clips the rect to the part of the iframe this viewport shows', () => {
    const frame = placeIframe(document.body, { left: 1200, top: 50, width: 304, height: 204 });

    const relayed = resolveRelayedStepFrameHop(
      hop(frame.contentWindow, payload({ rect: { x: 50, y: 0, width: 100, height: 10 } })),
      messageType,
      createStepFrameRelayLimiter(),
    );

    expect(relayed?.rect).toEqual({ x: 1252, y: 52, width: 28, height: 10 });
  });

  it('keeps the hop but drops the rect when the iframe is hidden here', () => {
    const frame = placeIframe(document.body);
    frame.style.visibility = 'hidden';

    const relayed = resolveRelayedStepFrameHop(hop(frame.contentWindow), messageType, createStepFrameRelayLimiter());

    expect(relayed).toMatchObject({ frame, rect: null });
  });

  it('ignores page-forged events, foreign message types and unknown senders', () => {
    const frame = placeIframe(document.body);
    const limiter = createStepFrameRelayLimiter();

    expect(resolveRelayedStepFrameHop(hop(frame.contentWindow, payload(), false), messageType, limiter)).toBeNull();
    expect(resolveRelayedStepFrameHop(hop(frame.contentWindow, payload({ type: 'other' })), messageType, limiter)).toBeNull();
    expect(resolveRelayedStepFrameHop(hop({}), messageType, limiter)).toBeNull();
  });

  it('stops routing once a frame floods the relay', () => {
    const frame = placeIframe(document.body);
    const limiter = createStepFrameRelayLimiter();
    const results = Array.from({ length: 91 }, () =>
      resolveRelayedStepFrameHop(hop(frame.contentWindow), messageType, limiter));

    expect(results.slice(0, 90).every((result) => result !== null)).toBe(true);
    expect(results[90]).toBeNull();
  });
});
