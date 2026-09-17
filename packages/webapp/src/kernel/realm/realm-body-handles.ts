/**
 * Keep the JS realm alive across constructed `Request` / `Response` body
 * reads. Native Body mixin consumption is a ReadableStream turn, which is
 * not an RPC or timer handle; after any earlier body read the drain can
 * post `realm-done` before the next `await res.text()` continuation runs
 * (silent exit 0 — #3227, leftover of #2862).
 *
 * Two layers, restored when the realm finishes (in-process tests share an
 * isolate with vitest):
 * 1. Sync-bufferable bodies (string, typed array, URLSearchParams) get the
 *    same microtask readers as fetch reconstruction.
 * 2. Remaining native readers (`Blob`, `FormData`, `ReadableStream`, clone)
 *    are counted as drain handles until their promise settles.
 */

import { attachBufferedBodyReaders } from './realm-fetch-response.js';

const BODY_METHOD_NAMES = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'] as const;
type BodyMethodName = (typeof BODY_METHOD_NAMES)[number];

type BodyMethod = (...args: unknown[]) => unknown;

interface SavedBodyMethod {
  proto: object;
  name: BodyMethodName;
  descriptor: PropertyDescriptor;
}

export interface BodyReadHandleTracker {
  readonly pendingCount: number;
  install(): void;
  restore(): void;
  waitForProgress(): Promise<void>;
}

export function trySyncBodyBytes(body: BodyInit | null | undefined): Uint8Array | undefined {
  if (body == null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  if (typeof URLSearchParams === 'function' && body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }
  return undefined;
}

export function createBodyReadHandleTracker(
  g: typeof globalThis = globalThis
): BodyReadHandleTracker {
  const NativeRequest = g.Request;
  const NativeResponse = g.Response;
  const savedMethods: SavedBodyMethod[] = [];
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

  const wrapPrototype = (ctor: typeof Request | typeof Response | undefined): void => {
    if (!ctor) return;
    const proto = ctor.prototype as unknown as Record<BodyMethodName, BodyMethod>;
    for (const name of BODY_METHOD_NAMES) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.value !== 'function') continue;
      savedMethods.push({ proto, name, descriptor });
      const orig = descriptor.value as BodyMethod;
      Object.defineProperty(proto, name, {
        ...descriptor,
        value: function wrappedBodyRead(this: unknown, ...args: unknown[]): unknown {
          return track(orig.apply(this, args));
        },
      });
    }
  };

  return {
    get pendingCount() {
      return pending;
    },

    install() {
      if (installed) return;
      installed = true;
      wrapPrototype(NativeRequest);
      wrapPrototype(NativeResponse);
      if (NativeResponse) {
        g.Response = class Response extends NativeResponse {
          constructor(body?: BodyInit | null, init?: ResponseInit) {
            super(body, init);
            const bytes = trySyncBodyBytes(body);
            if (bytes) attachBufferedBodyReaders(this, bytes);
          }
        };
      }
      if (NativeRequest) {
        g.Request = class Request extends NativeRequest {
          constructor(input: RequestInfo | URL, init?: RequestInit) {
            super(input, init);
            const copiedExisting =
              input instanceof NativeRequest && !(init && Object.hasOwn(init, 'body'));
            if (copiedExisting) return;
            const bytes = trySyncBodyBytes(init?.body ?? null);
            if (bytes) attachBufferedBodyReaders(this, bytes);
          }
        };
      }
    },

    restore() {
      if (!installed) return;
      installed = false;
      g.Request = NativeRequest;
      g.Response = NativeResponse;
      for (const { proto, name, descriptor } of savedMethods) {
        Object.defineProperty(proto, name, descriptor);
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
