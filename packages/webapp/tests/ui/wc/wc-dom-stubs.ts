class StubObserver {
  constructor(_callback?: unknown) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return [];
  }
}

export function installWcDomStubs(): void {
  const win = globalThis as unknown as Record<string, unknown>;

  const existing = (() => {
    try {
      const candidate = win['localStorage'] as Storage | undefined;
      return candidate && typeof candidate.setItem === 'function' ? candidate : undefined;
    } catch {
      return undefined;
    }
  })();
  if (!existing) {
    const store = new Map<string, string>();
    const polyfill = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    };
    try {
      win['localStorage'] = polyfill;
    } catch {
      Object.defineProperty(globalThis, 'localStorage', {
        value: polyfill,
        configurable: true,
        writable: true,
      });
    }
  }
  if (typeof win['matchMedia'] !== 'function') {
    win['matchMedia'] = (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent: () => false,
    });
  }
  if (typeof win['ResizeObserver'] === 'undefined') {
    win['ResizeObserver'] = StubObserver;
  }
  if (typeof win['IntersectionObserver'] === 'undefined') {
    win['IntersectionObserver'] = StubObserver;
  }

  if (typeof HTMLCanvasElement !== 'undefined') {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  }
}
