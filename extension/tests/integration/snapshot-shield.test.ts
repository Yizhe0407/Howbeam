// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';
import {
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_COMMIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_READY,
  SNAPSHOT_SHIELD_REGION_CAPTURE,
} from '@/lib/recording/snapshot-shield-protocol';

const mocks = vi.hoisted(() => {
  const stored = new Map<string, unknown>();
  return {
    getURL: vi.fn((path: string) => `https://extension.test${path}`),
    stored,
    storageGet: vi.fn(async (key: string | null) => {
      if (key === null) return Object.fromEntries(stored);
      return stored.has(key) ? { [key]: stored.get(key) } : {};
    }),
    storageSet: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) stored.set(key, value);
    }),
    storageRemove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) stored.delete(key);
    }),
  };
});

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { getURL: mocks.getURL },
    storage: {
      local: { get: mocks.storageGet, set: mocks.storageSet, remove: mocks.storageRemove },
    },
  },
}));

import { createSnapshotShield } from '@/lib/recording/snapshot-shield';

afterEach(() => {
  document.documentElement.querySelectorAll('[data-howbeam-snapshot-shield]').forEach((element) => element.remove());
  vi.restoreAllMocks();
});

describe('createSnapshotShield', () => {
  it('waits for the private channel and becomes click-blind only during hit testing', async () => {
    let shadowRoot: ShadowRoot | null = null;
    const originalAttachShadow = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
      shadowRoot = originalAttachShadow.call(this, { ...init, mode: 'open' });
      return shadowRoot;
    });
    const originalMatches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      if (selector === ':modal') return this instanceof HTMLDialogElement && this.hasAttribute('open');
      if (selector === ':popover-open') return false;
      return originalMatches.call(this, selector);
    });
    let activeModal: HTMLDialogElement | null = null;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => activeModal),
    });
    const postMessage = vi.fn();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({ postMessage } as unknown as Window);
    const selection = { rect: { x: 20, y: 30, width: 100, height: 40 }, label: 1 };
    const onPoint = vi.fn().mockResolvedValue(selection);
    const onHover = vi.fn(() => ({ rect: selection.rect }));
    const regionSelection = { rect: { x: 12, y: 18, width: 80, height: 60 }, label: 2 };
    const onRegion = vi.fn().mockResolvedValue(regionSelection);
    const shield = createSnapshotShield(onPoint, onHover, undefined, onRegion);
    const frame = shadowRoot!.querySelector('iframe')!;
    expect(frame.style.getPropertyValue('color-scheme')).toBe('only light');
    expect(frame.style.getPropertyPriority('color-scheme')).toBe('important');
    const focusFrame = vi.spyOn(frame, 'focus');

    // Token provisioning assigns src asynchronously; the load handler
    // ignores load events fired before src is set (about:blank guard).
    await vi.waitFor(() => expect(frame.src).not.toBe(''));
    frame.dispatchEvent(new Event('load'));
    const [initMessage, , transfer] = postMessage.mock.calls[0] as unknown as [
      { token: string },
      string,
      Transferable[],
    ];
    const framePort = transfer![0] as MessagePort;
    const frameMessages: Array<{ type?: string; requestId?: number; selection?: { id: number } | null }> = [];
    framePort.onmessage = (event) => frameMessages.push(event.data);
    framePort.start();
    framePort.postMessage({ type: SNAPSHOT_SHIELD_READY, token: initMessage.token });
    await shield.ready;
    await vi.waitFor(() => expect(focusFrame).toHaveBeenCalledWith({ preventScroll: true }));

    const host = shadowRoot!.host as HTMLElement;
    expect(shield.runWithoutShield(() => ({
      host: host.style.getPropertyValue('pointer-events'),
      frame: frame.style.getPropertyValue('pointer-events'),
    }))).toEqual({ host: 'none', frame: 'none' });
    expect(host.style.getPropertyValue('pointer-events')).toBe('auto');
    expect(frame.style.getPropertyValue('pointer-events')).toBe('auto');
    expect(() =>
      shield.runWithoutShield(() => {
        throw new Error('hit-test failed');
      }),
    ).toThrow('hit-test failed');
    expect(host.style.getPropertyValue('pointer-events')).toBe('auto');
    expect(frame.style.getPropertyValue('pointer-events')).toBe('auto');

    framePort.postMessage({
      type: SNAPSHOT_SHIELD_POINTER_MOVE,
      token: initMessage.token,
      requestId: 7,
      clientX: 50,
      clientY: 70,
    });
    await vi.waitFor(() => expect(onHover).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(frameMessages).toContainEqual(
        expect.objectContaining({
          type: SNAPSHOT_SHIELD_PREVIEW,
          requestId: 7,
          rect: selection.rect,
        }),
      ),
    );

    framePort.postMessage({
      type: SNAPSHOT_SHIELD_POINTER_DOWN,
      token: initMessage.token,
      captureId: 1,
      clientX: 50,
      clientY: 70,
    });
    await vi.waitFor(() => expect(onPoint).toHaveBeenCalledOnce());
    expect(onPoint).toHaveBeenCalledWith(expect.objectContaining({ clientX: 50, clientY: 70 }));
    await vi.waitFor(() =>
      expect(frameMessages).toContainEqual(
        expect.objectContaining({
          type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
          selection: expect.objectContaining({ id: 1, ...selection }),
        }),
      ),
    );

    framePort.postMessage({
      type: SNAPSHOT_SHIELD_REGION_CAPTURE,
      token: initMessage.token,
      captureId: 2,
      rect: { x: 12, y: 18, width: 7, height: 60 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRegion).not.toHaveBeenCalled();

    framePort.postMessage({
      type: SNAPSHOT_SHIELD_REGION_CAPTURE,
      token: initMessage.token,
      captureId: 3,
      rect: regionSelection.rect,
    });
    await vi.waitFor(() => expect(onRegion).toHaveBeenCalledOnce());
    expect(onRegion).toHaveBeenCalledWith(
      expect.objectContaining({ token: initMessage.token, rect: regionSelection.rect }),
    );
    await vi.waitFor(() =>
      expect(frameMessages).toContainEqual(
        expect.objectContaining({
          type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
          selection: expect.objectContaining({ id: 2, ...regionSelection }),
        }),
      ),
    );

    const modal = document.createElement('dialog');
    modal.setAttribute('open', '');
    activeModal = modal;
    document.body.append(modal);
    await vi.waitFor(() => expect(host.parentElement).toBe(modal));
    modal.removeAttribute('open');
    activeModal = null;
    await vi.waitFor(() => expect(host.parentElement).toBe(document.documentElement));
    modal.remove();

    onPoint.mockClear();
    host.remove();
    await vi.waitFor(() => expect(host.isConnected).toBe(true));
    // Token provisioning assigns src asynchronously; the load handler
    // ignores load events fired before src is set (about:blank guard).
    await vi.waitFor(() => expect(frame.src).not.toBe(''));
    frame.dispatchEvent(new Event('load'));
    const [, , replacementTransfer] = postMessage.mock.calls[1] as unknown as [
      { token: string },
      string,
      Transferable[],
    ];
    const replacementPort = replacementTransfer![0] as MessagePort;
    const replacementMessages: Array<{ type?: string; selection?: { id: number } }> = [];
    replacementPort.onmessage = (event) => replacementMessages.push(event.data);
    replacementPort.start();
    replacementPort.postMessage({ type: SNAPSHOT_SHIELD_READY, token: initMessage.token });
    await vi.waitFor(() =>
      expect(replacementMessages).toContainEqual(
        expect.objectContaining({
          type: SNAPSHOT_SHIELD_COMMIT,
          selection: expect.objectContaining({ id: 1, ...selection }),
        }),
      ),
    );
    replacementPort.postMessage({
      type: SNAPSHOT_SHIELD_POINTER_DOWN,
      token: initMessage.token,
      captureId: 4,
      clientX: 90,
      clientY: 110,
    });
    await vi.waitFor(() => expect(onPoint).toHaveBeenCalledOnce());

    onPoint.mockClear();
    shield.remove();
    framePort.postMessage({
      type: SNAPSHOT_SHIELD_POINTER_DOWN,
      token: initMessage.token,
      captureId: 5,
      clientX: 50,
      clientY: 70,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onPoint).not.toHaveBeenCalled();
    framePort.close();
    replacementPort.close();
    expect(host.isConnected).toBe(false);
  });

  it('removes the shield and reports a runtime channel failure after READY', async () => {
    silenceIntentionalErrorLogs();
    let shadowRoot: ShadowRoot | null = null;
    const originalAttachShadow = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
      shadowRoot = originalAttachShadow.call(this, { ...init, mode: 'open' });
      return shadowRoot;
    });
    const postMessage = vi.fn();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({ postMessage } as unknown as Window);
    const onFailure = vi.fn();
    const shield = createSnapshotShield(vi.fn(), undefined, undefined, undefined, onFailure);
    const frame = shadowRoot!.querySelector('iframe')!;

    // Token provisioning assigns src asynchronously; the load handler
    // ignores load events fired before src is set (about:blank guard).
    await vi.waitFor(() => expect(frame.src).not.toBe(''));
    frame.dispatchEvent(new Event('load'));
    const [initMessage, , transfer] = postMessage.mock.calls[0] as unknown as [
      { token: string },
      string,
      Transferable[],
    ];
    const framePort = transfer![0] as MessagePort;
    framePort.start();
    framePort.postMessage({ type: SNAPSHOT_SHIELD_READY, token: initMessage.token });
    await shield.ready;

    vi.spyOn(MessagePort.prototype, 'postMessage').mockImplementation(() => {
      throw new Error('detached channel');
    });
    shield.updateToolbar({
      runId: 'run-1',
      mode: 'snapshot',
      phase: 'recording',
      itemCount: 0,
      error: null,
    });

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
    expect(shadowRoot!.host.isConnected).toBe(false);
    framePort.close();
  });

});
