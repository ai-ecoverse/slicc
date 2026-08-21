/**
 * Map-backed `localStorage` for the node test environment.
 *
 * Node 22 exposes a `localStorage` global that throws unless the process was
 * started with `--localstorage-file`, so anything reading persisted settings
 * (`work-unit/default-root.ts`, `shell/sprinkle-routes.ts`) silently takes its
 * catch branch. Install this to exercise the stored path instead — it is the
 * same shape as the kernel worker's boot-seeded shim.
 */

export interface FakeLocalStorage {
  /** Restore whatever was on `globalThis` before. */
  restore(): void;
  /** Direct view of the backing store, for arrange/assert. */
  store: Map<string, string>;
}

export function installFakeLocalStorage(initial: Record<string, string> = {}): FakeLocalStorage {
  const store = new Map<string, string>(Object.entries(initial));
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
  });
  return {
    store,
    restore() {
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    },
  };
}
