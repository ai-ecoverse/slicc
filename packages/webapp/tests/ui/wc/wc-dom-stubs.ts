/**
 * jsdom shims for browser APIs the `@slicc/webcomponents` elements touch.
 * The library's own tests run in real Chromium; the webapp wiring tests run
 * under jsdom, which lacks `matchMedia`, `ResizeObserver`, and canvas
 * contexts. Components null-guard all three, so minimal stubs suffice.
 */

class StubObserver {
  // Accept (and ignore) the observer callback: the real ResizeObserver /
  // IntersectionObserver constructors take one, and a zero-arg signature
  // here makes static analysis flag every `new ResizeObserver(cb)` in the
  // library source as passing a superfluous argument.
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
  // Node's flag-gated experimental localStorage shadows jsdom's: undefined on
  // Node 24/26, and on Node 25 a BROKEN object whose methods are not functions
  // ("--localstorage-file was provided without a valid path"). Probe rather
  // than null-check, and overwrite anything non-functional.
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
      // The global may be an accessor — force it via defineProperty.
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
  // jsdom's getContext throws "not implemented" — the shader element
  // null-guards a missing WebGL context, so return null.
  if (typeof HTMLCanvasElement !== 'undefined') {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  }
}
