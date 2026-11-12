/**
 * Browser APIs every supported browser has (Chrome 111+, Firefox 140+) but
 * jsdom lacks. Production code uses them unguarded; tests get these stand-ins,
 * which a test can still replace with vi.stubGlobal to drive them.
 */
import { afterEach, beforeEach } from 'vitest';
import { createFakeLockManager } from './fake-locks';

/**
 * Node's BroadcastChannel reaches every worker thread in the process, so test
 * files running in parallel would hear each other's "projects changed" and
 * lock messages. This one only connects channels within one test file, as a
 * real browser connects only the pages of one extension.
 */
class TestBroadcastChannel extends EventTarget {
  static readonly open = new Map<string, Set<TestBroadcastChannel>>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  private closed = false;

  constructor(readonly name: string) {
    super();
    const peers = TestBroadcastChannel.open.get(name) ?? new Set();
    peers.add(this);
    TestBroadcastChannel.open.set(name, peers);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new DOMException('Channel is closed', 'InvalidStateError');
    const copy = structuredClone(data);
    for (const peer of TestBroadcastChannel.open.get(this.name) ?? []) {
      if (peer === this) continue;
      setTimeout(() => peer.deliver(copy), 0);
    }
  }

  private deliver(data: unknown): void {
    if (this.closed) return;
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  close(): void {
    this.closed = true;
    TestBroadcastChannel.open.get(this.name)?.delete(this);
  }
}

globalThis.BroadcastChannel = TestBroadcastChannel as unknown as typeof BroadcastChannel;

if (typeof window !== 'undefined') {
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  if (!('IntersectionObserver' in globalThis)) {
    /** Reports every observed element as on screen, as a small page would. */
    globalThis.IntersectionObserver = class {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() =>
          this.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  }

  if (typeof window.matchMedia !== 'function') {
    /** Answers min-width/max-width queries from the window size; anything else does not match. */
    window.matchMedia = (query: string) => {
      const min = /\(min-width:\s*(\d+)px\)/.exec(query);
      const max = /\(max-width:\s*(\d+)px\)/.exec(query);
      const matches =
        (min ? window.innerWidth >= Number(min[1]) : true) &&
        (max ? window.innerWidth <= Number(max[1]) : true) &&
        Boolean(min || max);
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    };
  }

  // A fresh lock manager per test, so a lock an earlier test's editor still
  // held while unmounting can never make this test's editor wait for it.
  beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: createFakeLockManager() });
  });

  if (typeof document.elementsFromPoint !== 'function') {
    document.elementsFromPoint = () => [];
  }

  if (!('CSS' in globalThis)) {
    (globalThis as { CSS?: unknown }).CSS = { supports: () => false, escape: (value: string) => value };
  }
}

if (typeof window !== 'undefined') {
  // react-hot-toast keeps its store across tests; a toast from one test must
  // not show up in the next one's DOM.
  const { default: toast } = await import('react-hot-toast');
  afterEach(() => toast.remove());
}
