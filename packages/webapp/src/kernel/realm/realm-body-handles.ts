/**
 * Keep the JS realm alive across WHATWG stream I/O. Native Body mixin,
 * Blob, and ReadableStream consumption is a stream turn, which is not an
 * RPC or timer handle; after any earlier read the drain can post
 * `realm-done` before the next continuation runs (silent exit 0 — #3227,
 * leftover of #2862).
 *
 * Two more promise-only waits count the same way, as they do in Node:
 * `WebAssembly.compile` / `instantiate` (an Emscripten program's glue starts
 * `main` only once its module instantiates) and `__slicc_mountVfs` (its
 * `--pre-js` mounts the live VFS before `main`). Without them a program run
 * as `node prog.js` exits 0 before `main` ever runs.
 *
 * Methods are wrapped and restored when the realm finishes
 * (in-process tests share an isolate with vitest). Constructors are left
 * alone so `instanceof Request` / `req.clone()` keep platform identity.
 * Fetch reconstruction still attaches microtask readers in
 * `realm-fetch-response.ts`.
 */

const BODY_METHODS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'] as const;
const BLOB_METHODS = ['arrayBuffer', 'bytes', 'text'] as const;
const STREAM_METHODS = ['cancel', 'pipeTo'] as const;
const READER_METHODS = ['cancel', 'read'] as const;
const WASM_METHODS = [
  'compile',
  'compileStreaming',
  'instantiate',
  'instantiateStreaming',
] as const;
/** Realm globals whose promise is a pending handle (`js-realm-shared.ts`). */
const REALM_HOOKS = ['__slicc_mountVfs'] as const;

type StreamMethod = (...args: unknown[]) => unknown;
type MethodCtor = { prototype: object };

interface SavedStreamMethod {
  target: object;
  name: string;
  descriptor: PropertyDescriptor;
  wrapper: StreamMethod;
}

export interface BodyReadHandleTracker {
  readonly pendingCount: number;
  install(): void;
  restore(): void;
  waitForProgress(): Promise<void>;
}

export function createBodyReadHandleTracker(
  g: typeof globalThis = globalThis
): BodyReadHandleTracker {
  const savedMethods: SavedStreamMethod[] = [];
  const progressWaiters = new Set<() => void>();
  let pending = 0;
  let installed = false;

  const notifyProgress = (): void => {
    if (progressWaiters.size === 0) return;
    const waiters = [...progressWaiters];
    progressWaiters.clear();
    for (const waiter of waiters) waiter();
  };

  const track = (result: unknown): unknown => {
    if (!isThenable(result)) return result;
    pending += 1;
    const done = (): void => {
      pending = Math.max(0, pending - 1);
      notifyProgress();
    };
    Promise.resolve(result).then(done, done);
    return result;
  };

  const wrapNamedMethods = (target: object | undefined, names: readonly string[]): void => {
    if (!target) return;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.configurable) {
        continue;
      }
      const orig = descriptor.value as StreamMethod;
      const wrapper = function wrappedStreamRead(this: unknown, ...args: unknown[]): unknown {
        return track(orig.apply(this, args));
      };
      savedMethods.push({ target, name, descriptor, wrapper });
      Object.defineProperty(target, name, { ...descriptor, value: wrapper });
    }
  };

  return {
    get pendingCount() {
      return pending;
    },

    install() {
      if (installed) return;
      installed = true;
      wrapNamedMethods(protoOf(g.Request), BODY_METHODS);
      wrapNamedMethods(protoOf(g.Response), BODY_METHODS);
      wrapNamedMethods(protoOf(g.Blob), BLOB_METHODS);
      wrapNamedMethods(protoOf(g.File), BLOB_METHODS);
      wrapNamedMethods(protoOf(g.ReadableStream), STREAM_METHODS);
      wrapNamedMethods(protoOf(readableStreamReaderCtor(g, 'default')), READER_METHODS);
      wrapNamedMethods(protoOf(readableStreamReaderCtor(g, 'byob')), READER_METHODS);
      wrapNamedMethods(g.WebAssembly, WASM_METHODS);
      wrapNamedMethods(g, REALM_HOOKS);
    },

    restore() {
      if (!installed) return;
      installed = false;
      for (const { target, name, descriptor, wrapper } of savedMethods) {
        // Leave a property the realm already replaced or deleted (it drops
        // `__slicc_mountVfs` at teardown) instead of resurrecting it.
        if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapper) continue;
        Object.defineProperty(target, name, descriptor);
      }
      savedMethods.length = 0;
      pending = 0;
      notifyProgress();
    },

    waitForProgress() {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        progressWaiters.add(resolve);
      });
    },
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}

function protoOf(value: unknown): object | undefined {
  return typeof value === 'function' ? (value as MethodCtor).prototype : undefined;
}

function readableStreamReaderCtor(g: typeof globalThis, kind: 'default' | 'byob'): unknown {
  const bag = g as typeof globalThis & {
    ReadableStreamDefaultReader?: unknown;
    ReadableStreamBYOBReader?: unknown;
  };
  return kind === 'byob' ? bag.ReadableStreamBYOBReader : bag.ReadableStreamDefaultReader;
}
