/**
 * jsdom shims for browser APIs the `@slicc/webcomponents` elements touch.
 * The library's own tests run in real Chromium; the webapp wiring tests run
 * under jsdom, which lacks `matchMedia`, `ResizeObserver`, and canvas
 * contexts. Components null-guard all three, so minimal stubs suffice.
 */

class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return [];
  }
}

export function installWcDomStubs(): void {
  const win = globalThis as unknown as Record<string, unknown>;
  // Node's flag-gated experimental localStorage shadows jsdom's as undefined.
  if (win['localStorage'] === undefined) {
    const store = new Map<string, string>();
    win['localStorage'] = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    };
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
