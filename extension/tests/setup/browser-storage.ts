class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

// jsdom ships no matchMedia, so any component that asks about a media feature
// (toasts check prefers-reduced-motion, the step rail checks the desktop
// breakpoint) throws on render. Individual tests can still stub a specific
// answer with vi.stubGlobal; this only guarantees the function exists.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom ships no ResizeObserver either; Radix Popper (used by Popover and the
// new Tooltip primitive) creates one to track trigger/content size.
if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
}

// Node 22 exposes a configurable but undefined localStorage global unless it
// receives a process-wide storage file. Tests need browser-like synchronous
// storage without relying on a host-specific Node flag.
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
if (!localStorageDescriptor || !('value' in localStorageDescriptor) || localStorageDescriptor.value === undefined) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
}
