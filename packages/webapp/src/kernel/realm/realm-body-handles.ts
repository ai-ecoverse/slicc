const BODY_METHODS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'] as const;
const BLOB_METHODS = ['arrayBuffer', 'bytes', 'text'] as const;
const STREAM_METHODS = ['cancel', 'pipeTo'] as const;
const READER_METHODS = ['cancel', 'read'] as const;

type StreamMethod = (...args: unknown[]) => unknown;
type MethodCtor = { prototype: object };

interface SavedStreamMethod {
  proto: object;
  name: string;
  descriptor: PropertyDescriptor;
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

  const wrapNamedMethods = (ctor: MethodCtor | undefined, names: readonly string[]): void => {
    if (!ctor) return;
    const proto = ctor.prototype;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.value !== 'function') continue;
      savedMethods.push({ proto, name, descriptor });
      const orig = descriptor.value as StreamMethod;
      Object.defineProperty(proto, name, {
        ...descriptor,
        value: function wrappedStreamRead(this: unknown, ...args: unknown[]): unknown {
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
      wrapNamedMethods(asMethodCtor(g.Request), BODY_METHODS);
      wrapNamedMethods(asMethodCtor(g.Response), BODY_METHODS);
      wrapNamedMethods(asMethodCtor(g.Blob), BLOB_METHODS);
      wrapNamedMethods(asMethodCtor(g.File), BLOB_METHODS);
      wrapNamedMethods(asMethodCtor(g.ReadableStream), STREAM_METHODS);
      wrapNamedMethods(asMethodCtor(readableStreamReaderCtor(g, 'default')), READER_METHODS);
      wrapNamedMethods(asMethodCtor(readableStreamReaderCtor(g, 'byob')), READER_METHODS);
    },

    restore() {
      if (!installed) return;
      installed = false;
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

function asMethodCtor(value: unknown): MethodCtor | undefined {
  return typeof value === 'function' ? (value as MethodCtor) : undefined;
}

function readableStreamReaderCtor(g: typeof globalThis, kind: 'default' | 'byob'): unknown {
  const bag = g as typeof globalThis & {
    ReadableStreamDefaultReader?: unknown;
    ReadableStreamBYOBReader?: unknown;
  };
  return kind === 'byob' ? bag.ReadableStreamBYOBReader : bag.ReadableStreamDefaultReader;
}
